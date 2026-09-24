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
 * 本模块是 WebDAV 服务的**普通客户端**：所有读写在 HTTP 层发起（HEAD / GET / PUT 到文件
 * 自己的 URL，带上服务自身的 Basic 凭据），**绝不碰 bucket**。好处是写入路径与其它客户端
 * 完全一致（父目录补建、影子文件过滤、PUT 前置条件都由 WebDAV 那层负责），也不会绕过
 * WebDAV 的规则去动它背后的数据。类型上 `OnlyOfficeEnv` 里根本没有 bucket —— 想碰也碰不到。
 *
 * 代价：每次操作多 1~2 个子请求（它们计入 Worker 的子请求配额）。
 *
 * token 的签发/校验原语在 signing.ts —— 那层是所有浏览器在线服务（drawio、Photopea…）
 * 共用的，不专属于 ONLYOFFICE。
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
	/** WebDAV 服务自身的账号：adapter 以普通客户端身份发子请求时用它鉴权 */
	USERNAME: string;
	PASSWORD: string;
	/**
	 * 配了它 → 签名模式（发短期短链，跨源可用）；不配 → 直连模式（给原生 WebDAV 地址，
	 * 要求编辑器与 WebDAV 同源，靠浏览器已缓存的 Basic 凭据）。
	 */
	ONLYOFFICE_HMAC_SECRET?: string;
	/** 对外暴露的基址（编辑器与 Worker 不同源、或前面挂了反代时用），例如 https://dav.example.com */
	ONLYOFFICE_BASE_URL?: string;
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

	const head = await webdav_fetch(env, request, path, { method: 'HEAD' });
	if (head.status === 404) {
		// 打开一个不存在的文件没有意义，而且会让"保存时凭空造出新文件"变得难以解释
		return json_response({ error: `文件不存在：/${path}` }, 404);
	}
	if (!head.ok) {
		return json_response({ error: `WebDAV 探测失败：${head.status}` }, 502);
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
		size,
		etag,
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

	const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
	const upstream = await webdav_fetch(env, request, payload.path, { method });
	if (upstream.status === 404) {
		return json_response({ error: '文件已不存在（可能已被删除或改名）' }, 404);
	}
	if (!upstream.ok) {
		return json_response({ error: `WebDAV 读取失败：${upstream.status}` }, 502);
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
	// 走标准 WebDAV PUT：body 直接流式转发，不落内存，也不自己写存储
	const upstream = await webdav_fetch(env, request, payload.path, {
		method: 'PUT',
		body: request.body,
		headers: { 'Content-Type': contentType },
	});
	if (!upstream.ok) {
		return json_response({ error: `WebDAV 保存失败：${upstream.status}` }, 502);
	}

	// 再探一次元数据，把新的 etag / key 回给宿主页面（内容变了，key 就该变）
	const head = await webdav_fetch(env, request, payload.path, { method: 'HEAD' });
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
	return (env.ONLYOFFICE_BASE_URL ?? new URL(request.url).origin).replace(/\/+$/, '');
}

/**
 * 向 WebDAV 服务发一个**普通 HTTP 子请求**（带服务自身的 Basic 凭据）。
 *
 * 这是本模块唯一的读写通道：不碰 bucket、不绕过 WebDAV 层 —— 父目录补建、影子文件过滤、
 * PUT 前置条件这些规则因此和其它客户端走的是同一条路径。
 */
function webdav_fetch(env: OnlyOfficeEnv, request: Request, path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Authorization', `Basic ${btoa(`${env.USERNAME}:${env.PASSWORD}`)}`);
	return fetch(`${webdav_base(env, request)}/${encode_path(path)}`, { ...init, headers });
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
