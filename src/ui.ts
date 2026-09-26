/**
 * 浏览器页面层（Alpine.js）。
 *
 * 这里只关心“给人看的页面”：目录浏览、上传、删除、预览。
 * 协议实现（PROPFIND/PUT/COPY…）全部留在 webdav.ts，两边互不引用。
 */

import { decode_path, is_os_metadata_key, listDir } from './r2';
import { encode_path } from './utils';
import PAGE_HTML from './index.html';
import ARCHIVE_JS from './archive.client.js';
import EDITORS_JS from './editors.client.js';
import OFFICE_TEMPLATES_JS from './office.templates.js';
// Default pack is inlined into the page (no extra request, no flash); the rest are
// served on demand from LOCALE_ASSET_PATH.
import en from './locales/en.json';
import zh from './locales/zh.json';

export type PreviewKind = 'markdown' | 'text' | 'image' | 'video' | 'audio';

/**
 * 客户端静态资源的路径。
 *
 * 放 `_app/` 前缀下是为了和用户数据分开 —— 这是个代码路由，R2 里并没有同名对象。
 * 不能用相对路径：页面本身是挂在任意集合路径上的（`/sub/` 也返回这个页面）。
 */
export const ARCHIVE_ASSET_PATH = '/_app/archive.client.js';
/** 外部编辑器（draw.io / Photopea）列表页脚本：分派 window.open + drawio opener 协议。 */
export const EDITORS_ASSET_PATH = '/_app/editors.client.js';
/** Office 空文档模板（base64），被 editors.client.js 用来 PUT 新建文档。 */
export const OFFICE_TEMPLATES_ASSET_PATH = '/_app/office.templates.js';

/** On-demand locale packs, e.g. /_app/locales/zh.json. en is inlined in the page instead. */
const LOCALES: Record<string, unknown> = { en, zh };
const LOCALE_ASSET_PREFIX = '/_app/locales/';
const LANG_CODES = ['en', 'zh'];

function handle_assets(request: Request, file: string, contentType = 'text/javascript; charset=utf-8'): Response {
	return new Response(request.method === 'HEAD' ? null : file, {
		status: 200,
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'no-cache',
		},
	});
}
/**
 * 分发客户端静态资源；不是资源请求就返回 null，交给 WebDAV 那层。
 *
 * 必须在 WebDAV 分发**之前**拦：无尾斜杠的 GET 在协议层是「取一个对象」，
 * 会去 R2 里找一个叫 `_app/archive.client.js` 的对象然后 404。
 * 这也意味着这个路径被占用了 —— 用户存不了这个键，可接受（`_app/` 就是留给应用的）。
 */
export function handle_asset_request(request: Request): Response | null {
	if (request.method !== 'GET' && request.method !== 'HEAD') return null;
	const pathname = new URL(request.url).pathname;
	if (pathname === ARCHIVE_ASSET_PATH) {
		return handle_assets(request, ARCHIVE_JS);
	}
	if (pathname === EDITORS_ASSET_PATH) {
		return handle_assets(request, EDITORS_JS);
	}
	if (pathname === OFFICE_TEMPLATES_ASSET_PATH) {
		return handle_assets(request, OFFICE_TEMPLATES_JS);
	}
	if (pathname.startsWith(LOCALE_ASSET_PREFIX)) {
		const code = pathname.slice(LOCALE_ASSET_PREFIX.length).replace(/\.json$/, '');
		const pack = LOCALES[code];
		if (pack === undefined) return null;
		return handle_assets(request, JSON.stringify(pack), 'application/json; charset=utf-8');
	}
	return null;
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv', 'avi', '3gp']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba', 'mid', 'midi']);
const TEXT_FILE_EXTENSIONS = new Set([
	'js',
	'mjs',
	'cjs',
	'jsx',
	'ts',
	'tsx',
	'java',
	'c',
	'h',
	'cc',
	'cpp',
	'cxx',
	'hpp',
	'hxx',
	'cs',
	'rs',
	'go',
	'py',
	'rb',
	'php',
	'swift',
	'kt',
	'kts',
	'scala',
	'dart',
	'lua',
	'pl',
	'r',
	'sh',
	'bash',
	'zsh',
	'fish',
	'ps1',
	'bat',
	'cmd',
	'sql',
	'html',
	'htm',
	'xhtml',
	'css',
	'scss',
	'sass',
	'less',
	'vue',
	'svelte',
	'xml',
	'json',
	'jsonc',
	'yaml',
	'yml',
	'toml',
	'ini',
	'cfg',
	'conf',
	'env',
	'properties',
	'gradle',
	'txt',
	'text',
	'log',
	'csv',
	'tsv',
	'gitignore',
	'dockerignore',
	'editorconfig',
	'lock',
]);

