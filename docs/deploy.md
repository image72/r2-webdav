# 部署期细节与常见的坑

README 里的「部署到 Cloudflare」五步足够跑通部署；这一页收的是部署 / 构建期的背景细节，改代码或排查部署问题时再看。

- **`[[rules]]` 的 glob 是按绝对路径匹配的**，所以只能写 `**/*.html` 这种形式。写成 `src/index.html` 永远不命中，构建时报的错是 `No matching export in "..." for import "default"`，看不出跟 glob 有关。
- `/_app/archive.client.js`、`/_app/editors.client.js` 都是**代码路由**（和页面同一个 Worker，由 `src/ui.ts` 直接吐出，源文件在 `src/_app/`），R2 里不能有同名 key。
- `compatibility_flags = ["nodejs_compat"]` 和 `wrangler.toml` 里那几条 `[[rules]]` 都要保留 —— 浏览器端脚本作为文本模块导入时依赖它们。
- 打包 / 解压上限 80 MB，只改 `src/_app/archive.client.js` 里的 `ZIP_BYTE_LIMIT` 一处即可。
- 浏览器端依赖 CDN：Alpine.js、JSZip、markdown-it、mermaid 全部从 jsdelivr 拉取；内网或离线部署需要把这些依赖一并自托管。

## 另一种用法：自带 webdav.ts 的极简 headless 入口

不想带整个项目、只要一个 R2 网盘时（效果同 `HEADLESS = "1"`，但代码完全自持）：

```toml
# wrangler.toml
main = "src/index.ts"
compatibility_date = "2023-10-16"

[[r2_buckets]]
binding = "bucket"
bucket_name = "webdav"
```

```typescript
// src/index.ts —— headless 入口，～20 行；同目录只需要本仓库的 webdav.ts + utils.ts
import { dispatch_handler } from './webdav';

export interface Env {
	bucket: R2Bucket;
	USERNAME: string;
	PASSWORD: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Basic 鉴权（webdav.ts 只讲协议，不管鉴权）；OPTIONS 在鉴权前放行
		const expected = `Basic ${btoa(`${env.USERNAME}:${env.PASSWORD}`)}`;
		if (request.method !== 'OPTIONS' && request.headers.get('Authorization') !== expected) {
			return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="webdav"' } });
		}
		// 不传第三个参数 → 目录 GET 走内置默认 browse（207 multistatus），纯协议、无 UI
		return dispatch_handler(request, env.bucket);
	},
};
```

```bash
npx wrangler r2 bucket create webdav
npx wrangler secret put USERNAME
npx wrangler secret put PASSWORD   # 生产密码走 secret，别写进 wrangler.toml
npx wrangler deploy
```

部署完 Finder / rclone 直接挂 `https://<name>.<account>.workers.dev/`；浏览器打开目录会看到 207 multistatus XML —— 这是预期行为，它本来就不是给人看的页面。
