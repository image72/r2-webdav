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
// 外部编辑器（draw.io / Photopea）顶层直开：注册表 + Photopea 签名会话/保存端点。
import {
	EDITORS_READ_PREFIX,
	EDITORS_SAVE_PREFIX,
	create_photopea_session,
	editors_page_config,
	verify_save_token,
} from './editors';
import { base64_to_bytes, encode_path, json_response } from './utils';

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
	// External editor pages (embed-only, zero source modification). Both optional.
	DRAWIO_EDITOR_URL?: string;
	PHOTOPEA_EDITOR_URL?: string;
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

/**
 * 外部编辑器（Photopea）的服务端路由。
 *
 * - GET  /editors/session?path=…：签发读/写短链 + PP hash 启动 JSON（Basic 鉴权）。
 * - POST /editors/save/<write-token>：PP 保存端点（k0.aFs 的 POST 目标）。
 *   version 0 格式：body 是 application/x-www-form-urlencoded，`p` 字段是
 *   encodeURIComponent(JSON{source, versions:[{format, data:base64}]})。
 *   解出第一个 version 的字节原样 PUT 回 token 里的路径。
 *
 * 保存响应的 {newSource} 会被 PP 回写进文件 source（k0.aA0 源码），返回新 etag。
 */
async function handle_editors_request(request: Request, env: Env, webdav: WebdavTransport): Promise<Response | null> {
	const url = new URL(request.url);
	const pathname = url.pathname;

	if (pathname === '/editors/session' && request.method === 'GET') {
		return await create_photopea_session(request, env, webdav);
	}

	if (pathname.startsWith(EDITORS_SAVE_PREFIX)) {
		if (request.method !== 'POST' && request.method !== 'PUT') {
			return json_response({ error: 'Method Not Allowed', allow: 'POST, PUT' }, 405);
		}
		const secret = env.SIGNING_SECRET;
		if (!secret) return json_response({ error: 'Not configured' }, 501);
		const payload = await verify_save_token(secret, pathname.slice(EDITORS_SAVE_PREFIX.length));
		if (payload === null) return json_response({ error: 'Invalid or expired token' }, 403);

		const contentType = request.headers.get('Content-Type') ?? '';
		const body = await request.text();
		let bytes: Uint8Array;
		if (contentType.includes('application/x-www-form-urlencoded')) {
			// version 0：p=<encodeURIComponent(JSON)>，versions[].data 是 base64
			const params = new URLSearchParams(body);
			const encoded = params.get('p');
			if (encoded === null) return json_response({ error: 'Missing "p" field' }, 400);
			let parsed: { versions?: Array<{ data?: string }> };
			try {
				parsed = JSON.parse(decodeURIComponent(encoded));
			} catch {
				return json_response({ error: 'Malformed payload' }, 400);
			}
			const data = parsed.versions && parsed.versions[0] && parsed.versions[0].data;
			if (typeof data !== 'string') return json_response({ error: 'Missing versions[0].data' }, 400);
			const decoded = base64_to_bytes(data);
			if (decoded === null) return json_response({ error: 'Malformed payload (bad base64)' }, 400);
			bytes = decoded;
		} else {
			// 兼容直发二进制（未来 PP 版本或自测用）
			bytes = new Uint8Array(await request.arrayBuffer());
		}
		if (bytes.byteLength === 0) return json_response({ error: 'Refusing to write an empty body' }, 400);

		const ext = payload.path.slice(payload.path.lastIndexOf('.') + 1).toLowerCase();
		const type = photopea_content_type(ext);
		const put = await webdav(
			new Request(`${new URL(request.url).origin}/${encode_path(payload.path)}`, {
				method: 'PUT',
				headers: { 'Content-Type': type },
				body: bytes,
			}),
		);
		if (!put.ok) {
			return json_response({ error: `Upstream PUT failed (${put.status})` }, 502);
		}
		const head = await webdav(
			new Request(`${new URL(request.url).origin}/${encode_path(payload.path)}`, { method: 'HEAD' }),
		);
		return json_response({
			ok: true,
			newSource: payload.path,
			etag: head.ok ? head.headers.get('etag') : null,
			...(head.ok ? {} : { warning: `HEAD failed (${head.status})` }),
		});
	}

	if (pathname.startsWith(EDITORS_READ_PREFIX)) {
		// PP 自己拉文件：把签名 token 换回真实路径，走内部 transport（已豁免 Basic）。
		const secret = env.SIGNING_SECRET;
		if (!secret) return json_response({ error: 'Not configured' }, 501);
		const payload = await verify_save_token(secret, pathname.slice(EDITORS_READ_PREFIX.length), 'read');
		if (payload === null) return json_response({ error: 'Invalid or expired token' }, 403);
		if (payload.mode !== 'read') return json_response({ error: 'Token is not a read token' }, 403);
		const head = await webdav(
			new Request(`${new URL(request.url).origin}/${encode_path(payload.path)}`, { method: 'HEAD' }),
		);
		if (head.status === 404) return json_response({ error: 'Not found' }, 404);
		const type =
			head.headers.get('content-type') ??
			photopea_content_type(payload.path.slice(payload.path.lastIndexOf('.') + 1).toLowerCase());
		const get = await webdav(
			new Request(`${new URL(request.url).origin}/${encode_path(payload.path)}`, { method: 'GET' }),
		);
		const headers = new Headers(get.headers);
		headers.set('Cache-Control', 'no-store');
		headers.set('Access-Control-Allow-Origin', '*');
		if (!headers.has('Content-Type')) headers.set('Content-Type', type);
		return new Response(get.body, { status: get.status, headers });
	}

	return null;
}

