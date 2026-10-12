# Changelog

## v1.2.0（未发布）
### 新功能
- **模型图标扩到 43 个品牌** —— 从 lobe-icons 固定 revision 取 32 个新商标；9 个 `currentColor` 烘成固定中性色。
- **网关 / 云的包裹 id 还原真实品牌** —— 覆盖 `openai-gpt-5.5`、`databricks-claude-*`、`eu.anthropic.claude-*` 等写法，原始 id 仍优先。
### 优化
- **按范围的旧查询结果不再滞留** —— 结果键里带 revision，旧条目永远读不到却仍占内存；现在数据或定价一变就清掉（每条约 30–115 KB × 最多 20 条）。
- **热力图入场动画不再拖长尾、也不再无视「减少动态效果」** —— 376 格的错峰延迟从「每格 1.2ms、最长 444ms」改为按 25 格循环（最长 **144ms**）：实测挂载 700ms 后仍在跑的动画 **393 → 11**（页面静置后只剩 4 个，其中含「今日」光晕）；「今日」呼吸光晕在 `prefers-reduced-motion: reduce` 下不再启动（它写在行内样式里，媒体查询原本覆盖不到）。
- **定价快照不再每次重算路由清单** —— 价格表要遍历全部用量行（本机 6.5 万条）才能列出用过的模型；该结果改为按「数据 / 定价 revision」缓存，只在两者变化时重算（模型化实测：每次 3.4 ms → 命中约 0 ms）。
- **筛选下拉不再每次渲染都重建** —— 三个菜单的选项列表改由 useMemo 派生、图标在列表构建时解析一次，菜单本身用 React.memo 包裹；真机同口径（开+关各一帧 × 20 轮）**47.96 → 29.4 ms/轮**。
- **首屏快照只带一份时区日历** —— 面板每次开屏会请求自己那份（本地或 UTC），不再同时传两份（原来两份各占一半）；按范围的「会话数」仍来自 /query，口径不变。
- **每天的会话 id 明细只保留近期** —— 超过 180 天的日子仍带数量与聚合，但不再拖着历史上所有会话 id（面板看旧日期的日志本就按需拉取）。
- **旧存储文件不再长期占盘** —— 账本改用「一条记录一个文件」后，原来的整单位文件（本机 32 个分片 + 一个遗留大文件，合计约 178 MB）已被逐条播种成新结构；账本现在会在**确认新结构已有记录**后删除这些旧文件并留下一次性的标记，失败则下次启动重试。
- **账本体积按路由去重** —— 同一条路由（供应商 / 模型）以前在每条用量里都重复一份身份对象；改为每条记录共享一张身份表、用量只存索引。实测本机 1059 条记录 **91.3 → 74.7 MB（−18.2%）**。
- **渲染不再被无关状态带着重画** —— 趋势 / 热力图（376 格）入参改为稳定引用，图标几何提到模块级；真机实测整页 DOM **6266 → 1719 节点**，bundle 235.2 KB。
- **账本改写方案已就位（待真机重启验证）** —— 会话记录改一条一文件存储，替代「每次更新重写整个分片」：实测单次更新 **273 ms → 中位 4.6 ms**（最大的会话 74 ms），整个分片目录 **13.27 → 11.88 MB**；冷启动在同一份真实数据上从 **8–9 s 降到 3.0 s**（首次含迁移 5.5 s）。
- **趋势图点数封顶 180** —— 半年以内按天，更长先降到 3 天一点再按需扩到周 / 月 / 季 / 年；桶不重叠不丢天，面板标注汇总粒度。实测 1 年 122 点、20 年 120 点。
- 图标溯源修正：11 条记录的路径改为 bundled 的 `icons/`，并断言 upstream 路径必须指向 bundled 文件。
- 图标清单改由 manifest / 目录推导 —— 以后加品牌不用手改清单。
- 没有品牌图标的模型用插件自己的**层叠标记**（不是空圆点），不指向任何品牌。
- 品牌图标改**宿主按需提供**（`GET /api/all-usage/icon?key=`），bundle **365 KB → 231 KB**，加品牌不再增体积。
- **DeepSeek 余额两位小数** —— 主数值 `¥13.8600` → **`¥13.86`**；其它币种仍四位。
- **概览卡片行压缩约四分之一** —— 内边距 16→10px、大数字 26→22px 等，整行 **156 → 114px**。
- **请求日志内部滚动 + 分页** —— 首屏最近 20 条，滚到底再取 20 条（实测 20 → **40 条**）。
### 修复
- **同一模型的多个路由合并为一个筛选项** —— 按模型名归并（忽略大小写与 `供应商/` 前缀），宿主同样按模型名匹配。
- **模型筛选不再显示供应商命名空间** —— 只显示模型名，取值仍是原始 id（实测 25 项里含 `/` 的为 0）。
- **供应商 / 模型下拉不再无限下延** —— 限高 `min(60vh, 420px)` 内滚，打开时滚到当前选中项。

