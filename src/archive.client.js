/**
 * 目录打包下载 —— 纯浏览器实现，完全不经过 Worker。
 *
 * 为什么单独一个文件：这块最容易出问题（内存、CDN、zip 工具兼容性），万一不值得留，
 * 删掉本文件 + index.html 里那一行 `<script>` 就能彻底摘干净，页面本身不受影响。
 * 所以这里**不引用页面的任何状态**，只通过 hooks 与外界通信：
 *
 *   R2Archive.downloadFolderAsZip(entry, { onProgress, signal })
 *
 * 将来若把实现换成 Web Worker，只要这套接口不动，index.html 一行都不用改。
 *
 * 关于 Web Worker（结论：现在不上）：JSZip 自身是单线程的 —— 它源码里那些 `*Worker.js`
 * 是内部的流式管道类，和 Web Worker 没有关系，`new Worker(` 在它仓库里一次都没出现；
 * 压缩/解压来自单线程的 pako。搬进 worker 不会更快，只是把主线程空出来、并把「取消」
 * 变成 terminate()。而当前用 STORE 压缩几乎没有 CPU 开销，瓶颈是 N 次请求的往返，
 * 所以真正的杠杆在并发度上（见 CONCURRENCY）。
 */
(function () {
	'use strict';

	const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

	/**
	 * 浏览器内打包的字节上限。
	 *
	 * JSZip 会把每个条目一直留在内存里，直到 generateAsync 结束，所以峰值内存大致等于
	 * 目录总大小。没有上限的话，一个几百 MB 的目录能把标签页拖死（而不是报错）。
	 * 超过就明确拒绝，让用户去打包子目录。
	 */
	const ZIP_BYTE_LIMIT = 256 * 1024 * 1024;

	/**
	 * 同时进行的请求数上限。
	 *
	 * 串行等每一个请求是两个方向的主要成本（打包是 N 次 GET，解压是 N 次 PUT）。
	 * 不能无上限：WebDAV 那层一次调用最多 6 个同时连接，而且并发数直接放大峰值内存
	 * （每个在途的请求体都占着一份）。4 是给两者都留了余量的取值。
	 */
	const CONCURRENCY = 4;

	const PROPFIND_BODY =
		'<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/></prop></propfind>';

	/** 惰性加载 JSZip：真的用到才拉（和页面里 markdown-it / mermaid 的做法一致）。 */
	let jszip = null;

	async function load_jszip() {
		if (jszip) return jszip;
		if (!window.JSZip) {
			await new Promise((resolve, reject) => {
				const script = document.createElement('script');
				script.src = JSZIP_URL;
				script.onload = resolve;
				script.onerror = () => reject(new Error('JSZip 加载失败（CDN 不可达？）'));
				document.head.appendChild(script);
			});
		}
		if (!window.JSZip) throw new Error('JSZip 加载失败');
		jszip = window.JSZip;
		return jszip;
	}

	/**
	 * 去掉 href 里的 `scheme://authority`，只留路径（RFC 4918 允许 href 是绝对 URI）。
	 *
	 * 刻意**不用 `new URL()`**：URL 解析器会把 `.` / `..` / `%2E%2E` 这些路径段折叠掉，
	 * 一个名字带 `..` 的对象会在比较前缀时就被悄悄丢掉，打包结果少了东西而用户完全
	 * 看不出来。自己切前缀，这种名字才能落到下面那道检查上被明确拒绝。
	 */
	const strip_origin = (href) => href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');

	/** 自带的体积格式化：模块要保持自包含，不依赖页面里的同名方法。 */
	function format_size(bytes) {
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let value = bytes;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value = value / 1024;
			unit++;
		}
		return (unit === 0 ? value : value.toFixed(1)) + ' ' + units[unit];
	}

	/** 把 zip 里的路径编成 URL 路径：逐段编码，`/` 保留为分隔符。 */
	const encode_path = (path) => path.split('/').map(encodeURIComponent).join('/');

	/**
	 * 有界并发。
	 *
	 * 一个任务失败后不再取新任务，但要等**在途的**任务都收尾再抛错 —— 调用方失败后会
	 * 立刻开始清理（DELETE），如果此时还有 PUT 在路上，它们会把内容又写回去，
	 * 于是“清干净了”变成假象。
	 */
	async function map_concurrent(items, limit, worker) {
		let next = 0;
		let failure = null;
		const runner = async () => {
			while (failure === null && next < items.length) {
				const index = next++;
				try {
					await worker(items[index], index);
				} catch (err) {
					if (failure === null) failure = err;
				}
			}
		};
		const runners = [];
		for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(runner());
		await Promise.all(runners);
		if (failure !== null) throw failure;
	}

	/** MKCOL。已存在会得到 405 —— 调用方自己保证不重复建。 */
	async function mkcol(url, signal) {
		const response = await fetch(url, { method: 'MKCOL', credentials: 'include', signal });
		if (!response.ok) throw new Error(url + ' 建目录失败：' + response.status);
	}

	/** PUT 一个对象。 */
	async function put_object(url, body, signal) {
		const response = await fetch(url, {
			method: 'PUT',
			credentials: 'include',
			signal,
			// If-None-Match 与上传路径一致：目标目录是刚建的，真出现 412 说明有别的客户端
			// 在同时写，如实报错而不是默默覆盖。
			headers: {
				'Content-Type': body.type || 'application/octet-stream',
				'If-None-Match': '*',
			},
			body,
		});
		if (response.status === 412) throw new Error(url + ' 已存在（有其它客户端在同时写入）');
		if (!response.ok) throw new Error(url + ' 写入失败：' + response.status);
	}

	/**
	 * 删除一个目录（递归）。
	 *
	 * 刻意**不接受 signal**：调用它时操作已经失败了，若是用户取消，signal 已经 abort，
	 * 把 abort 传上去会让这条清理请求立刻失败，半成品目录就留在那儿了。
	 */
	async function delete_tree(url) {
		try {
			const response = await fetch(url, { method: 'DELETE', credentials: 'include' });
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * 取一棵子树的清单。
	 *
	 * 用 `Depth: infinity` 的 PROPFIND —— 服务端已有的实现，一个请求就能拿到整个层级；
	 * 而且它已经过滤掉 `._*` 影子文件，与列表页看到的保持一致，不用客户端再筛一遍。
	 *
	 * 解析用 getElementsByTagNameNS（按「命名空间 + 本地名」匹配）而不是 querySelector，
	 * 这样服务端把前缀从默认命名空间换成 D: 也照样能解析。
	 */
	async function fetch_tree(href, signal) {
		const response = await fetch(href, {
			method: 'PROPFIND',
			credentials: 'include',
			signal,
			headers: { Depth: 'infinity', 'Content-Type': 'application/xml' },
			body: PROPFIND_BODY,
		});
		if (response.status !== 207) throw new Error('目录读取失败：' + response.status);

		// 服务端对象数超限时只返回一部分。静默少内容比直接失败糟得多：用户会以为备份完整，
		// 然后删掉原件。宁可拒绝也不产出一个不完整的 zip。
		if (response.headers.get('x-webdav-truncated') === 'true') {
			throw new Error('目录成员过多，服务端只能返回一部分清单，请分别打包子目录');
		}

		const doc = new DOMParser().parseFromString(await response.text(), 'application/xml');
		if (!doc.documentElement || doc.documentElement.localName !== 'multistatus') {
			throw new Error('目录清单解析失败');
		}

		const base = strip_origin(href).replace(/\/?$/, '/');
		const dirs = [];
		const files = [];
		for (const item of doc.getElementsByTagNameNS('DAV:', 'response')) {
			const node = item.getElementsByTagNameNS('DAV:', 'href')[0];
			if (!node) continue;
			const path = strip_origin(node.textContent.trim());
			// 以目录前缀（带斜杠）匹配：`/sub/` 不会误收 `/sub-x/`
			if (!path.startsWith(base)) continue;

			// 目录自己那一条（href 就是 base）没有后缀
			const tail = path.slice(base.length).replace(/\/+$/, '');
			if (!tail) continue;

			let relative;
			try {
				relative = decodeURIComponent(tail);
			} catch {
				// 名字解不出来就没法给它一个条目名。宁可整个失败，也不能少放一个文件
				// 还告诉用户「已打包」—— 用户可能就此拿这个 zip 当备份。
				throw new Error('目录清单里有无法解码的名字（' + tail + '），拒绝打包');
			}

			// R2 的 key 是任意字符串，能包含 `..`。带着它生成 zip 等于把
			// 「解压时写到目标目录之外」的路径写进文件里，不赌解压工具会消毒。
			if (relative.split('/').includes('..')) {
				throw new Error('目录里有名字含 .. 的对象（' + relative + '），拒绝打包');
			}

			if (item.getElementsByTagNameNS('DAV:', 'collection').length > 0) {
				dirs.push(relative);
				continue;
			}
			const raw = item.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent;
			const size = Number(raw ?? 0);
			files.push({ path: relative, href: path, size: Number.isFinite(size) ? size : 0 });
		}
		return { dirs, files };
	}

	/** 触发浏览器下载。blob URL 要延后回收，见 download_folder_as_zip 里的说明。 */
	function save_blob(blob, filename) {
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
		// blob URL 会一直钉住整个 zip 占的内存，直到页面关闭或显式回收。
		// 给下载留足启动时间再回收（立即回收会打断尚未开始的下载）。
		setTimeout(() => URL.revokeObjectURL(url), 60000);
	}

	/**
	 * 把一个目录打包成 zip 交给浏览器下载。
	 *
	 * @param {{ name: string, href: string }} entry
	 * @param {{ onProgress?: (text: string) => void, signal?: AbortSignal }} hooks
	 * @returns {Promise<{ files: number }>}
	 */
	async function download_folder_as_zip(entry, hooks) {
		const onProgress = (hooks && hooks.onProgress) || function () {};
		const signal = hooks && hooks.signal;

		onProgress('正在读取目录…');
		const tree = await fetch_tree(entry.href, signal);

		const total = tree.files.reduce((sum, file) => sum + file.size, 0);
		if (total > ZIP_BYTE_LIMIT) {
			throw new Error('共 ' + format_size(total) + '，超过 ' + format_size(ZIP_BYTE_LIMIT) + ' 的浏览器内打包上限');
		}

		const JSZip = await load_jszip();
		const zip = new JSZip();
		// 和 Finder 的「压缩」一致：zip 里保留目录本身这一层
		const root = zip.folder(entry.name);
		// 空目录不会因为子文件而自动出现，必须显式写一条，否则空目录会被静默丢掉
		for (const dir of tree.dirs) root.folder(dir);

		let done = 0;
		await map_concurrent(tree.files, CONCURRENCY, async (file) => {
			const response = await fetch(file.href, { credentials: 'include', signal });
			if (!response.ok) throw new Error(file.path + ' 读取失败：' + response.status);
			// zip.file() 是同步的且与顺序无关，所以下载可以并发，哪个先到先写
			root.file(file.path, await response.blob());
			done++;
			onProgress('打包中 ' + done + '/' + tree.files.length + '…');
		});

		onProgress('正在生成 zip…');
		// streamFiles 保持默认的 false：置 true 虽然省内存，但条目会用「数据描述符」写在末尾，
		// 部分解压工具（尤其 Windows 资源管理器）不接受这种 zip。
		const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
			onProgress('正在生成 zip… ' + Math.round(meta.percent) + '%');
		});

		save_blob(blob, entry.name + '.zip');
		return { files: tree.files.length };
	}

	/**
	 * 把一个 zip 解压到与它同名的目录里。
	 *
	 * 目标目录**必须不存在**。解压是多次请求、非原子的：写到一半失败会留下一个看着完整、
	 * 其实缺文件的目录，而用户很可能就拿它当备份 —— 这正是整个项目最想避免的那类状态。
	 * 所以宁可拒绝，也不往一个已有目录里合并。中途失败会把刚建的目录整个删掉。
	 *
	 * @param {{ name: string, href: string, size: number }} entry
	 * @param {{ onProgress?: (text: string) => void, signal?: AbortSignal }} hooks
	 * @returns {Promise<{ files: number, dirs: number }>}
	 */
	async function extract_zip_to_folder(entry, hooks) {
		const onProgress = (hooks && hooks.onProgress) || function () {};
		const signal = hooks && hooks.signal;

		// 先用列表接口已有的公开信息挡掉超大压缩包，不必先下完再发现放不下
		if (entry.size > ZIP_BYTE_LIMIT) {
			throw new Error(
				entry.name + ' 有 ' + format_size(entry.size) + '，超过 ' + format_size(ZIP_BYTE_LIMIT) + ' 的浏览器内解压上限',
			);
		}

		const target = entry.href.replace(/\.zip$/i, '') + '/';
		const base_name = entry.name.replace(/\.zip$/i, '');

		onProgress('正在读取 ' + entry.name + '…');
		const response = await fetch(entry.href, { credentials: 'include', signal });
		if (!response.ok) throw new Error('读取失败：' + response.status);
		const archive = await response.blob();

		const JSZip = await load_jszip();
		let zip;
		try {
			zip = await JSZip.loadAsync(archive);
		} catch (err) {
			throw new Error('不是有效的 zip 文件' + (err && err.message ? '（' + err.message + '）' : ''));
		}

		// 分类条目，并把父目录补全（有些工具不写目录条目，只写完整路径）
		const dirs = new Set();
		let files = [];
		const add_dir = (path) => {
			const parts = path.split('/').filter(Boolean);
			let acc = '';
			for (const part of parts) {
				acc = acc ? acc + '/' + part : part;
				dirs.add(acc);
			}
		};
		for (const name of Object.keys(zip.files)) {
			const item = zip.files[name];
			// JSZip 自 v3.8.0 起会自己折叠 `..`（zip slip），但它是**静默**折叠的，而且
			// 折叠后两个条目可能撞成同一个名字（互相覆盖 = 少内容）。所以这里主动拒绝。
			const original = item.unsafeOriginalName || name;
			if (original.split('/').includes('..')) {
				throw new Error('内含路径穿越的条目（' + original + '），拒绝解压');
			}
			const clean = name.replace(/\/+$/, '');
			if (!clean) continue;
			if (item.dir) {
				add_dir(clean);
				continue;
			}
			// path 是解压后要写的路径，key 是它在 zip 里的键。剥掉共同顶层目录之后
			// 两者就不一样了（roundtrip/a.txt → a.txt），所以必须分开存：
			// 只存一个的话，剥过名字的条目会再也取不到内容（zip.files[path] 是 undefined）。
			files.push({ path: clean, key: name });
			add_dir(clean.split('/').slice(0, -1).join('/'));
		}
		if (files.length === 0 && dirs.size === 0) throw new Error('这个 zip 里没有任何条目');

		// download_folder_as_zip 会保留目录本身这一层，所以原样展开会让 deep.zip 变成
		// deep/deep/… —— 往返一次就多一层。当所有条目都落在唯一一个与 zip 同名的顶层目录下时
		// 跳过这一层；只在名字对得上时这么做，不做更激进的猜测（那会改变本来的结构）。
		const roots = new Set([...files.map((f) => f.path), ...dirs].map((path) => path.split('/')[0]));
		if (files.every((f) => f.path.includes('/')) && roots.size === 1 && roots.has(base_name)) {
			const strip = (path) => path.split('/').slice(1).join('/');
			files = files.map((f) => ({ path: strip(f.path), key: f.key }));
			const stripped = [];
			for (const dir of dirs) {
				const inner = strip(dir);
				if (inner) stripped.push(inner);
			}
			dirs.clear();
			for (const dir of stripped) dirs.add(dir);
		}

		// 目标不能已存在
		const existing = await fetch(target, {
			method: 'PROPFIND',
			credentials: 'include',
			signal,
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPFIND_BODY,
		});
		if (existing.ok) {
			const kind = (await existing.text()).includes('<collection />') ? '目录' : '文件';
			throw new Error('已存在同名' + kind + ' ' + base_name + '，请先删除或改名');
		}

		onProgress('正在建目录…');
		await mkcol(target, signal);
		// 按深度分批：父目录必须先于子目录。先把目录全建完再传文件，避免 PUT 的自动补建父目录
		// 与后面的 MKCOL 撞上（撞上得到的是 405）。
		const by_depth = new Map();
		for (const dir of dirs) {
			const depth = dir.split('/').length;
			if (!by_depth.has(depth)) by_depth.set(depth, []);
			by_depth.get(depth).push(dir);
		}
		for (const depth of [...by_depth.keys()].sort((a, b) => a - b)) {
			await map_concurrent(by_depth.get(depth), CONCURRENCY, (dir) => mkcol(target + encode_path(dir) + '/', signal));
		}

		try {
			let done = 0;
			let total = 0;
			await map_concurrent(files, CONCURRENCY, async (file) => {
				const content = await zip.files[file.key].async('blob');
				// 累计上限防压缩炸弹：条目标称的大小不可信，只能边解边算。并发下最多超出
				// CONCURRENCY 个条目的量，可以接受。
				total += content.size;
				if (total > ZIP_BYTE_LIMIT) {
					throw new Error('解压后已超过 ' + format_size(ZIP_BYTE_LIMIT) + '，中止（可能是压缩炸弹）');
				}
				await put_object(target + encode_path(file.path), content, signal);
				done++;
				onProgress('解压中 ' + done + '/' + files.length + '…');
			});
		} catch (err) {
			const cleaned = await delete_tree(target);
			const suffix = cleaned ? '（已清掉不完整的目录）' : '（注意：' + base_name + '/ 里可能留有内容不完整的残留）';
			if (signal && signal.aborted) throw new Error('已取消' + suffix);
			throw new Error((err && err.message ? err.message : String(err)) + suffix);
		}

		return { files: files.length, dirs: dirs.size };
	}

	window.R2Archive = {
		downloadFolderAsZip: download_folder_as_zip,
		extractZipToFolder: extract_zip_to_folder,
		ZIP_BYTE_LIMIT: ZIP_BYTE_LIMIT,
	};
})();
