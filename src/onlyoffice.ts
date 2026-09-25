/**
 * ONLYOFFICE 打开 / 保存 adapter（可选模块，可以整块下线）。
 *
 * 只做两件事：给编辑器一个**不需要凭据**的读取 URL，和一个能接收编辑结果字节的写入端点。
 * 它是 WebDAV 服务的普通客户端：构造成标准 HTTP 请求（HEAD / GET / PUT，带服务自身
 * 的 Basic 凭据）交给协议层，**绝不碰 bucket**。
 *
 * 两种模式（看有没有配 `SIGNING_SECRET`，客户端接口一样）：`url` / `saveUrl` 要么是该文件
 * 自己的 WebDAV 地址（要求编辑器页面与 WebDAV 同源），要么是短期 HMAC 短链（跨源必需）。
 * 本地 localhost 与 127.0.0.1、线上 pages.dev 与 workers.dev 都算跨源。
 *
 * 传输层由 index.ts 注入且走进程内调用：不能 `fetch()` 自己的 hostname，生产环境
 * Worker 自调用会被平台拦掉（404 + `error code 1042`），Miniflare 里看不出这个问题。
 *
 * 协议细节、启用方式与自测见 docs/onlyoffice.md。
 */

import { encode_path } from './r2';
import { hex, json_response, mint_token, verify_token } from './signing';
import type { TokenPayload } from './signing';

/** 签名模式下带 token 的路径前缀；index.ts 靠它决定哪些请求可以跳过 Basic 鉴权。 */
export const ONLYOFFICE_TOKEN_PREFIX = '/onlyoffice/doc/';
/** 读取编辑器配置的入口（和 WebDAV 一样要 Basic 鉴权）。 */
export const ONLYOFFICE_SESSION_PATH = '/onlyoffice/session';

/** 签名模式下：读 token 拉一次原始文件就够；写 token 给久点，用户可能改很久才保存。 */
const READ_TTL_SECONDS = 3600;
const WRITE_TTL_SECONDS = 86400;

