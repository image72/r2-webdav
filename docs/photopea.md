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
r2-webdav 页面（浏览器，列表 UI）      r2-webdav Worker（r2-webdav 主机）    Photopea 实例（新标签页，PHOTOPEA_EDITOR_URL）
  │                                     │                                │
  ├─ GET /editors/session?path=… ──────▶│ 签发 read/write 两个 token     │
  │◀─ {files:[读URL], server:{写URL}} ──┤                                │
  ├─ window.open(Photopea 实例#启动JSON) ─────────────────────────────▶│
  │                                     │◀─ GET /editors/read/<token> ──┤ Photopea 实例自己拉文件
  │                                     │◀─ POST /editors/save/<token> ─┤ Photopea 实例自己保存
```

- **打开**：Photopea 实例按 hash 启动配置里的 `files[0]`（读 token，TTL 1h）自行 `GET
/editors/read/<token>` 拉文件。
- **保存**：Photopea 实例按 `server.url`（写 token，TTL 7 天）自行 `POST /editors/save/<token>`，
  body 为 `p=<encodeURIComponent(JSON{source, versions:[{format, data:base64}]})>`，
  响应 `{newSource}` 由 PP 回写文件状态（官方 `k0.aFs` / `k0.aA0` 行为）。
- 两个端点豁免 Basic —— token 本身就是凭据，路径写死在 token 里改不了。

## 消息体与 curl 自测

### 1. 会话 —— r2-webdav 页面调用，唯一带 Basic 的一步

```bash
BASE=http://127.0.0.1:8790 ; AUTH=test:test
SESSION=$(curl -su $AUTH "$BASE/editors/session?path=/images/test.png")
echo "$SESSION"
```

```json
{
	"mode": "signed",
	"readUrl": "https://<host>/editors/read/<read-token>",
	"server": {
		"url": "https://<host>/editors/save/<write-token>",
		"formats": ["png"]
	},
	"config": {
		"files": ["<readUrl>"],
		"server": { "url": "<saveUrl>", "formats": ["png"] },
		"environment": { "autosave": 0 }
	}
}
```

- `config` 就是 PP 的 hash 启动 JSON，r2-webdav 页面只做一次编码再挂到 `#` 后面：

```js
window.open(editorUrl + '#' + encodeURIComponent(JSON.stringify(session.config)), '_blank');
```

### 2. 打开 —— Photopea 实例自己拉文件（无凭据）

```bash
READURL=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).readUrl)' "$SESSION")
curl -s "$READURL" -o /tmp/downloaded.png # 响应体 = 文件字节（Cache-Control: no-store）
# 403 = token 无效/过期（读 TTL 1h）；404 = 文件已不存在
```

### 3. 保存 —— Photopea 实例 POST `/editors/save/<write-token>`，消息体构造（PP 官方 form 格式）

Photopea 实例保存时 POST 的 body 是 `application/x-www-form-urlencoded`，只有一个字段 `p`，值是
`encodeURIComponent(JSON)`，JSON 形如：

```json
{
	"source": "/images/test.png",
	"versions": [{ "format": "png", "data": "<base64 文件字节>" }]
}
```

服务端只消费 `versions[0].data`（base64 → 字节）；`source` 不参与寻址 —— 目标路径写死在
token 里，改 body 改不了写哪儿。用 curl 构造同样的消息体（`--data-urlencode` 做的编码与
`encodeURIComponent` 等价）：

```bash
SERVERURL=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).server.url)' "$SESSION")
B64=$(base64 < /tmp/edited.png | tr -d '\n')
printf '{"source":"/images/test.png","versions":[{"format":"png","data":"%s"}]}' "$B64" |
	curl -s -X POST "$SERVERURL" \
		-H 'Content-Type: application/x-www-form-urlencoded' \
		--data-urlencode 'p@-'
# → {"ok":true,"newSource":"/images/test.png","etag":"\"…\""}
```

- 响应里的 `newSource` 会被 PP 回写进文件状态（官方 `k0.aA0` 行为）；`etag` 留给后续 `If-Match`。
- 失败：`400`（缺 `p` / JSON 坏 / base64 坏 / 空 body）、`403`（写 token 过期，TTL 7 天）、
  `501`（没配 `SIGNING_SECRET`）、`502`（上游 PUT 失败）。
- 大文件用 node 拼 body，避免把 base64 塞进 argv 撞上 `ARG_MAX`：

```bash
node -e '
	const fs = require("fs");
	const b64 = fs.readFileSync(process.argv[1]).toString("base64");
	process.stdout.write(
		"p=" + encodeURIComponent(JSON.stringify({ source: process.argv[2], versions: [{ format: "png", data: b64 }] }))
	);
' /tmp/edited.png /images/test.png |
	curl -s -X POST "$SERVERURL" -H 'Content-Type: application/x-www-form-urlencoded' --data-binary @-
```

### 4. 等价捷径与核对

自测时可以跳过 form 格式直发二进制（服务端兼容，`POST` / `PUT` 都行）：

```bash
curl -s -X PUT "$SERVERURL" --data-binary @/tmp/edited.png
curl -su $AUTH "$BASE/images/test.png" -o /tmp/roundtrip.png
cmp /tmp/edited.png /tmp/roundtrip.png && echo OK
```

细节在 `src/editors.ts` / `src/editors.client.js`。下线：删 `PHOTOPEA_EDITOR_URL` 即可
（`SIGNING_SECRET` 若 ONLYOFFICE 还在用就保留）。
