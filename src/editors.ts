/**
 * 在线编辑器整合层（可选模块，整块可下线）：ONLYOFFICE + draw.io + Photopea。
 *
 * 三个外部编辑器、两种官方接入机制（都已在实例源码里逐行验证过）：
 *
 *   ONLYOFFICE（office-website，编辑器与 x2t 都在浏览器里跑，不需要 Document Server）
 *     列表页请求 /onlyoffice/session 拿到编辑器 config（url / saveUrl / key / type），
 *     window.open 进编辑器页。url 与 saveUrl 要么是该文件自己的 WebDAV 地址（要求
 *     编辑器页面与 WebDAV 同源），要么是短期 HMAC 短链（跨源必需）。
 *
 *   draw.io（embed JSON 协议）
 *     列表页 window.open(编辑器?embed=1&proto=json&...)，弹窗向 opener 发
 *     {event:'init'}；列表页回 {action:'load',xml,autosave:1}；用户改动后弹窗
 *     自动发 {event:'autosave',xml}（installMessageHandler 源码）。
 *     postMessage 走 opener —— 跨源可用，文件内容不经编辑器页的存储。
 *
 *   Photopea（官方 hash 启动配置，aqY 源码 z=='p' 分支）
 *     https://pp实例/#<encodeURIComponent(JSON)>，JSON 形如
 *       { files:[读URL], server:{url:写URL, formats:[...]}, environment:{...} }
 *     PP 自己 GET files[0] 拉文件；用户保存（或 autosave 定时器）时 PP 自己
 *     POST 到 server.url —— 全程零 postMessage、零 wrapper。
 *
 * 所有跨源读写都靠 HMAC 签名短链（signing.ts），编辑器拿不到 Basic 凭据，
 * 也改不了 token 里的路径。对 index.ts 的接口只有三个成员（路径白名单、HTTP handler、
 * 页面配置），/onlyoffice/*、/editors/* 的全部路由细节都留在本文件里：
 *
 *   /onlyoffice/session          GET                 签发 OO 编辑会话（Basic 鉴权）
 *   /onlyoffice/doc/<token>      GET/HEAD/PUT/POST   OO 读 / 写（token 鉴权）
 *   /editors/session             GET                 签发 Photopea 会话（Basic 鉴权）
 *   /editors/save/<write-token>  POST/PUT            PP 保存端点（token 鉴权）
 *   /editors/read/<read-token>   GET/HEAD            PP 拉文件（token 鉴权）
 *
 * 下线方式：删本文件 + editors.client.js + index.ts / ui.ts / index.html 里的对应接线 +
 * wrangler.toml 的编辑器 URL 变量。
 */

import {
	base_url,
	base64_to_bytes,
	encode_path,
	extension_of,
	json_response,
	log_error,
	log_info,
	log_warn,
	normalize_path,
	token_hint,
} from './utils';
import { hex, mint_token, verify_token } from './signing';
import type { TokenPayload } from './signing';

// ---------------------------------------------------------------------------
// 环境与注册表
// ---------------------------------------------------------------------------

/**
 * 把「一个标准 Request」交给本服务的 WebDAV 协议层，拿回 Response；由 index.ts 注入。
 *
 * adapter 的读写走这个进程内函数：不能 fetch 自己的 hostname，生产环境 Worker
 * 自调用会被平台拦掉（404 + error code 1042），Miniflare 里看不出这个问题。
 */
export type WebdavTransport = (request: Request) => Promise<Response>;

export type EditorsEnv = {
	/** 本服务凭据（ONLYOFFICE adapter 以 WebDAV 客户端身份读写文件时用）。 */
	USERNAME?: string;
	PASSWORD?: string;
	/** Shared HMAC secret for signed short links. Set => signed mode, unset => direct mode. */
	SIGNING_SECRET?: string;
	/** Public base URL of this service, e.g. https://dav.example.com. Defaults to the request origin. */
	EMBED_BASE_URL?: string;
	/** Online editor page, e.g. https://editor.example.com/editor. Adds the "open in ONLYOFFICE" action. */
	ONLYOFFICE_EDITOR_URL?: string;
	/** External editor pages (embed-only, zero source modification). Both optional. */
	DRAWIO_EDITOR_URL?: string;
	PHOTOPEA_EDITOR_URL?: string;
};

export type EditorDef = {
	/** 稳定 id，客户端按它分派（drawio / photopea）。 */
	id: string;
	/** 显示名（UI 按钮文案用）。 */
	name: string;
	/** 编辑器页面基址。 */
	url: string;
	/** 允许打开的扩展名（全小写）。 */
	extensions: string[];
};

