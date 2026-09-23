# WebDAV 缺陷修复列表

来源：2026-09-23 的 WebDAV 实现审计（RFC 4918/9110 语义 + 规模/并发/存储层）。
每一项都标注了证据来源：**[实测]** 为本地 `wrangler dev` 的原始结果，**[推导]** 为依据
Cloudflare 官方文档 + 代码运算量推算（本地无法复现平台侧限额）。

状态：`待修复` / `修复中` / `已修复` / `平台受限`（记录后跳过，附原因与替代方案）

## 修复进展

| 批次 | 覆盖 ID | 状态 |
|------|---------|------|
| 1 | A1 A2 A5 A6 B1 B2 B7 C1 C2 C3 C4 C5 C7 C9 C10 C11 C14 D6 | **已修复**，回归 72/72 通过 |
| 2 | A3 A4 B3 | 进行中 |
| 3 | B10 | 待修复 |
| 4 | B4 B5 B8 C6 | 待修复 |
| 5 | C12 C13 D2 D4 D7 | 待修复 |

> **A6 说明**：本地观察到的 `500` 是 Miniflare 的 R2 条件读取实现缺陷（错误页内容为
> `Error get: Unspecified error (0)`），生产 R2 未必复现。但代码层面确实存在两处真实缺陷且已修：
> ① 条件不满足时一律回 `412`，而 RFC 9110 要求 GET/HEAD 的 `If-None-Match` /
> `If-Modified-Since` 回 `304`；② 条件判断完全委托给 R2 的 `onlyIf`，无法区分这两种结果。
> 现在改为 `evaluate_conditionals()` 自行按 §13.2.2 的优先级求值（1 次请求，无额外子请求）。

> **C2/C1 附带教训**：不能用 `object.range !== undefined` 判断"是否返回了片段" ——
> R2 在请求**没有** Range 头时也会返回覆盖整个对象的 range，那样会让所有普通下载都变成
> `206 + Content-Range`（我第一版就这么写错了，被回归抓到）。必须用长度比对。

---

## A. P0 — 数据丢失 / 完全不可用

| ID | 问题 | 证据 | 状态 |
|----|------|------|------|
| A1 | `DELETE /` 清空整个 bucket，无确认，客户端探测即全量销毁 | [实测] 7 条 → 0 条，数据 DESTROYED | 待修复 |
| A2 | `bucket.put()` 条件失败返回 `null` 被忽略，谎报 `201`；R2 实际拒绝写入 | [实测] `If-None-Match:*` → 201，内容未变 | 待修复 |
| A3 | COPY/MOVE 超过 3000 成员时静默截断，回 `201`，其余成员丢失/变孤儿 | [实测] 3100 → 只处理 3000 | 待修复 |
| A4 | 列表（PROPFIND 与 Web UI）静默截断，无 507、无游标，超出部分对所有客户端不存在 | [实测] 3001 条 / f03100.txt 缺失 | 待修复 |
| A5 | `generate_propfind_response` 未转义，含 `&`/`<` 的文件名产出非法 XML，整目录列表不可解析 | [实测] xmllint parser error | 待修复 |
| A6 | 条件 GET（`If-None-Match` 命中）返回 `500` 而非 `304` | [实测] 500 | 待修复 |

## B. P1 — 互操作与数据完整性

