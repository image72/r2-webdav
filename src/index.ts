/**
 * Worker 入口：鉴权、CORS 与请求分发。
 *
 * - WebDAV protocol simple implement（PROPFIND/PUT/COPY/…）：webdav.ts
 */

import { SUPPORT_METHODS, dispatch_handler } from './webdav';
import { handle_asset_request } from './ui';
// ONLYOFFICE 适配层（可选，整块可下线）：搜 ONLYOFFICE 就能找到全部接线点。
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
 * 用 HTMLRewriter 而不是字符串替换：页面是流式下发的，也不会误伤正文里恰好出现的 `</head>`。
 */
function inject_page_config(response: Response, config: unknown): Response {
	// `<` 要转义，否则内容里出现 `</script>` 会提前结束脚本块
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

		// 签名模式（配了 SIGNING_SECRET）下跳过 Basic：调用方是浏览器里的在线服务，
		// 跨源带不了凭据，由 URL 里的 HMAC token 负责校验。直连模式没有这条路由。
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

		// 代码路由要先拦：这两个路径在 R2 里没有同名对象，直接进 dispatch_handler 会 404。
		//
		// adapter 的读写走下面这个注入的「WebDAV 协议层」函数，**进程内调用**：
		// 不能让它 fetch 自己的 hostname，生产环境 Worker 自调用会被平台拦掉（404 + 1042）。
		const webdav_transport: WebdavTransport = (req) => dispatch_handler(req, bucket);
		let response: Response =
			(await handle_onlyoffice_request(request, env, webdav_transport)) ??
			handle_asset_request(request) ??
			(await dispatch_handler(request, bucket));

		// 页面里的「用 ONLYOFFICE 打开」入口需要编辑器地址与放行的扩展名；
		// adapter 没开就返回 null，不注入任何东西。
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
