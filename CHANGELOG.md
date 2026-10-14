# Changelog

## v1.2.0（未发布）
### 新功能
- **模型图标扩到 43 个品牌** —— 从 lobe-icons 固定 revision 取 32 个新商标；9 个 `currentColor` 烘成固定中性色。
- **网关 / 云的包裹 id 还原真实品牌** —— 覆盖 `openai-gpt-5.5`、`databricks-claude-*`、`eu.anthropic.claude-*` 等写法，原始 id 仍优先。
### 优化
- **长时间运行不再越用越占内存** —— 用量明细不再全部常驻内存：每个会话维护一份摘要（足以把它的 token 与成本从聚合里精确扣回来），**已经定稿的行**在扫描结束后交还账本，查看「请求日志 / 当日明细」时再按需从磁盘读回；启动阶段也改为只列账本目录、按会话读单条记录（原来一次性解析全部记录）。真机 6.6 万行实测：峰值 156 MB、**静置降到 87 MB**，降前降后的日志页逐行一致、总额与逐日聚合一分不差。
- **热力图可以用键盘操作了** —— 每个日期格子现在是真正的按钮，带读屏可读的名字（如「2026年10月12日 周一：63 次使用」）；整块日历**只有一个 Tab 停靠点**（今天），方向键按天/按周移动、Home / End 到首尾、回车打开当日明细，悬停提示会跟着焦点走；图例对读屏隐藏（纯装饰），说明文字补上了键盘用法。
- **生效起点也按北京时间** —— 该日期现在表示「那天 00:00（北京时间）」，与时段同一时区。内置 DeepSeek 文本表本来就锚定在北京时间零点（存的是前一天 16:00 UTC），改前界面显示成 UTC 日期（差一天），现在显示正确、原样保存不变；英文界面仍按 UTC，留空仍表示全部历史。
- **成本设置里的时段改用北京时间** —— 峰的时段在宿主里按 UTC 存（DeepSeek 自己的峰时是北京时间 09:00–12:00 / 14:00–18:00），中文界面现在直接按北京时间显示与填写、保存时自动换回 UTC；跨午夜的时段会拆到次日并顺延星期；英文界面仍按 UTC。生效日期仍是 UTC（留空 = 全部历史）。
- **热力图改成蓝色** —— 方块由 GitHub 绿换成蓝色渐变（同一个强调色按 20/45/70/96% 混进面板底色，明暗主题都保持可读），图例与「今日」光晕同步换色。
- **冷启动再快一倍：小数累加走快路** —— 折叠阶段每加一个成本字段都要做两次 `10n ** k` 幂运算和三次「去尾零」规整，且每条用量的成本在装载与折叠时被**解析两遍**。改为查表取 10 的幂、省掉多余的规整、并把装载时解析出的数直接交给累加缓存后：同一份真机账本（139.3 MB / 1060 条 / 6.6 万行）的**折入 3.83 → 1.80 s**、**加载 2.8 → 2.5 s**，**完整冷启动 ~6.7 → ~4.3 s**（审计基线 8.6 s）。金额逐字校验：离线折叠与线上宿主的总成本完全一致（`2027.6934100306`、65,633 次计价）。
- **账本加载阶段提速约 1.5×** —— 每条用量行原先要跑两遍校验 + 两次成本快照解析（每次 11 个小数域），且「已是最新格式」的记录在装载时还会被再全量解析一遍；两处都消除后，同一份 156.7 MB 真实账本、**只计加载阶段**（读盘 + 归一化 + 展开）从 **4.2 s（审计基线）降到 2.2–3.2 s**（纯加载进程 2.2 s；聚合状态同时存活时因堆压力约 3.2 s）。这组旧基线的**完整冷启动**（含把 6.6 万条折进聚合 cube）为首次 9.8 s / 稳态 7.5 s，其中折入耗时 4.3 s 未变；后续首建扫描优化见下文。
- **首次建账复用会话观察快照** —— 在提供 `observeSession` 的 runtime 上跳过未使用的投影构建，并在扫描退出时释放观察租约；较旧 runtime 仍兼容 `readSession`。固定 570 会话的隔离对照中，ready 中位数 935.753 → 95.329 秒（−89.8%），两侧均完整读取全部会话日志，18 层原始账目一致。该计时包含独立测试宿主开销，不代表在线 DSH 启动耗时。
- **再清掉 5 个无人调用的客户端函数** —— `metadataVersion`、两个 `statusRequires*` 薄包装（语义已由 `statusRefreshKind` 覆盖，测试改为直接断言它）、`donutArcPath`（应用只用线段版）、`modelOptionLabel`；bundle 从 235.5 KB 再降到 **234.6 KB**。（本轮多提交一条：`scripts/dead-code.mjs` —— 可重复运行的死代码体检。）
- **清掉一处死代码与五组失效样式** —— 一个没有任何调用者的 host 辅助函数，以及「在用模型选择器」等 5 个再也不会出现的 class 样式规则（脚本按「CSS 之外零引用、且其前缀也无法动态拼出」判定，删前逐条核对）；bundle **235.5 → 234.6 KB**。
- **按范围的旧查询结果不再滞留** —— 结果键里带 revision，旧条目永远读不到却仍占内存；现在数据或定价一变就清掉（每条约 30–115 KB × 最多 20 条）。
- **热力图入场动画不再拖长尾、也不再无视「减少动态效果」** —— 376 格的错峰延迟从「每格 1.2ms、最长 444ms」改为按 25 格循环（最长 **144ms**）：实测挂载 700ms 后仍在跑的动画 **393 → 11**（页面静置后只剩 4 个，其中含「今日」光晕）；「今日」呼吸光晕在 `prefers-reduced-motion: reduce` 下不再启动（它写在行内样式里，媒体查询原本覆盖不到）。
- **定价快照不再每次重算路由清单** —— 价格表要遍历全部用量行（本机 6.5 万条）才能列出用过的模型；该结果改为按「数据 / 定价 revision」缓存，只在两者变化时重算（模型化实测：每次 3.4 ms → 命中约 0 ms）。
- **定价回填与时段核对合并为一次扫描** —— 价格同步和定价设置更新共用一次用量行遍历，避免对同一账本分别做两轮核对。固定账本隔离回放中，ready 中位数 21.883 → 18.131 秒（−17.1%），原地全量聚合重建 23.445 → 19.793 秒（−15.6%）；六层原始账目一致。
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
- **冷分页先从会话摘要构建索引** —— 冷查询先用摘要定位、筛选和排序，再按页读取所需明细；摘要不能精确描述范围时仍走完整读取回退。固定 67,328 行账本的隔离对照中，首屏中位数 2.946 → 0.287 秒（−90.2%），遍历 3,367 页为 7.187 → 4.770 秒（−33.6%），行及逐层账目一致。代价是 settled heap 增约 6.05 MiB，warm 后页 p99 中位数增加约 4.14 ms。
### 修复
- **修复「谷时段被记成峰时」** —— DSH 可能整场会话只发一次 `request/context`，而插件把这条**会话级**时间戳当成每次请求的计费时刻：实测 20:02 的调用按 14:10 的峰时窗口计价，峰谷**费率**与「峰/谷」标记一起错（本机 6.6 万条里有 1.6 万条受此影响）。现在会话级时间戳只在 30 分钟内有效（超时改用调用自身的时间），对账过程也会把历史里「比调用早 30 分钟以上、且该会话没有与这条记录 turn/step 对应的时间戳」的行按调用时间重新计价一次。逐请求（turn/step）时间戳的语义不变。
- **同一模型的多个路由合并为一个筛选项** —— 按模型名归并（忽略大小写与 `供应商/` 前缀），宿主同样按模型名匹配。
- **模型筛选不再显示供应商命名空间** —— 只显示模型名，取值仍是原始 id（实测 25 项里含 `/` 的为 0）。
- **供应商 / 模型下拉不再无限下延** —— 限高 `min(60vh, 420px)` 内滚，打开时滚到当前选中项。