| ID | 问题 | 证据 | 状态 |
|----|------|------|------|
| B1 | MOVE 的 `Overwrite` 默认值反了（应为 `T`，RFC 4918 §10.6），与 COPY 自相矛盾 | [实测] no-header → 412 | 待修复 |
| B2 | MOVE 集合 + `Depth: 0` 应 400（§9.9.3），实际搬走标记、留下孤儿 | [实测] 201 + 孤儿 | 待修复 |
| B3 | PUT 只创建末级父目录，祖先成为"幻影目录"，列表不可见、按名删不掉（根因：从不读 `delimitedPrefixes`） | [实测] `/t7/` 缺失、`DELETE /t7` 404 | 待修复 |
| B4 | PROPPATCH 完全空转却报 207（`HTMLRewriter` 只注册在根元素，收集逻辑永不触发） | [实测] 空 `<multistatus>`，0 个 `<response>` | 待修复 |
| B5 | PROPPATCH 无法设置受保护属性（应 403），属性名被小写化（XML 大小写敏感） | [实测] 报 200 | 待修复 |
| B6 | LOCK/UNLOCK 语义缺失：重复互斥 LOCK → 200（应 423）、不存在的资源 → 200、缺 `<lockroot>`、忽略 `Timeout`；假 token → 204（应 409）；无 token → 204（应 400） | [实测] 全部确认 | 部分平台受限 |
| B7 | PUT 静默忽略 `Content-Range`，分块上传的后一块整体替换前一块 → 静默截断文件 | [实测] 11 字节文件变 6 字节 | 待修复 |
| B8 | PROPPATCH 为重写元数据而重传整个对象（get+put 全量字节），且非原子 | [代码] | 待修复 |
| B9 | 目录 GET（无尾斜杠）返回 200 + 空体，应 301 重定向 | [实测] 200 (no Location) | 待修复 |
| B10 | 键按百分比编码存储（路径从不解码），与 R2 控制台/S3 API/`wrangler r2`/rclone S3 remote 名字不一致 | [实测] `my%20file.txt`、`%E4%B8%AD%E6%96%87.txt` | 待修复 |

## C. P2 — 语义与细节

| ID | 问题 | 证据 | 状态 |
|----|------|------|------|
| C1 | 200 响应上带 `Content-Range`（RFC 9110 §15.3.7 禁止） | [实测] `bytes 0-10/11` | 待修复 |
| C2 | 空对象返回 `Content-Range: bytes 0--1/0`（非法负区间） | [实测] | 待修复 |
| C3 | 缺 `Accept-Ranges: bytes` → 客户端不做范围请求（视频拖动、PDF 分页） | [实测] 缺失 | 待修复 |
| C4 | GET/HEAD 无 `ETag` / `Last-Modified` → 无缓存再验证通路 | [实测] 缺失 | 待修复 |
| C5 | `getetag` 未加引号（用 `etag` 而非 `httpEtag`） | [实测] | 待修复 |
| C6 | PROPFIND 完全忽略请求体：`<propname/>` 返回真值、`<prop>` 不收敛、未知属性无 404 propstat | [实测] | 待修复 |
| C7 | 非法 `Depth` 返回 403（§10.2 要求 400） | [实测] 403 | 待修复 |
| C8 | MKCOL 带 body 创建成功（应 415） | [实测] 201 | 有意偏离，保留并记录 |
| C9 | PUT/MKCOL 进入"父为文件"的路径成功（应 409），同一 key 既是文件又是文件夹 | [实测] 201 | 待修复 |
| C10 | `Destination` 指向外部主机时照写本桶（应 502） | [实测] 201 | 待修复 |
| C11 | COPY/MOVE 的 `destination_parent` 计算里 `endsWith('/')` 是死分支 | [代码] | 待修复（清理） |
| C12 | 缺 RFC 4331 `quota-available-bytes` / `quota-used-bytes` | [实测] | 待修复 |
| C13 | `displayname` 取自 `Content-Disposition`；PROPPATCH 永远无法设置它 | [代码] | 待修复 |
| C14 | MKCOL 把请求头当 `httpMetadata` 写进目录标记 | [代码] | 待修复 |

## D. 性能 / 阻塞

| ID | 问题 | 证据 | 状态 |
|----|------|------|------|
| D1 | COPY/MOVE 每成员 2–3 次 R2 调用；R2 调用计入**子请求**配额（Free 1,000 / Paid 10,000）→ 超限即 500 且**非原子、无回滚** | [推导] | 部分平台受限 |
| D2 | `MAX_CONCURRENT_OPERATIONS = 50` 不可达：平台限制**每次调用 6 个并发连接**，多余排队；按 50 分批还引入队头阻塞 | [推导] | 待修复 |
| D3 | PROPFIND 无界开销：`Depth` 缺省即 `infinity`，实测单个目录 2002 KiB / 66–208 ms；Free 计划 CPU 仅 10 ms | [实测]+[推导] | 部分平台受限 |
| D4 | `processWithConcurrencyLimit` 里 `results` 数组是死代码 | [代码] | 待修复 |
| D5 | DELETE 大树严格串行（list 分页 + 逐页 delete） | [实测] 1100 成员 267 ms | 可接受，记录 |
| D6 | `MAX_BATCH_DELETE_SIZE = 3000` 与 `delete()` "每次最多 1000 键" 冲突 | [推导] 当前不可达 | 待修复（改成 1000 + 注释） |
| D7 | `MAX_PROPFIND_DEPTH = 5` 声明但从未使用 | [代码] | 待修复（清理） |
| D8 | 恒定 `include: ['httpMetadata','customMetadata']` 且挂 `@ts-ignore` | [推导] | 记录 |
| D9 | `compatibility_date = 2023-10-16` 偏旧 | [文档] | 独立任务 |