/** 只允许这些类型走这个 adapter；与 office-website 的 docTypeMap / DocumentType 对齐。 */
const EXTENSION_TYPES: Record<string, { documentType: string; contentType: string }> = {
	// 文字文档
	docx: {
		documentType: 'word',
		contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	},
	doc: { documentType: 'word', contentType: 'application/msword' },
	odt: { documentType: 'word', contentType: 'application/vnd.oasis.opendocument.text' },
	rtf: { documentType: 'word', contentType: 'application/rtf' },
	// txt: { documentType: 'word', contentType: 'text/plain; charset=utf-8' },
	// 电子表格
	xlsx: { documentType: 'cell', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
	xls: { documentType: 'cell', contentType: 'application/vnd.ms-excel' },
	ods: { documentType: 'cell', contentType: 'application/vnd.oasis.opendocument.spreadsheet' },
	csv: { documentType: 'cell', contentType: 'text/csv; charset=utf-8' },
	// 演示文稿
	pptx: {
		documentType: 'slide',
		contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	},
	ppt: { documentType: 'slide', contentType: 'application/vnd.ms-powerpoint' },
	odp: { documentType: 'slide', contentType: 'application/vnd.oasis.opendocument.presentation' },
	// 绘图 / PDF
	vsdx: { documentType: 'draw', contentType: 'application/vnd.ms-visio.drawing' },
	pdf: { documentType: 'pdf', contentType: 'application/pdf' },
};

/**
 * 把「一个标准 Request」交给本服务的 WebDAV 协议层，拿回 Response；由 index.ts 注入。
 */
export type WebdavTransport = (request: Request) => Promise<Response>;

export type OnlyOfficeEnv = {
	/** Credentials of this WebDAV service, used for the adapter's own requests. */
	USERNAME: string;
	PASSWORD: string;
	/** Shared HMAC secret for signed short links. Set => signed mode, unset => direct mode. */
	SIGNING_SECRET?: string;
	/** Public base URL of this service, e.g. https://dav.example.com. Defaults to the request origin. */
	EMBED_BASE_URL?: string;
	/** Online editor page, e.g. https://editor.example.com/editor. Adds the "open in ONLYOFFICE" action. */
	ONLYOFFICE_EDITOR_URL?: string;
};

/**
 * 给文件列表页面（index.html）用的配置：在线编辑器地址 + 放行的扩展名清单。
 *
 * 返回 null 表示这个功能没开 —— 页面那边读不到配置，入口压根不出现，基础 UI 不受影响。
 * 扩展名直接取自本模块的 `EXTENSION_TYPES`：清单只有一份，前端不用再维护一遍、早晚对不上。
 */
export function onlyoffice_page_config(
	env: OnlyOfficeEnv,
	request: Request,
): { editorUrl: string; extensions: string[] } | null {
	const editorUrl = env.ONLYOFFICE_EDITOR_URL;
	if (!editorUrl) {
		return null;
	}
	let editor: URL;
	try {
		editor = new URL(editorUrl);
	} catch {
		// 地址配错了就当功能没开，别让每次打开页面都 500
		return null;
	}

	// 编辑器页面在**别的源**上时（线上基本都如此），它跨源 fetch 既带不了 Basic 凭据、也无法
	// 自定义头，只能靠签名短链读写 —— 没配 secret 的话这个入口点下去必然失败，那就不给入口。
	// 同源部署（编辑器页面和 WebDAV 同一个 host）不受此限：直连模式本身就能用。
	const same_origin = editor.origin === (env.EMBED_BASE_URL ?? new URL(request.url).origin).replace(/\/+$/, '');
	if (!same_origin && !env.SIGNING_SECRET) {
		return null;
	}

	return { editorUrl: editorUrl.replace(/\/+$/, ''), extensions: Object.keys(EXTENSION_TYPES) };
}

/**
 * 分发 /onlyoffice/* 请求；不是这些路径就返回 null，交回给页面层与 WebDAV。
 *
 * OPTIONS 也返回 null：预检交给 WebDAV 那层的 OPTIONS（它已经带上了整套 CORS 头），
 * 这里再写一遍只会跟 index.ts 里那份重复。
 */
export async function handle_onlyoffice_request(
	request: Request,
	env: OnlyOfficeEnv,
	webdav: WebdavTransport,
): Promise<Response | null> {
	const url = new URL(request.url);
	const is_session = url.pathname === ONLYOFFICE_SESSION_PATH;
	const is_token = url.pathname.startsWith(ONLYOFFICE_TOKEN_PREFIX);
	if (!is_session && !is_token) {
		return null;
	}
	if (request.method === 'OPTIONS') {
		return null;
	}

	if (is_session) {
		return request.method === 'GET'
			? await create_session(request, env, webdav)
			: json_response({ error: 'Method Not Allowed', allow: 'GET' }, 405);
	}

	// 短链只在签名模式下存在。直连模式没有这条路由 —— 返回 null 让请求落回 WebDAV，
	// 由它按「桶里没这个 key」回 404（这时请求已经过 Basic 鉴权，不会越权）。
	const secret = env.SIGNING_SECRET;
	if (!secret) {
		return null;
	}
	const token = url.pathname.slice(ONLYOFFICE_TOKEN_PREFIX.length);
	if (request.method === 'GET' || request.method === 'HEAD') {
		return await read_document(request, env, webdav, secret, token);
	}
	if (request.method === 'PUT' || request.method === 'POST') {
		return await write_document(request, env, webdav, secret, token);
	}
	return json_response({ error: 'Method Not Allowed', allow: 'GET, HEAD, PUT, POST' }, 405);
}

// ---------------------------------------------------------------------------
// 发号：/onlyoffice/session?path=/目录/文件.docx
// ---------------------------------------------------------------------------

/**
 * 读取一次「编辑会话」所需的配置：编辑器要的 key/title/documentType，以及打开与保存的 URL。
 *
 * 这个端点走 Basic 鉴权（和 WebDAV 同一组账号）—— 直连模式下返回的就是普通 WebDAV 地址，
 * 所以调用方必须是已登录的浏览器上下文。
 */
async function create_session(request: Request, env: OnlyOfficeEnv, webdav: WebdavTransport): Promise<Response> {
	const url = new URL(request.url);
	const path = normalize_path(url.searchParams.get('path'));
	if (path === null) {
		return json_response({ error: 'Missing or invalid "path" query parameter' }, 400);
	}

	const extension = extension_of(path);
	const types = EXTENSION_TYPES[extension];
	if (types === undefined) {
		return json_response(
			{
				error: `Unsupported file type: .${extension}`,
				supported: Object.keys(EXTENSION_TYPES),
			},
			415,
		);
	}

	const head = await webdav_fetch(env, request, path, { method: 'HEAD' }, webdav);
	if (head.status === 404) {
		// 打开一个不存在的文件没有意义，而且会让"保存时凭空造出新文件"变得难以解释
		return json_response({ error: `File not found: /${path}` }, 404);
	}
	if (!head.ok) {
		return json_response({ error: `Upstream error: HEAD /${path} returned ${head.status}` }, 502);
	}

	const title = path.slice(path.lastIndexOf('/') + 1);
	// 版本标识：优先 ETag；上游如果没给（非本服务实现的 WebDAV 可能会这样），退化成
	// Last-Modified + 长度 —— 关键是“内容一变它就变”，否则编辑器会一直用缓存里的旧内容。
	const etag = head.headers.get('etag');
	const size = Number(head.headers.get('content-length') ?? 0);
	const version = etag ?? `${head.headers.get('last-modified') ?? ''}:${size}`;
	const key = await version_key(path, version);
	const now = Math.floor(Date.now() / 1000);
	const base = webdav_base(env, request);
	const secret = env.SIGNING_SECRET;

	// 编辑器 document.key 的语义是"文档版本"：同一版本必须稳定（否则会重复下载），
	// 内容一变就必须变（否则编辑器会拿缓存继续用旧内容）。用 path + ETag 派生正好满足。

	// 直连：就是文件自己的 WebDAV 地址 —— 打开 = 原生 GET，保存 = 原生 PUT。
	const direct_url = `${base}/${encode_path(path)}`;
	const urls =
		secret === undefined
			? { url: direct_url, saveUrl: direct_url }
			: {
					url: `${base}${ONLYOFFICE_TOKEN_PREFIX}${await mint_token(secret, {
						path,
						mode: 'read',
						expires: now + READ_TTL_SECONDS,
						key,
						title,
					})}`,
					saveUrl: `${base}${ONLYOFFICE_TOKEN_PREFIX}${await mint_token(secret, {
						path,
						mode: 'write',
						expires: now + WRITE_TTL_SECONDS,
						key,
						title,
					})}`,
				};

	return json_response({
		// office-website 的编辑器页把这些直接塞进 DocEditor 的 config
		fileType: extension,
		documentType: types.documentType,
		title,
		key,
		url: urls.url,
		// 保存时把编辑结果 PUT 到这里（body 就是文件本身）
		saveUrl: urls.saveUrl,
		// 便于调用方展示与排查：direct = 靠同源 Basic；signed = 靠短链签名
		mode: secret === undefined ? 'direct' : 'signed',
		path: `/${path}`,
		size,
		etag,
		...(secret === undefined ? {} : { readExpiresAt: now + READ_TTL_SECONDS, writeExpiresAt: now + WRITE_TTL_SECONDS }),
	});
}

// ---------------------------------------------------------------------------
// 打开：GET /onlyoffice/doc/<read-token>
// ---------------------------------------------------------------------------

async function read_document(
	request: Request,
	env: OnlyOfficeEnv,
	webdav: WebdavTransport,
	secret: string,
	token: string,
): Promise<Response> {
	const payload = await verify_token(secret, token, 'read');
	if (payload === null) {
		return json_response({ error: 'Invalid or expired read token' }, 403);
	}

	const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
	const upstream = await webdav_fetch(env, request, payload.path, { method }, webdav);
	if (upstream.status === 404) {
		return json_response({ error: `File not found: /${payload.path}` }, 404);
	}
	if (!upstream.ok) {
		return json_response({ error: `Upstream error: ${method} /${payload.path} returned ${upstream.status}` }, 502);
	}

	const headers = document_headers(payload, upstream.headers.get('etag'));
	const length = upstream.headers.get('content-length');
	if (length !== null) {
		headers['Content-Length'] = length;
	}
	return new Response(method === 'HEAD' ? null : upstream.body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// 保存：PUT /onlyoffice/doc/<write-token>（body 是文件本身）
// ---------------------------------------------------------------------------

/**
 * 把编辑结果写回 token 里记录的那个路径。
 *
 * 刻意不做的事：
 *   - **不**用请求里任何东西决定写哪儿（路径只来自 token）；
 *   - 不做并发冲突检测（不带 If-Match）—— 单用户场景下最后写入者胜就够了，
 *     真要检测应该是独立的一轮功能，而不是塞进这个薄 adapter。
 */
async function write_document(
	request: Request,
	env: OnlyOfficeEnv,
	webdav: WebdavTransport,
	secret: string,
	token: string,
): Promise<Response> {
	const payload = await verify_token(secret, token, 'write');
	if (payload === null) {
		return json_response({ error: 'Invalid or expired write token' }, 403);
	}

	// 空体保护：编辑器或宿主页面出问题时，最坏的结果是"把文档清成 0 字节"。
	// 保存本来就是覆盖写，宁可拒绝也不能毁掉用户的文件。
	const declared = request.headers.get('Content-Length');
	if (declared !== null && Number(declared) === 0) {
		return json_response({ error: 'Refusing to write an empty body' }, 400);
	}
	if (request.body === null) {
		return json_response({ error: 'Missing request body' }, 400);
	}

	const contentType = EXTENSION_TYPES[extension_of(payload.path)]?.contentType ?? 'application/octet-stream';
	// 走标准 WebDAV PUT：body 直接流式转发，不落内存，也不自己写存储
	const upstream = await webdav_fetch(
		env,
		request,
		payload.path,
		{
			method: 'PUT',
			body: request.body,
			headers: { 'Content-Type': contentType },
		},
		webdav,
	);
	if (!upstream.ok) {
		return json_response({ error: `Upstream error: PUT /${payload.path} returned ${upstream.status}` }, 502);
	}

	// 再探一次元数据，把新的 etag / key 回给宿主页面（内容变了，key 就该变）
	const head = await webdav_fetch(env, request, payload.path, { method: 'HEAD' }, webdav);
	const etag = head.headers.get('etag');
	return json_response({
		ok: true,
		path: `/${payload.path}`,
		status: upstream.status,
		size: Number(head.headers.get('content-length') ?? 0),
		etag,
		key: etag === null ? null : await version_key(payload.path, etag),
	});
}

// ---------------------------------------------------------------------------
// 以 WebDAV 客户端身份访问文件（唯一的读写通道）
// ---------------------------------------------------------------------------

/** 对外基址：默认就是本次请求的 origin，也就是这个 WebDAV 服务自己。 */
function webdav_base(env: OnlyOfficeEnv, request: Request): string {
	return (env.EMBED_BASE_URL ?? new URL(request.url).origin).replace(/\/+$/, '');
}

/**
 * 向 WebDAV 服务发一个**标准 HTTP 请求**（带服务自身的 Basic 凭据），由注入的传输层执行。
 *
 * 这是本模块唯一的读写通道：不碰 bucket、不绕过 WebDAV 层 —— 父目录补建、影子文件过滤、
 * PUT 前置条件这些规则因此和其它客户端走的是同一条路径。
 */
function webdav_fetch(
	env: OnlyOfficeEnv,
	request: Request,
	path: string,
	init: RequestInit,
	webdav: WebdavTransport,
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Authorization', `Basic ${btoa(`${env.USERNAME}:${env.PASSWORD}`)}`);
	return webdav(new Request(`${webdav_base(env, request)}/${encode_path(path)}`, { ...init, headers }));
}

// ---------------------------------------------------------------------------
// token 与路径工具
// ---------------------------------------------------------------------------

/** 同一个 key 的版本标识：内容一变它就变，编辑器据此决定要不要重新下载。 */
async function version_key(path: string, etag: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${path}:${etag}`));
	return hex(new Uint8Array(digest)).slice(0, 40);
}

/**
 * 规范化用户传来的 path：去掉前导斜杠、拒绝目录与 `..`。
 *
 * 注意 URLSearchParams 已经把百分号编码解开了，这里拿到的是真实文件名（与 R2 key 一致）。
 */
function normalize_path(input: string | null): string | null {
	if (input === null) return null;
	const path = input.trim().replace(/^\/+/, '');
	if (path === '' || path.endsWith('/')) return null;
	if (path.split('/').includes('..')) return null;
	if (path.length > 900) return null;
	return path;
}

function extension_of(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * 文档响应的头。
 *
 * 必须返回**普通对象**：`{ ...new Headers(...) }` 得到的是空对象（Headers 的条目在内部
 * 迭代器里，不是自有可枚举属性），会把 Content-Type / ETag 全部丢掉。
 */
function document_headers(payload: TokenPayload, etag: string | null): Record<string, string> {
	const extension = extension_of(payload.path);
	return {
		'Content-Type': EXTENSION_TYPES[extension]?.contentType ?? 'application/octet-stream',
		...(etag === null ? {} : { ETag: etag }),
		// 文件名用 RFC 5987 形式，中文名不会变成乱码
		'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(payload.title)}`,
		// 短链 + 签名，不该进任何缓存
		'Cache-Control': 'no-store',
	};
}