### Features
- **43 model brands** — 32 new marks from the pinned lobe-icons revision; nine had currentColor baked to a fixed neutral.
- **Gateway and cloud ids resolve to the real brand** — covers openai-gpt-5.5, databricks-claude-*, eu.anthropic.claude-*; the raw id still wins.
### Improvements
- **A long-running install no longer keeps growing** — usage detail rows are no longer all resident: each session keeps a digest (enough to unwind its tokens and cost from the aggregate exactly), rows whose pricing is final are handed back to the ledger once a scan finishes, and the request log reads them from disk again on demand; a cold start now lists the ledger directory and reads one record per session instead of parsing every record at once. Measured on a real 66k-row ledger: peak 156 MB, **steady state 87 MB**, with the log pages byte-identical and the totals unchanged.
- **The heatmap is keyboard-operable** — every date cell is a real button with a screen-reader name (for example "2026-10-12 Monday: 63 uses"), the calendar is a single tab stop (today), arrows move by a day or a week, Home/End jump to the ends, Enter opens the day's detail, and the tooltip follows focus; the legend is hidden from screen readers because it is decorative, and the note mentions the keyboard.
- **The effective-from date follows Beijing time too** — the date now means 00:00 Beijing, the same zone as the windows. DeepSeek's built-in text plan already anchors at Beijing midnight (stored as 16:00 UTC the day before) and used to display as the previous calendar day; it reads correctly now and saves back unchanged. English keeps UTC, and an empty field still means the whole history.
- **Time-of-day pricing is edited in Beijing time** — the host stores peak plans in UTC while DeepSeek's own peak hours are 09:00-12:00 and 14:00-18:00 Beijing time, so Chinese now shows and accepts those times directly and converts back on save (a window crossing midnight moves to the next weekday); English keeps UTC, and the effective date stays a UTC date.
- **The heatmap is blue now** — cells switch from GitHub green to a blue ramp (one accent mixed into the panel surface at 20/45/70/96%, so it stays readable in both themes), and the legend and today's glow follow.
- **Cold start halves again: the decimal path takes a fast route** — every accumulated cost field paid for two `10n ** k` powers and three trailing-zero normalizations, and each usage row's cost was parsed twice (once on load, once when folded). A power table, fewer normalizing passes and handing the load-time parse to the accumulator cache took the same real ledger (139.3 MB, 1060 records, 66k rows) from a **3.83 s fold to 1.80 s** and a **2.8 s load to 2.5 s**: a **full cold start of about 4.3 s instead of 6.7 s** (the audit measured 8.6 s). The money is unchanged to the last digit — an offline fold and the live host agree exactly (`2027.6934100306`, 65,633 priced calls).
- **The ledger's load phase got about 1.5x faster** — every usage row ran two validation passes plus two cost-snapshot parses (eleven decimal fields each), and a record already in the current format was parsed in full again when it was applied; both are gone. On the same 156.7 MB of real data, the **load phase alone** (read, normalize, expand) went from the audit's **4.2 s to 2.2-3.2 s** (2.2 s in a lean process, about 3.2 s while the aggregation state is live). That earlier **full cold start** (including folding 66k rows into the cubes) measured **9.8 s on the first start and 7.5 s in steady state**, with folding unchanged at 4.3 s; the later first-scan optimization is described below.
- **First-install scans reuse observed session snapshots** — on runtimes providing `observeSession`, the scan skips unused projection construction and releases the observation lease on exit; older runtimes continue to use `readSession`. In an isolated, fixed 570-session comparison, median ready time fell from 935.753 to 95.329 seconds (−89.8%); both variants still read every session log and matched across all 18 raw accounting layers. The measurement includes the isolated harness and is not an online DSH startup time.
- **Five more client helpers nobody calls are gone** — metadataVersion, the two statusRequires* wrappers (statusRefreshKind already carries their meaning, and the tests assert it directly now), donutArcPath (only the line variant is drawn) and modelOptionLabel; the bundle drops from 235.5 KB to **234.6 KB**. A repeatable report ships with them: `scripts/dead-code.mjs`.
- **A dead helper and five orphaned style rules are gone** — a host helper with no caller and five class rules (the removed in-use model picker among them) that no code can render; each was checked for zero references outside the stylesheet and for a prefix that could not build it dynamically. Bundle **235.5 to 234.6 KB**.
- **Superseded scope results no longer linger** — the cache key carries the revision, so an old entry could never be read again while still holding 30-115 KB apiece (up to 20); a data or pricing change clears them now.
- **The heatmap entrance no longer trails and no longer ignores reduced motion** — the 376-cell stagger went from 1.2 ms per cell (a 444 ms tail) to a 25-cell wrap (144 ms); measured animations still running 700 ms after mount drop from **393 to 11** (four once the page settles, the today pulse among them), and that pulse is skipped under prefers-reduced-motion because an inline style had put it out of the media query's reach.
- **The pricing snapshot stops rebuilding its route list every time** — listing the models in use walks every usage row (65k here); the result is cached per data/pricing revision now and only rebuilt when either changes (modelled: 3.4 ms per call to about 0 ms when cached).
- **Pricing backfill and temporal reconciliation share one scan** — pricing sync and settings updates visit the usage rows once instead of running separate passes. In an isolated replay of a fixed ledger, median ready time fell from 21.883 to 18.131 seconds (−17.1%) and an in-place full aggregation rebuild from 23.445 to 19.793 seconds (−15.6%); all six raw accounting layers matched.
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
- **Cold request-log pages index from session digests** — cold queries use digest metadata to locate, filter and order rows, then load page payloads on demand; an incomplete digest still falls back to the full read. In an isolated 67,328-row ledger comparison, median first-page time fell from 2.946 to 0.287 seconds (−90.2%) and all 3,367 pages from 7.187 to 4.770 seconds (−33.6%), with rows and layered totals matching. The trade-off was about 6.05 MiB more settled heap and a 4.14 ms increase in median warm-page p99.
### Fixes
- **Fixed calls labelled peak that actually ran off-peak** — DSH can emit `request/context` once per session, and the plugin billed every later call at that session-level instant: a 20:02 call was priced in the 14:10 peak window, so both the peak rate and the badge were wrong (16k of this machine's 66k rows were affected). A session-level stamp now only counts within 30 minutes (past that the call's own time is used), and the reconciliation pass re-prices stored rows whose stamp is more than 30 minutes older than the call and which have no turn/step stamp of their own. Per-request stamps keep their meaning.
- **Routes of one model share a single filter entry** — grouped by model name (case ignored, vendor namespace dropped), matched the same way on the host.
- **The model filter no longer shows the vendor namespace** — the model name only, while the value stays the raw id (0 of 25 entries still contain a slash).
- **The provider and model menus no longer run past the window** — capped at min(60vh, 420px) with their own scroll.

