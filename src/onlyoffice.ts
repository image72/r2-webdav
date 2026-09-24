/**
 * ONLYOFFICE 打开 / 保存 adapter（可选模块，可以整块下线）。
 *
 * 目标实例（projects/office-website）把 ONLYOFFICE 编辑器和 x2t(WASM) 转换器都跑在
 * **浏览器里**：没有 Document Server，也就没有 `document.url` / `callbackUrl` 那一套
 * 服务端流程（`utils/editor/server.ts` 是个 mock 文档服务器，靠 XHR/fetch 代理喂数据）。
 * 它真正缺的只有两件事，本文件就只做这两件：
 *
 *   1. 打开：一个**不需要凭据**、能取到文件字节的 URL。
 *      编辑器那边是 `fetch(url).then(res => res.arrayBuffer())` —— 裸 fetch，既不会带
 *      Basic 凭据，也没法带自定义头，所以这个 URL 只能自己签名。
 *   2. 保存：一个能接收编辑结果字节的写入端点。编辑器在浏览器里跑完转换后，由宿主页面
 *      把结果 POST/PUT 回来。
 *
 * 两种模式（用有没有配 `ONLYOFFICE_HMAC_SECRET` 自动切换，客户端接口完全一样）：
 *
 *   直连（默认）：`url` / `saveUrl` 就是该文件自己的 WebDAV 地址 —— 打开走原生 GET、
 *     保存走原生 PUT。前提是**编辑器页面与 WebDAV 同源**：同源请求浏览器的 fetch 会自动
 *     补上已缓存的 Basic 凭据，所以不需要任何额外授权机制。
 *   签名（配了 secret）：发短期 HMAC 短链。跨源时必需 —— 跨源 fetch 默认不带凭据，
 *     而我们的 CORS 是 `Allow-Origin: *` + `Allow-Credentials: false`，Basic 送不过去。
 *
 * 怎么判断自己属于哪种：本地 `localhost:3000` 与 `127.0.0.1:8790`、线上 `*.pages.dev` 与
 * `*.workers.dev` 都是**跨源**，那种情况必须用签名模式；只有把编辑器页面挂到与 WebDAV
 * 同一个 host:port 上，直连模式才成立。
 *
 * 为了能干净下掉，这里**不碰** webdav.ts / r2.ts / index.html：要下线就删掉本文件 +
 * index.ts 里搜 `ONLYOFFICE` 的那几处接线，其余代码根本不知道它存在过。
 */

import { encode_path } from './r2';

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
	txt: { documentType: 'word', contentType: 'text/plain; charset=utf-8' },
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

export type OnlyOfficeEnv = {
	bucket: R2Bucket;
	/**
	 * 配了它 → 签名模式（发短期短链，跨源可用）；不配 → 直连模式（给原生 WebDAV 地址，
	 * 要求编辑器与 WebDAV 同源，靠浏览器已缓存的 Basic 凭据）。
	 */
	ONLYOFFICE_HMAC_SECRET?: string;
	/** 编辑器与 Worker 不同源（或前面挂了反代）时，对外暴露的基址，例如 https://dav.example.com */
	ONLYOFFICE_BASE_URL?: string;
};

type TokenMode = 'read' | 'write';

type TokenPayload = {
	/** R2 key，不带前导斜杠 */
	path: string;
	mode: TokenMode;
	/** 过期时间（秒） */
	expires: number;
	/** 交给编辑器的 document.key：同一版本稳定、内容一变就变 */
	key: string;
	/** 文件名，用于 Content-Disposition 与调试 */
	title: string;
};

/**
 * 分发 /onlyoffice/* 请求；不是这些路径就返回 null，交回给页面层与 WebDAV。
 *
 * OPTIONS 也返回 null：预检交给 WebDAV 那层的 OPTIONS（它已经带上了整套 CORS 头），
 * 这里再写一遍只会跟 index.ts 里那份重复。
 */
export async function handle_onlyoffice_request(request: Request, env: OnlyOfficeEnv): Promise<Response | null> {
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
			? await create_session(request, env)
			: json_response({ error: '请用 GET 读取会话' }, 405);
	}

	// 短链只在签名模式下存在。直连模式没有这条路由 —— 返回 null 让请求落回 WebDAV，
	// 由它按「桶里没这个 key」回 404（这时请求已经过 Basic 鉴权，不会越权）。
	const secret = env.ONLYOFFICE_HMAC_SECRET;
	if (!secret) {
		return null;
	}
	const token = url.pathname.slice(ONLYOFFICE_TOKEN_PREFIX.length);
	if (request.method === 'GET' || request.method === 'HEAD') {
		return await read_document(request, env, secret, token);
	}
	if (request.method === 'PUT' || request.method === 'POST') {
		return await write_document(request, env, secret, token);
	}
	return json_response({ error: `${request.method} 不受支持，请用 GET / PUT` }, 405);
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
async function create_session(request: Request, env: OnlyOfficeEnv): Promise<Response> {
	const url = new URL(request.url);
	const path = normalize_path(url.searchParams.get('path'));
	if (path === null) {
		return json_response({ error: '需要 ?path=/目录/文件.docx（指向桶里已存在的文件）' }, 400);
	}

	const extension = extension_of(path);
	const types = EXTENSION_TYPES[extension];
	if (types === undefined) {
		return json_response(
			{
				error: `ONLYOFFICE 打不开 .${extension}（本 adapter 只放行办公文档）`,
				supported: Object.keys(EXTENSION_TYPES),
			},
			415,
		);
	}

	const head = await env.bucket.head(path);
	if (head === null) {
		// 打开一个不存在的文件没有意义，而且会让"保存时凭空造出新文件"变得难以解释
		return json_response({ error: `文件不存在：/${path}` }, 404);
	}

	const title = path.slice(path.lastIndexOf('/') + 1);
	const key = await version_key(path, head.httpEtag);
	const now = Math.floor(Date.now() / 1000);
	const base = (env.ONLYOFFICE_BASE_URL ?? url.origin).replace(/\/+$/, '');
	const secret = env.ONLYOFFICE_HMAC_SECRET;

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
		size: head.size,
		etag: head.httpEtag,
		...(secret === undefined ? {} : { readExpiresAt: now + READ_TTL_SECONDS, writeExpiresAt: now + WRITE_TTL_SECONDS }),
	});
}