### Features
- **43 model brands** — 32 new marks from the pinned lobe-icons revision; nine had currentColor baked to a fixed neutral.
- **Gateway and cloud ids resolve to the real brand** — covers openai-gpt-5.5, databricks-claude-*, eu.anthropic.claude-*; the raw id still wins.
### Improvements
- **Superseded scope results no longer linger** — the cache key carries the revision, so an old entry could never be read again while still holding 30-115 KB apiece (up to 20); a data or pricing change clears them now.
- **The heatmap entrance no longer trails and no longer ignores reduced motion** — the 376-cell stagger went from 1.2 ms per cell (a 444 ms tail) to a 25-cell wrap (144 ms); measured animations still running 700 ms after mount drop from **393 to 11** (four once the page settles, the today pulse among them), and that pulse is skipped under prefers-reduced-motion because an inline style had put it out of the media query's reach.
- **The pricing snapshot stops rebuilding its route list every time** — listing the models in use walks every usage row (65k here); the result is cached per data/pricing revision now and only rebuilt when either changes (modelled: 3.4 ms per call to about 0 ms when cached).
- **The filter menus stop rebuilding on every render** — their option lists are derived with useMemo (icons resolve once, when the list is built) and the menu itself is wrapped in React.memo; measured in the panel over 20 open/close cycles: **47.96 ms down to 29.4 ms** per cycle.
- **The first-paint snapshot carries one timezone calendar** — the panel asks for its own copy (local or UTC) instead of both, which used to split the payload in half; per-range session counts still come from /query, so the numbers are unchanged.
- **Per-day session ids ride along only for recent history** — a day older than 180 days keeps its counts and aggregates but no longer drags every session id ever recorded (opening an old day's log already fetches it on demand).
- **The old storage files no longer stay on disk** — after the ledger moved to one document per record, each legacy whole-unit file (32 shards plus a leftover monolith, about 178 MB here) has been seeded into the new tree; the ledger now removes those files once the tree provably holds records, leaves a one-time marker, and retries on the next start if anything fails.
- **Ledger rows share one identity table per session** — a route (provider / model) used to repeat its identity object on every usage item; rows now carry an index into one shared list. Measured: 1059 records drop from **91.3 to 74.7 MB (−18.2%)**.
- **Unrelated state no longer redraws the charts** — the trend chart and the 376-cell heatmap take stable props now and icon geometry lives at module level; measured: the page DOM drops from **6266 to 1719 nodes**, bundle 235.2 KB.
- **The ledger write-amplification fix is ready (needs a host restart to verify)** — one file per session record replaces rewriting a whole shard on every update: measured **273 ms to a 4.6 ms median** (74 ms for the largest session), the shard directory drops from **13.27 to 11.88 MB**, and a cold start on the same real data falls from **8-9 s to 3.0 s** (5.5 s for the first one, which migrates).
- **The trend chart is capped at 180 points** — a span up to half a year stays daily, a longer one drops to three days first and widens on demand; buckets never overlap or drop a day, and the panel names the stride.
- Icon provenance corrected: eleven entries now point at the bundled icons/ path, and a test asserts an upstream path names the file it came from.
- The icon list is derived from the manifest and the directory, so a new brand needs no hand-edited list.
- A model without a bundled brand shows the plugin own stacked-layers mark (never an empty dot), which implies no brand.
- Brand marks are served by the host on demand (GET /api/all-usage/icon?key=), dropping the bundle from 365 KB to 231 KB; a new brand no longer grows it.
- **The DeepSeek balance reads with two decimals** — ¥13.8600 becomes ¥13.86, while any other currency keeps the four the API reports.
- **The summary row is about a quarter shorter** — padding 16 to 10px, big numbers 26 to 22px: 156 down to 114px.
- **The request log scrolls in its own box and pages as you go** — newest 20 rows first, 20 more at the end (20 to 40 measured).
### Fixes
- **Routes of one model share a single filter entry** — grouped by model name (case ignored, vendor namespace dropped), matched the same way on the host.
- **The model filter no longer shows the vendor namespace** — the model name only, while the value stays the raw id (0 of 25 entries still contain a slash).
- **The provider and model menus no longer run past the window** — capped at min(60vh, 420px) with their own scroll.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.18 (2026-10-07)
### 新功能
- **「近 7 天」范围** —— 含今天的 7 个日历日，作用于摘要 / 趋势 / 模型表 / 日志 / 筛选 / CSV。
- **热力图跨度可切换** —— 30 天 / 90 天 / 12 个月 = 5 / 13 / 53 列，格子随之变大（实测 34px vs 18px）；默认仍 12 个月，与时间范围互不影响。
- **标题旁版本指示** —— 显示运行版本；一致时小字「已是最新」，落后时高亮「最新 vX.Y.Z」，点击开 GitHub 仓库。

### Features
- **A seven-day range** — seven calendar days including today; scopes the summary, trend, model tables, request log, filters and CSV.
- **A switchable heatmap span** — 30 days / 90 days / 12 months draw 5 / 13 / 53 columns, so shorter spans get larger cells (34px vs 18px measured); twelve months stays the default and the span is independent of the time range.
- **A version indicator in the header** — the running version, plus “Up to date” in small text or a highlighted “Latest vX.Y.Z”; clicking it opens the GitHub repository.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.17 (2026-10-01)
### 修复
- **桌面端又能保存了** —— 写接口原要求 `Origin` 与 loopback 同源，而 Electron 转发时会删掉它；改为以进程令牌授权，`Origin` 存在时仍校验，`Host` 仍限 loopback。
- **缺 `usageBacked` 不再误判** —— 旧宿主不发该字段，面板不再渲染成「账本无用量」，改为「用量未知」三态。
- **令牌轮换自愈** —— 状态轮询带派生 `capabilityId`；写入遇 403 自动重取令牌并重试一次，文案改为「进程令牌已失效」。
### 新功能
- `/api/all-usage/status` 增加 `pluginVersion` 与 `capabilityId`，宿主与页面版本不一致时面板会提示重启。

### Fixes
- **The desktop client can save again** — writes required an `Origin` matching the loopback host, which Electron strips when forwarding; they are now authorized by the process capability, a present `Origin` is still validated and `Host` stays loopback-only.
- **A missing `usageBacked` is no longer a verdict** — an older host omits the field and the panel rendered it as “no ledger usage”; it now degrades to a distinct “usage unknown” state.
- **A rotated capability heals itself** — the status poll carries a derived `capabilityId`; a write rejected with 403 re-reads the capability and retries once, and the message names a stale capability.
### Features
- `/api/all-usage/status` reports `pluginVersion` and `capabilityId`, so a host/page version mismatch can say “restart DSH” instead of staying invisible.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.16 (2026-09-29)
### 新功能
- **支持 DSH 0.2.0-rc.2** —— 真机 Cordis smoke 全过；区间加 `>=0.2.0-rc.2 <0.2.1-0`，已验证增至 6 个运行时，CI 12 个作业。

### Features
- **DSH 0.2.0-rc.2 is supported** — the real Cordis smoke passes; the declared range gains `>=0.2.0-rc.2 <0.2.1-0`, the verified list grows to six runtimes and CI to twelve jobs.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.15 (2026-09-28)
### 新功能
- **中国法定节假日全天谷价** —— 峰谷计划可带显式节假日日期（支持区间写法与一键抓取当年安排）；内置 DeepSeek 表自带 2026 年 33 天官方安排，官方直连与已映射行零配置生效，快照记录 `pricingHoliday`。
### 优化
- **成本设置合并成一张可编辑价格表** —— 映射列 + 四个价格框 + 上下文档位 / UTC 峰谷编辑器；仅存在于配置的行仍可见、可改、可删。
- **峰谷计划可按模型编辑** —— 接口返回去重的 `temporalSchedules` 与每行来源标记；改计划按文档口径对账历史，改价格永不改写历史。

### Features
- **Chinese statutory holidays price as a full off-peak day** — a peak plan can carry explicit holiday dates (ranges and a one-click fetch of the year's arrangement); the built-in DeepSeek plan ships the 2026 33-day arrangement, so first-party and mapped rows need no configuration, and snapshots record `pricingHoliday`.
### Improvements
- **Cost Settings is one editable price table** — a mapping column, four price boxes and context-band / UTC peak editors; rows that exist only in the configuration stay visible, editable and removable.
- **Peak plans are editable per model** — the payload carries deduplicated `temporalSchedules` plus per-row provenance; changing a plan reconciles that model's history, while price edits never rewrite history.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.14 (2026-09-27)
### 修复
- **`deepseek-flash` 补进内置峰谷表** —— 峰值时段成本此前被少算约 57%；已带豁免结论落盘的记录一次性迁移。报告者 @baileyh8（#2）。

### Fixes
- **`deepseek-flash` joins the built-in peak table** — peak-hour cost had been under-reported by roughly 57%; records stored with the exempt verdict are migrated once. Reported by @baileyh8 (#2).
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.13 (2026-09-25)
### 新功能
- **支持 DSH 0.1.7-rc.2** —— 真机 smoke 全过，进入声明区间与 CI 矩阵（桌面客户端即该运行时线）。
### 优化
- smoke 对 0.1.7 的抽象 settings seam 版本感知；`0.1.5-rc.2` 纳入 CI；`check-package` 会拦下「声明已验证却不在 CI 矩阵 / 档位表」的情况。

### Features
- **DSH 0.1.7-rc.2 is supported** — the real smoke passes, and the line joins the declared range and the CI matrix (the desktop client runs on it).
### Improvements
- The smoke is aware of 0.1.7's abstract settings seam; `0.1.5-rc.2` joins CI; and `check-package` now fails when a runtime is called verified without appearing in the CI matrix and the profile table.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.12 (2026-09-25)
### 修复
- **runtime smoke 不再手数路由** —— 此前断言 dispose 恰好移除 9 条，v1.1.11 加路由后所有 smoke 作业失败并连带发布失败；期望值改由路由清单推导。
### 说明
- v1.1.11 只发了 GitHub Release，**未进 npm**（发布工作流校验 tag，已发布的 tag 不移动），其修复随本版到达 npm。

### Fixes
- **The runtime smoke no longer counts routes by hand** — it asserted that dispose removed exactly nine, so v1.1.11's new route failed every smoke job and its own publication; the expectation is now derived from the route list.
### Notes
- v1.1.11 reached GitHub Releases but **never npm** (the publish workflow verifies the tag and a published tag is never moved); its fix reaches npm users with this release.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.11 (2026-09-25)
### 修复
- **桌面端关闭按钮不再被盖** —— 面板改为从 `--dsh-windows-titlebar-height`（40px）之下开始。
- **预留标题条其实从未生效** —— 未设置的 localStorage 键被读成 `0` 并通过了 `>= 0` 判断，宿主标记 / Overlay / UA 兜底全是死代码。
### 优化
- 预留高度来源顺序改为宿主声明 → Overlay 矩形 → UA，localStorage 仍可覆盖。
- 新增 `GET /api/all-usage/client-env`（并以 `clientEnv` 出现在 status），正是它从桌面应用之外暴露了上面的 bug。

### Fixes
- **The desktop client's close button is no longer covered** — the sheet now starts below `--dsh-windows-titlebar-height` (40px on Windows).
- **The reserved strip never actually applied** — an unset localStorage key read as `0`, passed the `>= 0` check and returned early, leaving the host marker, the overlay geometry and the user-agent fallback as dead code.
### Improvements
- The reserved height now comes from the host declaration, then the overlay rectangle, then the user agent, with localStorage still overriding everything.
- A new `GET /api/all-usage/client-env` route (surfaced as `clientEnv`) is what exposed that bug from outside the desktop app.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.10 (2026-09-14)
### 修复
- **账本快路径回归** —— 0.1.5 把 `listSnapshots()` 改名 `list()`，修订号拿不到导致每次基线重读全部日志（479 会话 / 431 次读取 / 约 13 分钟）；两种拼写都接受后恢复跳过。
- **基线期间的工作区变更不再丢** —— 扫描结束后立刻重放。
### 优化
- 工作区注册表每 30 秒额外轮询一次；status 暴露探针计数（累计，不被基线重置）。
### 说明
- 升级后首次启动仍会读一遍全部日志（旧账本没有 `lastRevision`），从下一次启动起才免读。

### Fixes
- **The ledger fast path is back** — DSH 0.1.5 renamed `listSnapshots()` to `list()`, so no revision was available and every baseline re-read every log (479 sessions, 431 reads, about 13 minutes); both spellings are accepted again and unchanged sessions are skipped.
- **A registry change during a baseline is no longer dropped** — it is remembered and replayed as soon as the scan settles.
### Improvements
- The workspace registry is polled every 30 seconds as well, and status exposes the probe counters (cumulative, never reset by a baseline).
### Notes
- The first start after upgrading still reads every log once (older records carry no `lastRevision`); re-read avoidance starts from the next start.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.9 (2026-09-12)
### 修复
- **删除工作区不再抹掉历史** —— 探针丢弃其账本行、恢复又跳过 `sourceCwd` 失效的行，两者叠加销毁了已记录的历史。
### 优化
- 被移除工作区的用量汇总成一行「已删除」；`retargetSession()` 就地改键，未落账的实时用量也保留。
- 账本行保留原 workspace id 与 cwd（改键只在内存副本）；严格注册边界不变，旧 `unregistered:` 行不复活。

### Fixes
- **Deleting a workspace no longer erases its history** — the probe dropped its ledger rows while recovery skipped rows whose `sourceCwd` no longer mapped, and together they destroyed recorded history.
### Improvements
- Usage from removed workspaces is summed into a single **Deleted** row, and `retargetSession()` re-keys live aggregates in place so usage that had not reached the ledger survives too.
- Ledger rows keep their original workspace id and cwd (re-keying happens on the in-memory copy only), the strict registration boundary is unchanged and legacy `unregistered:` rows are never resurrected.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.8 (2026-09-11)
### 修复
- README 仍引用 0.1.5 之前的兼容声明与停在 0.1.1 的验证矩阵，与 v1.1.6 / v1.1.7 之后的 `package.json` 矛盾；中英已改齐。
### 优化
- CI smoke 覆盖 `0.1.5-rc.1`，并按运行时版本选择 cordis / loader / timer 线。

### Fixes
- The README still quoted the pre-0.1.5 compatibility declaration and a matrix that stopped at 0.1.1, contradicting `package.json` after v1.1.6/v1.1.7; both languages now agree.
### Improvements
- CI smoke covers `0.1.5-rc.1` and selects the cordis/loader/timer line per runtime version.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.7 (2026-09-11)
### 修复
- 兼容区间改为按元组带预发布分支 —— node-semver 只放行「同 `major.minor.patch` 且自带预发布标签」的比较符，旧的宽区间把目标运行时 `0.1.5-rc.1` 静默判为不支持。

### Fixes
- The compatibility range now carries an explicit prerelease branch per tuple: node-semver only admits a prerelease when a comparator shares its `major.minor.patch` and carries a prerelease tag, so the previous broad range silently rejected the target runtime `0.1.5-rc.1`.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.6 (2026-09-11)
### 修复
- **DSH 0.1.5 兼容** —— 该版本用 `snapshotEvents()` 取代 `events`，实时 flush 会写空账本记录（`lastSeq: -1`）；现在优先 `events`、否则退回 `snapshotEvents()`。
- smoke 断言账本保留被 flush 会话的序号与用量，并覆盖 0.1.5-rc.1。
### 优化
- 兼容区间放宽到 `>=0.1.1-rc.1 <0.1.6`，`0.1.5-rc.1` 进入已验证列表。

### Fixes
- **DSH 0.1.5 compatibility** — it replaces `events` with `snapshotEvents()`, so live flushes wrote empty ledger records (`lastSeq: -1`); event access now prefers `events` and falls back to `snapshotEvents()`.
- The smoke asserts the persisted ledger keeps a flushed session's sequence and usage, and covers 0.1.5-rc.1.
### Improvements
- The declared range widens to `>=0.1.1-rc.1 <0.1.6` and `0.1.5-rc.1` joins the verified list.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.5 (2026-09-07)
### 新功能
- **工作区注册表自动探针** —— 监听 `domain/changed`，增量同步（只扫新增、逆折叠移除、未变化零重扫）；手动刷新控件 / 路由 / 按钮一并移除。
### 修复
- 用量严格限定于已注册工作区；`sourceCwd` 失效的账本行恢复时跳过，并按源路径校验归属。

### Features
- **An automatic workspace-registry probe** — it follows `domain/changed` and syncs incrementally (only new workspaces are scanned, removals are subtracted by inverse folding, unchanged ones are reused); the manual refresh control, route and button are gone.
### Fixes
- Usage is strictly limited to registered workspaces; ledger rows whose `sourceCwd` no longer maps are skipped during recovery, and the source path is persisted so ownership can be validated.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.4 (2026-09-03)
### 新功能
- **DeepSeek 峰谷计费成为一等、带版本的「分时价格计划」** —— cost schema v2，快照记录计费时刻、时间来源、UTC 档位与策略 id / 哈希。
- **内置一线档位表** —— v4-flash / v4-flash-vision-exp / v4-pro，按 UTC 工作日 01:00-04:00 与 06:00-10:00；峰值费率是数据，不是自动折扣。
- **半开边界且只看 UTC** —— 周末全天谷时，观众时区与夏令时都影响不了结果。
- **确定性复用** —— 同一 turn/step 的后续样本仅在 identity / 桶 / 档位 / 策略全等时复用，跨峰值边界不继承价格。
- **受控对账** —— 一线快照按用量时刻重定价，v1 快照迁移到 v2，窗口不覆盖则 fail closed 为 `unsupported`。
- **路由安全边界** —— 只对一线 deepseek 或显式映射到官方条目的路由生效；中转路由保持静态价并标 `route-not-official`。
- **尊重官方生效时刻** —— 从 2026-08-16T16:00:00Z 起算（vision-exp 为 08-21），更早的用量 fail closed。
- **真实厂商品牌图标** —— 请求日志 / 调用详情 / 模型表 / 成本设置表改用 11 个品牌 SVG（构建期内嵌 data URI，运行时不联网）。
- **图标来源随包发布** —— manifest 钉住上游 commit 与逐文件归属，缺许可或归属即构建失败。
### 优化
- 请求上下文归档持久化并参与增量播种；真 LRU + 512 条上限；整折时清理陈旧上下文。
- 已定价的 v2 快照跨目录刷新仍可审计：policy hash 不含实时费率，只有显式 `repriceTemporal` 才重估。
- 策略归档支持有序窗口并拒绝跨规则重叠；非法时段配置保持可见并 fail closed。
- 实时重同步原子化（权威快照重建并持久化账本，失败保留 dirty 状态）；权威性改为基于证明，滞后快照只 upsert。
- 构建期 SVG 守卫（`scripts/svg-guard.mjs`）拒绝外部 `url()` / `image-set()` / `@import`、DOCTYPE / CDATA / 处理指令与外部资源元素。
### 修复
- 审计后加固：CDO/CDC 相邻 `@import`、命名空间 `<svg:style>` 内的 `@import`、CSS 转义 `url(`、外部 `image-set()` 全部拒绝；style 属性在原始与实体解码两份文档上检查。
- CSS 检查只在 style 属性与 `<style>` 体内运行（注释与文本不误报）；对抗样本断言的是拒绝原因。
- 模型筛选下拉也显示品牌图标，三张看板截图刷新。

### Features
- **DeepSeek peak/off-peak billing became a first-class, versioned temporal plan** — cost schema v2 records the billing instant, its time source, the UTC band and the policy id/hash in every snapshot.
- **A built-in first-party rate table** — v4-flash / v4-flash-vision-exp / v4-pro for the UTC weekday windows 01:00-04:00 and 06:00-10:00; peak rates are data, never an automatic discount.
- **Half-open boundaries, UTC only** — weekends are off-peak all day and neither the viewer's timezone nor DST can change a result.
- **Deterministic reuse** — a later sample for the same turn/step reuses a snapshot only when identity, buckets, band and policy all match, so a message crossing a peak boundary never inherits the price.
- **Controlled reconciliation** — first-party snapshots are re-priced against their usage instant, v1 snapshots migrate to v2, and an uncovered instant fails closed as `unsupported`.
- **Route safety boundary** — the plan applies only to first-party deepseek routes or routes explicitly mapped to the official entry; reseller routes keep the static price and are labelled `route-not-official`.
- **The official effective instant is respected** — the plan starts at 2026-08-16T16:00:00Z (08-21 for vision-exp) and earlier usage fails closed.
- **Real vendor brand icons** — the request log, call details, model table and cost-settings table use eleven brand SVGs (embedded as data URIs at build time; the runtime never touches the network).
- **Icon provenance ships with the package** — the manifest pins the upstream commit and per-file attribution, and the build fails without the licence or attribution.
### Improvements
- The request-context archive is persisted and seeds incremental folds; a real LRU with a 512-entry cap; full folds clear stale contexts.
- Priced v2 snapshots stay auditable across catalog refreshes: the policy hash excludes live rates and only an explicit `repriceTemporal` re-estimates them.
- Policy archives support ordered, non-overlapping windows and reject cross-rule overlap; an invalid temporal config stays visible and fails closed.
- Live resyncs are atomic (an authoritative snapshot rebuilds and persists the ledger record, failures stay dirty) and authority is proof-based: lagging snapshots only upsert.
- A build-time SVG guard (`scripts/svg-guard.mjs`) rejects external `url()` / `image-set()` / `@import`, DOCTYPE / CDATA / processing instructions and every external-resource element.
### Fixes
- Hardened after an independent audit: CDO/CDC-adjacent `@import`, `@import` inside a namespaced `<svg:style>`, CSS-escaped `url(` and external `image-set()` targets are all rejected, and style attributes are checked on both the raw and entity-decoded document.
- CSS checks run only on style attributes and `<style>` bodies (comments and text cannot false-positive), and the adversarial fixtures assert the rejection reason.
- The model filter dropdown shows brand icons too, and the three dashboard screenshots were refreshed.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.3 (2026-09-01)
### 新功能
- 成本统计支持上下文档位，可展开官方费率表。
- 确定性用量不变量 + 脱敏 fixture 回放命令。
- Node 22/24 CI 矩阵（含包内容检查与 0.1.1-rc.1 / rc.2 真机 smoke）。
- 三份社区 issue 模板（数据不一致 / 启动失败 / 成本计算）。
### 优化
- flush 不再重建干净会话的账本（脏记录合并，退出时 drain）。
- 派生账本分 32 个稳定哈希分片，只重写受影响的分片。
- scope query 与 53 周热力图改用 ingest 期 cube + BigInt 精确累加。
- 热力图指针跟踪与渲染路径隔离（memo + rAF 合并，后台标签节流兜底）。
- 客户端产物 276 KB → 177 KB（固定版本 Terser）。
### 修复
- **账本序号契约贯穿所有读写路径** —— 只接受 `-1` 哨兵或非负安全整数；污染键与非规范数字一律标记重建并持久化原因。
- **折叠存疑时全量重建** —— 序号不连续、折叠起点之前有非法序号、尾部未前进，都不再尾部折叠。
- **定价与刷新时序** —— 读写前等待持久化配置；定价 revision 变化优先；只在影响成本时提升 revision；目录哈希排除 `fetchedAt`。
- **在飞的官方模型搜索彻底失效化** —— 删行、关面板、目录替换都会提升行代际。
- **服务端 auto-sync 标志是唯一真相** —— 客户端不再用本地状态播种草稿。
- **时区与时间桶** —— 半小时偏移不丢事件；趋势标签用真实桶边界；DST 回拨的重复小时分别成桶。
- **工作区身份** —— 以不同 id 重建时强制全量重建；顶层与历史条目不一致的行标为不可用。
- **HTTP 与激活边界** —— peer 必须是 loopback（含 IPv4-mapped）；激活前必须有 `webServer`。
- **发布与构建守卫** —— 拒绝缺失或未跟踪的生成 bundle；手动 npm 恢复必须校验 tag 与完整 SHA。
### 文档
- 记录兼容矩阵、本地可复算与供应商账单的区别、缓存 / Token 示例与 fixture 工作流。

### Features
- Cost statistics became tier-aware with expandable official rate schedules.
- Deterministic usage invariants plus a redacted fixture replay command.
- A Node 22/24 CI matrix with package-content checks and required real DSH smoke coverage for 0.1.1-rc.1 and rc.2.
- Three community issue templates (data inconsistency, startup failure, cost calculation).
### Improvements
- A clean session's ledger is no longer rebuilt at flush: dirty records are coalesced and drained on disposal.
- The ledger is stored in 32 stable-hash shards, so an update rewrites only its own shard.
- Scoped queries and the heatmap build from ingest-time cubes with exact BigInt accumulators.
- Heatmap pointer tracking is isolated from the render path (memoized parts, rAF-coalesced coordinates, a throttled fallback for background tabs).
- The shipped client artifact dropped from about 276 KB to about 177 KB with pinned Terser.
### Fixes
- **The ledger sequence contract covers every read and write path** — only the `-1` sentinel or a non-negative safe integer is accepted; polluted keys and non-canonical numbers are flagged for rebuild with the reason persisted.
- **Any doubt about folding triggers a full rebuild** — broken sequence continuity, an invalid sequence before the fold start, or a tail that did not advance no longer tail-folds.
- **Pricing and refresh ordering** — reads and writes wait for the persisted configuration, a pricing revision change wins over concurrent data, revisions only bump for cost-affecting changes, and the catalog hash excludes `fetchedAt`.
- **In-flight official-model searches are invalidated for good** — deleting a row, closing the panel and replacing the catalog all bump the row generation.
- **The server-persisted auto-sync flag is the single truth** — the client no longer seeds the draft from local state.
- **Timezones and buckets** — fractional-hour offsets no longer drop events, trend labels use real bucket boundaries, and both repeated hours of a DST fall-back day stay distinct.
- **Workspace identity** — a workspace recreated with a different id forces a full rebuild, and rows whose top-level workspace disagrees with their items are marked unusable.
- **HTTP and activation boundaries** — the socket peer must be loopback (IPv4-mapped included) and `webServer` must exist before the Host activates.
- **Release and build guards** — a missing or untracked generated bundle is rejected, and manual npm recovery must verify the tag and full commit SHA.
### Documentation
- Documented the compatibility matrix, the difference between local replayable statistics and provider billing, cache/token examples and the fixture workflow.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.2 (2026-08-30)
### 新功能
- models.dev 价格目录同步（持久缓存、可选 6 小时自动同步、模型映射与手工覆盖）。
- cc-switch 兼容的四桶成本快照（倍率只作用于总额）。
- 账本 v3 成本快照、未计价计数、导出成本列与成本设置面板。
- 可搜索的当前模型选择器与自动官方模型查找。
- 环形图的 Token / 成本明细；按日期索引的查询与 revision 作用域缓存。
### 修复
- 不再把推理 Token 收两次费；已定价历史在目录更新后保持稳定。
- 已保存映射不再显示空模型字段；会话引导或读取失败不丢首批实时事件；拒绝超大请求体与非法时间戳。

### Features
- models.dev catalog sync with a persisted last-good cache, optional 6-hour auto sync, mappings and manual overrides.
- cc-switch-compatible four-bucket cost snapshots, with multipliers applied to the total only.
- Ledger v3 cost snapshots, unpriced counters, cost columns in exports and the cost-settings panel.
- Searchable current-model selectors and automatic official-model lookup.
- Token/cost details in the donut legends, date-indexed queries and revision-scoped caches.
### Fixes
- Reasoning tokens are no longer charged twice, and priced history stays stable across catalog updates.
- Saved mappings no longer reopen with an empty model field, first live events survive bootstrap or read failures, and oversized bodies and invalid timestamps are rejected.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.1 (2026-08-29)
### 修复
- 为兼容注册表，以新的修订号重发 v1.1 包。

### Fixes
- The v1.1 package was reissued under a new patch version for registry compatibility.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.1.0 (2026-08-29)
### 新功能
- 结构化 Provider / requested / actual / display 身份字段（保留旧 `model`）。
- 向后兼容的账本 v2 适配器。
- 共享 scope 查询与隐私安全分页接口（`/query`、`/records`），单日 scope 增加小时行。
- 三个筛选维度互相独立可组合，选项只列当前范围内实际用过的值。
- 统一筛选贯穿聚合、热力图、趋势与导出。
- 可选 Token 趋势图（平滑曲线、可切序列、单日用小时桶）。
- Token 占比环形图（排名图例与悬停明细）。
- 常驻请求日志标签页（分页表、选中明细、CSV 导出）。
### 优化
- records 分页改 revision 排序 + 预计算；聚合加 memo 并只渲染活动标签页。
### 修复
- 修复显示标签含 ` / ` 的身份碰撞；检测被截断或替换的日志；三类计数分开定义；趋势与 tooltip 的一系列渲染修复。

### Features
- Structured Provider / requested / actual / display identity fields, keeping the legacy `model`.
- A backward-compatible ledger v2 adapter.
- Shared scoped query and privacy-safe paged APIs (`/query`, `/records`), with hourly rows for single-day scopes.
- Workspace, provider and model filters are independent and combinable, and options list only values used in the selected range.
- Unified filtering spans aggregates, the heatmap, trends and exports.
- A selectable Token trend chart (smooth curves, switchable series, hourly buckets for single days).
- Token-share donut charts with ranked legends and hover details.
- A persistent Request Logs tab (paged table, selected-row detail, CSV export).
### Improvements
- Records pagination uses revision ordering and precomputed values; aggregates are memoized and only the active tab renders.
### Fixes
- Fixed identity collisions from display labels containing ` / `, detected truncated or replaced logs, kept the three counters separately defined, and fixed a series of trend/tooltip rendering issues.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.0.9 (2026-08-26)
### 新功能
- 轻量 `/api/all-usage/status` 契约（实例 ID、单调 revision、扫描进度、同步健康）。
- 同步健康可见性（跳过 / 读取 / 账本恢复 / 失败 / 快照可用性）。
- revision 驱动的客户端刷新（只在实例或 revision 变化时取全量）。
### 修复
- 失败时保留上一次视图，提供重试与有界退避。

### Features
- A lightweight `/api/all-usage/status` contract (instance id, monotonic revision, scan progress, sync health).
- Sync-health visibility (skipped, read, ledger-recovered, failed, snapshot availability).
- Revision-driven client refresh: the full snapshot is fetched only when the instance or revision changes.
### Fixes
- The last successful view survives failures, with a retry action and bounded backoff.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.0.8 (2026-08-24)
### 新功能
- **重启免读游标** —— 用持久化日志修订号作为变更信号，未变更会话直接从账本应用。
### 修复
- 重启不再重读每个会话的历史。

### Features
- **A restart read-avoidance cursor** — the persisted log revision is the change signal, so unchanged sessions are applied straight from the ledger.
### Fixes
- Restarts no longer re-read every session's history.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.0.7 (2026-08-23)
### 新功能
- 增量账本游标（未变会话从账本播种，变化会话只折叠新尾部）。
- 全零用量守卫；`tokenSemantics` 语义声明。
### 修复
- 降低长历史的启动扫描成本；防止实时重试重复计数。

### Features
- An incremental ledger cursor: unchanged sessions seed from the ledger and changed ones fold only the new tail.
- An all-zero usage guard and a machine-readable `tokenSemantics` declaration.
### Fixes
- Startup scan cost on long histories is reduced, and live retries no longer double-count.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.0.6 (2026-08-23)
### 新功能
- 持久化逐会话用量账本（在 `session/flush` 边界写入）；日志删除后用量仍在；缺失时自动重建。
### 修复
- 防陈旧基线覆盖新账本；重复键规范化与退出期写入守卫；非法存储单元名；Cordis 定时器上下文不再致命。

### Features
- A durable per-session usage ledger written at the `session/flush` boundary; flushed usage survives log deletion and is rebuilt automatically when logs are missing.
### Fixes
- Stale baselines no longer overwrite newer ledger records; duplicate keys are normalized and writes are guarded during disposal; invalid storage unit names are fixed; inactive Cordis timer contexts are no longer fatal.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.0.5 (2026-08-21)
### 新功能
- 自定义起止日期范围；热力图仍固定最近 53 周；有界范围给出独立会话计数。
### 修复
- 基线重试带退避；退出或刷新竞争后停止在飞扫描与陈旧轮询。

### Features
- Custom start/end ranges, a heatmap that stays a fixed latest-53-week view, and distinct session counts for bounded ranges.
### Fixes
- Baseline retries back off, and in-flight scans and stale polling stop after disposal or refresh races.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.

## v1.0.4 (2026-08-18)
### 修复
- 加固 loopback / 同源 / 方法 / 令牌检查；允许省略 `Origin` 的同源余额 GET；英文模式统一 UTC。

### Fixes
- Hardened loopback, same-origin, method and token checks; allowed same-origin balance GETs without `Origin`; and standardised English mode on UTC.
> 每条改动的背景、真机证据与踩过的坑，见对应提交信息。 / Background, evidence and pitfalls for each change live in the corresponding commit message.
