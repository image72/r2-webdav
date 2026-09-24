# ONLYOFFICE 打开 / 保存 adapter

给 [office-website](../../../office-website)（浏览器里跑 ONLYOFFICE 编辑器 + x2t WASM 转换的实例）
提供「打开」和「保存」两件事。**整块功能是可下线的**，见文末。

## 为什么是这个形状

那边没有 Document Server：编辑器、格式转换（x2t.wasm）、mock 文档服务器（`utils/editor/server.ts`）
全在浏览器里跑，所以 **没有** `document.url` 下载 + `callbackUrl` 回调那一套服务端流程。
代码里能看到的两个事实决定了本 adapter 的接口：

1. **打开**：`server.ts` 里是 `loader = (url) => fetch(url).then(res => res.arrayBuffer())`
   —— 一个**裸 fetch**，既不带 Basic 凭据，也加不了自定义头。所以取文件的 URL 必须自带凭证，
   而且只能是**短期签名 URL**。
2. **保存**：编辑结果最终是浏览器里的一个 `Blob`（`server.ts` 的 `downloadas` 分支里
   `new Blob([new Uint8Array(output)])`），它需要一个能接收字节的写入端点。

于是 adapter 只做两件事，不碰 `webdav.ts` / `r2.ts` / `index.html`：

```
office-website（浏览器）                     r2-webdav（Worker）
  │                                            │
  ├─ GET  /onlyoffice/session?path=/a.docx ───▶│  Basic 鉴权，换 token
  │◀── { url, saveUrl, key, fileType, … } ─────┤
  │                                            │
  ├─ GET  /onlyoffice/doc/<read-token>  ──────▶│  签名校验 → 读 R2（裸 fetch 可用）
  │◀── 文件字节 ────────────────────────────────┤
  │   （x2t 在浏览器里转换、编辑）              │
  │                                            │
  ├─ PUT  /onlyoffice/doc/<write-token> ──────▶│  签名校验 → 覆盖写回 R2（路径只来自 token）
  │◀── { ok, size, etag, key } ────────────────┤
```

## 两种模式（靠 secret 自动切换，客户端接口一模一样）

上面那张图是**签名模式**。如果编辑器页面与 WebDAV **同源**，还可以不要 token：
两个 URL 直接就是文件自己的 WebDAV 地址（打开 = 原生 GET、保存 = 原生 PUT）——
同源请求浏览器的 `fetch()` 会自动补上已缓存的 Basic 凭据。

|                   | 直连（默认，不配 secret） | 签名（配了 `ONLYOFFICE_HMAC_SECRET`） |
| ----------------- | ------------------------- | ------------------------------------- |
| `url` / `saveUrl` | 文件自己的 WebDAV 地址    | `/onlyoffice/doc/<短期 HMAC 短链>`    |
| 打开 / 保存       | 原生 `GET` / `PUT`        | adapter 校验签名后读写 R2             |
| 授权              | 浏览器**已缓存的 Basic**  | 短链自带签名，不需要凭据              |
| 前提              | **与 WebDAV 同源**        | 无（跨源可用）                        |

判断标准很硬，别凭直觉：`localhost:3000` 与 `127.0.0.1:8790`、`*.pages.dev` 与
`*.workers.dev` 都算**跨源**。跨源时裸 `fetch()` 不会带凭据，而我们的 CORS 是
`Access-Control-Allow-Origin: *` + `Allow-Credentials: false`，Basic 根本送不过去
（实测：带 `-u` 能取到文件，不带就是 `401`）。只有把编辑器页面挂到与 WebDAV
**同一个 host:port** 上，直连模式才成立。

## 端点

| 端点                        | 鉴权                   | 说明                                            |
| --------------------------- | ---------------------- | ----------------------------------------------- |
| `GET /onlyoffice/session`   | **Basic**（同 WebDAV） | `?path=/目录/文件.docx` → 换 token 与编辑器配置 |
| `GET /onlyoffice/doc/<tok>` | token（HMAC）          | 取文件字节（另有 `HEAD`）                       |
| `PUT /onlyoffice/doc/<tok>` | token（HMAC）          | 覆盖写回文件（body 就是文件本身；`POST` 等价）  |

`session` 的响应：

```json
{
	"fileType": "docx",
	"documentType": "word",
	"title": "report.docx",
	"key": "3f1c…（40 位十六进制，= sha256(path + ETag)）",
	"url": "https://<host>/onlyoffice/doc/<read-token>",
	"saveUrl": "https://<host>/onlyoffice/doc/<write-token>",
	"path": "/oo/report.docx",
	"size": 12345,
	"etag": "\"…\"",
	"readExpiresAt": 1699999999,
	"writeExpiresAt": 1699999999
}
```

- `key` 就是编辑器 `document.key`：同一版本稳定、内容一变就变（内容变了必须让编辑器重新下载，
  否则会继续用缓存里的旧内容）。
- `documentType` 取值 `word | cell | slide | draw | pdf`，与 office-website 的
  `utils/editor/types.ts` 里的 `DocumentType` 一致；`fileType` 是文件后缀。
