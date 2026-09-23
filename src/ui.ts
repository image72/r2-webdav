/**
 * 浏览器页面层（Alpine.js）。
 *
 * 这里只关心“给人看的页面”：目录浏览、上传、删除、预览。
 * 协议实现（PROPFIND/PUT/COPY…）全部留在 webdav.ts，两边互不引用。
 */

import { listAll } from './r2';

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
	// 浏览器与 WebDAV 客户端写入的 key 是百分号编码的，展示时解码还原
	return safe_decode(object.key.slice(prefix.length));
}

/** 列出目录的直接子项。目录本身以 `<collection />` 标记对象的形式存储。 */
async function list_entries(bucket: R2Bucket, dir: string): Promise<BrowseEntry[]> {
	const prefix = dir === '' ? '' : `${dir}/`;
	const entries: BrowseEntry[] = [];

	for await (const object of listAll(bucket, prefix)) {
		if (object.key === dir) {
			continue;
		}
		const isDir = object.customMetadata?.resourcetype === '<collection />';
		const name = display_name(object, prefix);
		entries.push({
			name,
			href: `/${object.key}${isDir ? '/' : ''}`,
			isDir,
			kind: isDir ? null : preview_kind(name),
			contentType: object.httpMetadata?.contentType ?? null,
			size: object.size,
			modified: object.uploaded.toISOString(),
		});
	}

	entries.sort((a, b) =>
		a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1,
	);
	return entries;
}