## v1.1.18 (2026-10-07)
### 新功能
- **「近 7 天」范围** —— 含今天的 7 个日历日，作用于摘要 / 趋势 / 模型表 / 日志 / 筛选 / CSV。
- **热力图跨度可切换** —— 30 天 / 90 天 / 12 个月 = 5 / 13 / 53 列，格子随之变大（实测 34px vs 18px）；默认仍 12 个月，与时间范围互不影响。
- **标题旁版本指示** —— 显示运行版本；一致时小字「已是最新」，落后时高亮「最新 vX.Y.Z」，点击开 GitHub 仓库。

### Features
- **A seven-day range** — seven calendar days including today; scopes the summary, trend, model tables, request log, filters and CSV.
- **A switchable heatmap span** — 30 days / 90 days / 12 months draw 5 / 13 / 53 columns, so shorter spans get larger cells (34px vs 18px measured); twelve months stays the default and the span is independent of the time range.
- **A version indicator in the header** — the running version, plus “Up to date” in small text or a highlighted “Latest vX.Y.Z”; clicking it opens the GitHub repository.

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

## v1.1.16 (2026-09-29)
### 新功能
- **支持 DSH 0.2.0-rc.2** —— 真机 Cordis smoke 全过；区间加 `>=0.2.0-rc.2 <0.2.1-0`，已验证增至 6 个运行时，CI 12 个作业。

