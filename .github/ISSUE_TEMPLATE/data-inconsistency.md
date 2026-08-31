---
name: 数据不一致 / Data inconsistency
about: 报告看板、records 或 fixture 结果与预期不一致
title: "[数据不一致] "
labels: bug, data
assignees: ''
---

## 提交前检查

- [ ] 我已删除 API Key、Token、session ID、工作区真实路径、提示词和回复正文。
- [ ] 我已确认问题不是浏览器缓存，可以提供新的 status/snapshot 结果。
- [ ] 我已运行 node scripts/replay-fixture.mjs fixtures/usage-events.json，并说明 fixture 是否通过。

## 现象

<!-- 请说明哪个数字不一致，以及预期值和实际值。 -->

## 运行环境

- 插件版本：
- DSH 版本：
- Node.js 版本：
- 操作系统：
- 浏览器和版本（如涉及界面）：
- 语言与时区：

## 统计范围

- 起止日期：
- UTC 或本地时间：
- 工作区筛选：请使用脱敏 ID 或 all
- Provider/model 筛选：
- 视图：/api/all-usage、/api/all-usage/query、/api/all-usage/records 或 dashboard

## 预期与实际

~~~text
预期：
实际：
~~~

请优先提供这些不含敏感内容的字段：turns、sessions、calls、input、output、cacheRead、cacheWrite、reasoning、cost.status。

## 最小复现

<!-- 请给出脱敏后的事件类型、turn/step、usage 桶和 seq；不要粘贴原始会话日志。 -->

~~~json
{
  "eventTypes": [],
  "turnStep": "",
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "reasoningTokens": 0
  }
}
~~~

## 诊断信息

<!-- 可粘贴脱敏后的 status 响应或截图。 -->
