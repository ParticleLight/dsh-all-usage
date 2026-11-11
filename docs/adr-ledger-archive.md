# ADR：账本冷归档

- 状态：已接受（1.2.4 开发分支）
- 相关：`lib/archive.js`、`lib/ledger.js`、`lib/http.js`、`scripts/archive-ledger.mjs`

## 决定

超过阈值的会话记录折叠进 `<root>/archive/<YYYY-MM>.jsonl.gz`，落盘成功后才删除逐记录文档；默认不归档，只在显式执行 `npm run ledger:archive -- --root <dir> --older-than-days 90 --apply` 时发生。面板里的「数据维护」走同一个 `archiveRecords()`：先 `POST /api/all-usage/archive` 取计划（请求体默认 `dryRun: true`），用户看过条数、月份与压缩前后大小并二次确认后，才以 `dryRun: false` 写入；HTTP 端点与 CLI 共用同一把维护锁，锁被占用时回答 409。

## 为什么默认关

归档物理删除热副本，不可逆。默认保持只读、由用户决定何时收缩，事故面最小。

## 为什么不迁 SQLite

宿主与插件都不带数据库引擎，SQLite 要原生扩展，违反零外部依赖的约束。月份 gz 是普通文件：可拷走、可 gunzip 直接审计、坏一个月只丢一个月，删掉即退回纯树布局；换库则是单向门。

## 为什么保留整会话粒度

账本契约是每会话一份快照、按 sessionId upsert。拆成逐条明细后，同一会话的新旧两版无法比较合并，也就保不住"归档前后逐日／工作区／模型三层总量不变"——那是本设计的唯一硬指标。

## 失败时为什么允许短期重复

写归档与删源不可能原子，因此先写后删：任一层失败就留两份，读路径树优先、按键去重，只多占空间，不丢数也不双计；下次运行按 updatedAt 合并即收敛。
