/**
 * 目录打包 / 解压（纯浏览器实现，不经过 Worker）。
 *
 * 不引用页面任何状态，只通过 hooks 与外界通信：
 *
 *   R2Archive.downloadFolderAsZip(entry, { onProgress, signal })
 *   R2Archive.storeFolderAsZip(entry, { onProgress, signal })
 *   R2Archive.extractZipToFolder(entry, { onProgress, signal })
 *
 * 接口不变就可以整个换实现（甚至搬进 Web Worker），index.html 不用改。
 */
(function () {
	'use strict';

	const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

	/** 压缩 / 解压的字节上限；改上限只改这一处。 */
	const ZIP_BYTE_LIMIT = 80 * 1024 * 1024;

	/** 并发请求数上限；WebDAV 层一次调用最多 6 个同时连接。 */
	const CONCURRENCY = 4;

	const PROPFIND_BODY =
		'<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/></prop></propfind>';

	/** 惰性加载 JSZip。 */
	let jszip = null;

	async function load_jszip() {
		if (jszip) return jszip;
		if (!window.JSZip) {
			await new Promise((resolve, reject) => {
				const script = document.createElement('script');
				script.src = JSZIP_URL;
				script.onload = resolve;
				script.onerror = () => reject(new Error('JSZip 加载失败（CDN 不可达？）'));
				document.head.appendChild(script);
			});
		}
		if (!window.JSZip) throw new Error('JSZip 加载失败');
		jszip = window.JSZip;
		return jszip;
	}

	/**
	 * 去掉 href 里的 `scheme://authority`（RFC 4918 允许 href 是绝对 URI）。
	 * 不要改用 `new URL()`：它会折叠 `.` / `..` 路径段，含 `..` 的名字会被静默丢掉。
	 */
	const strip_origin = (href) => href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');

	function format_size(bytes) {
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let value = bytes;
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value = value / 1024;
			unit++;
		}
		return (unit === 0 ? value : value.toFixed(1)) + ' ' + units[unit];
	}

	const encode_path = (path) => path.split('/').map(encodeURIComponent).join('/');

	/**
	 * 条目的**声明**解压后大小：JSZip 的私有字段 `_data.uncompressedSize`。
	 * 取不到就返回 null，调用方退回「边解边算」的累计检查。
	 */
	function declared_size(item) {
		const size = item && item._data && item._data.uncompressedSize;
		return typeof size === 'number' && Number.isFinite(size) ? size : null;
	}

	/** 有界并发；任何一个任务失败后，要等在途任务收尾再抛错。 */
	async function map_concurrent(items, limit, worker) {
		let next = 0;
		let failure = null;
		const runner = async () => {
			while (failure === null && next < items.length) {
				const index = next++;
				try {
					await worker(items[index], index);
				} catch (err) {
					if (failure === null) failure = err;
				}
			}
		};
		const runners = [];
		for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(runner());
		await Promise.all(runners);
		if (failure !== null) throw failure;
	}

	async function mkcol(url, signal) {
		const response = await fetch(url, { method: 'MKCOL', credentials: 'include', signal });
		if (!response.ok) throw new Error(url + ' 建目录失败：' + response.status);
	}

	async function put_object(url, body, signal) {
		const response = await fetch(url, {
			method: 'PUT',
			credentials: 'include',
			signal,
			// 不覆盖已有对象：真出现 412 就如实报错。
			headers: {
				'Content-Type': body.type || 'application/octet-stream',
				'If-None-Match': '*',
			},
			body,
		});
		if (response.status === 412) throw new Error(url + ' 已存在（有其它客户端在同时写入）');
		if (!response.ok) throw new Error(url + ' 写入失败：' + response.status);
	}

	/** 删除一个资源（目录则递归）。刻意不接受 signal。 */
	async function remove_path(url) {
		try {
			const response = await fetch(url, { method: 'DELETE', credentials: 'include' });
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * 取一棵子树的清单：`Depth: infinity` 的 PROPFIND（服务端已过滤掉影子文件）。
	 * 解析用 getElementsByTagNameNS，服务端换命名空间前缀也能解析。
	 */
	async function fetch_tree(href, signal) {
		const response = await fetch(href, {
			method: 'PROPFIND',
			credentials: 'include',
			signal,
			headers: { Depth: 'infinity', 'Content-Type': 'application/xml' },
			body: PROPFIND_BODY,
		});
		if (response.status !== 207) throw new Error('目录读取失败：' + response.status);

		// 清单被截断时必须失败，不能产出不完整的 zip。
		if (response.headers.get('x-webdav-truncated') === 'true') {
			throw new Error('目录成员过多，服务端只能返回一部分清单，请分别打包子目录');
		}

		const doc = new DOMParser().parseFromString(await response.text(), 'application/xml');
		if (!doc.documentElement || doc.documentElement.localName !== 'multistatus') {
			throw new Error('目录清单解析失败');
		}

		const base = strip_origin(href).replace(/\/?$/, '/');
		const dirs = [];
		const files = [];
		for (const item of doc.getElementsByTagNameNS('DAV:', 'response')) {
			const node = item.getElementsByTagNameNS('DAV:', 'href')[0];
			if (!node) continue;
			const path = strip_origin(node.textContent.trim());
			// 带斜杠匹配前缀：`/sub/` 不会误收 `/sub-x/`
			if (!path.startsWith(base)) continue;

			const tail = path.slice(base.length).replace(/\/+$/, '');
			if (!tail) continue;

			let relative;
			try {
				relative = decodeURIComponent(tail);
			} catch {
				// 名字解不出来就拒绝打包，绝不产出不完整的结果。
				throw new Error('目录清单里有无法解码的名字（' + tail + '），拒绝打包');
			}

			// 含 `..` 的名字不能写进 zip。
			if (relative.split('/').includes('..')) {
				throw new Error('目录里有名字含 .. 的对象（' + relative + '），拒绝打包');
			}

			if (item.getElementsByTagNameNS('DAV:', 'collection').length > 0) {
				dirs.push(relative);
				continue;
			}
			const raw = item.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent;
			const size = Number(raw ?? 0);
			files.push({ path: relative, href: path, size: Number.isFinite(size) ? size : 0 });
		}
		return { dirs, files };
	}

	/** 触发浏览器下载。 */
	function save_blob(blob, filename) {
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
		// 立即 revoke 会打断尚未开始的下载，延后回收。
		setTimeout(() => URL.revokeObjectURL(url), 60000);
	}

	/**
	 * 把一个目录打成 zip（全部在内存里）。
	 *
	 * @param {{ name: string, href: string }} entry
	 * @param {{ onProgress?: (text: string) => void, signal?: AbortSignal }} hooks
	 * @returns {Promise<{ blob: Blob, files: number }>}
	 */
	async function build_zip(entry, hooks) {
		const onProgress = (hooks && hooks.onProgress) || function () {};
		const signal = hooks && hooks.signal;

		onProgress('正在读取目录…');
		const tree = await fetch_tree(entry.href, signal);

		const total = tree.files.reduce((sum, file) => sum + file.size, 0);
		if (total > ZIP_BYTE_LIMIT) {
			throw new Error(
				'目录内容共 ' + format_size(total) + '，超过 ' + format_size(ZIP_BYTE_LIMIT) + ' 的压缩上限，请分次压缩子目录',
			);
		}

		const JSZip = await load_jszip();
		const zip = new JSZip();
		// 保留目录本身这一层（同 Finder），extract 会在结构对得上时收回去。
		const root = zip.folder(entry.name);
		// 空目录要显式写一条。
		for (const dir of tree.dirs) root.folder(dir);

		let done = 0;
		await map_concurrent(tree.files, CONCURRENCY, async (file) => {
			const response = await fetch(file.href, { credentials: 'include', signal });
			if (!response.ok) throw new Error(file.path + ' 读取失败：' + response.status);
			root.file(file.path, await response.blob());
			done++;
			onProgress('打包中 ' + done + '/' + tree.files.length + '…');
		});

		onProgress('正在生成 zip…');
		// 不要开 streamFiles：数据描述符写在末尾，部分解压工具（Windows 资源管理器）不接受。
		const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
			onProgress('正在生成 zip… ' + Math.round(meta.percent) + '%');
		});

		return { blob: blob, files: tree.files.length };
	}

	/** 压缩并直接下载，服务器上不留东西。 */
	async function download_folder_as_zip(entry, hooks) {
		const result = await build_zip(entry, hooks);
		save_blob(result.blob, entry.name + '.zip');
		return result;
	}

	/**
	 * 压缩并在当前目录生成真实的 `<目录名>.zip` 对象（不下载）。
	 * 代价是整个 zip 要额外上传一遍。
	 *
	 * @param {{ name: string, href: string }} entry
	 * @param {{ onProgress?: (text: string) => void, signal?: AbortSignal }} hooks
	 * @returns {Promise<{ files: number, bytes: number, href: string }>}
	 */
	async function store_folder_as_zip(entry, hooks) {
		const onProgress = (hooks && hooks.onProgress) || function () {};
		const signal = hooks && hooks.signal;

		// 目录 href 形如 `/a/b/`，zip 放到它的父目录下。
		const base = strip_origin(entry.href).replace(/\/+$/, '');
		const parent = base.slice(0, base.lastIndexOf('/') + 1);
		const target = parent + encode_path(entry.name + '.zip');

		// 不覆盖已有对象，也不静默改名。
		const existing = await fetch(target, {
			method: 'PROPFIND',
			credentials: 'include',
			signal,
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPFIND_BODY,
		});
		if (existing.ok) {
			throw new Error('已存在 ' + entry.name + '.zip，请先删除或改名');
		}

		const result = await build_zip(entry, hooks);
		try {
			onProgress('正在上传 ' + entry.name + '.zip…');
			await put_object(target, result.blob, signal);
		} catch (err) {
			// 失败或取消就清掉它，否则下次压缩会撞上「已存在」。
			const cleaned = await remove_path(target);
			const suffix = cleaned
				? '（已清掉不完整的 ' + entry.name + '.zip）'
				: '（注意：服务器上可能留有 ' + entry.name + '.zip）';
			if (signal && signal.aborted) throw new Error('已取消' + suffix);
			throw new Error((err && err.message ? err.message : String(err)) + suffix);
		}
		return { files: result.files, bytes: result.blob.size, href: target };
	}

	/**
	 * 把一个 zip 解压到与它同名的目录里；目标目录必须不存在，中途失败会整个删掉。
	 *
	 * @param {{ name: string, href: string, size: number }} entry
	 * @param {{ onProgress?: (text: string) => void, signal?: AbortSignal }} hooks
	 * @returns {Promise<{ files: number, dirs: number }>}
	 */
	async function extract_zip_to_folder(entry, hooks) {
		const onProgress = (hooks && hooks.onProgress) || function () {};
		const signal = hooks && hooks.signal;

		// 先按列表接口给出的公开信息挡掉超大包。
		if (entry.size > ZIP_BYTE_LIMIT) {
			throw new Error(
				entry.name + ' 有 ' + format_size(entry.size) + '，超过 ' + format_size(ZIP_BYTE_LIMIT) + ' 的解压上限',
			);
		}

		const target = entry.href.replace(/\.zip$/i, '') + '/';
		const base_name = entry.name.replace(/\.zip$/i, '');

		onProgress('正在读取 ' + entry.name + '…');
		const response = await fetch(entry.href, { credentials: 'include', signal });
		if (!response.ok) throw new Error('读取失败：' + response.status);
		const archive = await response.blob();

		const JSZip = await load_jszip();
		let zip;
		try {
			zip = await JSZip.loadAsync(archive);
		} catch (err) {
			throw new Error('不是有效的 zip 文件' + (err && err.message ? '（' + err.message + '）' : ''));
		}

		// 补全父目录：有些工具只写完整路径
		const dirs = new Set();
		let files = [];
		let declared_total = 0;
		const add_dir = (path) => {
			const parts = path.split('/').filter(Boolean);
			let acc = '';
			for (const part of parts) {
				acc = acc ? acc + '/' + part : part;
				dirs.add(acc);
			}
		};
		for (const name of Object.keys(zip.files)) {
			const item = zip.files[name];
			// 主动拒绝含 `..` 的条目：JSZip 会静默折叠，折叠后还可能重名。
			const original = item.unsafeOriginalName || name;
			if (original.split('/').includes('..')) {
				throw new Error('内含路径穿越的条目（' + original + '），拒绝解压');
			}
			const clean = name.replace(/\/+$/, '');
			if (!clean) continue;
			if (item.dir) {
				add_dir(clean);
				continue;
			}
			// path = 解压后路径，key = zip 里的键；剥掉顶层目录后两者不同。
			files.push({ path: clean, key: name });
			add_dir(clean.split('/').slice(0, -1).join('/'));

			const size = declared_size(item);
			if (size === null) declared_total = null;
			else if (declared_total !== null) declared_total += size;
		}
		if (files.length === 0 && dirs.size === 0) throw new Error('这个 zip 里没有任何条目');

		// 必须在解压前挡掉：累计检查要等条目进内存，那时已经晚了。
		if (declared_total !== null && declared_total > ZIP_BYTE_LIMIT) {
			throw new Error(
				'解压后约 ' + format_size(declared_total) + '，超过 ' + format_size(ZIP_BYTE_LIMIT) + ' 的解压上限，拒绝解压',
			);
		}

		// 剥掉与 zip 同名的唯一顶层目录，否则往返一次就多一层。
		const roots = new Set([...files.map((f) => f.path), ...dirs].map((path) => path.split('/')[0]));
		if (files.every((f) => f.path.includes('/')) && roots.size === 1 && roots.has(base_name)) {
			const strip = (path) => path.split('/').slice(1).join('/');
			files = files.map((f) => ({ path: strip(f.path), key: f.key }));
			const stripped = [];
			for (const dir of dirs) {
				const inner = strip(dir);
				if (inner) stripped.push(inner);
			}
			dirs.clear();
			for (const dir of stripped) dirs.add(dir);
		}

		const existing = await fetch(target, {
			method: 'PROPFIND',
			credentials: 'include',
			signal,
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPFIND_BODY,
		});
		if (existing.ok) {
			const kind = (await existing.text()).includes('<collection />') ? '目录' : '文件';
			throw new Error('已存在同名' + kind + ' ' + base_name + '，请先删除或改名');
		}

		onProgress('正在建目录…');
		await mkcol(target, signal);
		// 父目录必须先建：先建完所有目录再传文件，避免 PUT 自动补建与 MKCOL 相撞（405）。
		const by_depth = new Map();
		for (const dir of dirs) {
			const depth = dir.split('/').length;
			if (!by_depth.has(depth)) by_depth.set(depth, []);
			by_depth.get(depth).push(dir);
		}
		for (const depth of [...by_depth.keys()].sort((a, b) => a - b)) {
			await map_concurrent(by_depth.get(depth), CONCURRENCY, (dir) => mkcol(target + encode_path(dir) + '/', signal));
		}

		try {
			let done = 0;
			let total = 0;
			await map_concurrent(files, CONCURRENCY, async (file) => {
				const content = await zip.files[file.key].async('blob');
				// 累计上限：条目标称大小不可信。
				total += content.size;
				if (total > ZIP_BYTE_LIMIT) {
					throw new Error('解压后已超过 ' + format_size(ZIP_BYTE_LIMIT) + '，中止（可能是压缩炸弹）');
				}
				await put_object(target + encode_path(file.path), content, signal);
				done++;
				onProgress('解压中 ' + done + '/' + files.length + '…');
			});
		} catch (err) {
			const cleaned = await remove_path(target);
			const suffix = cleaned ? '（已清掉不完整的目录）' : '（注意：' + base_name + '/ 里可能留有内容不完整的残留）';
			if (signal && signal.aborted) throw new Error('已取消' + suffix);
			throw new Error((err && err.message ? err.message : String(err)) + suffix);
		}

		return { files: files.length, dirs: dirs.size };
	}

	window.R2Archive = {
		downloadFolderAsZip: download_folder_as_zip,
		storeFolderAsZip: store_folder_as_zip,
		extractZipToFolder: extract_zip_to_folder,
	};
})();
