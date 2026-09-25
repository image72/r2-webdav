# Photopea 集成

`psd / psb / png / jpg / webp / gif / tif / svg` 等图片文件的操作面板里会出现
「用 Photopea 打开」：新标签页直接打开 Photopea 全功能编辑器并加载文件，Ctrl+S 直接
POST 存回 R2。**编辑器运行在 Photopea 实例上**（官方站或自建均可），r2-webdav 页面与
窗口内不出现任何编辑器界面。

## 配置

```toml
# wrangler.toml
[vars]
PHOTOPEA_EDITOR_URL = "https://<your-photopea-instance>/"
```

```bash
npx wrangler secret put SIGNING_SECRET # 必需：Photopea 保存走签名写端点
```

- 可以直接用官方服务：`PHOTOPEA_EDITOR_URL = "https://www.photopea.com/"`。
  hash 启动配置（`files` / `server`）是 Photopea 官方公开的接入方式，官方站与自建
  实例行为一致；差别只在官方站有 Cloudflare 防护 —— 真人浏览器正常打开不受影响。
- PP 官方对集成本身没有授权门槛，但注意其**使用条款对商业用途有订阅要求**
  （详见 photopea.com 的 Terms & Pricing），自建实例（非官方镜像）则不受此限。
- `SIGNING_SECRET` 与 ONLYOFFICE 共用，配一次即可。
- 不配 `PHOTOPEA_EDITOR_URL`，这个功能就完全不存在。
- 可选 `EMBED_BASE_URL`：服务在反代/自定义域名后面时，用它指定签名短链的对外基址
  （否则用请求 origin 拼）。

## 为什么必须签名短链

Photopea 跑在跨源实例上，取文件和保存都是**它自己发的请求**：拿不到浏览器缓存的
Basic 凭据，也加不了自定义头。所以两个方向都靠 URL 里的 HMAC token 鉴权
（与 ONLYOFFICE 短链同一套签名原语）：

```
列表页 (Basic)                    r2-webdav Worker                 Photopea 新标签页
  │                                     │                                │
  ├─ GET /editors/session?path=… ──────▶│ 签发 read/write 两个 token     │
  │◀─ {files:[读URL], server:{写URL}} ──┤                                │
  ├─ window.open(pp实例#启动JSON) ──────────────────────────────────────▶│
  │                                     │◀─ GET /editors/read/<token> ──┤ 自己拉文件
  │                                     │◀─ POST /editors/save/<token> ─┤ 自己保存
```

- **打开**：PP 按 hash 启动配置里的 `files[0]`（读 token，TTL 1h）自行 GET 文件。
- **保存**：PP 按 `server.url`（写 token，TTL 7 天）自行 POST
  `p=<encodeURIComponent(JSON{source, versions:[{format, data:base64}]})>`，
  响应 `{newSource}` 由 PP 回写文件状态（官方 `k0.aFs` / `k0.aA0` 行为）。
- 两个端点豁免 Basic —— token 本身就是凭据，路径写死在 token 里改不了。

细节在 `src/editors.ts` / `src/editors.client.js`。下线：删 `PHOTOPEA_EDITOR_URL` 即可
（`SIGNING_SECRET` 若 ONLYOFFICE 还在用就保留）。