function directory_path(pathname: string): string {
	const trimmed = pathname.slice(1);
	return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/** 目录请求：`?format=json` 给 Alpine 取数据，其余返回页面本身。 */
export async function handle_browse_request(request: Request, bucket: R2Bucket): Promise<Response> {
	const url = new URL(request.url);

	if (url.searchParams.get('format') === 'json') {
		const dir = directory_path(url.pathname);
		const parent = dir === '' ? null : `/${dir.split('/').slice(0, -1).join('/')}${dir.includes('/') ? '/' : ''}`;
		return Response.json(
			{ path: dir, parent, entries: await list_entries(bucket, dir) },
			{ headers: { 'Cache-Control': 'no-store' } },
		);
	}

	return new Response(PAGE_HTML, {
		status: 200,
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#047857">
<title>R2 Storage</title>
<style>
	:root {
		--bg: #f1f5f9;
		--surface: #ffffff;
		--ink: #0f172a;
		--ink-80: #334155;
		--ink-60: #64748b;
		--line: #e2e8f0;
		--accent: #047857;
		--accent-soft: #ecfdf5;
		--danger: #dc2626;
		--danger-soft: #fef2f2;
		--r-sm: 8px;
		--r-md: 12px;
		--r-lg: 16px;
		--r-full: 999px;
		--sp-1: 4px;
		--sp-2: 8px;
		--sp-3: 12px;
		--sp-4: 16px;
		--sp-6: 24px;
		--sp-8: 32px;
		--tap: 44px;
	}
	* { box-sizing: border-box; }
	html { -webkit-text-size-adjust: 100%; }
	body {
		margin: 0;
		background: var(--bg);
		color: var(--ink);
		font: 400 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
	}
	body.locked { overflow: hidden; }
	/* 移动端：去掉 300ms 双击缩放延迟与点击高亮 */
	button, input, a { font: inherit; color: inherit; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
	:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	/* 内联 SVG 图标统一尺寸与配色（fill 继承 currentColor） */
	.icon { display: block; width: 20px; height: 20px; flex: none; fill: currentColor; }
	.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

	.app { display: flex; flex-direction: column; min-height: 100dvh; }

	/* 顶栏：面包屑就是标题（52px 一行），不再单独占一行静态应用名 */
	.app-bar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		padding: calc(var(--sp-1) + env(safe-area-inset-top)) var(--sp-2) var(--sp-1) var(--sp-3);
		background: rgba(255, 255, 255, 0.92);
		-webkit-backdrop-filter: blur(8px);
		backdrop-filter: blur(8px);
		border-bottom: 1px solid var(--line);
	}
	.icon-btn {
		display: grid;
		place-items: center;
		width: var(--tap);
		height: var(--tap);
		flex: none;
		border: 0;
		border-radius: var(--r-sm);
		background: none;
		color: var(--ink-60);
		cursor: pointer;
	}
	.icon-btn:hover { background: var(--bg); color: var(--ink); }

	.crumbs {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
		font-size: 15px;
		white-space: nowrap;
	}
	.crumbs::-webkit-scrollbar { display: none; }
	.crumb {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		padding: 0 var(--sp-2);
		border-radius: var(--r-sm);
		color: var(--ink-60);
		text-decoration: none;
	}
	.crumb:hover { background: var(--bg); color: var(--ink); }
	.crumb--current { color: var(--ink); font-weight: 600; }
	.crumb-sep { color: var(--ink-60); }

	.content { flex: 1; padding: var(--sp-2) var(--sp-3) calc(96px + env(safe-area-inset-bottom)); }

	.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) var(--tap);
		align-items: center;
		gap: var(--sp-1);
		min-height: 64px;
		padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-2);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r-md);
	}
	.row:active { background: var(--bg); }
	.row__main {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		min-width: 0;
		min-height: var(--tap);
		padding: var(--sp-1) 0;
		border: 0;
		background: none;
		text-align: left;
		cursor: pointer;
	}
	/* 按类型给出色调，便于一眼区分目录/图片/媒体/文本/不可预览 */
	.row__icon {
		display: grid;
		place-items: center;
		flex: none;
		width: 40px;
		height: 40px;
		border-radius: var(--r-sm);
		background: var(--tone-soft, var(--bg));
		color: var(--tone, var(--ink-60));
	}
	.row__icon .icon { width: 22px; height: 22px; }
	.row__icon--folder { --tone: #047857; --tone-soft: #ecfdf5; }
	.row__icon--image { --tone: #1d4ed8; --tone-soft: #eff6ff; }
	.row__icon--video { --tone: #6d28d9; --tone-soft: #f5f3ff; }
	.row__icon--audio { --tone: #b45309; --tone-soft: #fffbeb; }
	.row__icon--markdown { --tone: #0e7490; --tone-soft: #ecfeff; }
	.row__icon--text { --tone: #334155; --tone-soft: #f1f5f9; }
	.row__icon--archive { --tone: #a16207; --tone-soft: #fefce8; }
	.row__icon--file { --tone: #94a3b8; --tone-soft: #f8fafc; }
	.row__text { min-width: 0; }
	.row__name { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.row__meta { display: block; font-size: 13px; color: var(--ink-60); }

	.skeleton { height: 64px; border-radius: var(--r-md); background: var(--surface); border: 1px solid var(--line); }
	.state { padding: var(--sp-8) var(--sp-4); text-align: center; color: var(--ink-60); }
	.state__icon { display: grid; place-items: center; width: 48px; height: 48px; margin: 0 auto var(--sp-3); color: var(--ink-60); }
	.state__icon .icon { width: 40px; height: 40px; }
	.state__actions { display: flex; justify-content: center; padding-top: var(--sp-4); }
	.state--error { color: var(--danger); }

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--sp-2);
		min-height: var(--tap);
		padding: 0 var(--sp-4);
		border: 0;
		border-radius: var(--r-md);
		background: var(--accent);
		color: #fff;
		font-weight: 600;
		cursor: pointer;
	}
	.btn--ghost { background: var(--accent-soft); color: var(--accent); }
	.btn--danger { background: var(--danger); }
	.btn--muted { background: var(--bg); color: var(--ink-80); }
	.btn[disabled] { opacity: 0.5; cursor: default; }

	.fab {
		position: fixed;
		right: var(--sp-4);
		bottom: calc(var(--sp-4) + env(safe-area-inset-bottom));
		z-index: 30;
		display: inline-flex;
		align-items: center;
		gap: var(--sp-2);
		height: 56px;
		padding: 0 var(--sp-6) 0 var(--sp-4);
		border: 0;
		border-radius: var(--r-full);
		background: var(--accent);
		color: #fff;
		font-weight: 600;
		cursor: pointer;
		box-shadow: 0 8px 24px rgba(4, 120, 87, 0.32);
	}
	.fab:active { transform: scale(0.97); }

	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 65; /* 高于预览层，便于在预览里触发删除确认 */
		background: rgba(15, 23, 42, 0.45);
		opacity: 0;
		visibility: hidden;
		transition: opacity 0.2s ease;
	}
	.backdrop.open { opacity: 1; visibility: visible; }

	.sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 66;
		max-height: 85dvh;
		overflow-y: auto;
		padding: var(--sp-3) var(--sp-3) calc(var(--sp-3) + env(safe-area-inset-bottom));
		background: var(--surface);
		border-radius: var(--r-lg) var(--r-lg) 0 0;
		transform: translateY(100%);
		transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1);
	}
	.sheet.open { transform: translateY(0); }
	.sheet__title {
		display: block;
		padding: var(--sp-2) var(--sp-3) var(--sp-4);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sheet__item {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		width: 100%;
		min-height: 52px;
		padding: var(--sp-3);
		border: 0;
		border-radius: var(--r-md);
		background: none;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}
	.sheet__item:hover { background: var(--bg); }
	.sheet__item--danger { color: var(--danger); }
	.sheet__item--muted { color: var(--ink-60); justify-content: center; }
	.sheet__item .icon { color: var(--ink-60); }
	.sheet__item--danger .icon { color: var(--danger); }
	.sheet__item + .sheet__item { margin-top: var(--sp-1); }
	/* 取消（退出类）与上面的删除拉开距离，避免想点取消却点到删除 */
	.sheet__item.sheet__item--muted { margin-top: var(--sp-3); }
	.sheet__actions { display: flex; gap: var(--sp-2); padding: var(--sp-3) 0 0; }
	.sheet__actions .btn { flex: 1; }

	/* 预览层与编辑器共用的抽屉外壳：移动端全屏、桌面端右侧停靠 */
	.panel {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		flex-direction: column;
		height: 100dvh;
		background: var(--surface);
		transform: translateY(100%);
		visibility: hidden;
		transition: transform 0.26s ease, visibility 0s linear 0.26s;
	}
	.panel.open { transform: translateY(0); visibility: visible; transition: transform 0.26s ease, visibility 0s; }
	.viewer__bar {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: calc(var(--sp-2) + env(safe-area-inset-top)) var(--sp-2) var(--sp-2) var(--sp-4);
		border-bottom: 1px solid var(--line);
	}
	.viewer__title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	/* 防误触：删除放最左、关闭放最右，中间隔着 复制链接/下载 与分隔线（边缘距离约 121px）；
	   相邻 44px 目标之间留 8px。删除按钮在触摸设备上常态即红色（触屏没有 hover） */
	.viewer__actions { display: flex; align-items: center; gap: var(--sp-2); }
	.panel__sep { width: 1px; height: 24px; background: var(--line); margin: 0 var(--sp-2); flex: none; }
	.icon-btn--danger { color: var(--danger); }
	.icon-btn--danger:hover { background: var(--danger-soft); color: var(--danger); }
	.icon-btn--primary { color: var(--accent); }
	.icon-btn--primary:hover { background: var(--accent-soft); color: var(--accent); }
	.icon-btn[disabled] { opacity: 0.5; cursor: default; }
	.viewer__body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: var(--sp-4); }
	.viewer--image .viewer__body,
	.viewer--video .viewer__body { display: flex; align-items: center; justify-content: center; padding: 0; }
	.viewer--image img,
	.viewer--video video { width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: contain; }
	.viewer--audio .viewer__body { display: flex; align-items: center; justify-content: center; }
	.viewer--audio audio { width: 100%; }

	.viewer__body pre.plain {
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
		font: 400 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}
	.md { max-width: 600px; }
	.md > :first-child { margin-top: 0; }
	.md h1 { font-size: 24px; }
	.md h2 { font-size: 18px; }
	.md h3 { font-size: 16px; }
	.md pre { background: var(--bg); padding: var(--sp-3); border-radius: var(--r-sm); overflow-x: auto; }
	.md code {
		background: var(--bg);
		padding: 2px 4px;
		border-radius: 4px;
		font: 400 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	}
	.md pre code { background: none; padding: 0; }
	.md blockquote { margin: 0 0 var(--sp-3); padding-left: var(--sp-3); border-left: 3px solid var(--line); color: var(--ink-80); }
	.md table { border-collapse: collapse; }
	.md th, .md td { border: 1px solid var(--line); padding: var(--sp-1) var(--sp-2); }
	.md img { max-width: 100%; }
	.md a { color: var(--accent); }

	/* 编辑器：复用 .panel 外壳；z-index 高于遮罩，编辑时不被压暗 */
	.editor { z-index: 67; }
	.editor__bar {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: calc(var(--sp-2) + env(safe-area-inset-top)) var(--sp-2) var(--sp-2) var(--sp-4);
		border-bottom: 1px solid var(--line);
	}
	.editor__title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.editor__body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		overflow-y: auto;
		/*padding: var(--sp-4);*/
	}
	.editor__field { display: flex; flex-direction: column; gap: var(--sp-1); }
	.editor__label { font-size: 13px; color: var(--ink-60); }
	.editor__input,
	.editor__text {
		width: 100%;
		min-height: var(--tap);
		padding: var(--sp-3);
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		background: var(--surface);
		color: var(--ink);
		font: inherit;
		font-size: 16px; /* ≥16px，避免 iOS 聚焦输入框时自动放大页面 */
	}
	.editor__input:focus,
	.editor__text:focus { border-color: var(--accent); outline: none; }
	.editor__text {
		flex: 1;
		min-height: 45dvh;
		resize: none;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		line-height: 1.6;
	}
	.editor__error, .editor__warn { margin: 0; font-size: 14px; color: var(--danger); }
	.editor__discard {
		display: flex;
		flex-direction: column;
		gap: var(--sp-1);
		padding: var(--sp-3);
		border: 1px solid var(--danger);
		border-radius: var(--r-md);
		background: var(--danger-soft);
	}
	.editor__discard > span { font-weight: 600; }

	.dropzone {
		position: fixed;
		inset: var(--sp-4);
		z-index: 70;
		display: grid;
		place-items: center;
		border: 2px dashed var(--accent);
		border-radius: var(--r-lg);
		background: rgba(236, 253, 245, 0.96);
		color: var(--accent);
		font-weight: 600;
		pointer-events: none;
	}

	.toast {
		position: fixed;
		left: 50%;
		bottom: calc(88px + env(safe-area-inset-bottom));
		z-index: 80;
		max-width: 90vw;
		transform: translateX(-50%);
		padding: var(--sp-3) var(--sp-4);
		border-radius: var(--r-md);
		background: var(--ink);
		color: #fff;
		font-size: 14px;
		box-shadow: 0 8px 24px rgba(15, 23, 42, 0.24);
	}

	@media (min-width: 640px) {
		.content { max-width: 760px; margin: 0 auto; width: 100%; }
		/* 顶栏保留整条背景与分隔线，只把内容对齐到 760px 主列 */
		.app-bar { padding-left: max(var(--sp-3), calc((100% - 760px) / 2)); padding-right: max(var(--sp-2), calc((100% - 760px) / 2)); }
		.sheet {
			left: 50%;
			right: auto;
			bottom: auto;
			top: 50%;
			width: min(420px, 92vw);
			border-radius: var(--r-lg);
			transform: translate(-50%, -46%) scale(0.98);
			transition: transform 0.18s ease, opacity 0.18s ease;
			opacity: 0;
		}
		.sheet.open { transform: translate(-50%, -50%) scale(1); opacity: 1; }
		.panel { inset: 0 0 0 auto; width: min(760px, 92vw); transform: translateX(100%); box-shadow: -8px 0 32px rgba(15, 23, 42, 0.16); }
		.panel.open { transform: translateX(0); }
	}
</style>
</head>
<body>
<!-- 图标：Material Design Icons（Apache-2.0，google/material-design-icons），内联为 sprite，
     避免 emoji 在 Windows/Linux 上字形不一致，也省掉额外请求 -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
	<symbol id="i-folder" viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></symbol>
	<symbol id="i-folder-open" viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/></symbol>
	<symbol id="i-file" viewBox="0 0 24 24"><path d="M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/></symbol>
	<symbol id="i-image" viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></symbol>
	<symbol id="i-video" viewBox="0 0 24 24"><path d="m18 4 2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></symbol>
	<symbol id="i-audio" viewBox="0 0 24 24"><path d="M12 3v9.28a4.39 4.39 0 0 0-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z"/></symbol>
	<symbol id="i-text" viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></symbol>
	<symbol id="i-markdown" viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></symbol>
	<symbol id="i-archive" viewBox="0 0 24 24"><path d="m20.54 5.23-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5 6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/></symbol>
	<symbol id="i-upload" viewBox="0 0 24 24"><path d="M5 20h14v-2H5v2zm0-10h4v6h6v-6h4l-7-7-7 7z"/></symbol>
	<symbol id="i-refresh" viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></symbol>
	<symbol id="i-close" viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></symbol>
	<symbol id="i-more" viewBox="0 0 24 24"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></symbol>
	<symbol id="i-eye" viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></symbol>
	<symbol id="i-download" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></symbol>
	<symbol id="i-link" viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></symbol>
	<symbol id="i-delete" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></symbol>
	<symbol id="i-warning" viewBox="0 0 24 24"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></symbol>
	<symbol id="i-add" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></symbol>
	<symbol id="i-save" viewBox="0 0 24 24"><path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></symbol>
	<symbol id="i-note-add" viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 14h-3v3h-2v-3H8v-2h3v-3h2v3h3v2zm-3-7V3.5L18.5 9H13z"/></symbol>
	<symbol id="i-edit" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></symbol>
</svg>
<div class="app"
	x-data="browser()"
	x-init="init()"
	x-effect="document.body.classList.toggle('locked', !!(viewer.open || sheet || confirmTarget || newMenu || editor.open))"
	@dragover.prevent="dragging = true"
	@dragleave="dragging = false"
	@drop.prevent="onDrop($event)">

	<header class="app-bar">
		<h1 class="sr-only">R2 Storage</h1>
		<nav class="crumbs" aria-label="路径" x-ref="crumbs">
			<template x-for="(crumb, index) in crumbs" :key="crumb.href">
				<span class="crumbs__part">
					<span class="crumb-sep" x-show="index > 0">/</span>
					<a class="crumb" :class="{ 'crumb--current': index === crumbs.length - 1 }" :href="crumb.href" x-text="crumb.label"></a>
				</span>
			</template>
		</nav>
		<button class="icon-btn" @click="load()" :disabled="loading" title="刷新" aria-label="刷新">
			<svg class="icon" aria-hidden="true"><use href="#i-refresh"></use></svg>
		</button>
	</header>

	<main class="content">
		<div x-show="loading" aria-hidden="true">
			<div class="list">
				<div class="skeleton"></div>
				<div class="skeleton"></div>
				<div class="skeleton"></div>
			</div>
		</div>

		<div class="state state--error" x-show="!loading && error">
			<span class="state__icon"><svg class="icon" aria-hidden="true"><use href="#i-warning"></use></svg></span>
			<p x-text="error"></p>
			<div class="state__actions">
				<button class="btn btn--ghost" @click="load()">重试</button>
			</div>
		</div>

		<div class="state" x-show="!loading && !error && entries.length === 0">
			<span class="state__icon"><svg class="icon" aria-hidden="true"><use href="#i-folder-open"></use></svg></span>
			<p>这个目录还是空的</p>
			<div class="state__actions">
				<button class="btn btn--ghost" @click="pickerRef().click()">上传第一个文件</button>
			</div>
		</div>

		<ul class="list" x-show="!loading && !error && entries.length > 0">
			<template x-for="entry in entries" :key="entry.href">
				<li class="row">
					<button class="row__main" @click="open(entry)" :title="entry.name">
						<span class="row__icon" :class="'row__icon--' + iconFor(entry)"><svg class="icon" aria-hidden="true"><use :href="'#i-' + iconFor(entry)"></use></svg></span>
						<span class="row__text">
							<span class="row__name" x-text="entry.name"></span>
							<span class="row__meta" x-text="metaFor(entry)"></span>
						</span>
					</button>
					<button class="icon-btn" @click="sheet = entry" :aria-label="'更多操作：' + entry.name">
						<svg class="icon" aria-hidden="true"><use href="#i-more"></use></svg>
					</button>
				</li>
			</template>
		</ul>
	</main>

	<button class="fab" @click="newMenu = true">
		<svg class="icon" aria-hidden="true"><use href="#i-add"></use></svg><span>新建</span>
	</button>
	<input type="file" multiple x-ref="picker" @change="onPick($event)" aria-hidden="true" tabindex="-1"
		style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">

	<div class="backdrop" :class="{ open: !!(sheet || confirmTarget || newMenu || editor.open) }"
		@click="sheet = null; confirmTarget = null; newMenu = false"></div>

	<template x-if="newMenu">
		<div class="sheet open" role="dialog" aria-modal="true" aria-label="新建">
			<span class="sheet__title">新建</span>
			<button class="sheet__item" @click="newMenu = false; pickerRef().click()">
				<svg class="icon" aria-hidden="true"><use href="#i-upload"></use></svg><span>上传文件</span>
			</button>
			<button class="sheet__item" @click="openEditor()">
				<svg class="icon" aria-hidden="true"><use href="#i-note-add"></use></svg><span>新建文本文件</span>
			</button>
			<button class="sheet__item sheet__item--muted" @click="newMenu = false">取消</button>
		</div>
	</template>

	<template x-if="sheet">
		<div class="sheet open" role="dialog" aria-modal="true" :aria-label="sheet.name">
			<span class="sheet__title" x-text="sheet.name"></span>
			<button class="sheet__item" x-show="sheet.kind" @click="preview(sheet)">
				<svg class="icon" aria-hidden="true"><use href="#i-eye"></use></svg><span>预览</span>
			</button>
			<button class="sheet__item" x-show="sheet.kind === 'text' || sheet.kind === 'markdown'" @click="editExisting(sheet)">
				<svg class="icon" aria-hidden="true"><use href="#i-edit"></use></svg><span>编辑</span>
			</button>
			<a class="sheet__item" :href="sheet.href" :download="sheet.name">
				<svg class="icon" aria-hidden="true"><use href="#i-download"></use></svg><span>下载</span>
			</a>
			<button class="sheet__item" @click="copyLink(sheet)">
				<svg class="icon" aria-hidden="true"><use href="#i-link"></use></svg><span>复制链接</span>
			</button>
			<button class="sheet__item sheet__item--danger" @click="askDelete(sheet)">
				<svg class="icon" aria-hidden="true"><use href="#i-delete"></use></svg><span>删除</span>
			</button>
			<button class="sheet__item sheet__item--muted" @click="sheet = null">取消</button>
		</div>
	</template>

	<template x-if="confirmTarget">
		<div class="sheet open" role="dialog" aria-modal="true">
			<span class="sheet__title">删除 “<span x-text="confirmTarget.name"></span>” ？</span>
			<p class="state" style="padding: 0 var(--sp-3) var(--sp-4); text-align: left;"
				x-text="confirmTarget.isDir ? '目录及其中的所有文件都会被删除，无法撤销。' : '删除后无法撤销。'"></p>
			<div class="sheet__actions">
				<button class="btn btn--muted" @click="confirmTarget = null" :disabled="busy">取消</button>
				<button class="btn btn--danger" @click="remove()" :disabled="busy"
					x-text="busy ? '删除中…' : '删除'"></button>
			</div>
		</div>
	</template>

	<div class="panel viewer" :class="[viewer.open ? 'open' : '', 'viewer--' + viewer.kind]" role="dialog" aria-modal="true">
		<div class="viewer__bar">
			<span class="viewer__title" x-text="viewer.title"></span>
			<div class="viewer__actions">
				<button class="icon-btn icon-btn--danger" @click="askDelete(viewer.entry)" title="删除" aria-label="删除">
					<svg class="icon" aria-hidden="true"><use href="#i-delete"></use></svg>
				</button>
				<button class="icon-btn" @click="copyLink(viewer.entry)" title="复制链接" aria-label="复制链接">
					<svg class="icon" aria-hidden="true"><use href="#i-link"></use></svg>
				</button>
				<a class="icon-btn" :href="viewer.entry && viewer.entry.href" :download="viewer.entry && viewer.entry.name"
					title="下载" aria-label="下载">
					<svg class="icon" aria-hidden="true"><use href="#i-download"></use></svg>
				</a>
				<span class="panel__sep" aria-hidden="true"></span>
				<button class="icon-btn" @click="closeViewer()" aria-label="关闭预览">
					<svg class="icon" aria-hidden="true"><use href="#i-close"></use></svg>
				</button>
			</div>
		</div>
		<div class="viewer__body" x-ref="viewerBody">
			<template x-if="viewer.status === 'loading'">
				<p class="state">加载中…</p>
			</template>
			<template x-if="viewer.status === 'error'">
				<p class="state state--error" x-text="viewer.error"></p>
			</template>
			<template x-if="viewer.status === 'ready' && viewer.kind === 'image'">
				<img :src="viewer.href" :alt="viewer.title" @error="viewer.status = 'error'; viewer.error = '图片加载失败'">
			</template>
			<template x-if="viewer.status === 'ready' && viewer.kind === 'video'">
				<video :src="viewer.href" controls playsinline preload="metadata"
					@error="viewer.status = 'error'; viewer.error = '视频无法播放（或浏览器不支持该编码）'"></video>
			</template>
			<template x-if="viewer.status === 'ready' && viewer.kind === 'audio'">
				<audio :src="viewer.href" controls preload="metadata"
					@error="viewer.status = 'error'; viewer.error = '音频无法播放（或浏览器不支持该编码）'"></audio>
			</template>
			<template x-if="viewer.status === 'ready' && viewer.kind === 'text'">
				<pre class="plain" x-text="viewer.text"></pre>
			</template>
			<template x-if="viewer.status === 'ready' && viewer.kind === 'markdown'">
				<div class="md" x-html="viewer.html"></div>
			</template>
		</div>
	</div>

	<div class="panel editor" :class="{ open: editor.open }" role="dialog" aria-modal="true"
		:aria-label="editor.href ? '编辑 ' + editor.name : '新建文本文件'">
		<div class="editor__bar">
			<span class="editor__title" x-text="editor.href ? editor.name : '新建文本文件'"></span>
			<button class="icon-btn" :class="editor.conflict ? 'icon-btn--danger' : 'icon-btn--primary'"
				@click="saveEditor()" :disabled="editor.busy" title="保存" aria-label="保存">
				<svg class="icon" aria-hidden="true"><use href="#i-save"></use></svg>
			</button>
			<span class="panel__sep" aria-hidden="true"></span>
			<button class="icon-btn" @click="requestCloseEditor()" aria-label="关闭编辑器">
				<svg class="icon" aria-hidden="true"><use href="#i-close"></use></svg>
			</button>
		</div>
		<div class="editor__body">
			<!-- 编辑已有文件时标题已经显示文件名，且这里本来也不可改，就不重复占一行 -->
			<label class="editor__field" x-show="!editor.href">
				<span class="editor__label">文件名</span>
				<input class="editor__input" type="text" x-model="editor.name"
					placeholder="untitled.txt" autocomplete="off" autocapitalize="off" spellcheck="false">
			</label>
			<textarea class="editor__text" x-model="editor.text" spellcheck="false"
				placeholder="在这里输入内容…" @input="editor.dirty = true"></textarea>
			<p class="editor__error" x-show="editor.error" x-text="editor.error"></p>
			<p class="editor__warn" x-show="editor.conflict">同名文件已存在，再点一次保存会覆盖它。</p>
			<template x-if="editor.confirmDiscard">
				<div class="editor__discard">
					<span>有未保存的内容，确定放弃？</span>
					<div class="sheet__actions">
						<button class="btn btn--muted" @click="editor.confirmDiscard = false">继续编辑</button>
						<button class="btn btn--danger" @click="discardEditor()">放弃</button>
					</div>
				</div>
			</template>
		</div>
	</div>

	<div class="dropzone" x-show="dragging" x-transition.opacity>松手即可上传到当前目录</div>
	<div class="toast" x-show="toast" x-transition.opacity x-text="toast" role="status" aria-live="polite"></div>
</div>

<script>
	window.browser = function () {
		return {
			entries: [],
			loading: true,
			error: '',
			busy: false,
			dragging: false,
			toast: '',
			sheet: null,
			confirmTarget: null,
			newMenu: false,
			viewer: { open: false, entry: null, kind: '', title: '', href: '', status: 'loading', text: '', html: '', error: '' },
			editor: { open: false, href: '', name: '', text: '', contentType: null, dirty: false, conflict: false, busy: false, error: '', confirmDiscard: false },

			init() {
				this.load();
				this.scrollCrumbs();
				document.addEventListener('keydown', (event) => {
					if (event.key !== 'Escape') return;
					if (this.confirmTarget) this.confirmTarget = null;
					else if (this.sheet) this.sheet = null;
					else if (this.newMenu) this.newMenu = false;
					else if (this.editor.open) this.requestCloseEditor();
					else if (this.viewer.open) this.closeViewer();
				});
			},

			async load() {
				this.loading = true;
				this.error = '';
				try {
					const response = await fetch(location.pathname + '?format=json', {
						credentials: 'include',
						headers: { Accept: 'application/json' },
					});
					if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
					const data = await response.json();
					this.entries = data.entries;
				} catch (err) {
					this.error = '目录加载失败：' + err.message;
				} finally {
					this.loading = false;
				}
			},

			get crumbs() {
				const parts = decodeURIComponent(location.pathname).split('/').filter(Boolean);
				const trail = [{ label: '根目录', href: '/' }];
				let path = '';
				for (const part of parts) {
					path += '/' + part;
					trail.push({ label: part, href: path + '/' });
				}
				return trail;
			},

			/** 路径较深时把面包屑滚到末尾，保证当前目录始终可见。 */
			scrollCrumbs() {
				this.$nextTick(() => {
					const el = this.$refs.crumbs;
					if (el) el.scrollLeft = el.scrollWidth;
				});
			},

			iconFor(entry) {
				if (entry.isDir) return 'folder';
				if (entry.kind) return entry.kind;
				return /\.(zip|rar|7z|tar|gz|bz2|xz)$/i.test(entry.name) ? 'archive' : 'file';
			},

			metaFor(entry) {
				if (entry.isDir) return '目录';
				return this.formatSize(entry.size) + ' · ' + this.formatDate(entry.modified);
			},

			formatSize(bytes) {
				const units = ['B', 'KB', 'MB', 'GB', 'TB'];
				let value = bytes;
				let unit = 0;
				while (value >= 1024 && unit < units.length - 1) {
					value = value / 1024;
					unit++;
				}
				return (unit === 0 ? value : value.toFixed(1)) + ' ' + units[unit];
			},

			formatDate(iso) {
				const date = new Date(iso);
				const pad = (n) => String(n).padStart(2, '0');
				return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
			},

			pickerRef() {
				return this.$refs.picker;
			},

			open(entry) {
				if (entry.isDir) {
					location.href = entry.href;
					return;
				}
				if (entry.kind) this.preview(entry);
				else location.href = entry.href;
			},

			async preview(entry) {
				this.sheet = null;
				this.viewer = { open: true, entry, kind: entry.kind, title: entry.name, href: entry.href, status: 'loading', text: '', html: '', error: '' };

				if (entry.kind !== 'text' && entry.kind !== 'markdown') {
					this.viewer.status = 'ready';
					return;
				}

				try {
					const response = await fetch(entry.href, { credentials: 'include' });
					if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
					const text = await response.text();
					if (entry.kind === 'markdown') {
						await this.loadMarkdown();
						this.viewer.html = window.markdownit({ html: true, linkify: true, typographer: true, breaks: true }).render(text);
						this.viewer.status = 'ready';
						// 等 Alpine 把 HTML 写进 DOM 之后再画 mermaid 图
						await this.$nextTick();
						await this.renderMermaid();
					} else {
						this.viewer.text = text;
						this.viewer.status = 'ready';
					}
				} catch (err) {
					this.viewer.status = 'error';
					this.viewer.error = '预览失败：' + err.message;
				}
			},

			loadScript(src) {
				if (document.querySelector('script[src="' + src + '"]')) return Promise.resolve();
				return new Promise((resolve, reject) => {
					const script = document.createElement('script');
					script.src = src;
					script.onload = resolve;
					script.onerror = reject;
					document.head.appendChild(script);
				});
			},

			async loadMarkdown() {
				await this.loadScript('https://cdn.jsdelivr.net/npm/markdown-it@14.0.0/dist/markdown-it.min.js');
				await this.loadScript('https://cdn.jsdelivr.net/npm/mermaid@10.9.0/dist/mermaid.min.js');
			},

			// markdown-it 会把 mermaid 代码块渲染成 <pre><code>，这里换成 mermaid 节点再绘制。
			async renderMermaid() {
				if (!window.mermaid) return;
				const root = this.$refs.viewerBody && this.$refs.viewerBody.querySelector('.md');
				if (!root) return;
				root.querySelectorAll('code.language-mermaid').forEach((block) => {
					const container = document.createElement('div');
					container.className = 'mermaid';
					container.textContent = block.textContent;
					block.parentNode.replaceWith(container);
				});
				const nodes = root.querySelectorAll('.mermaid:not([data-processed])');
				if (nodes.length === 0) return;
				window.mermaid.initialize({ startOnLoad: false });
				await window.mermaid.run({ nodes });
			},

			closeViewer() {
				this.viewer.open = false;
				this.viewer.entry = null;
				this.viewer.href = '';
				this.viewer.html = '';
				this.viewer.text = '';
			},

			/** 打开编辑器：不传参为新建，传入 { href, name, text } 则编辑已有文件。 */
			openEditor(entry) {
				this.newMenu = false;
				this.sheet = null;
				this.editor = {
					open: true,
					href: entry ? entry.href : '',
					name: entry ? entry.name : 'untitled.txt',
					text: entry ? entry.text : '',
					// 编辑已有文件时沿用原 Content-Type，避免仅仅编辑一下就顺手改了它的元数据
					contentType: (entry && entry.contentType) || null,
					dirty: false,
					conflict: false,
					busy: false,
					error: '',
					confirmDiscard: false,
				};
			},

			/** 编辑已有文本文件：先取回内容再进编辑器。 */
			async editExisting(entry) {
				this.sheet = null;
				try {
					const response = await fetch(entry.href, { credentials: 'include' });
					if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
					this.openEditor({ href: entry.href, name: entry.name, text: await response.text(), contentType: entry.contentType });
				} catch (err) {
					this.notify('打开失败：' + err.message);
				}
			},

			requestCloseEditor() {
				// 有未保存内容时先确认一次，避免误点关闭丢掉刚写的东西
				if (this.editor.confirmDiscard) return this.discardEditor();
				if (this.editor.dirty && this.editor.text) this.editor.confirmDiscard = true;
				else this.discardEditor();
			},

			discardEditor() {
				this.editor.open = false;
				this.editor.confirmDiscard = false;
				this.editor.text = '';
			},

			async saveEditor() {
				const raw = this.editor.name.trim();
				if (!raw) {
					this.editor.error = '请填写文件名';
					return;
				}
				// 这段 JS 处在 TS 模板字符串里，'\\\\' 输出的才是浏览器看到的 '\\'（单个反斜杠）
				if (raw.includes('/') || raw.includes('\\\\')) {
					this.editor.error = '文件名不能包含斜杠';
					return;
				}
				// 没写扩展名时补 .txt，否则存完自己都预览不了
				const name = raw.includes('.') ? raw : raw + '.txt';
				const href = this.editor.href || location.pathname + encodeURIComponent(name);

				this.editor.busy = true;
				this.editor.error = '';
				try {
					// 新建时先探一下重名，避免默默覆盖掉已有文件
					if (!this.editor.href && !this.editor.conflict) {
						const probe = await fetch(href, { method: 'HEAD', credentials: 'include' });
						if (probe.ok) {
							this.editor.conflict = true;
							this.editor.name = name;
							return;
						}
					}
					const response = await fetch(href, {
						method: 'PUT',
						body: this.editor.text,
						credentials: 'include',
						headers: { 'Content-Type': this.editor.contentType || 'text/plain; charset=utf-8' },
					});
					if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
					this.discardEditor();
					this.notify('已保存 ' + name);
					await this.load();
				} catch (err) {
					this.editor.error = '保存失败：' + err.message;
				} finally {
					this.editor.busy = false;
				}
			},

			async copyLink(entry) {
				if (!entry) return;
				const url = location.origin + entry.href;
				this.sheet = null;
				try {
					await navigator.clipboard.writeText(url);
					this.notify('链接已复制');
				} catch {
					this.notify(url);
				}
			},

			/** 删除前先落到统一的应用内确认面板（列表和预览层共用）。 */
			askDelete(entry) {
				if (!entry) return;
				this.sheet = null;
				this.confirmTarget = entry;
			},

			async remove() {
				const target = this.confirmTarget;
				this.busy = true;
				try {
					const response = await fetch(target.href, { method: 'DELETE', credentials: 'include' });
					if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
					this.confirmTarget = null;
					// 被删掉的正好是当前预览的文件时，一并关掉预览层
					if (this.viewer.entry && this.viewer.entry.href === target.href) this.closeViewer();
					this.notify('已删除 ' + target.name);
					await this.load();
				} catch (err) {
					this.notify('删除失败：' + err.message);
				} finally {
					this.busy = false;
				}
			},

			onPick(event) {
				const files = Array.from(event.target.files || []);
				event.target.value = '';
				this.upload(files);
			},

			onDrop(event) {
				this.dragging = false;
				this.upload(Array.from(event.dataTransfer.files || []));
			},

			async upload(files) {
				if (files.length === 0) return;
				this.busy = true;
				let done = 0;
				for (const file of files) {
					this.notify('上传中 ' + (done + 1) + '/' + files.length + '：' + file.name);
					try {
						const response = await fetch(location.pathname + encodeURIComponent(file.name), {
							method: 'PUT',
							body: file,
							credentials: 'include',
						});
						if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
						done++;
					} catch (err) {
						this.busy = false;
						this.notify('上传失败 ' + file.name + '：' + err.message);
						await this.load();
						return;
					}
				}
				this.busy = false;
				this.notify('已上传 ' + done + ' 个文件');
				await this.load();
			},

			notify(message) {
				this.toast = message;
				clearTimeout(this.toastTimer);
				this.toastTimer = setTimeout(() => (this.toast = ''), 2400);
			},
		};
	};
</script>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js"></script>
</body>
</html>`;
