# office-website 补丁记录

r2-webdav 依赖 [office-website](../../../office-website) 编辑器页接受 `?saveUrl=` 参数才能完成
「保存回写 R2」。office-website 的上游是 ZIZIYI（office.ziziyi.com 的源码），为了保持
**最大公约数兼容**（少改 = 好合并），对上游的所有改动都以补丁形式留档在这里。

## 补丁清单

### `office-website-save-to-storage.patch`

- 基线：office-website fork 基线提交 `ddcc66f`（"fix: fetch remote http(s) documents
  natively when extension is unavailable"，与 upstream/main 同点）
- 生成：`cd ../office-website && git format-patch ddcc66f..HEAD --stdout > ../r2-webdav/patches/office-website-save-to-storage.patch`
- 应用（在 office-website 仓库、基线之后的提交上）：
  `git am patches/office-website-save-to-storage.patch`（从 r2-webdav 目录拷过去跑）
- 内容 = 2 个提交：

| 提交      | 主题                                                             | 改动                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `a73cecc` | feat: save back to storage via saveUrl query param               | `server.ts` / `page.tsx` / `_headers`                                                                                                                                    |
| `0894bf9` | fix: save-to-storage is authoritative, download only as fallback | `server.ts`（保存语义修正）                                                                                                                                              |
| `4ed7dfd` | fix: revert added \_headers rules, keep upstream config as-is    | `public/_headers`（撤掉新增规则；`/x2t-*` 与 upstream 原有 `/x2t-*` 通配叠加产生 `content-encoding: br, br`，导致 x2t 解压失败 → 打开报错、保存卡 Downloading document） |

### 涉及文件与「侵入面」

| 文件                     | 改动                                                                                                                  | 对上游行为的影响                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `utils/editor/server.ts` | `openUrl` 新增可选 `saveUrl` 参数 + `getSaveError()`；`downloadas` 分支：有 `saveUrl` 时 PUT 回写、失败才退回本地下载 | **不传 `saveUrl` 时与 upstream 完全一致**（所有新参数可选、新分支不触发） |
| `app/editor/page.tsx`    | 读 `?saveUrl=` query 并传给 `server.openUrl`；`onSave` 事件里读 `getSaveError()` 用 `showMessage` 提示回写失败        | URL 不带 `?saveUrl=` 时零影响                                             |
| `public/_headers`        | x2t wasm 30d 缓存 + SWR；HTML 短 TTL                                                                                  | 与上游功能无关，纯部署优化                                                |

### 兼容性要点

- `saveUrl` **不是** ONLYOFFICE 官方 Document Server 协议参数（官方走 `callbackUrl` 回调）。
  它是 r2-webdav `docs/onlyoffice.md` 定义的会话契约字段，office-website 仅将其作为普通
  query 参数消费，不与官方协议冲突。
- 兼容性红线：**不动** `messages/*`（next-intl 4.x 的 `experimental.extract` 会在
  `pnpm build` 时回写 `messages/en.json` 的 hash key —— 这是构建副作用，构建后需
  `git restore messages/en.json`，严禁把回写结果提交进仓库）；不动 x2t / 编辑器内核目录。
- 若上游更新后合并冲突，优先保上游、把本补丁的功能重新套一遍，保持侵入面最小。

## 维护方式

office-website 每次为 r2-webdav 新增/修改集成功能后：

```bash
cd ../office-website
git format-patch <fork基线commit>..HEAD --stdout \
  > ../r2-webdav/patches/office-website-save-to-storage.patch
```

并更新本 README 的补丁清单表格（提交列表、基线 commit）。
