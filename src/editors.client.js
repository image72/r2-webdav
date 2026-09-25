/**
 * 外部编辑器（draw.io / Photopea）客户端 —— 弹窗宿主方案。
 *
 * 一个文件两个角色，按运行环境自动分派：
 *
 *   A) 主页面（文件列表，有 window.alpineScene 或 body 未挂宿主 DOM）：
 *      只提供 ext_of / canOpenInExternal / openExternal ——
 *      openExternal 用 window.open 弹出宿主页 /_app/editor-host?p=…&e=…。
 *      用户硬性要求：r2-webdav 页面内禁止嵌入/编辑，一律新开实例页。
 *
 *   B) 宿主页（/_app/editor-host，URL 带 ?p=&e=）：
 *      建 iframe 装编辑器实例，跑协议适配 + 同源 PUT 保存回路。
 *      draw.io：官方 embed JSON 协议（opener||parent 均可，实测源码）；
 *      Photopea：官方 Live Messaging（仅 window.parent —— 所以必须 iframe）。
 *
 * 编辑器实例零改动；宿主页与 R2 同源，PUT 自带 Basic 凭据，If-Match 做冲突检测。
 */
(function () {
	'use strict';

	/** 与服务端注册表一致的放行扩展名。 */
	var EXTENSIONS = {
		drawio: ['drawio', 'xml'],
		photopea: ['psd', 'psb', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'svg'],
	};

	var IS_HOST_PAGE = /[?&]e=(drawio|photopea)/.test(location.search) && document.getElementById('host-frame') !== null;

	// =========================================================================
	// 角色 A：主页面 API（列表页调用）
	// =========================================================================

	var main_api = {
		ext_of: extension_of,
		canOpenInExternal: canOpenInExternal,
		externalEditorsFor: externalEditorsFor,
		/** entry, editorDef → 新标签页打开宿主页。返回 window 引用或 null（被拦截时）。 */
		openExternal: function (entry, editor) {
			var url = '/_app/editor-host?p=' + encodeURIComponent(entry.href) + '&e=' + editor.id;
			return window.open(url, '_blank');
		},
	};

	if (typeof window !== 'undefined') {
		window.external_editors = main_api;
	}

	function extension_of(name) {
		var dot = name.lastIndexOf('.');
		return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
	}

	function canOpenInExternal(entry, id) {
		if (!entry || entry.isDir) return false;
		var ext = extension_of(entry.name || '');
		if (id) return EXTENSIONS[id] !== undefined && EXTENSIONS[id].indexOf(ext) !== -1;
		return Object.keys(EXTENSIONS).some(function (k) {
			return EXTENSIONS[k].indexOf(ext) !== -1;
		});
	}

	function externalEditorsFor(entry) {
		if (!entry || entry.isDir) return [];
		var ext = extension_of(entry.name || '');
		return Object.keys(EXTENSIONS).filter(function (k) {
			return EXTENSIONS[k].indexOf(ext) !== -1;
		});
	}

	// =========================================================================
	// 角色 B：宿主页（?p=&e=）
	// =========================================================================

	if (IS_HOST_PAGE) {
		run_host_page();
	}

	function run_host_page() {
		var params = new URLSearchParams(location.search);
		/** 文件编码路径，如 /diagrams/smoke.drawio */
		var FILE_PATH = params.get('p') || '';
		var EDITOR_ID = params.get('e') || '';
		var FILE_NAME = '';
		try {
			FILE_NAME = decodeURIComponent(FILE_PATH.split('/').pop() || '');
		} catch (e) {
			FILE_NAME = FILE_PATH;
		}

		var state = { etag: null, saving: false };
		var el = {
			title: document.getElementById('host-title'),
			status: document.getElementById('host-status'),
			frame: document.getElementById('host-frame'),
			save: document.getElementById('host-save'),
			back: document.getElementById('host-back'),
		};

		function extension_of_host(name) {
			return extension_of(name);
		}

		function content_type_for(name) {
			var map = {
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
				xml: 'application/xml',
				drawio: 'application/xml',
			};
			return map[extension_of_host(name)] || 'application/octet-stream';
		}

		function setStatus(text) {
			el.status.textContent = text || '';
		}

		/** 同源 PUT。If-Match 带打开时 ETag → 期间被改过返回 412。 */
		function put_bytes(bytes, etag) {
			var headers = { 'Content-Type': content_type_for(FILE_NAME) };
			if (etag) headers['If-Match'] = etag;
			return fetch(FILE_PATH, { method: 'PUT', credentials: 'include', headers: headers, body: bytes });
		}

		/** 保存回路：字节 → PUT → 412 冲突 → 显示 Overwrite。成功刷新 etag。 */
		function handle_save_bytes(bytes) {
			if (state.saving) return;
			state.saving = true;
			setStatus('Saving…');
			put_bytes(bytes, state.etag)
				.then(function (resp) {
					if (resp.status === 412) {
						state.saving = false;
						el.save.hidden = false;
						el.save.textContent = 'Overwrite';
						el.save.dataset.mode = 'overwrite';
						el.save.dataset.pending = '1';
						setStatus('Modified remotely — Overwrite to force.');
						return;
					}
					if (!resp.ok) throw new Error('PUT ' + resp.status);
					state.etag = resp.headers.get('etag') || state.etag;
					state.saving = false;
					restore_save_button();
					setStatus('Saved ✓');
					setTimeout(function () {
						if (!el.save.dataset.mode) setStatus('');
					}, 1500);
				})
				.catch(function (err) {
					state.saving = false;
					setStatus('Save failed: ' + err.message);
				});
		}

		function restore_save_button() {
			el.save.hidden = EDITOR_ID !== 'photopea';
			el.save.textContent = 'Save';
			delete el.save.dataset.mode;
			delete el.save.dataset.pending;
		}

		/** 覆盖写：不带 If-Match。 */
		function force_save(bytes) {
			state.saving = true;
			setStatus('Overwriting…');
			put_bytes(bytes, null)
				.then(function (resp) {
					if (!resp.ok) throw new Error('PUT ' + resp.status);
					state.etag = resp.headers.get('etag') || state.etag;
					state.saving = false;
					restore_save_button();
					setStatus('Saved ✓');
					setTimeout(function () {
						if (!el.save.dataset.mode) setStatus('');
					}, 1500);
				})
				.catch(function (err) {
					state.saving = false;
					setStatus('Overwrite failed: ' + err.message);
				});
		}

		function find_editor(id) {
			var list = (window.__APP_CONFIG__ && window.__APP_CONFIG__.editors) || [];
			for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
			return null;
		}

		// ---------------------------------------------------------------------
		// Adapter：draw.io（官方 embed JSON 协议）
		// ---------------------------------------------------------------------

		/*
		 * 源码依据（EditorUi.js initializeEmbedMode）：var parent = window.opener ||
		 * window.parent —— 宿主页是弹窗时 parent 即弹窗自己，iframe 消息照常走通。
		 *   编辑器 → 宿主：{event:'init'} / {event:'save', xml, exit?}
		 *   宿主 → 编辑器：{action:'load', xml, autosave:1}（xml 必须是字符串本体）
		 */
		function drawio_adapter(editor_url) {
			el.frame.src =
				editor_url + '?embed=1&proto=json&splash=0&ui=min&chrome=0&lang=' + (navigator.language || 'en').slice(0, 2);

			var pending = null;
			var last_xml = null;

			function post(obj) {
				el.frame.contentWindow.postMessage(JSON.stringify(obj), '*');
			}

			function on_message(event) {
				if (event.source !== el.frame.contentWindow) return;
				var msg;
				try {
					msg = JSON.parse(event.data);
				} catch (e) {
					return;
				}
				if (msg.event === 'init' && pending !== null) {
					post({ action: 'load', xml: pending, autosave: 1 });
				} else if (msg.event === 'save') {
					last_xml = msg.xml || '';
					handle_save_bytes(last_xml);
				}
			}
			window.addEventListener('message', on_message);

			return {
				fetch_file: function () {
					return fetch(FILE_PATH, { credentials: 'include' }).then(function (r) {
						if (!r.ok) throw new Error('GET ' + r.status);
						state.etag = r.headers.get('etag') || null;
						return r.text();
					});
				},
				on_ready: function (xml) {
					pending = xml;
				},
				force_save: function () {
					if (last_xml !== null) force_save(last_xml);
				},
				destroy: function () {
					window.removeEventListener('message', on_message);
				},
			};
		}

		// ---------------------------------------------------------------------
		// Adapter：Photopea（官方 Live Messaging）
		// ---------------------------------------------------------------------

		/*
		 * 源码依据（pp*.js）：OE 出口固定 window.parent（全源码 0 处 opener），
		 * 所以编辑器必须以 iframe 嵌在弹窗里。
		 *   宿主 → PP：字符串（当脚本执行）或 ArrayBuffer（文件字节）
		 *   PP → 宿主："done"（就绪/脚本完成） / ArrayBuffer（saveToOE 产物）
		 */
		function photopea_adapter(editor_url) {
			el.frame.src = editor_url + '?';

			var extension = extension_of(FILE_NAME);
			var save_format = extension === 'psb' ? 'psb' : extension === 'tif' || extension === 'tiff' ? 'tiff' : extension;
			var byte_ready = null;
			var last_bytes = null;

			function run_script(script) {
				el.frame.contentWindow.postMessage(script, '*');
			}

			function on_message(event) {
				if (event.source !== el.frame.contentWindow) return;
				if (event.data instanceof ArrayBuffer) {
					last_bytes = event.data;
					handle_save_bytes(event.data);
					return;
				}
				if (typeof event.data === 'string' && event.data === 'done' && byte_ready) {
					var bytes = byte_ready;
					byte_ready = null;
					// 喂字节（PP 打开为活动文档），记录 source 便于排查。
					el.frame.contentWindow.postMessage(bytes, '*');
					el.frame.contentWindow.postMessage('app.activeDocument.source=' + JSON.stringify(FILE_PATH) + ';', '*');
					setStatus('');
				}
			}
			window.addEventListener('message', on_message);

			return {
				fetch_file: function () {
					return fetch(FILE_PATH, { credentials: 'include' }).then(function (r) {
						if (!r.ok) throw new Error('GET ' + r.status);
						state.etag = r.headers.get('etag') || null;
						return r.arrayBuffer();
					});
				},
				on_ready: function (bytes) {
					byte_ready = bytes;
				},
				save: function () {
					if (state.saving) return;
					setStatus('Exporting…');
					run_script('app.activeDocument.saveToOE(' + JSON.stringify(save_format) + ');');
				},
				force_save: function () {
					if (last_bytes !== null) force_save(last_bytes);
				},
				destroy: function () {
					window.removeEventListener('message', on_message);
				},
			};
		}

		// ---------------------------------------------------------------------
		// 启动
		// ---------------------------------------------------------------------

		var adapter = null;

		function boot() {
			el.title.textContent = FILE_NAME || FILE_PATH;
			var editor = find_editor(EDITOR_ID);
			if (!editor || !FILE_PATH || EXTENSIONS[EDITOR_ID] === undefined) {
				setStatus('Bad editor link.');
				return;
			}
			adapter = EDITOR_ID === 'drawio' ? drawio_adapter(editor.url) : photopea_adapter(editor.url);
			el.save.hidden = EDITOR_ID !== 'photopea';
			setStatus('Loading…');

			adapter
				.fetch_file()
				.then(function (bytes) {
					adapter.on_ready(bytes);
				})
				.catch(function (err) {
					setStatus('Open failed: ' + err.message);
				});
		}

		el.back.addEventListener('click', function () {
			// 脚本打开的窗口允许 self-close；被拦（直接输入 URL）就退 history。
			window.close();
			setTimeout(function () {
				if (!window.closed) history.back();
			}, 250);
		});

		el.save.addEventListener('click', function () {
			if (!adapter) return;
			if (el.save.dataset.mode === 'overwrite') {
				delete el.save.dataset.mode;
				adapter.force_save();
				return;
			}
			adapter.save();
		});

		boot();
	}
})();
