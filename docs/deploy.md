# 部署期细节与常见的坑

README 里的「部署到 Cloudflare」五步足够跑通部署；这一页收的是部署 / 构建期的背景细节，改代码或排查部署问题时再看。

- **`[[rules]]` 的 glob 是按绝对路径匹配的**，所以只能写 `**/*.html` 这种形式。写成 `src/index.html` 永远不命中，构建时报的错是 `No matching export in "..." for import "default"`，看不出跟 glob 有关。
- `/_app/archive.client.js`、`/_app/office.templates.js` 都是**代码路由**（和页面同一个 Worker，由 `src/ui.ts` 直接吐出），R2 里不能有同名 key。
- `compatibility_flags = ["nodejs_compat"]` 和 `wrangler.toml` 里那几条 `[[rules]]` 都要保留 —— 浏览器端脚本作为文本模块导入时依赖它们。
- 打包 / 解压上限 80 MB，只改 `src/archive.client.js` 里的 `ZIP_BYTE_LIMIT` 一处即可。
- 浏览器端依赖 CDN：Alpine.js、JSZip、markdown-it、mermaid 全部从 jsdelivr 拉取；内网或离线部署需要把这些依赖一并自托管。