/**
 * 白名单只收**能原样保存回去**的格式：
 * - draw.io：.drawio 原生 + drawio XML（.xml）。vsdx/gliffy 只进不出（保存会变 XML），
 *   放进来等于让用户一键毁掉原格式，不放。
 * - Photopea：PSD/PSB 原生 + 有对应导出格式的位图/矢量。sketch/xd/fig/ai 这类
 *   「只读打开」的同样不放。
 */
const REGISTRY: Array<Omit<EditorDef, 'url'>> = [
	{ id: 'drawio', name: 'draw.io', extensions: ['drawio', 'xml'] },
	{
		id: 'photopea',
		name: 'Photopea',
		extensions: ['psd', 'psb', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'svg'],
	},
];

/** Photopea server.formats：PP 保存时按原扩展名导出（psb 存 psb，tif/tiff 归一 tiff）。 */
function photopea_formats(name: string): string[] {
	const ext = extension_of(name);
	if (ext === 'psb') return ['psb'];
	if (ext === 'tif' || ext === 'tiff') return ['tiff'];
	return ext ? [ext] : ['psd'];
}

/** Photopea 保存文件的 Content-Type（按扩展名映射）。 */
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

/**
 * 页面配置：配了哪些编辑器就给哪些，没配返回 null（页面入口不出现）。
 * 地址解析失败视同没配，别让一个坏 URL 把页面搞挂。
 */
export function editors_page_config(env: EditorsEnv): EditorDef[] | null {
	const defs: EditorDef[] = [];
	for (const entry of REGISTRY) {
		const raw = entry.id === 'drawio' ? env.DRAWIO_EDITOR_URL : env.PHOTOPEA_EDITOR_URL;
		if (!raw) continue;
		try {
			new URL(raw);
		} catch {
			continue;
		}
		defs.push({ ...entry, url: raw.replace(/\/+$/, '') + '/' });
	}
	return defs.length === 0 ? null : defs;
}

// ---------------------------------------------------------------------------
// 路由前缀与 TTL（模块私有：index.ts 不需要知道路径长什么样，白名单走 is_token_request）
// ---------------------------------------------------------------------------

const ONLYOFFICE_TOKEN_PREFIX = '/onlyoffice/doc/';
const ONLYOFFICE_SESSION_PATH = '/onlyoffice/session';
const EDITORS_SAVE_PREFIX = '/editors/save/';
const EDITORS_READ_PREFIX = '/editors/read/';

/** 签名模式下：读 token 拉一次原始文件就够；写 token 给久点，用户可能改很久才保存。 */
const READ_TTL_SECONDS = 3600;
/** OO 写 token 1 天；PP 弹窗可能开很久才保存，写 token 给 7 天。 */
const OO_WRITE_TTL_SECONDS = 86400;
const PP_WRITE_TTL_SECONDS = 86400 * 7;

// ---------------------------------------------------------------------------
// ONLYOFFICE：扩展名 → 文档类型（与 office-website 的 docTypeMap / DocumentType 对齐）
// ---------------------------------------------------------------------------

/** 只允许这些类型走这个 adapter。 */
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

// ===========================================================================
// ONLYOFFICE
// ===========================================================================

/**
 * 给文件列表页面（index.html）用的配置：在线编辑器地址 + 放行的扩展名清单。
 *
 * 返回 null 表示这个功能没开 —— 页面那边读不到配置，入口压根不出现，基础 UI 不受影响。
 * 扩展名直接取自本模块的 `EXTENSION_TYPES`：清单只有一份，前端不用再维护一遍、早晚对不上。
 */
