# 工作区探针 + 账本复用 改造计划

> 状态：待评审
> 目标版本：1.1.4（随下一发布链）
> 涉及：lib/session-sync.js · lib/http.js · src/client.js · test/* · README.md · CHANGELOG.md

---

## 1. 背景与问题

当前「工作区刷新」是**手动按钮**触发，且实现为：

```
refreshWorkspaceRegistry()
  = resetAggregationState()   // 清空全部聚合、totals、scan 状态、resync 定时器
  + runBaseline()             // 全量重扫：listSessions 全列 + 每个 session 走
                              //   ledger-reuse / readSession / fold / persist 链
```

虽然 per-session 已有「revision 不变则复用 ledger」的快路径（实测 371/378 被跳过），但：
- 每次刷新仍会**清空并重建所有聚合结构**（byDay/byWs/query 索引/perModel/usageByStep 等），
  触发一票 markStatsChanged，并把大量 session 重新 applyLedgerRecord；
- 依赖用户手动点击（当天有未注册工作区时，用户不知道什么时候该点）；
- 刷新期间与 live 事件存在代际冲突（generation bump 会作废进行中的 live 任务）。

**目标**：工作区注册信息一旦发生变动即自动感知（探针），只对发生增删的工作区做增量处理，
其余工作区**完全复用**已计算的聚合与账本，零重扫。

---

## 2. 调研结论（DSH 侧既有能力）

### 2.1 ctx.workspaceRegistry.list() 开销本身极小
@deepseek-ai/dsh-workspace 的 WorkspaceRegistry.list() 是**同步内存读**：
requireState().workspaceIds.map(id => entities.get(id))。无持久化 IO。
「性能负担」不在 list()，而在 reset + 全量重扫 —— 本计划将负担转移到「探针 + diff + 增量」。

### 2.2 DSH 已有官方变更通知：domain/changed
@deepseek-ai/dsh-storage-domain 在**每次持久化写之后**（durable + 内存均已生效）发射：

```
ctx.emit('domain/changed', { domain, table, key, operation, value })
```

workspace 域的实际事件形态（dsh-workspace 源码）：
- 创建工作区：global put（table 为空字符串）+ workspaces 表 put（两次事件）
- 删除工作区：global put + workspaces 表 deleted
- 重命名/重排/归档/挂接与摘除 session：global put 或表 put（updatedAt 变化）

官方 dsh-workspace/invariant 插件已经用 ctx.on('domain/changed', ...)
校验缓存与持久表的一致性 —— 这是**官方认可的通知渠道**，即本方案所谓「探针」。

### 2.3 逆折叠能力已经存在
lib/aggregation.js 的 removeSession(sid) 是完备的逆折叠：
usageByStep / turnRecords / 日索引 / query 索引 / totals / perModel / perWorkspace / byWs
全部按 -1 方向回退。删除工作区 = 对其每个 session 调 removeSession。

### 2.4 未注册 cwd 的 session 从未进入账本
runBaseline 只处理 workspaceForCwd(cwd) !== undefined 的 session
（行 386–390：sid 或 wsId 为 undefined 直接 continue）。
因此「新增工作区」时，那些 cwd 变合法 的 session 之前**没有任何 ledger 记录**，
从磁盘读一次即可，天然走现有 per-session 增量逻辑，无历史归并问题。

---

## 3. 方案设计

### 3.1 探针（lib/session-sync.js）

```
ctx.on('domain/changed', (change) => {
  if (change === undefined || change === null) return
  if (change.domain !== 'workspace') return
  scheduleWorkspaceSync()
})
```

- scheduleWorkspaceSync()：**去抖 ~300ms**（合并一次 create 的双 put、批量操作），
  并做并发保护：state.workspaceSyncInFlight 进行中时仅置 state.workspaceSyncPending，
  结束后若仍有 pending 再跑一轮（不丢事件）。
- 过滤条件：table 为 workspaces 或空字符串（global 也涉及 workspaceIds 与 archived 集合），
  其余 domain 的事件全部忽略。

### 3.2 增量同步 synchronizeWorkspaceRegistry()（替代 refreshWorkspaceRegistry）

```
1) list = ctx.workspaceRegistry.list()            // 同步内存读，try/catch
   失败：noteSyncError(workspace-list-failed)；不破坏现有状态，直接返回
2) (wsMeta, pathIndex, memberOf) = buildWorkspaceSnapshot(list)   // 从 runBaseline 抽取共用
3) diff：
   addedWs   = 新 pathIndex 中 value 不在旧 pathIndex value 集
   removedWs = 旧 pathIndex 中 value 不在新 pathIndex value 集
   metaChanged = title/path/sessionIds 显示层差异
4) 无 added/removed（纯复用路径）：
   替换 wsMeta/pathIndex/memberOf；若 metaChanged 则 markStatsChanged(metadata)
   ★ 直接返回 —— 零 session 读取、零聚合改动
5) removedWs 非空（逆折叠路径）：
   对每个 removed ws：
     sids = { ledgerRecords 中 record.workspaceId 属于 removedWs 的 sid }
            + { memberOf 中归属该 ws 的 sid }
     对每个 sid：host.aggregation.removeSession(sid)   // 完备逆折叠
       ledgerRecords.delete(sid)
       knownSessionIds / sessionCount / sessionSeq / memberOf 清理
     清理 perWorkspace / byDay.byWs 中被移除 ws 的空项
6) addedWs 非空（新增路径）：
   records = await ctx.sessionQuery.listSessions()   // 与 baseline 同成本，一次
   按新 pathIndex 找出归属 addedWs 的 sid
   对每个 sid：复用现有 per-session 流程（抽取为 scanOneSession(sid, record, wsId, generation)）
     - 无 ledger 记录 → readSession + fold + replaceLedgerRecord + persistLedgerRecord
     - revision 快路径对新增 ws 天然不适用（无 previousRecord）
7) 收尾：markStatsChanged([data, metadata, scan])
```

关键约束：
- **不做 aggregationGeneration bump** —— 增量仅按 sid 入 enqueue 链，与 live 事件天然串行；
  不打断进行中的 live 任务（这是与旧刷新方案最大的行为差异）。
- **scan 未完成时（首次 baseline 未完成）**：探针仅更新 meta 并返回 ——
  因为 runBaseline 会用最新 list 完成全量，无需增量。
- **scan.done 之后**才会做真正的增/删处理。

### 3.3 UI / 路由移除

| 位置 | 删除内容 |
|---|---|
| lib/http.js | POST /api/all-usage/workspaces/refresh 整段 |
| src/client.js | refreshWorkspacesRpc、onRefreshWorkspaces、workspaceRefreshError state、头部刷新工作区按钮、说明 note div、.uh-workspace-refresh-note 样式 |
| lib/session-sync.js | 导出 refreshWorkspaceRegistry（由内部 synchronizeWorkspaceRegistry 取代） |
| README.md / CHANGELOG.md | 点击刷新工作区/重启 DSH Web 文案 → 注册变化自动探针同步；未变化工作区复用账本 |

### 3.4 复用机制（核心语义）

> 探针收到事件 → 重读 workspaceRegistry.list()（内存级）→ 与当前索引 diff →
> **无增删：只更新元数据，已有工作区直接复用现有聚合与账本（零重扫）**；
> 有增删：仅对发生变化的 1 个（或 N 个）工作区做增量处理，其余工作区原样保留。

这与要求「对未变化的已有工作区直接复用账本，避免性能开销」完全一致。

---

## 4. 测试计划

### test/aggregation.test.js
1. 改造现有 manual workspace refresh rereads the registry and remaps ...
   → workspace registry change is probed automatically：模拟 emit domain/changed
   （workspace create 语义），断言该 cwd 的 session 从「未计入」变为「计入」，totals 精确。
2. 新增 unchanged registry change reuses aggregation without rescan：
   emit 无关 domain/changed（如 title 变化）→ 断言无新增 sessionRead、聚合对象未重建、
   scan 计数不变。（这是「复用」的可测断言。）
3. 新增 removed workspace subtracts its session from totals：
   emit delete 语义 → 断言 totals 回退、perWorkspace 无空项、ledgerRecords 清理。
4. 保留 does not include sessions whose cwd is not registered、
   live sessions outside the registry are ignored until their workspace is registered
   （后者语义调整为：注册后探针自动纳入，无需手动刷新）。

### test/dsh-runtime.test.js
- 两个 routes 数组移除 /api/all-usage/workspaces/refresh，恢复原「减 9」断言。

### test/client-refresh.test.js
- 若引用刷新工作区按钮，改为断言其已移除。

---

## 5. 风险与边界

| 风险 | 处置 |
|---|---|
| domain/changed 仅本进程内发射 | DSH Web 的 registry 操作全在本进程 → 覆盖目标场景。跨进程（多实例共享 workspace.json）不在本期范围；如需可后续加 workspace.json mtime 低频探针（本期不做） |
| 去抖期间连发事件 | 300ms debounce + pending 兜底，不丢最终状态 |
| 删除工作区后 ledger 文件仍保留 | 符合现行「stale ledger 不复活」语义（sourceCwd 校验已有）；只清内存记账 |
| 新增工作区 session 无 ledger | 首次从磁盘读，成本 = 该工作区 session 数（远小于全量 378） |
| 探针处理与 scan.started 竞争 | scan 未完成时只更新 meta，交给 runBaseline 全量收尾 |
| 并发 live 事件 | 按 sid 入 enqueue 链，天然串行；无 generation bump，不打断 live |

---

## 6. 落地顺序

1. lib/session-sync.js：抽取 buildWorkspaceSnapshot + scanOneSession；
   新增探针监听 + scheduleWorkspaceSync + synchronizeWorkspaceRegistry；
   删除 refreshWorkspaceRegistry 导出。
2. lib/http.js：删除 refresh route。
3. src/client.js：删除按钮 / note / rpc / state。
4. 测试：aggregation.test.js 改造 1 + 新增 2；dsh-runtime.test.js 恢复断言；
   client-refresh.test.js 校验。
5. 构建：npm run build-client；node --check 全部；npm run fixture:check；
   npm run check:pack；npm test 全量。
6. README.md / CHANGELOG.md 文案更新。
7. 热载 + 真实环境验证：在 DSH GUI 新建/删除一个工作区，断言探针自动纳入/剔除、
   totals 一致、未变工作区无重扫（观察 sessionRead 计数不变）。