// ---------------------------------------------------------------------------
// 打开：GET /onlyoffice/doc/<read-token>
// ---------------------------------------------------------------------------

async function read_document(request: Request, env: OnlyOfficeEnv, secret: string, token: string): Promise<Response> {
	const payload = await verify_token(secret, token, 'read');
	if (payload === null) {
		return json_response({ error: 'token 无效、已过期或方向不对' }, 403);
	}

	if (request.method === 'HEAD') {
		const head = await env.bucket.head(payload.path);
		if (head === null) {
			return new Response(null, { status: 404 });
		}
		return new Response(null, { status: 200, headers: document_headers(payload, head) });
	}

	const object = await env.bucket.get(payload.path);
	if (object === null) {
		return json_response({ error: '文件已不存在（可能已被删除或改名）' }, 404);
	}

	return new Response(object.body, {
		status: 200,
		headers: { ...document_headers(payload, object), 'Content-Length': object.size.toString() },
	});
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
async function write_document(request: Request, env: OnlyOfficeEnv, secret: string, token: string): Promise<Response> {
	const payload = await verify_token(secret, token, 'write');
	if (payload === null) {
		return json_response({ error: 'token 无效、已过期、或这是只读 token' }, 403);
	}

	// 空体保护：编辑器或宿主页面出问题时，最坏的结果是"把文档清成 0 字节"。
	// 保存本来就是覆盖写，宁可拒绝也不能毁掉用户的文件。
	const declared = request.headers.get('Content-Length');
	if (declared !== null && Number(declared) === 0) {
		return json_response({ error: '拒绝写入空内容' }, 400);
	}
	if (request.body === null) {
		return json_response({ error: '缺少请求体' }, 400);
	}

	const contentType = EXTENSION_TYPES[extension_of(payload.path)]?.contentType ?? 'application/octet-stream';
	// 流式写入，不把整份文档读进内存
	const stored = await env.bucket.put(payload.path, request.body, { httpMetadata: { contentType } });
	if (stored === null) {
		return json_response({ error: '写入失败' }, 500);
	}

	return json_response({
		ok: true,
		path: `/${payload.path}`,
		size: stored.size,
		etag: stored.httpEtag,
		// 内容变了 → key 变了；宿主页面若想接着编辑，用这个新 key 重开会话
		key: await version_key(payload.path, stored.httpEtag),
	});
}

// ---------------------------------------------------------------------------
// token 与路径工具
// ---------------------------------------------------------------------------

async function mint_token(secret: string, payload: TokenPayload): Promise<string> {
	const body = base64url_encode(new TextEncoder().encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign('HMAC', await hmac_key(secret), new TextEncoder().encode(body));
	return `${body}.${base64url_encode(new Uint8Array(signature))}`;
}

/** 校验签名、方向与过期时间。签名比较交给 crypto.subtle.verify（恒定时间）。 */
async function verify_token(secret: string, token: string, mode: TokenMode): Promise<TokenPayload | null> {
	const dot = token.lastIndexOf('.');
	if (dot <= 0) {
		return null;
	}
	const body = token.slice(0, dot);
	const signature = base64url_decode(token.slice(dot + 1));
	if (signature === null) {
		return null;
	}
	const valid = await crypto.subtle.verify('HMAC', await hmac_key(secret), signature, new TextEncoder().encode(body));
	if (!valid) {
		return null;
	}

	const raw = base64url_decode(body);
	if (raw === null) {
		return null;
	}
	let payload: TokenPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(raw)) as TokenPayload;
	} catch {
		return null;
	}
	if (payload.mode !== mode) return null;
	if (typeof payload.expires !== 'number' || payload.expires * 1000 <= Date.now()) return null;
	if (typeof payload.path !== 'string' || payload.path === '') return null;
	return payload;
}

/**
 * CryptoKey 缓存。
 *
 * 同一 isolate 内会反复用到同一把密钥，而 importKey 是异步的、每次请求都做一遍纯属浪费。
 * 按 secret 缓存 promise，重复请求直接复用。
 */
const key_cache = new Map<string, Promise<CryptoKey>>();

function hmac_key(secret: string): Promise<CryptoKey> {
	let cached = key_cache.get(secret);
	if (cached === undefined) {
		cached = crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign', 'verify'],
		);
		key_cache.set(secret, cached);
	}
	return cached;
}

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
function document_headers(payload: TokenPayload, object: R2Object | R2ObjectBody): Record<string, string> {
	const extension = extension_of(payload.path);
	return {
		'Content-Type': EXTENSION_TYPES[extension]?.contentType ?? 'application/octet-stream',
		ETag: object.httpEtag,
		// 文件名用 RFC 5987 形式，中文名不会变成乱码
		'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(payload.title)}`,
		// 短链 + 签名，不该进任何缓存
		'Cache-Control': 'no-store',
	};
}

function json_response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}

function base64url_encode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64url_decode(value: string): Uint8Array | null {
	try {
		const padded = value.replace(/-/g, '+').replace(/_/g, '/');
		const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
