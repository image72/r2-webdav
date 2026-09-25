/**
 * 外部编辑器客户端脚本 —— 顶层直开方案。
 *
 * r2-webdav 页面与窗口内**零编辑器 UI**（用户硬性要求）：
 *   - draw.io：window.open 弹实例页；本页作为 opener 参与官方 embed JSON 协议
 *     （init → load → autosave/save），xml 全程在 opener 与编辑器之间流动。
 *   - Photopea：先要签名会话（服务端发读/写短链），再 window.open 到
 *     `pp实例/#<JSON>`；PP 自己拉文件、自己把保存的字节 POST 回我们的写端点。
 *     本页对 PP **零 postMessage**。
 *
 * 两个实例都是官方原版、零修改。
 */
(function () {
	'use strict';

	// -----------------------------------------------------------------------
	// 页面 API（index.html 的 Alpine 组件调用）
	// -----------------------------------------------------------------------

	var api = {
		ext_of: extension_of,
		canOpenInExternal: canOpenInExternal,
		openExternal: openExternal,
	};

	if (typeof window !== 'undefined') {
		window.external_editors = api;
	}

	function extension_of(name) {
		var dot = name.lastIndexOf('.');
		return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
	}

	/** 这个文件能不能用外部编辑器打开（id 缺省 = 任一编辑器放行即可）。 */
	function canOpenInExternal(entry, id) {
		if (!entry || entry.isDir) return false;
		var ext = extension_of(entry.name || '');
		if (!ext) return false;
		var editors = (window.__APP_CONFIG__ && window.__APP_CONFIG__.editors) || [];
		if (id) {
			var def = null;
			for (var i = 0; i < editors.length; i++) if (editors[i].id === id) def = editors[i];
			return !!def && def.extensions.indexOf(ext) !== -1;
		}
		for (var j = 0; j < editors.length; j++) {
			if (editors[j].extensions.indexOf(ext) !== -1) return true;
		}
		return false;
	}

	// -----------------------------------------------------------------------
	// 分派
	// -----------------------------------------------------------------------

	function openExternal(entry, editor, hooks) {
		if (editor.id === 'drawio') return open_drawio(entry, editor, hooks || {});
		if (editor.id === 'photopea') return open_photopea(entry, editor, hooks || {});
	}

	// -----------------------------------------------------------------------
	// draw.io：opener 模式 embed JSON 协议
	// -----------------------------------------------------------------------

	/*
	 * 源码依据（EditorUi.js）：
	 *   initializeEmbedMode: var parent = window.opener || window.parent
	 *     → 弹窗顶层的 opener 就是我们这页。
	 *   installMessageHandler:
	 *     - 收 {action:'load', xml, autosave:1}
	 *     - 改动后自动发 createLoadMessage('autosave') + xml
	 *     - 用户 Ctrl+S / File→Save（embed 模式下 saveFile 直接向 opener 发）发 {event:'save', xml, exit?}
	 * 消息是 JSON 字符串，targetOrigin '*'（drawio 自己发的时候）。
	 *
	 * URL 参数：embed=1 + proto=json 只开启协议通道；**不要带 ui=min / chrome=0** ——
	 * 那两个会把菜单、工具栏、形状面板全剥掉，画布不可交互，变成纯预览。
	 * 默认主题下是全功能编辑器，保存走 embed 协议回 opener。
	 */
	function open_drawio(entry, editor, hooks) {
		var editor_url = editor.url.replace(/\/+$/, '') + '/';
		var win = window.open(
			editor_url + '?embed=1&proto=json&splash=0&autosave=1&lang=' + (navigator.language || 'en').slice(0, 2),
			'_blank',
		);
		if (!win) {
			if (hooks.notify) hooks.notify('popupBlocked');
			return;
		}

		var etag = null;
		var saving = false;
		var pending_xml = null; // fetch 完成前的 init 先落在这

		function fetch_file() {
			return fetch(entry.href, { credentials: 'include' }).then(function (resp) {
				if (!resp.ok) throw new Error('GET ' + resp.status);
				etag = resp.headers.get('etag');
				return resp.text();
			});
		}

		function save(xml, opts) {
			if (saving) return;
			saving = true;
			var headers = { 'Content-Type': 'application/xml' };
			if (etag) headers['If-Match'] = etag;
			fetch(entry.href, { method: 'PUT', credentials: 'include', headers: headers, body: xml })
				.then(function (resp) {
					saving = false;
					if (resp.status === 412) {
						// 远端已改：本轮放弃，提示用户重开（保存按钮在编辑器里，宿主只记账）。
						etag = null;
						if (hooks.notify) hooks.notify('conflict');
						return;
					}
					if (!resp.ok) throw new Error('PUT ' + resp.status);
					etag = resp.headers.get('etag') || etag;
					if (hooks.notify) hooks.notify('saved');
					if (opts && opts.exit) {
						try {
							win.close();
						} catch (e) {}
					}
				})
				.catch(function (err) {
					saving = false;
					if (hooks.notify) hooks.notify('saveFailed', { msg: String(err && err.message) });
				});
		}

		function on_message(event) {
			if (event.source !== win) return; // 只认我们弹的那个编辑器窗口
			var msg;
			try {
				msg = JSON.parse(event.data);
			} catch (e) {
				return;
			}
			if (msg.event === 'init') {
				if (pending_xml !== null) {
					win.postMessage(JSON.stringify({ action: 'load', xml: pending_xml, autosave: 1 }), '*');
					pending_xml = null;
				} else {
					fetch_file()
						.then(function (xml) {
							win.postMessage(JSON.stringify({ action: 'load', xml: xml, autosave: 1 }), '*');
						})
						.catch(function (err) {
							if (hooks.notify) hooks.notify('openFailed', { msg: String(err && err.message) });
						});
				}
			} else if (msg.event === 'autosave' || msg.event === 'save') {
				if (typeof msg.xml === 'string') save(msg.xml, { exit: msg.event === 'save' && msg.exit });
			}
		}
		window.addEventListener('message', on_message);

		// fetch 与 init 谁先到都成立：init 先到就等 fetch，fetch 先到就缓存。
		fetch_file()
			.then(function (xml) {
				pending_xml = xml;
			})
			.catch(function () {});

		// 窗口关了就摘监听，别留一堆死监听器
		var sweep = setInterval(function () {
			if (win.closed) {
				clearInterval(sweep);
				window.removeEventListener('message', on_message);
				if (hooks.onClose) hooks.onClose();
			}
		}, 1500);
	}

	// -----------------------------------------------------------------------
	// Photopea：官方 hash 启动配置（server POST 保存，零 postMessage）
	// -----------------------------------------------------------------------

	/*
	 * 源码依据（pp*.js）：
	 *   aqY: hash 内容 decodeURIComponent 后 JSON.parse（z=='p' 分支，官方支持）
	 *   n.files → G6({url}) → PP 自己 XHR 拉文件
	 *   n.server → azB → 所有打开文件的保存都 POST server.url
	 *     （k0.aFs，version 0：application/x-www-form-urlencoded，
	 *      p=<encodeURIComponent(JSON{source, versions:[{format, data:base64}]})>）
	 *   响应 JSON {newSource} 会回写文件 source；{message} 会 alert 给用户。
	 */
	function open_photopea(entry, editor, hooks) {
		var editor_url = editor.url.replace(/\/+$/, '') + '/';
		fetch('/editors/session?path=' + encodeURIComponent(decodeURIComponent(entry.href)), {
			credentials: 'include',
		})
			.then(function (resp) {
				if (!resp.ok) throw new Error('session ' + resp.status);
				return resp.json();
			})
			.then(function (session) {
				var hash = encodeURIComponent(JSON.stringify(session.config));
				var win = window.open(editor_url + '#' + hash, '_blank');
				if (!win && hooks.notify) hooks.notify('popupBlocked');
			})
			.catch(function (err) {
				if (hooks.notify) hooks.notify('openFailed', { msg: String(err && err.message) });
			});
	}
})();