### Features
- **DSH 0.2.0-rc.2 is supported** — the real Cordis smoke passes; the declared range gains `>=0.2.0-rc.2 <0.2.1-0`, the verified list grows to six runtimes and CI to twelve jobs.

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

## v1.1.14 (2026-09-27)
### 修复
- **`deepseek-flash` 补进内置峰谷表** —— 峰值时段成本此前被少算约 57%；已带豁免结论落盘的记录一次性迁移。报告者 @baileyh8（#2）。

### Fixes
- **`deepseek-flash` joins the built-in peak table** — peak-hour cost had been under-reported by roughly 57%; records stored with the exempt verdict are migrated once. Reported by @baileyh8 (#2).

## v1.1.13 (2026-09-25)
### 新功能
- **支持 DSH 0.1.7-rc.2** —— 真机 smoke 全过，进入声明区间与 CI 矩阵（桌面客户端即该运行时线）。
### 优化
- smoke 对 0.1.7 的抽象 settings seam 版本感知；`0.1.5-rc.2` 纳入 CI；`check-package` 会拦下「声明已验证却不在 CI 矩阵 / 档位表」的情况。

### Features
- **DSH 0.1.7-rc.2 is supported** — the real smoke passes, and the line joins the declared range and the CI matrix (the desktop client runs on it).
### Improvements
- The smoke is aware of 0.1.7's abstract settings seam; `0.1.5-rc.2` joins CI; and `check-package` now fails when a runtime is called verified without appearing in the CI matrix and the profile table.

## v1.1.12 (2026-09-25)
### 修复
- **runtime smoke 不再手数路由** —— 此前断言 dispose 恰好移除 9 条，v1.1.11 加路由后所有 smoke 作业失败并连带发布失败；期望值改由路由清单推导。
### 说明
- v1.1.11 只发了 GitHub Release，**未进 npm**（发布工作流校验 tag，已发布的 tag 不移动），其修复随本版到达 npm。

### Fixes
- **The runtime smoke no longer counts routes by hand** — it asserted that dispose removed exactly nine, so v1.1.11's new route failed every smoke job and its own publication; the expectation is now derived from the route list.
### Notes
- v1.1.11 reached GitHub Releases but **never npm** (the publish workflow verifies the tag and a published tag is never moved); its fix reaches npm users with this release.

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

## v1.1.8 (2026-09-11)
### 修复
- README 仍引用 0.1.5 之前的兼容声明与停在 0.1.1 的验证矩阵，与 v1.1.6 / v1.1.7 之后的 `package.json` 矛盾；中英已改齐。
### 优化
- CI smoke 覆盖 `0.1.5-rc.1`，并按运行时版本选择 cordis / loader / timer 线。

### Fixes
- The README still quoted the pre-0.1.5 compatibility declaration and a matrix that stopped at 0.1.1, contradicting `package.json` after v1.1.6/v1.1.7; both languages now agree.
### Improvements
- CI smoke covers `0.1.5-rc.1` and selects the cordis/loader/timer line per runtime version.

## v1.1.7 (2026-09-11)
### 修复
- 兼容区间改为按元组带预发布分支 —— node-semver 只放行「同 `major.minor.patch` 且自带预发布标签」的比较符，旧的宽区间把目标运行时 `0.1.5-rc.1` 静默判为不支持。

### Fixes
- The compatibility range now carries an explicit prerelease branch per tuple: node-semver only admits a prerelease when a comparator shares its `major.minor.patch` and carries a prerelease tag, so the previous broad range silently rejected the target runtime `0.1.5-rc.1`.

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

## v1.1.5 (2026-09-07)
### 新功能
- **工作区注册表自动探针** —— 监听 `domain/changed`，增量同步（只扫新增、逆折叠移除、未变化零重扫）；手动刷新控件 / 路由 / 按钮一并移除。
### 修复
- 用量严格限定于已注册工作区；`sourceCwd` 失效的账本行恢复时跳过，并按源路径校验归属。

### Features
- **An automatic workspace-registry probe** — it follows `domain/changed` and syncs incrementally (only new workspaces are scanned, removals are subtracted by inverse folding, unchanged ones are reused); the manual refresh control, route and button are gone.
### Fixes
- Usage is strictly limited to registered workspaces; ledger rows whose `sourceCwd` no longer maps are skipped during recovery, and the source path is persisted so ownership can be validated.

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

## v1.1.1 (2026-08-29)
### 修复
- 为兼容注册表，以新的修订号重发 v1.1 包。

### Fixes
- The v1.1 package was reissued under a new patch version for registry compatibility.

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

## v1.0.8 (2026-08-24)
### 新功能
- **重启免读游标** —— 用持久化日志修订号作为变更信号，未变更会话直接从账本应用。
### 修复
- 重启不再重读每个会话的历史。

### Features
- **A restart read-avoidance cursor** — the persisted log revision is the change signal, so unchanged sessions are applied straight from the ledger.
### Fixes
- Restarts no longer re-read every session's history.

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

## v1.0.6 (2026-08-23)
### 新功能
- 持久化逐会话用量账本（在 `session/flush` 边界写入）；日志删除后用量仍在；缺失时自动重建。
### 修复
- 防陈旧基线覆盖新账本；重复键规范化与退出期写入守卫；非法存储单元名；Cordis 定时器上下文不再致命。

### Features
- A durable per-session usage ledger written at the `session/flush` boundary; flushed usage survives log deletion and is rebuilt automatically when logs are missing.
### Fixes
- Stale baselines no longer overwrite newer ledger records; duplicate keys are normalized and writes are guarded during disposal; invalid storage unit names are fixed; inactive Cordis timer contexts are no longer fatal.

## v1.0.5 (2026-08-21)
### 新功能
- 自定义起止日期范围；热力图仍固定最近 53 周；有界范围给出独立会话计数。
### 修复
- 基线重试带退避；退出或刷新竞争后停止在飞扫描与陈旧轮询。

### Features
- Custom start/end ranges, a heatmap that stays a fixed latest-53-week view, and distinct session counts for bounded ranges.
### Fixes
- Baseline retries back off, and in-flight scans and stale polling stop after disposal or refresh races.

## v1.0.4 (2026-08-18)
### 修复
- 加固 loopback / 同源 / 方法 / 令牌检查；允许省略 `Origin` 的同源余额 GET；英文模式统一 UTC。

### Fixes
- Hardened loopback, same-origin, method and token checks; allowed same-origin balance GETs without `Origin`; and standardised English mode on UTC.
