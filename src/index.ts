/**
 * Worker 入口：鉴权、CORS 与请求分发。
 *
 * - WebDAV 协议实现（PROPFIND/PUT/COPY/…）：webdav.ts
 * - 浏览器页面（列表/上传/预览）：ui.ts
 * - R2 访问工具：r2.ts
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { SUPPORT_METHODS, dispatch_handler } from './webdav';
import { handle_asset_request } from './ui';
// ONLYOFFICE 适配层（可选，整块可下线）。搜 ONLYOFFICE 就能找到全部接线点：
// 这里的 import、Env 里那两个字段、以及下面鉴权旁路与分发各一处。
import { ONLYOFFICE_TOKEN_PREFIX, handle_onlyoffice_request } from './onlyoffice';
import type { WebdavTransport } from './onlyoffice';

export interface Env {
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;

	// Variables defined in the "Environment Variables" section of the Wrangler CLI or dashboard
	USERNAME: string;
	PASSWORD: string;

	// 浏览器在线服务（ONLYOFFICE、drawio、Photopea…）**共用**的签名密钥：配了它就启用
	// `/embed/*` 这类「无凭据短链」路由；不配则所有服务都退回直连模式（要求同源）。
	SIGNING_SECRET?: string;
	// 对外暴露的基址（服务与 Worker 不同源、或前面挂了反代时用），例如 https://dav.example.com
	EMBED_BASE_URL?: string;
}

function is_authorized(authorization_header: string, username: string, password: string): boolean {
	const encoder = new TextEncoder();

	const header = encoder.encode(authorization_header);
	const expected = encoder.encode(`Basic ${btoa(`${username}:${password}`)}`);

	return header.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(header, expected);
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
