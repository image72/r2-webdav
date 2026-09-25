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
列表页 (opener)                                draw.io 新标签页
  │                                                │
  ├─ window.open(editor?embed=1&proto=json) ──────▶│ 全功能编辑器（ui=min/chrome=0 会变预览，勿加）
  │◀─ {event:'init'} ─────────────────────────────┤
  ├─ GET 文件（自带 Basic）→ {action:'load',xml} ▶│
  │◀─ {event:'autosave',xml}（改动后自动）────────┤
  │◀─ {event:'save',xml,exit}（Ctrl+S / Save）────┤
  ├─ PUT 文件（If-Match etag，412 提示冲突）       │
```

- `embed=1&proto=json` 是 draw.io 官方 embed 协议，与全功能编辑器不互斥。
- 保存走 `If-Match` 乐观锁：文件在别处被改过时回 412，界面提示「重新打开编辑器」。
- 支持 `.drawio` 与 `.xml`；vsdx/gliffy 这类「只进不出」的格式不放行（保存会变 XML）。

细节在 `src/editors.ts` / `src/editors.client.js`。下线：删 `DRAWIO_EDITOR_URL` 即可，
按钮消失，其余代码不受影响。