export function onlyoffice_page_config(
	env: EditorsEnv,
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
 * 对 index.ts 的接口之二：哪些路径带签名 token（Basic 鉴权豁免名单）。
 *
 * 只在配了 SIGNING_SECRET 时才有 token 型路径 —— 谓词与路径清单都收在这里，
 * 入口不再出现任何前缀常量。
 */
export function is_token_request(pathname: string, env: EditorsEnv): boolean {
	if (!env.SIGNING_SECRET) return false;
	return (
		pathname.startsWith(ONLYOFFICE_TOKEN_PREFIX) ||
		pathname.startsWith(EDITORS_SAVE_PREFIX) ||
		pathname.startsWith(EDITORS_READ_PREFIX)
	);
}

/**
 * 对 index.ts 的接口之三：整个页面的注入配置（ONLYOFFICE + draw.io/Photopea 一并拼好）。
 * 两边都没开就返回 null，页面不注入任何东西。
 */
export function page_config(env: EditorsEnv, request: Request): Record<string, unknown> | null {
	const onlyoffice = onlyoffice_page_config(env, request);
	const editors = editors_page_config(env);
	if (onlyoffice === null && editors === null) return null;
	return {
		...(onlyoffice !== null ? { onlyoffice } : {}),
		...(editors !== null ? { editors } : {}),
	};
}

/**
 * 对 index.ts 的接口之一：整个在线编辑器层的 HTTP 入口。/onlyoffice/* 与 /editors/*
 * 的全部路由都在这里；不认识的路径返回 null，交回给页面层与 WebDAV。
 */
export async function handle_editors_request(
	request: Request,
	env: EditorsEnv,
	webdav: WebdavTransport,
): Promise<Response | null> {
	return (await handle_onlyoffice_request(request, env, webdav)) ?? (await handle_pp_request(request, env, webdav));
}

/**
 * 分发 /onlyoffice/* 请求。
 *
 * OPTIONS 返回 null：预检交给 WebDAV 那层的 OPTIONS（它已经带上了整套 CORS 头），
 * 这里再写一遍只会跟 index.ts 里那份重复。
 */
async function handle_onlyoffice_request(
	request: Request,
	env: EditorsEnv,
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
			? await onlyoffice_create_session(request, env, webdav)
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
		return await onlyoffice_read_document(request, env, webdav, secret, token);
	}
	if (request.method === 'PUT' || request.method === 'POST') {
		return await onlyoffice_write_document(request, env, webdav, secret, token);
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
async function onlyoffice_create_session(
	request: Request,
	env: EditorsEnv,
	webdav: WebdavTransport,
): Promise<Response> {
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
						expires: now + OO_WRITE_TTL_SECONDS,
						key,
						title,
					})}`,
				};

	// 打点：签发了哪个文件的读写短链（token 只露前 12 位）。
	log_info(secret === undefined ? 'oo.session direct' : 'oo.session signed', {
		path: `/${path}`,
		key,
		...(secret === undefined
			? {}
			: {
					read_tok: token_hint(urls.url.slice(urls.url.lastIndexOf('/') + 1)),
					write_tok: token_hint(urls.saveUrl.slice(urls.saveUrl.lastIndexOf('/') + 1)),
				}),
	});

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
		...(secret === undefined
			? {}
			: { readExpiresAt: now + READ_TTL_SECONDS, writeExpiresAt: now + OO_WRITE_TTL_SECONDS }),
	});
}

// ---------------------------------------------------------------------------
// 打开：GET /onlyoffice/doc/<read-token>
// ---------------------------------------------------------------------------

async function onlyoffice_read_document(
	request: Request,
	env: EditorsEnv,
	webdav: WebdavTransport,
	secret: string,
	token: string,
): Promise<Response> {
	const payload = await verify_token(secret, token, 'read');
	if (payload === null) {
		log_warn('oo.read rejected', { reason: 'bad_token', tok: token_hint(token) });
		return json_response({ error: 'Invalid or expired read token' }, 403);
	}

	const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
	const upstream = await webdav_fetch(env, request, payload.path, { method }, webdav);
	if (upstream.status === 404) {
		log_warn('oo.read miss', { path: `/${payload.path}` });
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
async function onlyoffice_write_document(
	request: Request,
	env: EditorsEnv,
	webdav: WebdavTransport,
	secret: string,
	token: string,
): Promise<Response> {
	const payload = await verify_token(secret, token, 'write');
	if (payload === null) {
		log_warn('oo.write rejected', { reason: 'bad_token', tok: token_hint(token) });
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
		log_error('oo.write failed', { path: `/${payload.path}`, upstream: upstream.status });
		return json_response({ error: `Upstream error: PUT /${payload.path} returned ${upstream.status}` }, 502);
	}

	// 再探一次元数据，把新的 etag / key 回给宿主页面（内容变了，key 就该变）
	const head = await webdav_fetch(env, request, payload.path, { method: 'HEAD' }, webdav);
	const etag = head.headers.get('etag');
	log_info('oo.write done', { path: `/${payload.path}`, status: upstream.status, etag: etag ?? 'none' });
	return json_response({
		ok: true,
		path: `/${payload.path}`,
		status: upstream.status,
		size: Number(head.headers.get('content-length') ?? 0),
		etag,
		key: etag === null ? null : await version_key(payload.path, etag),
	});
}

// ===========================================================================
// draw.io / Photopea
// ===========================================================================

/**
 * 外部编辑器（Photopea）的服务端路由；不是这些路径就返回 null。
 *
 * - GET  /editors/session?path=…：签发读/写短链 + PP hash 启动 JSON（Basic 鉴权）。
 * - POST /editors/save/<write-token>：PP 保存端点（k0.aFs 的 POST 目标）。
 *   version 0 格式：body 是 application/x-www-form-urlencoded，`p` 字段是
 *   encodeURIComponent(JSON{source, versions:[{format, data:base64}]})。
 *   解出第一个 version 的字节原样 PUT 回 token 里的路径。
 *
 * 保存响应的 {newSource} 会被 PP 回写进文件 source（k0.aA0 源码），返回新 etag。
 */
async function handle_pp_request(request: Request, env: EditorsEnv, webdav: WebdavTransport): Promise<Response | null> {
	const url = new URL(request.url);
	const pathname = url.pathname;

	if (pathname === '/editors/session' && request.method === 'GET') {
		return await create_photopea_session(request, env);
	}

	if (pathname.startsWith(EDITORS_SAVE_PREFIX)) {
		if (request.method !== 'POST' && request.method !== 'PUT') {
			return json_response({ error: 'Method Not Allowed', allow: 'POST, PUT' }, 405);
		}
		const secret = env.SIGNING_SECRET;
		if (!secret) return json_response({ error: 'Not configured' }, 501);
		const token = pathname.slice(EDITORS_SAVE_PREFIX.length);
		const payload = await verify_save_token(secret, token);
		if (payload === null) return json_response({ error: 'Invalid or expired token' }, 403);

		// 打点：到达这里 = 写 token 已验证；后续按「解析 → PUT → HEAD」逐步留痕。
		log_info('pp.save', { path: `/${payload.path}`, declared: request.headers.get('content-length') ?? '?' });

		const contentType = request.headers.get('Content-Type') ?? '';
		const body = await request.text();
		let bytes: Uint8Array;
		if (contentType.includes('application/x-www-form-urlencoded')) {
			// version 0：p=<encodeURIComponent(JSON)>，versions[].data 是 base64
			const params = new URLSearchParams(body);
			const encoded = params.get('p');
			if (encoded === null) {
				log_warn('pp.save rejected', { reason: 'missing_p_field', tok: token_hint(token) });
				return json_response({ error: 'Missing "p" field' }, 400);
			}
			let parsed: { versions?: Array<{ data?: string }> };
			try {
				parsed = JSON.parse(decodeURIComponent(encoded));
			} catch {
				log_warn('pp.save rejected', { reason: 'malformed_json', tok: token_hint(token) });
				return json_response({ error: 'Malformed payload' }, 400);
			}
			const data = parsed.versions && parsed.versions[0] && parsed.versions[0].data;
			if (typeof data !== 'string') {
				log_warn('pp.save rejected', { reason: 'missing_versions_data', tok: token_hint(token) });
				return json_response({ error: 'Missing versions[0].data' }, 400);
			}
			const decoded = base64_to_bytes(data);
			if (decoded === null) {
				log_warn('pp.save rejected', { reason: 'bad_base64', tok: token_hint(token) });
				return json_response({ error: 'Malformed payload (bad base64)' }, 400);
			}
			bytes = decoded;
		} else {
			// 兼容直发二进制（未来 PP 版本或自测用）
			bytes = new Uint8Array(await request.arrayBuffer());
		}
		if (bytes.byteLength === 0) {
			log_warn('pp.save rejected', { reason: 'empty_body', tok: token_hint(token) });
			return json_response({ error: 'Refusing to write an empty body' }, 400);
		}

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
			log_error('pp.save failed', { path: `/${payload.path}`, upstream: put.status });
			return json_response({ error: `Upstream PUT failed (${put.status})` }, 502);
		}
		const head = await webdav(
			new Request(`${new URL(request.url).origin}/${encode_path(payload.path)}`, { method: 'HEAD' }),
		);
		log_info('pp.save done', {
			path: `/${payload.path}`,
			bytes: bytes.byteLength,
			etag: head.headers.get('etag') ?? 'none',
		});
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
		if (head.status === 404) {
			log_warn('pp.read miss', {
				path: `/${payload.path}`,
				tok: token_hint(pathname.slice(pathname.lastIndexOf('/') + 1)),
			});
			return json_response({ error: 'Not found' }, 404);
		}
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

// ---------------------------------------------------------------------------
// Photopea 签名会话：/editors/session?path=…（Basic 鉴权，列表页调用）
// ---------------------------------------------------------------------------

/** 会话响应：列表页用它拼 Photopea 的 hash 启动 JSON。 */
export type PhotopeaSession = {
	mode: 'signed';
	/** 签名读 URL（PP 自己 GET 拉文件）。 */
	readUrl: string;
	/** PP server 配置：保存时 POST 到这里。 */
	server: { url: string; formats: string[] };
	/** PP 启动 JSON（encodeURIComponent 之前），列表页直接 encodeURIComponent 进 hash。 */
	config: Record<string, unknown>;
};

/**
 * 给 Photopea 发会话。没有 SIGNING_SECRET 时直接拒绝 —— PP 在跨源实例上跑，
 * 既拿不到 Basic 凭据也不能带自定义头，签名短链是唯一的干净路径。
 */
async function create_photopea_session(request: Request, env: EditorsEnv): Promise<Response> {
	const secret = env.SIGNING_SECRET;
	if (!secret) {
		log_warn('pp.session rejected', { reason: 'no_signing_secret' });
		return json_response({ error: 'Photopea session requires SIGNING_SECRET' }, 501);
	}

	const url = new URL(request.url);
	const rawPath = url.searchParams.get('path');
	if (rawPath === null) {
		log_warn('pp.session rejected', { reason: 'missing_path' });
		return json_response({ error: 'Missing "path" query parameter' }, 400);
	}
	const path = normalize_path(rawPath);
	if (path === null) {
		log_warn('pp.session rejected', { reason: 'bad_path', raw: rawPath.slice(0, 60) });
		return json_response({ error: 'Invalid "path" parameter' }, 400);
	}

	const name = path.slice(path.lastIndexOf('/') + 1);
	const base = base_url(env.EMBED_BASE_URL, request);
	const now = Math.floor(Date.now() / 1000);

	const readToken = await mint_token(secret, {
		path,
		mode: 'read',
		expires: now + READ_TTL_SECONDS,
		key: name,
		title: name,
	});
	const writeToken = await mint_token(secret, {
		path,
		mode: 'write',
		expires: now + PP_WRITE_TTL_SECONDS,
		key: name,
		title: name,
	});

	const readUrl = `${base}/editors/read/${readToken}`;
	const server = {
		url: `${base}${EDITORS_SAVE_PREFIX}${writeToken}`,
		formats: photopea_formats(name),
	};

	// 打点：签发了哪个文件的读写短链（token 只露前 12 位）。
	log_info('pp.session', {
		path: `/${path}`,
		read_tok: token_hint(readToken),
		read_ttl: '1h',
		write_tok: token_hint(writeToken),
		write_ttl: '7d',
	});

	/**
	 * PP 官方 hash 启动 JSON（aqY 源码）：
	 * - files: 启动即打开的文件（PP 自己 XHR）
	 * - server: 保存通道（k0.aFs：POST url，version 0 = form 表单 p=<JSON+base64>）
	 * - environment.autosave: 秒数 —— PP 定时自动保存到 server
	 * - environment.customIO.exportAs: 导出完成时把字节发回 OE（关掉：我们走 server）
	 * - environment.localsave:false + hidesave? 不动 —— PP 原生 File>Save 就会走 server。
	 */
	const config: Record<string, unknown> = {
		files: [readUrl],
		server,
		environment: {
			autosave: 0, // 0 = 不定时；用户点 Save（Ctrl+S）时保存。要自动改这里。
		},
	};

	return json_response({ mode: 'signed', readUrl, server, config } satisfies PhotopeaSession);
}

/** 校验 /editors/save|read/<token> 的签名 token；payload 直接携带 R2 路径与模式。 */
async function verify_save_token(
	secret: string,
	token: string,
	mode: 'read' | 'write' = 'write',
): Promise<{ path: string; title: string; mode: string } | null> {
	const payload = await verify_token(secret, token, mode);
	if (payload === null) {
		// 打点：签名/过期/mode 不匹配都落在这。外面这层只看得见 403，这里给出区分度。
		log_warn(`pp.${mode} rejected`, { reason: 'bad_token', tok: token_hint(token) });
		return null;
	}
	return { path: payload.path, title: payload.title, mode: payload.mode };
}

// ===========================================================================
// 共用：以 WebDAV 客户端身份访问文件（唯一的读写通道）
// ===========================================================================

/** 对外基址：默认就是本次请求的 origin，也就是这个 WebDAV 服务自己。 */
function webdav_base(env: EditorsEnv, request: Request): string {
	return (env.EMBED_BASE_URL ?? new URL(request.url).origin).replace(/\/+$/, '');
}

/**
 * 向 WebDAV 服务发一个**标准 HTTP 请求**（带服务自身的 Basic 凭据），由注入的传输层执行。
 *
 * 这是 adapter 唯一的读写通道：不碰 bucket、不绕过 WebDAV 层 —— 父目录补建、影子文件
 * 过滤、PUT 前置条件这些规则因此和其它客户端走的是同一条路径。
 */
function webdav_fetch(
	env: EditorsEnv,
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
