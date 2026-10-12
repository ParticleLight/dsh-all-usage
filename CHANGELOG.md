# Changelog

## v1.2.0（未发布）
### 新功能
- **模型图标扩到 43 个品牌** —— 从 lobe-icons 固定 revision 取 32 个新商标（Mistral、NVIDIA、Cohere、Amazon Nova、Microsoft、Perplexity、百度、腾讯、阶跃、百川、商汤、InternLM、LongCat、小米 MiMo、AI21、IBM、Upstage、Liquid、Ai2、BAAI、Voyage、字节 Seed、Kling、Skywork、Aion、Nous、TII、Aleph Alpha、Yandex、Snowflake、讯飞星火），其中 9 个 `currentColor` 烘成固定中性色并标 `modified`。
- **网关与云的包裹写法能还原到真实品牌** —— `openai-gpt-5.5`、`databricks-claude-*`、`google.gemma-3-12b-it`、`eu.anthropic.claude-*`、SAP 的 `anthropic--claude-*` 都按真实品牌着色；原始 id 优先，因此 `deepseek-v4` 不会被包裹规则抢走，包着未知模型时仍然中性。另给 10 个已覆盖品牌补「无连字符」前缀（`llama3-70b`、`gemma3-12b`、`glm4-9b`、`gpt4o`），且只在后跟数字时命中。
### 优化
- 图标溯源路径修正：原先 11 条记录的 `packages/static-svg/svg/` 在该 revision 并不存在（实际是 `icons/`），并新增「upstream 路径必须指向 bundled 文件」的断言（`openai-color.svg` 是唯一记录在案的例外）。
- 打包门禁改为从 manifest 推导图标清单，图标测试从目录推导文件清单 —— 以后加品牌不再需要手改任何清单。
- 没有品牌图标的模型改用插件自己的**层叠标记**（不再是空圆点），图标加载失败时也显示它 —— 这个标记本身不指向任何品牌，所以不会被误读成一次归属。
- 品牌图标改为**宿主按需提供**（`GET /api/all-usage/icon?key=…`）：bundle 只携带解析元数据，体积 **365 KB → 231 KB**，以后新增品牌不再增加体积；每个图标仍在构建期过一遍 SVG 守卫，并按 key（而非路径）解析、长缓存 + ETag。
### 修复
- **供应商 / 模型筛选的下拉不再无限向下延伸** —— 面板限高 `min(60vh, 420px)` 并自带滚动（`overscroll-behavior: contain`，滚到底不会带动页面），打开时把当前选中项滚进可见区域。实测 23 个供应商：面板 430px（内容区 420px）、列表 746px、可内部滚动，且不再越过窗口底边。

### Features
- **43 model brands** — 32 new marks from the pinned lobe-icons revision (Mistral, NVIDIA, Cohere, Amazon Nova, Microsoft, Perplexity, Baidu, Tencent, StepFun, Baichuan, SenseNova, InternLM, LongCat, Xiaomi MiMo, AI21, IBM, Upstage, Liquid, Ai2, BAAI, Voyage, ByteDance Seed, Kling, Skywork, Aion, Nous, TII, Aleph Alpha, Yandex, Snowflake, iFlytek), nine of which had `currentColor` baked to a fixed neutral and are marked `modified`.
- **Gateway and cloud envelopes resolve to the real brand** — `openai-gpt-5.5`, `databricks-claude-*`, `google.gemma-3-12b-it`, `eu.anthropic.claude-*` and SAP's `anthropic--claude-*`; the raw id is always tried first, so `deepseek-v4` cannot lose its brand to the rule and an envelope around an unknown model stays neutral. Ten covered brands also gained a bare prefix for ids that drop the hyphen (`llama3-70b`, `gemma3-12b`, `glm4-9b`, `gpt4o`), which only matches when a digit follows.
### Improvements
- Icon provenance corrected: the original eleven entries recorded `packages/static-svg/svg/`, which does not exist at that revision (it is `icons/`), and a test now asserts that an upstream path names the file it came from (`openai-color.svg` is the documented exception).
- The packaging gate derives the icon list from the manifest and the icon tests derive it from the directory, so adding a brand no longer requires editing either list.
- Models without a bundled brand now show the plugin's own stacked-layers mark instead of an empty dot (a failed icon load uses it too); the mark implies no brand, so it can never be misread as an attribution.
- Brand marks are now served by the host on demand (`GET /api/all-usage/icon?key=…`): the bundle carries only the resolution metadata and drops from **365 KB to 231 KB**, and adding a brand no longer grows it. Every file is still validated by the SVG guard at build time, resolution is by manifest key (never a path) and the response is long-cached with an ETag.
### Fixes
- **The provider and model filter menus no longer run past the bottom of the window** — the panel is capped at `min(60vh, 420px)` with its own scrollbar (`overscroll-behavior: contain`, so reaching the end does not scroll the page) and opens scrolled to the current choice. Measured with 23 providers: a 430px panel (420px content box) over a 746px list, scrolling internally and staying inside the window.
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
