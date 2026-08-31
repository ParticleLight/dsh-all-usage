---
name: 插件启动失败 / Plugin startup failure
about: 报告 dsh-all-usage 无法加载、路由未注册或卸载异常
title: "[启动失败] "
labels: bug, runtime
assignees: ''
---

## 提交前检查

- [ ] 我已删除 API Key、Token、session ID、工作区真实路径和完整配置文件。
- [ ] 我已记录 Node.js、DSH runtime 和插件版本。
- [ ] 我已确认这不是仅需刷新浏览器的 Client 缓存问题。

## 失败阶段

- [ ] 安装或 profile 装配
- [ ] Host loader 启动
- [ ] Web 路由注册
- [ ] 历史扫描
- [ ] session flush 或重启恢复
- [ ] 插件卸载或热重载

## 运行环境

- 插件版本：
- DSH 版本：
- Node.js 版本：
- 操作系统：
- DSH profile：
- 安装方式：官方命令 / 本地 junction / 其他

## 复现步骤

1. [步骤]
2. [步骤]
3. [步骤]

## 预期行为

<!-- 例如：成功注册 /api/all-usage 并完成扫描。 -->

## 实际行为

<!-- 请粘贴最小化、脱敏后的错误消息。保留错误类型和调用位置，不要粘贴凭据或原始日志。 -->

~~~text
错误消息：
~~~

## 路由与清理检查

- /api/all-usage 是否注册：
- /api/all-usage/status 是否注册：
- 卸载后路由是否仍存在：
- 是否有 timer/listener 残留：

## 相关验证

~~~text
node scripts/replay-fixture.mjs fixtures/usage-events.json：通过 / 失败
npm test：通过 / 失败 / 未运行
~~~
