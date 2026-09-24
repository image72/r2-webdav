/**
 * 本地 Finder 挂载代理：补上 `wrangler dev` 缺失的 `100 Continue`。
 *
 * 为什么需要它
 * ------------
 * macOS 的 `webdavfs`（Finder / TextEdit 挂载 WebDAV 时用的就是它）在发送带请求体的
 * PUT 时会带上 `Expect: 100-continue`，然后**等服务器先回 `HTTP/1.1 100 Continue`**
 * 才开始发 body。
 *
 * 实测结论（用原始 socket 双侧对比，见 /tmp/expect_probe.py 与 expect_probe_tls.py）：
 *   - 生产 Cloudflare 边缘          → 会回 `100 Continue`，上传正常
 *   - 本地 `wrangler dev`（workerd）→ **5 秒内零响应**，永不回
 *   → 于是本地挂载卷里任何上传/保存都会永久卡住（Finder 拖文件卡住、TextEdit 无法保存）。
 *     用 `curl` 测不出来，因为 curl 自带 1 秒兜底，只会表现为"慢了 1 秒"。
 *
 * 这个代理做三件事
 * ----------------
 *  1. 收到带 `Expect: 100-continue` 的请求时，**立刻回 100**，客户端随即开始发 body；
 *  2. 把请求（含 body）原样转发给本地 dev server，转发时去掉 `Expect` —— 上游不需要再协商一次；
 *  3. **保持 Host 头不变**。Worker 内部用 `new URL(request.url)` 的 host 与 `Destination`
 *     头比对（COPY/MOVE 用），若把 Host 改写成上游端口，Destination 就会被判成"外部主机"
 *     而回 502 —— 那是代理制造的假象，不是真实行为。
 *
 * 用法
 * ----
 *   # 1) 起一个 dev server（另开一个终端）
 *   npx wrangler dev --port 8790 --persist-to /tmp/mount-test --var USERNAME:test --var PASSWORD:test
 *
 *   # 2) 起代理
 *   node tools/dev-mount-proxy.mjs            # 默认 8787 -> 8790
 *   PROXY_PORT=8787 UPSTREAM_PORT=8790 node tools/dev-mount-proxy.mjs
 *
 *   # 3) Finder 里 ⌘K 挂载 http://127.0.0.1:8787/
 *
 * 注意：这是**本地测试用**的绕行方案，生产不需要它 —— 边缘会正确处理 `100 Continue`。
 */

import http from 'node:http';

const LISTEN_PORT = Number(process.env.PROXY_PORT ?? 8787);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 8790);

function handle(req, res) {
	const headers = { ...req.headers };
	// 客户端是否在等我们回 100 —— 这一行日志就是"Finder 到底带不带 Expect"的证据
	const expect = req.headers.expect ?? '(无)';
	const started = Date.now();
	console.log(
		`--> ${req.method} ${req.url}  expect=${expect}  content-length=${req.headers['content-length'] ?? '-'}`, 
	);

	// 上游是本地 dev server，body 会跟着一起发过去，不需要再协商一次
	delete headers.expect;
	// Host 保持客户端原样：Worker 要用它和 Destination 比对

	const upstream = http.request(
		{
			host: UPSTREAM_HOST,
			port: UPSTREAM_PORT,
			method: req.method,
			path: req.url,
			headers: headers,
		},
		(up) => {
			console.log(`<-- ${req.method} ${req.url}  ${up.statusCode}  (${Date.now() - started}ms)`);
			res.writeHead(up.statusCode ?? 502, up.headers);
			up.pipe(res);
		},
	);

	upstream.on('error', (error) => {
		console.error(`[proxy] ${req.method} ${req.url} -> 上游失败: ${error.message}`);
		if (!res.headersSent) {
			res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
		}
		res.end(`dev-mount-proxy: upstream error: ${error.message}`);
	});

	req.pipe(upstream);
}

// 必须**同时**监听 IPv4 与 IPv6 回环：macOS 的 webdavfs 挂载 `localhost` 时走的是 `[::1]`
// （实测 lsof 显示 `[::1]:xxxxx->[::1]:8787`），只监听 127.0.0.1 会让它连不上。
// 两个监听器共用同一个 handler，各自都要注册 checkContinue。
for (const address of ['127.0.0.1', '::1']) {
	const listener = http.createServer(handle);
	listener.on('checkContinue', (req, res) => {
		res.writeContinue();
		handle(req, res);
	});
	listener.listen(LISTEN_PORT, address, () => {
		console.log(`dev-mount-proxy: http://${address === '::1' ? '[::1]' : address}:${LISTEN_PORT}/ -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}  (补 100 Continue)`);
	});
}
