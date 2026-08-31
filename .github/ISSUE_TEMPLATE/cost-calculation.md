---
name: 成本计算问题 / Cost calculation issue
about: 报告模型匹配、价格桶、缓存 Token 或估算成本异常
title: "[成本计算] "
labels: bug, pricing
assignees: ''
---

## 提交前检查

- [ ] 我已删除 API Key、Token、session ID、工作区真实路径、提示词和回复正文。
- [ ] 我没有上传完整 session 日志，只提供必要的 usage 桶和模型元数据。
- [ ] 我已说明价格来自 models.dev、显式 mapping、显式 override，还是未计价状态。

## 运行环境

- 插件版本：
- DSH 版本：
- Node.js 版本：
- 操作系统：

## 模型与价格来源

- DSH Provider（仅作上下文）：
- 请求模型：
- 实际模型：
- 官方模型厂商（如已知）：
- 价格来源：models.dev / mapping / override / 未匹配
- input token semantics：fresh / total / legacy / 未知
- multiplier：

## 脱敏 usage 桶

~~~json
{
  "input": 0,
  "output": 0,
  "cacheRead": 0,
  "cacheWrite": 0,
  "reasoning": 0
}
~~~

## 结果对比

~~~text
预期成本：
实际成本：
预期状态：priced / unpriced / ambiguous / unsupported
实际状态：
~~~

请说明是否发生以下情况：

- [ ] reasoning 被重复计入 output
- [ ] cacheRead 或 cacheWrite 被错误并入 input
- [ ] 未匹配模型被错误套价
- [ ] 历史正成本被价格目录更新重算
- [ ] chunk 与最终 message 被重复计费
- [ ] 十进制成本出现浮点误差

## 诊断与复现

<!-- 可提供脱敏后的 pricing 响应字段和最小事件序列。不要粘贴任何凭据。 -->

~~~text
node scripts/replay-fixture.mjs fixtures/usage-events.json：通过 / 失败
~~~