function photopea_content_type(ext: string): string {
	const map: Record<string, string> = {
		psd: 'image/vnd.adobe.photoshop',
		psb: 'image/vnd.adobe.photoshop',
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		webp: 'image/webp',
		gif: 'image/gif',
		bmp: 'image/bmp',
		tif: 'image/tiff',
		tiff: 'image/tiff',
		svg: 'image/svg+xml',
	};
	return map[ext] ?? 'application/octet-stream';
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { bucket } = env;

		// 签名模式（配了 SIGNING_SECRET）下跳过 Basic：调用方是浏览器里的在线服务，
		// 跨源带不了凭据，由 URL 里的 HMAC token 负责校验。直连模式没有这条路由。
		const pathname = new URL(request.url).pathname;
		const is_onlyoffice_token_request = Boolean(env.SIGNING_SECRET) && pathname.startsWith(ONLYOFFICE_TOKEN_PREFIX);
		// Photopea 保存端点：PP 弹窗发起 POST，带不了 Basic —— 靠 URL 里的写 token 鉴权。
		const is_editors_save_request =
			Boolean(env.SIGNING_SECRET) &&
			(pathname.startsWith(EDITORS_SAVE_PREFIX) || pathname.startsWith(EDITORS_READ_PREFIX));
		if (
			request.method !== 'OPTIONS' &&
			!is_onlyoffice_token_request &&
			!is_editors_save_request &&
			!is_authorized(request.headers.get('Authorization') ?? '', env.USERNAME, env.PASSWORD)
		) {
			return new Response('Unauthorized', {
				status: 401,
				headers: {
					'WWW-Authenticate': 'Basic realm="webdav"',
				},
			});
		}

		// 代码路由要先拦：这些路径在 R2 里没有同名对象，直接进 dispatch_handler 会 404。
		//
		// adapter 的读写走下面这个注入的「WebDAV 协议层」函数，**进程内调用**：
		// 不能让它 fetch 自己的 hostname，生产环境 Worker 自调用会被平台拦掉（404 + 1042）。
		const webdav_transport: WebdavTransport = (req) => dispatch_handler(req, bucket);

		// 外部编辑器（Photopea）的两条服务端路由：会话签发（Basic 鉴权）与保存（写 token 鉴权）。
		const editors_response = await handle_editors_request(request, env, webdav_transport);
		let response: Response =
			editors_response ??
			(await handle_onlyoffice_request(request, env, webdav_transport)) ??
			handle_asset_request(request) ??
			(await dispatch_handler(request, bucket));

		// 页面里的「用 ONLYOFFICE 打开」入口需要编辑器地址与放行的扩展名；
		// adapter 没开就返回 null，不注入任何东西。
		const page_config = onlyoffice_page_config(env, request);
		const editors = editors_page_config(env);
		if (
			(page_config !== null || editors !== null) &&
			(response.headers.get('Content-Type') ?? '').startsWith('text/html')
		) {
			response = inject_page_config(response, {
				...(page_config !== null ? { onlyoffice: page_config } : {}),
				...(editors !== null ? { editors } : {}),
			});
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
