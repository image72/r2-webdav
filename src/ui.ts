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
	button, input, a { font: inherit; color: inherit; }
	:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

	.app { display: flex; flex-direction: column; min-height: 100dvh; }

	.app-bar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: calc(var(--sp-3) + env(safe-area-inset-top)) var(--sp-4) var(--sp-3);
		background: rgba(255, 255, 255, 0.92);
		-webkit-backdrop-filter: blur(8px);
		backdrop-filter: blur(8px);
		border-bottom: 1px solid var(--line);
	}
	.app-bar__title { flex: 1; min-width: 0; margin: 0; font-size: 18px; font-weight: 600; }
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
		overflow-x: auto;
		scrollbar-width: none;
		padding: var(--sp-2) var(--sp-4);
		background: var(--surface);
		border-bottom: 1px solid var(--line);
		font-size: 13px;
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
	.row__icon {
		display: grid;
		place-items: center;
		flex: none;
		width: 40px;
		height: 40px;
		border-radius: var(--r-sm);
		background: var(--accent-soft);
		font-size: 18px;
	}
	.row__text { min-width: 0; }
	.row__name { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.row__meta { display: block; font-size: 13px; color: var(--ink-60); }

	.skeleton { height: 64px; border-radius: var(--r-md); background: var(--surface); border: 1px solid var(--line); }
	.state { padding: var(--sp-8) var(--sp-4); text-align: center; color: var(--ink-60); }
	.state__emoji { display: block; font-size: 32px; margin-bottom: var(--sp-2); }
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
		z-index: 40;
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
		z-index: 50;
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
	.sheet__actions { display: flex; gap: var(--sp-2); padding: var(--sp-3) 0 0; }
	.sheet__actions .btn { flex: 1; }

	.viewer {
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
	.viewer.open { transform: translateY(0); visibility: visible; transition: transform 0.26s ease, visibility 0s; }
	.viewer__bar {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: calc(var(--sp-2) + env(safe-area-inset-top)) var(--sp-2) var(--sp-2) var(--sp-4);
		border-bottom: 1px solid var(--line);
	}
	.viewer__title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
		.crumbs { max-width: 760px; margin: 0 auto; }
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
		.viewer { inset: 0 0 0 auto; width: min(760px, 92vw); transform: translateX(100%); box-shadow: -8px 0 32px rgba(15, 23, 42, 0.16); }
		.viewer.open { transform: translateX(0); }
	}
</style>
</head>
<body>
<div class="app"
	x-data="browser()"
	x-init="init()"
	x-effect="document.body.classList.toggle('locked', !!(viewer.open || sheet || confirmTarget))"
	@dragover.prevent="dragging = true"
	@dragleave="dragging = false"
	@drop.prevent="onDrop($event)">

	<header class="app-bar">
		<h1 class="app-bar__title">R2 Storage</h1>
		<button class="icon-btn" @click="load()" :disabled="loading" title="刷新" aria-label="刷新">⟳</button>
	</header>

	<nav class="crumbs" aria-label="路径">
		<template x-for="(crumb, index) in crumbs" :key="crumb.href">
			<span class="crumbs__part">
				<span class="crumb-sep" x-show="index > 0">/</span>
				<a class="crumb" :class="{ 'crumb--current': index === crumbs.length - 1 }" :href="crumb.href" x-text="crumb.label"></a>
			</span>
		</template>
	</nav>

	<main class="content">
		<div x-show="loading" aria-hidden="true">
			<div class="list">
				<div class="skeleton"></div>
				<div class="skeleton"></div>
				<div class="skeleton"></div>
			</div>
		</div>

		<div class="state state--error" x-show="!loading && error">
			<span class="state__emoji">⚠️</span>
			<p x-text="error"></p>
			<button class="btn btn--ghost" @click="load()">重试</button>
		</div>

		<div class="state" x-show="!loading && !error && entries.length === 0">
			<span class="state__emoji">📂</span>
			<p>这个目录还是空的</p>
			<button class="btn btn--ghost" @click="pickerRef().click()">上传第一个文件</button>
		</div>

		<ul class="list" x-show="!loading && !error && entries.length > 0">
			<template x-for="entry in entries" :key="entry.href">
				<li class="row">
					<button class="row__main" @click="open(entry)" :title="entry.name">
						<span class="row__icon" x-text="iconFor(entry)"></span>
						<span class="row__text">
							<span class="row__name" x-text="entry.name"></span>
							<span class="row__meta" x-text="metaFor(entry)"></span>
						</span>
					</button>
					<button class="icon-btn" @click="sheet = entry" :aria-label="'更多操作：' + entry.name">⋯</button>
				</li>
			</template>
		</ul>
	</main>

	<button class="fab" @click="pickerRef().click()">
		<span aria-hidden="true">⬆️</span><span>上传</span>
	</button>
	<input type="file" multiple x-ref="picker" @change="onPick($event)" aria-hidden="true" tabindex="-1"
		style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">

	<div class="backdrop" :class="{ open: !!(sheet || confirmTarget) }"
		@click="sheet = null; confirmTarget = null"></div>

	<template x-if="sheet">
		<div class="sheet open" role="dialog" aria-modal="true" :aria-label="sheet.name">
			<span class="sheet__title" x-text="sheet.name"></span>
			<button class="sheet__item" x-show="sheet.kind" @click="preview(sheet)">
				<span aria-hidden="true">👁</span><span>预览</span>
			</button>
			<a class="sheet__item" :href="sheet.href" :download="sheet.name">
				<span aria-hidden="true">⬇️</span><span>下载</span>
			</a>
			<button class="sheet__item" @click="copyLink(sheet)">
				<span aria-hidden="true">🔗</span><span>复制链接</span>
			</button>
			<button class="sheet__item sheet__item--danger" @click="confirmTarget = sheet; sheet = null">
				<span aria-hidden="true">🗑</span><span>删除</span>
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

	<div class="viewer" :class="[viewer.open ? 'open' : '', 'viewer--' + viewer.kind]" role="dialog" aria-modal="true">
		<div class="viewer__bar">
			<span class="viewer__title" x-text="viewer.title"></span>
			<button class="icon-btn" @click="closeViewer()" aria-label="关闭预览">✕</button>
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
			viewer: { open: false, kind: '', title: '', href: '', status: 'loading', text: '', html: '', error: '' },

			init() {
				this.load();
				document.addEventListener('keydown', (event) => {
					if (event.key !== 'Escape') return;
					if (this.confirmTarget) this.confirmTarget = null;
					else if (this.sheet) this.sheet = null;
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

			iconFor(entry) {
				if (entry.isDir) return '📁';
				return { image: '🖼', video: '🎬', audio: '🎵', markdown: '📝', text: '📄' }[entry.kind] || '📦';
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
				this.viewer = { open: true, kind: entry.kind, title: entry.name, href: entry.href, status: 'loading', text: '', html: '', error: '' };

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
				this.viewer.href = '';
				this.viewer.html = '';
				this.viewer.text = '';
			},

			async copyLink(entry) {
				const url = location.origin + entry.href;
				this.sheet = null;
				try {
					await navigator.clipboard.writeText(url);
					this.notify('链接已复制');
				} catch {
					this.notify(url);
				}
			},

			async remove() {
				const target = this.confirmTarget;
				this.busy = true;
				try {
					const response = await fetch(target.href, { method: 'DELETE', credentials: 'include' });
					if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
					this.confirmTarget = null;
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
