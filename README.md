# dsh-all-usage

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[中文](#中文) · [English](#english)

## 中文

DeepSeek Harness 全量用量看板：按模型、供应商、工作区和时间范围分析 Token、缓存与账户余额。

### 功能

- **热力图**：53 周使用热力图；按工作区筛选并查看每日回合与 Token 明细
- **模型统计**：支持混合查看、按模型合并、按供应商汇总三种维度，展示调用次数、各类 Token 与缓存命中率
- **摘要与工作区**：Token 用量、缓存命中、账户余额、连续使用、工作区 Token 分布和明细
- **导出**：按当前时间范围和模型聚合方式导出 CSV
- **时间范围**：今日、近 30 天、近 90 天、全部，或在全部可扫描历史日数据中自定义起止日期；热力图始终展示最近 53 周
- **工作区别名**：在侧栏入口打开看板后管理，持久化保存到 $DSH_HOME/storages 的 KV 单元 `all_usage_aliases`
- **界面语言**：在看板顶部切换中文与 English；选择会保存到浏览器本地
- **完整历史与增量重建**：基线扫描全部可读历史会话；独立用量账本同时作为每会话游标——未变化的会话直接复用账本，新增事件只增量回填，长历史重启不再全量重建
- **重启免读**：用持久化日志的 revision 作为每会话的变更信号（只读头部行 + stat，不读全量）——日志未变的会话重启时连事件都不读，直接从账本复用；仅日志变化（新增/修改）的会话才做增量读取
- **数据健康与按需刷新**：扫描完成后浏览器只检查轻量状态版本，只有用量、别名或同步状态变化时才拉完整历史；显示本次数据更新时间、历史扫描健康、revision 免读、实际读取、账本恢复和失败，网络异常保留上次成功数据并可重试
- **性能优化**：Host 复用 canonical identity、local/UTC 日期键和当前 revision 的 records 排序；Client memo 化 scope 聚合与统计行，并只渲染当前明细页签
- **趋势折线图**：按当前范围、时区、工作区、供应商和模型显示输入、缓存读写、输出、推理及总处理量；单日范围按小时聚合并显示小时轴，跨日范围按日聚合；使用平滑单调曲线与入场动画，悬停查看精确值，图例可切换曲线，点击点位进入当日明细
- **统一筛选与审计**：工作区、供应商、模型和日期筛选贯穿摘要、热力图、趋势、表格与 CSV；工作区、供应商、模型三个筛选维度可独立自由组合，工作区、供应商和模型选项只展示当前日期范围内实际使用过的值；切换范围后失效筛选会自动清除；请求日志以紧凑分页表常驻显示，选择单条后查看分组 Token 详情
- **Token 口径**：输入按「未含缓存命中」计，缓存命中 / 写入与推理独立成桶；全 0 用量的重放事件不会覆盖已记录的真实用量，仅缓存命中的请求也会计入

### 最近更新

**v1.1.0**

- 结构化模型身份与兼容 ledger v2：区分 Provider、请求模型和实际模型，旧账本自动升级
- 统一 scope 查询：时间、时区、工作区、Provider、模型筛选同时作用于摘要、热力图、趋势、表格和 CSV
- Token 趋势折线图：单日范围按小时、跨日范围按日；平滑单调曲线、分层入场动画、多桶图例切换、悬停精确值和点位审计钻取
- 模型与工作区统计：在明细表上方提供 Token 占比环形图、中心总量、Top 项目图例和 hover 明细；环段带绘制动画，tooltip 会跟随鼠标位置
- turn / step 审计明细：常驻请求日志标签、紧凑分页表、选中行分组详情、脱敏来源标记和当前筛选范围明细 CSV

完整版本记录见 [CHANGELOG.md](CHANGELOG.md)。

### 截图 / Screenshots

![dsh-all-usage 看板总览 / Dashboard overview](assets/screenshot-1.png)

![dsh-all-usage Token 使用趋势 / Token usage trend](assets/screenshot-2.png)

![dsh-all-usage 使用热力图 / Usage heatmap](assets/screenshot-3.png)

![dsh-all-usage 请求日志 / Request logs](assets/screenshot-4.png)

![dsh-all-usage 模型占比环图 / Model usage donut chart](assets/screenshot-5.png)

![dsh-all-usage 模型明细表 / Model details table](assets/screenshot-6.png)

![dsh-all-usage 工作区占比环图与明细 / Workspace donut chart and details](assets/screenshot-7.png)

### 安装

本插件是标准的 DSH 社区插件包（声明 `dsh.bundle` manifest 与 Web Client），数据来自持久化会话日志和独立用量账本，安装后自动回填历史。

#### 官方插件命令（推荐）

~~~bash
dsh plugin --profile web add github:ParticleLight/dsh-all-usage
~~~

安装命令会装配 bundle；随后刷新浏览器页面以加载 Client，无需手动修改 profile。若当前 DSH 版本未动态装配新包，请按 DSH 的提示重载包或重启进程。

#### 手动注册（本地包）

1. 把本目录放入任意位置，并在 $DSH_HOME/profiles/node_modules/ 下创建指向本目录的符号链接（Windows 用 junction）：

   ~~~powershell
   New-Item -ItemType Junction -Path (Join-Path $env:DSH_HOME 'profiles/node_modules/dsh-all-usage') -Target '<本目录绝对路径>'
   ~~~

2. 在 $DSH_HOME/profiles/web/cordis.patch.yml 添加一行：

   ~~~yaml
   - insert:
       - id: all-usage
         name: dsh-all-usage
   ~~~

用户 patch 层会被热重载：保存后刷新页面即可。

### 架构

- **Host 端**（`lib/index.js`）：扫描持久化会话日志聚合用量（`turn/end` + `assistant/message.usage`），监听 `session/event` 实时折叠；通过 `webServer` 服务注册数据路由：
  - `GET /api/all-usage` — 兼容统计快照
  - `GET /api/all-usage/status` — 轻量 revision 与同步健康状态
  - `GET /api/all-usage/query` — 按 scope 返回聚合、daily/hourly 趋势和 heatmap 数据；单日 scope 填充 `hourly`，跨日 scope 的 `hourly` 为空
  - `GET /api/all-usage/records` — 按 scope 分页返回脱敏 canonical usage rows
  - `GET /api/all-usage/balance?force=1` — 账户余额（复用 `llm-deepseek` 的 API Key 配置）
  - `POST /api/all-usage/alias` — 设置工作区别名
- **Client 端**（`lib/client.js`）：`window.__ModuleLoader__` 工厂格式的浏览器 bundle，注册侧边栏「用量统计」入口（`sidebar.footer.action` 槽位）。所有 API 仅接受本机 loopback 请求并拒绝显式跨域请求；余额读取与别名写入还要求插件启动时生成、仅在当前进程有效的令牌（余额 GET 兼容浏览器省略 Origin）。英文模式的日期分桶、范围筛选、连续使用、热力图和导出时间统一按 UTC；中文模式按本地时区。

### 数据说明

- 使用次数与 Token 来自 DSH 会话日志，并在 `session/flush` 时写入独立用量账本；插件激活时会回填日志与账本历史，插件卸载/重启后已成功持久化的数据不丢
- 按日范围统计会保留全部可读取历史会话的有使用记录日期；热力图仅作为最近 53 周的固定视图窗口
- 会话删除后，已成功 flush 的用量仍从独立账本恢复；会话销毁提示和周期对账只负责触发重建，不会删除账本记录
- 同一会话的同一 `turn / step` 只保留一份最终 usage；重试或替换消息会替换旧贡献，不重复累计
- 输入 Token 按「未含缓存命中」计（缓存命中 / 写入独立成桶）；全 0 用量的重放事件不会覆盖已记录的真实用量，纯缓存命中的请求仍会计入
- 轻量状态接口只公开 Host 实例、统计 revision、扫描进度与同步计数，不公开会话 ID、工作区路径、提示词或回复正文；完整快照仅在状态变化或手动刷新时获取
- scope query 将回合（turns）、模型调用（calls）和去重会话（sessions）分开统计；Provider/模型筛选缺少路由信息时明确归为 Unknown，不从展示字符串猜测
- records 接口只返回短 hash、时间、工作区 ID、结构化模型身份、turn/step、Token buckets 和当前物化来源，不返回原始 session ID、路径、提示词、回复或凭据
- 看板中的总处理量 = 输入 + 输出 + 缓存读写 + 推理；缓存命中表示复用的上下文 Token，不等于新生成 Token 或实际费用
- 余额查询走 DeepSeek 官方 `/user/balance` 接口；未配置 API Key 时卡片显示引导文案
- 仅统计能归属到已注册工作区（按会话 cwd 匹配）的会话

### 开发

- 修改 `lib/client.js` 后刷新页面即可；修改 `lib/index.js` 后，需由 DSH 重载该包或重启进程，单纯刷新页面不会替换已运行的 Host 代码
- 插件包无第三方依赖：Host 端只使用 Cordis 服务，Client 端只使用 runtime 提供的 React 模块

## English

A full usage dashboard for DeepSeek Harness. Analyze tokens, cache behavior, account balance, and activity by model, provider, workspace, and time range.

### Features

- **Heatmap**: a 53-week activity heatmap with workspace filters and daily turn/token details
- **Model analytics**: mixed view, model-merged view, and provider summary with calls, token categories, and cache hit rate
- **Summary and workspaces**: processed tokens, cache hits, account balance, usage streaks, workspace distribution, and details
- **CSV export**: export data using the selected time range and aggregation mode
- **Time ranges**: today, last 30 days, last 90 days, all time, or a custom start/end date across all available historical daily data; the heatmap always shows the latest 53 weeks
- **Workspace aliases**: manage aliases from the sidebar dashboard; values persist in the $DSH_HOME/storages KV cell `all_usage_aliases`
- **Interface language**: switch between Chinese and English from the dashboard header; your choice persists locally in the browser
- **Full history & incremental rebuild**: the baseline scans every readable historical session; the durable usage ledger doubles as a per-session cursor, so unchanged sessions are reused straight from the ledger and only newly appended events are folded — long histories restart without a full rebuild
- **Restart with no re-read**: the persisted log revision (a header-line + stat via `sessionPersistence.listSnapshots()`) acts as a per-session change signal — sessions whose log is unchanged are applied from the ledger on restart without reading their events at all; only changed/new sessions are read incrementally
- **Data health and on-demand refresh**: after a scan completes, the browser polls only a lightweight status revision and fetches full history only after usage, alias, or sync state changes; it shows the latest full-data update, historical scan health, revision skips, rereads, ledger recovery, and failures while preserving last-good data on network errors
- **Performance**: Host reuses canonical identities, local/UTC date keys, and the current-revision records ordering; Client memoizes scope aggregates and detail rows and renders only the active detail tab
- **Trend line chart**: show input, cache read/write, output, reasoning, and total processed tokens for the active range, timezone, workspace, provider, and model scope; use hourly buckets for a single-day scope and daily buckets for cross-day scopes, with smooth monotone curves, staged entrance animation, hover for exact values, and click a point to inspect that day
- **Unified filters and audit**: workspace, provider, model, and date filters apply to the summary, heatmap, trend, tables, and CSV; workspace, provider, and model filters remain independent and can be combined freely, while workspace, provider, and model options are limited to values used in the selected date range and stale selections clear automatically; request logs stay visible as a compact paginated table with grouped Token details for the selected row
- **Token accounting semantics**: input tokens are fresh (exclude cache hits/writes, which sit in separate buckets along with reasoning); all-zero usage replays never overwrite recorded usage, while cache-only requests still count

### Latest Update

**v1.1.0**

- Structured model identity with backward-compatible ledger v2 migration
- Unified scope queries for time, timezone, workspace, provider, and model filters
- Token trend line chart with hourly single-day data, selectable series, exact hover values, and point-to-audit drill-down
- Model and workspace analytics with Token-share donut charts, center totals, ranked legends, animated arc reveals, and cursor-following hover details
- Paginated turn/step audit records with redacted provenance and scoped detail CSV export

See [CHANGELOG.md](CHANGELOG.md) for the complete version history.

### Installation

This is a standard DSH community bundle. It declares a `dsh.bundle` manifest and a web client, and backfills its data from persisted session logs and the durable usage ledger after installation.

#### Official plugin command (recommended)

~~~bash
dsh plugin --profile web add github:ParticleLight/dsh-all-usage
~~~

The installation command assembles the bundle. Refresh the browser page to load the client; no manual profile edits are required. If your DSH version does not dynamically assemble newly installed packages, use its supported package reload or restart the process.

#### Manual local registration

1. Place this directory anywhere and create a symlink to it under $DSH_HOME/profiles/node_modules/ (use a junction on Windows):

   ~~~powershell
   New-Item -ItemType Junction -Path (Join-Path $env:DSH_HOME 'profiles/node_modules/dsh-all-usage') -Target '<absolute plugin path>'
   ~~~

2. Add this entry to $DSH_HOME/profiles/web/cordis.patch.yml:

   ~~~yaml
   - insert:
       - id: all-usage
         name: dsh-all-usage
   ~~~

The profile patch layer hot-reloads; save the file and refresh the page.

### Architecture

- **Host** (`lib/index.js`): aggregates persisted session logs (`turn/end` and `assistant/message.usage`), folds live `session/event` updates, and exposes data routes through `webServer`:
  - `GET /api/all-usage` — compatible usage snapshot
  - `GET /api/all-usage/status` — lightweight revision and sync health
  - `GET /api/all-usage/query` — scoped aggregate, daily/hourly trend, and heatmap data; single-day scopes populate `hourly`, while cross-day scopes return an empty `hourly` array
  - `GET /api/all-usage/records` — paginated privacy-safe canonical usage rows
  - `GET /api/all-usage/balance?force=1` — account balance using the configured `llm-deepseek` API key
  - `POST /api/all-usage/alias` — update workspace aliases
- **Client** (`lib/client.js`): a `window.__ModuleLoader__` browser bundle that registers the “Usage statistics” sidebar entry through the `sidebar.footer.action` slot. All API routes accept loopback requests and reject an explicit cross-origin Origin; balance reads and alias writes also require a process-scoped token generated when the plugin starts (the balance GET tolerates browsers omitting Origin).

### Data semantics

- Calls and tokens come from DSH session logs and a separate usage ledger written at `session/flush`; readable logs and ledger history are backfilled when the plugin activates, so successfully persisted data survives reloads or session deletion
- Day-level range data retains every readable historical session date with tracked usage; the heatmap is only a fixed latest-53-week view
- After a session is deleted, successfully flushed usage is restored from the separate ledger; disposal hints and periodic reconciliation trigger rebuilds without deleting ledger rows
- For each session and logical `turn / step`, only the final usage contribution is kept; retries or replaced messages do not double-count
- Input tokens are fresh (exclude cache hits/writes, which sit in their own buckets); all-zero usage replays do not overwrite recorded usage and pure cache-read requests still count
- The lightweight status endpoint exposes only Host instance, stats revision, scan progress, and sync counters. It does not expose session IDs, workspace paths, prompts, or reply bodies; full snapshots are fetched only after status changes or a manual refresh
- Scoped results keep turns, model calls, and distinct sessions as separate metrics; missing route identity is explicitly Unknown rather than inferred from a display label
- The records endpoint returns only a short hash, time, workspace ID, structured model identity, turn/step, token buckets, and current materialization source. It omits raw session IDs, paths, prompts, replies, and credentials
- Processed tokens = input + output + cache read/write + reasoning; a cache hit means reused context, not newly generated tokens or actual cost
- Balance data comes from DeepSeek’s official `/user/balance` endpoint; the card shows guidance when no API key is configured
- English mode uses UTC for date buckets, range filters, streaks, heatmap dates, and export timestamps; Chinese mode uses local time
- Only sessions that can be mapped to a registered workspace by their working directory are included

### Development

- After editing `lib/client.js`, refresh the page. After editing `lib/index.js`, reload the package through DSH or restart the process; a page refresh alone cannot replace running host code
- The plugin has no third-party package dependencies: the Host uses Cordis services and the Client uses the runtime-provided React module

## License / 许可证

MIT
