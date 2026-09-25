# draw.io 集成

`.drawio` / `.xml` 文件的操作面板里会出现「用 draw.io 打开」：新标签页直接打开 draw.io
全功能编辑器，加载文件内容，Ctrl+S 或 File→Save 存回 R2。**编辑器运行在你自己的 draw.io
实例上**，r2-webdav 页面与窗口内不出现任何编辑器界面。

## 配置

```toml
# wrangler.toml
[vars]
DRAWIO_EDITOR_URL = "https://<your-drawio-instance>/"
```

- 没有现成实例的话，直接用官方服务：`DRAWIO_EDITOR_URL = "https://draw.io"`（也可用
  [jgraph/drawio](https://github.com/jgraph/drawio) 自建一份，协议行为完全一致）。
- 注意 draw.io 官方站也在 Cloudflare 后面：**真人浏览器正常打开**，本仓库的集成
  （window.open + postMessage）走的就是真人浏览器路径，实测无影响。
- 跨源部署需要配 `SIGNING_SECRET`？**不需要** —— draw.io 不用签名短链，文件内容走
  `postMessage` 在列表页与编辑器之间传输，凭据是浏览器已缓存的 Basic。
- 不配 `DRAWIO_EDITOR_URL`，这个功能就完全不存在（按钮不出现）。

## 工作原理

```
r2-webdav 页面（opener，列表 UI 所在标签页）    draw.io 实例（新标签页，DRAWIO_EDITOR_URL）
  │                                                │
  ├─ window.open(editor?embed=1&proto=json) ──────▶│ 全功能编辑器（ui=min/chrome=0 会变预览，勿加）
  │◀─ {event:'init'} ─────────────────────────────┤
  ├─ GET 文件（自带 Basic）→ {action:'load',xml} ▶│
  │◀─ {event:'autosave',xml}（改动后自动）────────┤
  │◀─ {event:'save',xml,exit}（Ctrl+S / Save）────┤
  ├─ PUT 文件到 r2-webdav 原生 WebDAV（If-Match）  │
```

- `embed=1&proto=json` 是 draw.io 官方 embed 协议，与全功能编辑器不互斥。
- 保存走 `If-Match` 乐观锁：文件在别处被改过时回 412，界面提示「重新打开编辑器」。
- 支持 `.drawio` 与 `.xml`；vsdx/gliffy 这类「只进不出」的格式不放行（保存会变 XML）。

## 消息协议与 curl 自测

集成没有任何自建 HTTP 端点。文件内容靠 postMessage 在**两个标签页**之间传输 —— 发送方只有
`r2-webdav 页面（opener）` 与 `draw.io 实例（新标签页）` 两方，不经过任何服务器。消息都是
JSON **字符串**（targetOrigin 用 `'*'`，跨源可用）：

| 消息路径                                | 消息                                               | 说明                                    |
| --------------------------------------- | -------------------------------------------------- | --------------------------------------- |
| draw.io 实例 → r2-webdav 页面（opener） | `{"event":"init"}`                                 | 弹窗就绪，可以灌内容                    |
| r2-webdav 页面（opener）→ draw.io 实例  | `{"action":"load","xml":"<mxfile…>","autosave":1}` | 文件内容；`autosave:1` 开启改动回调     |
| draw.io 实例 → r2-webdav 页面（opener） | `{"event":"autosave","xml":"…"}`                   | 用户每次改动后自动发                    |
| draw.io 实例 → r2-webdav 页面（opener） | `{"event":"save","xml":"…","exit":true}`           | Ctrl+S / File→Save；`exit` 时保存后关窗 |

r2-webdav 页面（opener）侧的收发（`src/editors.client.js`）：

```js
win.postMessage(JSON.stringify({ action: 'load', xml: pending_xml, autosave: 1 }), '*');
// …
if (msg.event === 'autosave' || msg.event === 'save') {
	if (typeof msg.xml === 'string') save(msg.xml, { exit: msg.event === 'save' && msg.exit });
}
```

保存是 **r2-webdav 页面**收到 `{event:'save'}` / `{event:'autosave'}` 后，把 `xml` 对文件的
**原生 WebDAV 地址**直接 `PUT`（如 `PUT /diagrams/smoke.drawio`，带 `If-Match` 乐观锁）。
draw.io 集成**不走** `/editors/save/`（那是 Photopea 的签名保存端点，draw.io 用不上签名）——
用 curl 模拟保存就是标准 WebDAV 流程：

```bash
BASE=http://127.0.0.1:8790 ; AUTH=test:test

# 1. 拿当前内容与 etag
ETAG=$(curl -su $AUTH -I "$BASE/diagrams/smoke.drawio" | awk 'tolower($1)=="etag:"{print $2}' | tr -d '\r')
curl -su $AUTH "$BASE/diagrams/smoke.drawio" > /tmp/cur.drawio

# 2. 模拟 draw.io 实例保存（r2-webdav 页面收到 {event:'save'} 后执行的就是这个 PUT）：
#    消息体 = drawio XML 本身
printf '<mxfile><diagram name="Page-1"><mxGraphModel/></diagram></mxfile>' > /tmp/new.drawio
curl -su $AUTH -X PUT "$BASE/diagrams/smoke.drawio" \
	-H 'Content-Type: application/xml' \
	-H "If-Match: $ETAG" \
	--data-binary @/tmp/new.drawio -w '\n%{http_code}\n' # → 201

# 3. 冲突路径：文件被改过后复用旧 etag → 412（界面提示「重新打开编辑器」）
curl -su $AUTH -X PUT "$BASE/diagrams/smoke.drawio" \
	-H 'Content-Type: application/xml' -H "If-Match: $ETAG" \
	--data-binary @/tmp/new.drawio -o /dev/null -w '%{http_code}\n' # → 412
```

- 不带 `If-Match` 也能保存，但冲突检测就没了；`.drawio` 与 `.xml` 都走这条路。

细节在 `src/editors.ts` / `src/editors.client.js`。下线：删 `DRAWIO_EDITOR_URL` 即可，
按钮消失，其余代码不受影响。
