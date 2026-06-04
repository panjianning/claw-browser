# Claw Browser 并发与零 Active 依赖需求文档

## 1. 背景与目标

当前系统在单 session 并发执行 `pipeline` / `site` / 常规 browser 命令时，仍存在对 `active tab/session` 的隐式依赖，导致：

- 并发任务可能互相覆盖 active 路由
- 同一 tab 被不同任务串扰
- 某些命令在高并发下出现 target/session 错绑
- 用户侧感知为“看起来并发，实则串行或半串行”

本需求目标：

1. 完全支持同 session 高并发执行。
2. 所有浏览器操作必须基于显式 `tabId` / `sessionId` / `ownerId` 路由。
3. 禁止任何业务命令依赖全局 `active tab` 作为执行依据。
4. 并发隔离粒度从 session 下沉到 tab。

## 2. 术语定义

- `ownerId`：一次运行实例的隔离标识，默认等于 `pipeline runId`；`site run` 无显式 owner 时自动生成临时 owner。
- `tab ownership`：tab 与 owner 的归属关系（一个 tab 同时最多归属一个 owner）。
- `global command`：不针对单 tab 的命令，如 `launch`、`close`、`session_status`。
- `tab command`：必须落在某个 tab 上执行的命令，如 `click`、`fill`、`evaluate`、`site run`。
- `scheduler`：daemon 内部并发调度器，负责按 key（tab/global）串并行执行。

## 3. 范围

### 3.1 In Scope

1. daemon 调度模型重构为“按 tab 串行、跨 tab 并行”。
2. browser 命令执行路径改造为“显式 session/tab 绑定”。
3. pipeline/site 的 owner 生命周期与 tab 绑定。
4. 子 tab opener 继承 owner。
5. 可观测性：`tab list` / 日志 / 状态接口可见 owner 与调度信息。

### 3.2 Out of Scope

1. 多进程分布式调度（只覆盖单 daemon 进程内）。
2. 浏览器内核/CDP 协议升级。
3. 跨机器共享 owner 状态。

## 4. 问题陈述（现状）

1. 命令分发层存在“设置 active 后再执行”的路径。
2. 多个 handler 默认通过 `mgr.activeSessionId()` 取执行上下文。
3. daemon 当前为“全局串行 + 白名单放行”模型，无法表达“同 tab 串行、异 tab 并行”。
4. `site` 与 `pipeline` 的并发约束曾存在双模型，不利于一致性。

## 5. 功能需求

### FR-1 零 Active 执行依赖

1. 所有 tab 级命令执行前必须得到明确 `effectiveTabId` 与 `effectiveSessionId`。
2. 禁止 handler 以内置 active 作为首选路由来源。
3. 若命令未提供 `tabId`：
   - 有 `ownerId`：绑定 owner root tab。
   - 无 `ownerId`：报错并提示需显式 `tabId` 或 owner 上下文。

### FR-2 Owner 归属约束

1. tab command 带 `ownerId` 时，必须校验目标 tab 归属。
2. 若目标 tab 无 owner，可绑定到当前 owner。
3. 若目标 tab 属于其他 owner，命令失败并返回明确错误。

### FR-3 Site/Pipeline 统一运行模型

1. `pipeline run`：ownerId = runId。
2. `site run`：
   - 若调用方提供 ownerId，则沿用。
   - 否则自动创建临时 ownerId，执行后释放。
3. `pipeline -> site` 必须在同 owner 内执行。

### FR-4 子 Tab 继承

1. 通过 CDP target 信息识别 `openerTargetId`。
2. 若 opener tab 有 owner，则新 tab 自动继承同 owner。
3. 继承必须幂等，不得覆盖已有有效 owner。

### FR-5 调度器重构

1. daemon 引入 `tab-keyed scheduler`：
   - 同 `tabId` 命令串行。
   - 不同 `tabId` 命令并行。
2. `global command` 走全局队列，并与 tab 队列互斥（防止 launch/close 与 tab 命令并发破坏状态）。
3. `tab list`、`session_status` 允许并发读，但需保证一致性快照。

### FR-6 可观测性

1. `tab list` 输出 `ownerId`。
2. `pipeline status/runs` 输出 run 绑定 `tabId`、`ownerId`。
3. 关键日志字段必须包含：`sessionId`, `ownerId`, `tabId`, `action`, `schedulerKey`。

## 6. 非功能需求

### NFR-1 正确性

1. 不得出现“命令执行到非目标 tab”的情况。
2. 并发任务之间不得出现跨 owner 写入。

