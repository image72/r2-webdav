/**
 * 外部编辑器（draw.io / Photopea）—— 顶层直开方案（可选模块，整块可下线）。
 *
 * 用户要求：r2-webdav 页面与窗口内**禁止**出现编辑器界面。点按钮必须新开标签页，
 * 编辑器占满整个窗口 —— 没有 wrapper、没有 iframe、没有 overlay。
 *
 * 两个编辑器、两种官方机制（都已在实例源码里逐行验证过）：
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
 * server.url 指向本模块的 /editors/save/<write-token>：token 是 HMAC 签名的
 * R2 路径（同 onlyoffice.ts 的一套签名原语），编辑器拿不到 Basic 凭据，
 * 也改不了 token 里的路径。
 *
 * 下线方式：删本文件 + editors.client.js + index.ts/ui.ts/index.html 里
 * EDITORS 相关接线 + wrangler.toml 的两个 URL 变量。
 */

import { base_url, extension_of, json_response, normalize_path } from './utils';
import { mint_token, verify_token } from './signing';
import { log_info, log_warn, token_hint } from './log';

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

export type EditorsEnv = {
	DRAWIO_EDITOR_URL?: string;
	PHOTOPEA_EDITOR_URL?: string;
	SIGNING_SECRET?: string;
	/** 公网基址，默认取请求 origin。 */
	EMBED_BASE_URL?: string;
	USERNAME?: string;
	PASSWORD?: string;
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
// Photopea 签名会话：/editors/session?path=…（Basic 鉴权，列表页调用）
// ---------------------------------------------------------------------------

/** PP 保存端点的前缀；index.ts 靠它决定哪些请求跳过 Basic 鉴权。 */
export const EDITORS_SAVE_PREFIX = '/editors/save/';
/** PP 拉文件的签名读短链前缀，同样豁免 Basic（PP 跨源拿不到凭据）。 */
export const EDITORS_READ_PREFIX = '/editors/read/';

const READ_TTL_SECONDS = 3600;
const WRITE_TTL_SECONDS = 86400 * 7; // PP 弹窗可能开很久才保存

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
export async function create_photopea_session(
	request: Request,
	env: EditorsEnv & { SIGNING_SECRET?: string },
	webdav: (request: Request) => Promise<Response>,
): Promise<Response> {
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
		expires: now + WRITE_TTL_SECONDS,
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
export async function verify_save_token(
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
