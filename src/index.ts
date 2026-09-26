/**
 * Worker 入口：鉴权、CORS 与请求分发。本文件只做编排，不含任何具体业务 ——
 *
 *   WebDAV 协议（PROPFIND/PUT/COPY/…）        webdav.ts
 *   页面与代码路由、目录数据                    ui.ts
 *   在线编辑器（ONLYOFFICE/draw.io/Photopea）  editors.ts —— 三者的 path 与 handler 全在该模块
 *   短链签名原语                              signing.ts
 *   纯工具 + 结构化日志                        utils.ts
 */

import { SUPPORT_METHODS, dispatch_handler } from './webdav';
import { handle_asset_request } from './ui';
import { log_info, log_warn, token_hint } from './utils';
import { handle_editors_request, is_token_request, page_config } from './editors';
import type { EditorsEnv, WebdavTransport } from './editors';

export interface Env extends EditorsEnv {
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;

	// Variables defined in the "Environment Variables" section of the Wrangler CLI or dashboard
	USERNAME: string;
	PASSWORD: string;
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
		const started = Date.now();

		// 签名模式（配了 SIGNING_SECRET）下跳过 Basic：调用方是浏览器里的在线服务，
		// 跨源带不了凭据，由 URL 里的 HMAC token 负责校验。直连模式没有这些路由。
		// 哪些路径算 token 路由，只有 editors.ts 知道 —— 入口不做路径白名单。
		const pathname = new URL(request.url).pathname;
		const token_request = is_token_request(pathname, env);
		if (
			request.method !== 'OPTIONS' &&
			!token_request &&
			!is_authorized(request.headers.get('Authorization') ?? '', env.USERNAME, env.PASSWORD)
		) {
			// 打点：未授权（含完全没带凭据的探测流量）。凭据本身绝不落日志。
			log_warn('401 unauthorized', { method: request.method, path: pathname });
			return new Response('Unauthorized', {
				status: 401,
				headers: {
					'WWW-Authenticate': 'Basic realm="webdav"',
				},
			});
		}

		// adapter 的读写走下面这个注入的「WebDAV 协议层」函数，**进程内调用**：
		// 不能让它 fetch 自己的 hostname，生产环境 Worker 自调用会被平台拦掉（404 + 1042）。
		const webdav_transport: WebdavTransport = (req) => dispatch_handler(req, bucket);

		// 在线编辑器（/onlyoffice/*、/editors/*）不认识就返回 null，逐层落下去。
		let response: Response =
			(await handle_editors_request(request, env, webdav_transport)) ??
			handle_asset_request(request) ??
			(await dispatch_handler(request, bucket));

		// 页面里的「在线编辑」入口需要编辑器地址与放行的扩展名；配置的拼装在 editors.ts，
		// 都没开就返回 null，不注入任何东西。
		const config = page_config(env, request);
		if (config !== null && (response.headers.get('Content-Type') ?? '').startsWith('text/html')) {
			response = inject_page_config(response, config);
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

		// 打点：每条请求一行 access log。token 型请求只带前 12 位，凭据永不落日志。
		log_info('req', {
			method: request.method,
			path: pathname,
			status: response.status,
			ms: Date.now() - started,
			...(token_request ? { tok: token_hint(pathname.slice(pathname.lastIndexOf('/') + 1)) } : {}),
		});

		return response;
	},
};