### NFR-2 性能

1. 同 session 多 tab 并发吞吐显著高于全局串行模型。
2. 调度器开销不应成为主瓶颈（单命令调度开销目标 < 2ms）。

### NFR-3 可恢复性

1. run 异常退出后 owner 可回收（TTL + heartbeat）。
2. 僵尸 owner 不得长期占用 tab。

### NFR-4 可维护性

1. 单一并发模型，禁止 site/pipeline 双轨调度。
2. 新命令接入必须声明命令类型（global/tab）。

## 7. 架构要求

### 7.1 执行上下文对象

引入统一 `ExecutionContext`（内部对象，不要求暴露 CLI）：

- `sessionId`
- `ownerId?`
- `tabId?`
- `effectiveSessionId?`
- `schedulerKey` (`global` | `tab:<id>`)

所有 handler 通过 context 获取 session，不再直接调用 `activeSessionId()`。

### 7.2 调度层

1. `createSerializedExecutor` 重构为多队列调度器。
2. 队列键选择规则：
   - global command -> `global`
   - tab command -> `tab:<effectiveTabId>`
3. global 与 tab 队列互斥策略必须明确实现（读写锁或单写栅栏）。

### 7.3 BrowserManager 约束

1. 允许保留 activePage 用于人机交互展示，但禁止作为命令执行依据。
2. 对外新增/统一“按 target/session 执行”的 helper，供 handler 调用。

## 8. 接口与行为契约

### 8.1 错误契约

统一错误码/文案：

- `TabNotSpecified`：缺失 tabId 且无 owner 绑定。
- `OwnerConflict`：目标 tab 属于其他 owner。
- `TabSessionNotFound`：tab 存在但 session 无效。
- `GlobalLockBusy`：global 命令阻塞期间拒绝或排队策略触发。

### 8.2 向后兼容

1. CLI 命令名保持不变。
2. 旧行为中“隐式 active 路由”改为显式错误（属于行为收紧）。
3. 提供迁移提示：建议传 `--tab-id` 或在 pipeline/site 上下文执行。

## 9. 测试需求

### 9.1 单元测试

1. owner 绑定/冲突/释放/继承。
2. scheduler 同 key 串行、异 key 并行。
3. context 解析规则（tabId、owner fallback）。

### 9.2 集成测试

1. 同 session 并发两个 pipeline，各自 click/fill，互不干扰。
2. 并发两个 `site run xhs/search`，必须落在不同 owner 路由下。
3. `pipeline -> site` 链路 owner 继承正确。
4. 并发执行时 `tab list` 能即时返回，不被长任务完全阻塞。

### 9.3 回归测试

1. 单任务串行场景功能无回退。
2. 无 owner 的普通命令在明确 tabId 下可正常执行。

## 10. 验收标准

满足以下全部条件方可验收：

1. 任意 tab command 不再依赖 active tab。
2. 并发 `site/pipeline` 不会在同一 tab 串扰（除非显式同 tab）。
3. `tab list` 可见 owner，且与运行态一致。
4. 在 20 并发任务压力下，无 `Inspected target navigated or closed` 的错误激增（相较基线显著下降）。
5. 所有新增测试通过，现有核心回归通过。

## 11. 实施阶段

### Phase 1：上下文与调度基础

1. 引入 ExecutionContext。
2. 上线 tab-keyed scheduler。
3. 标注命令类型（global/tab）。

### Phase 2：handler 去 active 化

1. 逐模块改造：interactions -> queries -> advanced -> session-data -> navigation。
2. 删除执行路径中的 `setActivePageByTargetId` 路由依赖。

### Phase 3：owner 完整闭环

1. site 自动 owner + pipeline owner 统一。
2. opener 继承 + TTL 回收。
3. 补齐可观测字段。

### Phase 4：压测与发布

1. 并发压测与故障注入。
2. 发布说明与迁移指南。

## 12. 风险与应对

1. 风险：历史命令依赖隐式 active，升级后报错增多。  
   应对：提供明确错误提示和迁移建议。

2. 风险：global/tab 互斥策略设计不当导致饥饿。  
   应对：引入公平队列与超时告警。

3. 风险：CDP target 事件不稳定导致继承遗漏。  
   应对：定期 `Target.getTargets` 同步兜底。

## 13. 里程碑交付物

1. 设计文档（本文件）。
2. 调度器实现与代码注释。
3. handler 改造 PR（按阶段拆分）。
4. 并发回归测试集。
5. 发布与迁移说明文档。

