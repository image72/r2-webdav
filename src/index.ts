/**
 * Worker 入口：鉴权、CORS 与请求分发。
 *
 * - WebDAV protocol simple implement（PROPFIND/PUT/COPY/…）：webdav.ts
 */

import { SUPPORT_METHODS, dispatch_handler } from './webdav';
import { handle_asset_request } from './ui';
// ONLYOFFICE 适配层（可选，整块可下线）。搜 ONLYOFFICE 就能找到全部接线点：
// 这里的 import、Env 里那两个字段、以及下面鉴权旁路与分发各一处。
import { ONLYOFFICE_TOKEN_PREFIX, handle_onlyoffice_request, onlyoffice_page_config } from './onlyoffice';
import type { WebdavTransport } from './onlyoffice';

export interface Env {
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;

	// Variables defined in the "Environment Variables" section of the Wrangler CLI or dashboard
	USERNAME: string;
	PASSWORD: string;

	// Shared HMAC secret for signed short links (ONLYOFFICE, drawio, …). Omit to disable.
	SIGNING_SECRET?: string;
	// Public base URL of this service, e.g. https://dav.example.com. Defaults to the request origin.
	EMBED_BASE_URL?: string;
}

function is_authorized(authorization_header: string, username: string, password: string): boolean {
	const encoder = new TextEncoder();

	const header = encoder.encode(authorization_header);
	const expected = encoder.encode(`Basic ${btoa(`${username}:${password}`)}`);

	return header.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(header, expected);
}

/**
 * 把页面配置塞进 HTML 的 `</head>` 前。
 *
 * 用 HTMLRewriter 而不是字符串替换：页面是**流式**下发的（不必先把 HTML 读进内存），也不会
 * 误伤正文里恰好出现的 `</head>`。ui.ts / webdav.ts 都不需要知道 ONLYOFFICE 存在 ——
 * 这只是 index.ts 这一层的接线。
 */
function inject_page_config(response: Response, config: unknown): Response {
	// `<` 要转义：配置里万一出现 `</script>` 会提前结束脚本块
	const json = JSON.stringify(config).replace(/</g, '\\u003c');
	return new HTMLRewriter()
		.on('head', {
			element(element) {
				element.append(`<script>window.__APP_CONFIG__=${json};</script>`, { html: true });
			},
		})
		.transform(response);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { bucket } = env;

		// 只在**签名模式**（配了 SIGNING_SECRET）下才跳过 Basic：那边的调用方是浏览器里的
		// 在线服务（裸 fetch 取文件、PUT 保存），跨源时它带不了 Basic 凭据，由 URL 里的
		// HMAC token 负责校验。直连模式没有这条路由，绝不能开这个口子（否则未鉴权的请求
		// 会直接落到 WebDAV 的 GET/PUT 上）。
		const is_onlyoffice_token_request =
			env.SIGNING_SECRET !== undefined && new URL(request.url).pathname.startsWith(ONLYOFFICE_TOKEN_PREFIX);
		if (
			request.method !== 'OPTIONS' &&
			!is_onlyoffice_token_request &&
			!is_authorized(request.headers.get('Authorization') ?? '', env.USERNAME, env.PASSWORD)
		) {
			return new Response('Unauthorized', {
				status: 401,
				headers: {
					'WWW-Authenticate': 'Basic realm="webdav"',
				},
			});
		}

		// ONLYOFFICE adapter 先拦（它的两个路径也是「代码路由」，R2 里并没有同名对象）；
		// 其次是页面用的静态资源：无尾斜杠的 GET 在 WebDAV 语义里是「取一个对象」，
		// 直接进 dispatch_handler 会去 R2 里找同名对象然后 404。
		//
		// adapter 要读写文件时，它自己构造 Request、交给下面这个「WebDAV 协议层」函数 ——
		// **进程内调用，不是网络请求**。绝不能让它去 fetch 自己的 hostname：生产环境 Worker
		// 自调用会被平台拦掉（实测 404 + `error code 1042`），而 Miniflare 里看不出这个问题）。
		const webdav_transport: WebdavTransport = (req) => dispatch_handler(req, bucket);
		let response: Response =
			(await handle_onlyoffice_request(request, env, webdav_transport)) ??
			handle_asset_request(request) ??
			(await dispatch_handler(request, bucket));

		// 文件列表页里的「用 ONLYOFFICE 打开」入口需要知道在线编辑器地址与放行的扩展名，
		// 由 adapter 给（未配就是 null＝功能关着）。
		//
		// 这里用 HTMLRewriter 挂在响应上，而不是让 ui.ts / webdav.ts 去拼 HTML：那两个文件
		// 不需要知道 ONLYOFFICE 存在（页面是流式下发的，这样也不用把 HTML 读进内存）。
		// 下线时把这几行连同上面两处接线一起删掉，页面读不到配置，入口自然消失。
		const page_config = onlyoffice_page_config(env, request);
		if (page_config !== null && (response.headers.get('Content-Type') ?? '').startsWith('text/html')) {
			response = inject_page_config(response, { onlyoffice: page_config });
		}

		// Set CORS headers
		response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
		response.headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
		response.headers.set(
			'Access-Control-Allow-Headers',
			[
				'authorization',
				'content-type',
				'depth',
				'overwrite',
				'destination',
				'range',
				'lock-token',
				'timeout',
				'if',
				'if-match',
				'if-none-match',
			].join(', '),
		);
		response.headers.set(
			'Access-Control-Expose-Headers',
			['content-type', 'content-length', 'dav', 'etag', 'last-modified', 'location', 'date', 'content-range'].join(
				', ',
			),
		);
		response.headers.set('Access-Control-Allow-Credentials', 'false');
		response.headers.set('Access-Control-Max-Age', '86400');
		response.headers.set('MS-Author-Via', 'DAV');

		return response;
	},
};
