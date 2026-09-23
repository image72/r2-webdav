/**
 * 浏览器页面层（Alpine.js）。
 *
 * 这里只关心“给人看的页面”：目录浏览、上传、删除、预览。
 * 协议实现（PROPFIND/PUT/COPY…）全部留在 webdav.ts，两边互不引用。
 */

import { decode_path, encode_path, is_os_metadata_key, listDir } from './r2';
import PAGE_HTML from './index.html';

export type PreviewKind = 'markdown' | 'text' | 'image' | 'video' | 'audio';

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

/** WebDAV 客户端会把 Content-Disposition 当文件名写入元数据，这里还原成干净的显示名。 */
function display_name(object: R2Object, prefix: string): string {
	const raw = object.httpMetadata?.contentDisposition;
	if (raw) {
		const matched = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(raw);
		if (matched) return safe_decode(matched[1]);
	}
	// key 已经是解码后的真实文件名（见 r2.decode_path），无需再解码
	return object.key.slice(prefix.length);
}

/**
 * 列出目录的直接子项。目录本身以 `<collection />` 标记对象的形式存储，
 * 也可以是"隐式目录"（只有子对象、没有标记对象），由 listDir 一并合成。
 */
async function list_entries(bucket: R2Bucket, dir: string): Promise<{ entries: BrowseEntry[]; truncated: boolean }> {
	const prefix = dir === '' ? '' : `${dir}/`;
	const entries: BrowseEntry[] = [];
	const listing = await listDir(bucket, prefix);

	for (const item of listing.entries) {
		if (item.key === dir) {
			continue;
		}
		// macOS 的影子文件不在界面上展示（上传层已经拦了，这里挡历史遗留的）
		if (is_os_metadata_key(item.key)) {
			continue;
		}
		const isDir = item.is_collection;
		const relative = item.key.slice(prefix.length);
		const name = item.object === null ? relative : display_name(item.object, prefix);
		entries.push({
			name,
			// href 必须编码：key 里可能是空格、中文、& 等
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
	// truncated 必须传给前端：以前静默截断在 3000 条，用户会以为目录里只有这些
	return { entries, truncated: listing.truncated };
}

function directory_path(pathname: string): string {
	const trimmed = pathname.slice(1);
	// 浏览器发来的是编码后的路径，而 R2 里的 key 是真实文件名
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

	return new Response(PAGE_HTML, {
		status: 200,
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
}