## E. R2 存储层

| ID | 问题 | 证据 | 状态 |
|----|------|------|------|
| E1 | 键被百分比编码写入（同 B10） | [实测] | 见 B10 |
| E2 | 目录 = 0 字节目录标记对象；对非本 Worker 的工具就是一个"与文件夹同名的空文件"；标记缺失即幻影目录 | [实测] | 部分待修复（B3），架构本身记录 |
| E3 | 未使用 R2 分片上传，也无 WebDAV 分片/续传；上传受 Cloudflare 请求体上限约束（Free/Pro 100 MB，Business 200 MB） | [文档] | **平台受限** |
| E4 | 全站无游标分页 | [代码] | 见 A4 |
| E5 | 无 `storageClass` 配置（未用 IA 存储类） | [代码] | 记录（成本优化） |

---

## 平台受限项（记录后跳过）

这些**无法在 Cloudflare Workers 上按要求完成**，不在本轮修复范围内，仅记录原因与替代方案：

| 项 | 平台原因 | 替代方案 |
|----|----------|----------|
| **B6 真锁**（互斥锁、423 Locked、token 校验） | Workers 是无跨请求共享状态的隔离运行环境；锁必须持久化到共享存储才有效。真正的锁需要 **Durable Objects**（或 KV + 竞态处理） | 保留 advisory stub（Office/Windows 需要 LOCK 存在才能工作），把便宜的一致性细节修对，并**在文档中明确"锁不具强制力"**。彻底实现需引入 DO 绑定，属独立的架构变更 |
| **E3 大文件上传 / 分块续传** | Cloudflare 请求体上限 100 MB（Free/Pro）/ 200 MB（Business），且 Worker 无法绕过；WebDAV 本身没有标准的分片上传 | 修 B7：对 `Content-Range` 明确回 `501`，**不再静默产出截断文件**；大文件需走 S3 兼容 API（`createMultipartUpload`）而非 WebDAV |
| **D1 子请求上限下的"一次性"COPY/MOVE** | Free 1,000 / Paid 10,000 子请求，超出即终止，且 Worker 内无法跨请求保持进度（无共享状态） | 短期：改为**有界批次 + 明确失败**（回 507 并说明已处理多少），不再静默丢数据。彻底方案需引入 **Queues** 或 **Durable Objects** 做可续的任务状态 |
| **D3 Free 计划 10 ms CPU** | 平台 CPU 配额，代码无法绕过；只能在既定预算内减少工作量 | 降低 PROPFIND 默认开销（尊重请求体收敛属性、给客户端分页/游标）；Paid 计划可调 `limits.cpu_ms` |
| **D2 6 连接并发** | 平台每次调用最多 6 个等待响应头的连接 | 把常量改为 6 并说明，避免"50 路并发"的错觉 |

---

## 修复批次计划

| 批次 | 内容 | 风险 |
|------|------|------|
| 1 | A1 A2 A5 B1 B2 B7 C1 C2 C3 C4 C5 C7 C9 C10 | 低：局部条件判断与响应头 |
| 2 | A3 A4 B3（列表/枚举语义：显式失败 + `delimitedPrefixes` + 幻影目录） | 中：改动列表与遍历 |
| 3 | B10（路径解码 + href 编码，涉及存量键命名迁移） | 中：影响既有对象的显示名 |
| 4 | A6 B4 B5 B8 C6（条件 GET、PROPPATCH、PROPFIND 请求体） | 中：需要协议细节回归 |
| 5 | C11 C12 C13 C14 D2 D4 D6 D7（清理与补齐） | 低 |