/** 该文件在浏览器里应该怎么预览；null 表示只能下载。 */
export function preview_kind(name: string): PreviewKind | null {
	const ext = name.includes('.') ? (name.split('.').pop() as string).toLowerCase() : '';
	if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
	if (IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (VIDEO_EXTENSIONS.has(ext)) return 'video';
	if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
	return TEXT_FILE_EXTENSIONS.has(ext) ? 'text' : null;
}

type BrowseEntry = {
	name: string;
	href: string;
	isDir: boolean;
	kind: PreviewKind | null;
	contentType: string | null;
	size: number;
	modified: string;
};

function safe_decode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** 从 Content-Disposition 还原显示名（WebDAV 客户端会把文件名写在那里）。 */
function display_name(object: R2Object, prefix: string): string {
	const raw = object.httpMetadata?.contentDisposition;
	if (raw) {
		const matched = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(raw);
		if (matched) return safe_decode(matched[1]);
	}
	// key 已是解码后的真实文件名（见 r2.decode_path）
	return object.key.slice(prefix.length);
}

/** 列出目录的直接子项；隐式目录由 listDir 合成。 */
async function list_entries(bucket: R2Bucket, dir: string): Promise<{ entries: BrowseEntry[]; truncated: boolean }> {
	const prefix = dir === '' ? '' : `${dir}/`;
	const entries: BrowseEntry[] = [];
	const listing = await listDir(bucket, prefix);

	for (const item of listing.entries) {
		if (item.key === dir) {
			continue;
		}
		// 影子文件不展示（上传层已拦，这里挡历史遗留）
		if (is_os_metadata_key(item.key)) {
			continue;
		}
		const isDir = item.is_collection;
		const relative = item.key.slice(prefix.length);
		const name = item.object === null ? relative : display_name(item.object, prefix);
		entries.push({
			name,
			// href 必须编码（key 里可能有空格、中文、&）
			href: `/${encode_path(item.key)}${isDir ? '/' : ''}`,
			isDir,
			kind: isDir ? null : preview_kind(name),
			contentType: item.object?.httpMetadata?.contentType ?? null,
			size: item.object?.size ?? 0,
			modified: item.object?.uploaded.toISOString() ?? '',
		});
	}

	entries.sort((a, b) =>
		a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1,
	);
	// truncated 必须传给前端，不能静默截断。
	return { entries, truncated: listing.truncated };
}

function directory_path(pathname: string): string {
	const trimmed = pathname.slice(1);
	return decode_path(trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed);
}

/** 目录请求：`?format=json` 给 Alpine 取数据，其余返回页面本身。 */
export async function handle_browse_request(request: Request, bucket: R2Bucket): Promise<Response> {
	const url = new URL(request.url);

	if (url.searchParams.get('format') === 'json') {
		const dir = directory_path(url.pathname);
		const parent = dir === '' ? null : `/${dir.split('/').slice(0, -1).join('/')}${dir.includes('/') ? '/' : ''}`;
		const listing = await list_entries(bucket, dir);
		return Response.json(
			{ path: dir, parent, entries: listing.entries, truncated: listing.truncated },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	}

	return new Response(
		PAGE_HTML.replace(
			'/*__LOCALES__*/',
			`window.__LOCALES__ = { en: ${JSON.stringify(en).replace(/</g, '\\u003c')} };` +
				`window.__LOCALE_CODES__ = ${JSON.stringify(LANG_CODES)};`,
		),
		{
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		},
	);
}
