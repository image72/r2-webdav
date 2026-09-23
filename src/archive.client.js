/**
 * 目录打包下载 —— 纯浏览器实现，完全不经过 Worker。
 *
 * 为什么单独一个文件：这块最容易出问题（内存、CDN、zip 工具兼容性），万一不值得留，
 * 删掉本文件 + index.html 里那一行 `<script>` 就能彻底摘干净，页面本身不受影响。
 * 所以这里**不引用页面的任何状态**，只通过 hooks 与外界通信：
 *
 *   R2Archive.downloadFolderAsZip(entry, { onProgress, signal })
 *
 * 将来若把实现换成 Web Worker，只要这套接口不动，index.html 一行都不用改。
 *
 * 关于 Web Worker（结论：现在不上）：JSZip 自身是单线程的 —— 它源码里那些 `*Worker.js`
 * 是内部的流式管道类，和 Web Worker 没有关系，`new Worker(` 在它仓库里一次都没出现；
 * 压缩/解压来自单线程的 pako。搬进 worker 不会更快，只是把主线程空出来、并把「取消」
 * 变成 terminate()。而当前用 STORE 压缩几乎没有 CPU 开销，瓶颈是 N 次请求的往返，
 * 所以真正的杠杆在并发度上（见 CONCURRENCY）。
 */
(function () {
	'use strict';

	const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

	/**
	 * 浏览器内打包的字节上限。
	 *
	 * JSZip 会把每个条目一直留在内存里，直到 generateAsync 结束，所以峰值内存大致等于
	 * 目录总大小。没有上限的话，一个几百 MB 的目录能把标签页拖死（而不是报错）。
	 * 超过就明确拒绝，让用户去打包子目录。
	 */
	const ZIP_BYTE_LIMIT = 256 * 1024 * 1024;

	const PROPFIND_BODY =
		'<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/></prop></propfind>';

	/** 惰性加载 JSZip：真的用到才拉（和页面里 markdown-it / mermaid 的做法一致）。 */
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
	 * 去掉 href 里的 `scheme://authority`，只留路径（RFC 4918 允许 href 是绝对 URI）。
	 *
	 * 刻意**不用 `new URL()`**：URL 解析器会把 `.` / `..` / `%2E%2E` 这些路径段折叠掉，
	 * 一个名字带 `..` 的对象会在比较前缀时就被悄悄丢掉，打包结果少了东西而用户完全
	 * 看不出来。自己切前缀，这种名字才能落到下面那道检查上被明确拒绝。
	 */
	const strip_origin = (href) => href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');

	/** 自带的体积格式化：模块要保持自包含，不依赖页面里的同名方法。 */
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

	/**
	 * 取一棵子树的清单。
	 *
	 * 用 `Depth: infinity` 的 PROPFIND —— 服务端已有的实现，一个请求就能拿到整个层级；
	 * 而且它已经过滤掉 `._*` 影子文件，与列表页看到的保持一致，不用客户端再筛一遍。
	 *
	 * 解析用 getElementsByTagNameNS（按「命名空间 + 本地名」匹配）而不是 querySelector，
	 * 这样服务端把前缀从默认命名空间换成 D: 也照样能解析。
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

		// 服务端对象数超限时只返回一部分。静默少内容比直接失败糟得多：用户会以为备份完整，
		// 然后删掉原件。宁可拒绝也不产出一个不完整的 zip。
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
			// 以目录前缀（带斜杠）匹配：`/sub/` 不会误收 `/sub-x/`
			if (!path.startsWith(base)) continue;

			// 目录自己那一条（href 就是 base）没有后缀
			const tail = path.slice(base.length).replace(/\/+$/, '');
			if (!tail) continue;

			let relative;
			try {
				relative = decodeURIComponent(tail);
			} catch {
				// 名字解不出来就没法给它一个条目名。宁可整个失败，也不能少放一个文件
				// 还告诉用户「已打包」—— 用户可能就此拿这个 zip 当备份。
				throw new Error('目录清单里有无法解码的名字（' + tail + '），拒绝打包');
			}

			// R2 的 key 是任意字符串，能包含 `..`。带着它生成 zip 等于把
			// 「解压时写到目标目录之外」的路径写进文件里，不赌解压工具会消毒。
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

	/** 触发浏览器下载。blob URL 要延后回收，见 download_folder_as_zip 里的说明。 */
	function save_blob(blob, filename) {
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
		// blob URL 会一直钉住整个 zip 占的内存，直到页面关闭或显式回收。
		// 给下载留足启动时间再回收（立即回收会打断尚未开始的下载）。
		setTimeout(() => URL.revokeObjectURL(url), 60000);
	}

	/**
	 * 把一个目录打包成 zip 交给浏览器下载。
	 *
	 * @param {{ name: string, href: string }} entry
	 * @param {{ onProgress?: (text: string) => void, signal?: AbortSignal }} hooks
	 * @returns {Promise<{ files: number }>}
	 */
	async function download_folder_as_zip(entry, hooks) {
		const onProgress = (hooks && hooks.onProgress) || function () {};
		const signal = hooks && hooks.signal;

		onProgress('正在读取目录…');
		const tree = await fetch_tree(entry.href, signal);

		const total = tree.files.reduce((sum, file) => sum + file.size, 0);
		if (total > ZIP_BYTE_LIMIT) {
			throw new Error('共 ' + format_size(total) + '，超过 ' + format_size(ZIP_BYTE_LIMIT) + ' 的浏览器内打包上限');
		}

		const JSZip = await load_jszip();
		const zip = new JSZip();
		// 和 Finder 的「压缩」一致：zip 里保留目录本身这一层
		const root = zip.folder(entry.name);
		// 空目录不会因为子文件而自动出现，必须显式写一条，否则空目录会被静默丢掉
		for (const dir of tree.dirs) root.folder(dir);

		let done = 0;
		for (const file of tree.files) {
			// 一次只下一个：进度干净，峰值内存也最低（反正 JSZip 都会留着）
			done++;
			onProgress('打包中 ' + done + '/' + tree.files.length + '…');
			const response = await fetch(file.href, { credentials: 'include', signal });
			if (!response.ok) throw new Error(file.path + ' 读取失败：' + response.status);
			root.file(file.path, await response.blob());
		}

		onProgress('正在生成 zip…');
		// streamFiles 保持默认的 false：置 true 虽然省内存，但条目会用「数据描述符」写在末尾，
		// 部分解压工具（尤其 Windows 资源管理器）不接受这种 zip。
		const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
			onProgress('正在生成 zip… ' + Math.round(meta.percent) + '%');
		});

		save_blob(blob, entry.name + '.zip');
		return { files: tree.files.length };
	}

	window.R2Archive = {
		downloadFolderAsZip: download_folder_as_zip,
		ZIP_BYTE_LIMIT: ZIP_BYTE_LIMIT,
	};
})();