- 只放行办公文档（docx/xlsx/pptx/odt/ods/odp/csv/txt/pdf/vsdx… 见 `src/onlyoffice.ts` 里的
  `EXTENSION_TYPES`），其它类型回 `415` 并列出支持的后缀。

## 启用

```bash
# 直连模式（编辑器与 WebDAV 同源）：什么都不用配

# 签名模式（跨源，例如 office-website 部署在 pages.dev、WebDAV 在 workers.dev）：
# 加一个密钥即可，客户端接口不变，不需要改任何调用代码
npx wrangler secret put ONLYOFFICE_HMAC_SECRET
```

可选：`ONLYOFFICE_BASE_URL` —— 编辑器与 Worker 不同源、或前面挂了反代时，用它指定
对外暴露的基址（否则用请求的 origin 拼 URL）。

## 自测（不需要浏览器）

```bash
BASE=http://127.0.0.1:8790 ; AUTH=test:test

# 1. 先放一个文件进去（内容随便，这里只是造一个“已有文档”）
printf 'PK\003\004 v1' > /tmp/a.docx
curl -u $AUTH -T /tmp/a.docx $BASE/oo/a.docx

# 2. 换 token
curl -su $AUTH "$BASE/onlyoffice/session?path=/oo/a.docx"
# → 取响应里的 url / saveUrl / key

# 3. 打开（注意：不带 -u，模拟编辑器的裸 fetch）
curl -s $URL | head -c 16

# 4. 保存
printf 'PK\003\004 v2' > /tmp/b.docx
curl -s -X PUT --data-binary @/tmp/b.docx $SAVEURL

# 5. 核对真的写回去了
curl -su $AUTH $BASE/oo/a.docx | head -c 16
```

## 接入 office-website（页面侧）

1. 用 Basic 凭据调一次 `GET /onlyoffice/session?path=…`，拿到 `url / key / fileType / title`；
2. 打开编辑器页：`…/editor?url=<url>&fileType=<fileType>&fileName=<title>`
   —— 页面会把它交给 `server.openUrl()`，编辑器对 `url` 做裸 `fetch`；
3. 保存：把 x2t 产出的 `Blob` `PUT` 到 `saveUrl`，例如
   `fetch(saveUrl, { method: 'PUT', body: blob })`。
   现在 `utils/editor/server.ts` 的 `downloadas` 分支是 `new Blob(...)` → `a.download`，
   把最后那三行换成这个 PUT 即可（页面上的 `onSave` / `writeFile` 事件是另一个可选落点）。

跨域写在同源之外时会走 CORS 预检：`PUT` 本来就在 `Access-Control-Allow-Methods` 里，
预检由 WebDAV 那层的 `OPTIONS` 回答，无需额外配置。

## 安全模型

- **直连模式**：打开 / 保存就是普通 WebDAV GET/PUT，安全边界与 WebDAV 完全一致（Basic
  鉴权），adapter 只多提供一份「编辑器配置」（`key` / `documentType` / 两个 URL）。
  ⚠️ 代价：保存走原生 PUT，**空 body 会把文件覆盖成空** —— 页面侧要自己防（失败的
  空 Blob 不要发出去）。
- **签名模式**：`/onlyoffice/session` 是唯一入口（Basic 鉴权）；token 是 HMAC-SHA256
  签名的无状态凭证（`base64url(负载).base64url(签名)`，服务端不存会话），负载里带
  `path` / 读写方向 / 过期时间 / 版本 key；
- **写入路径只来自 token**：请求体、查询串都改不了目标文件，避开「callback 指哪写哪」那类漏洞；
- 读 token `TTL 1h`、写 token `TTL 24h` 分开；签名比较交给 `crypto.subtle.verify`（恒定时间）；
  密钥按 secret 缓存在 isolate 内；空 body 直接拒绝；
- 「URL 里放凭证」的固有代价是 TTL 内可重放 —— 所以读 token 只给 1 小时。**能同源部署就
  优先用直连模式**，连这个代价都没有。

## 已知限制（有意不做）

- **不做并发冲突检测**：不带 `If-Match`，同一文件的两次编辑按"最后写入者胜"。真要做应该是
  独立一轮功能，而不是塞进这个薄 adapter。
- **token 泄露窗口**：URL 里带凭证就有重放风险，所以 TTL 取短；要更严就得换成一次性 token +
  存储（那会让它重新变"重"）。
- **大文件全量传输**：`GET` 不支持 `Range` 续传，编辑器本来就是整份拉取；
  保存也是整份 PUT。
- **不做 ONLYOFFICE 服务端那套**：没有 `callbackUrl`（`status: 2/6`）实现 —— 目标实例不需要它。
  若将来改成真 Document Server，需要另加一个回调端点，并复用这里的 token/路径校验思路。

## 下线

1. 删 `src/onlyoffice.ts`；
2. `src/index.ts` 里搜 `ONLYOFFICE`，删掉三处接线（import、`Env` 里两个字段、鉴权旁路与分发那两行）；
3. 有 secret 的话 `npx wrangler secret delete ONLYOFFICE_HMAC_SECRET`。

其余代码（WebDAV、页面、归档）与它没有任何耦合。
