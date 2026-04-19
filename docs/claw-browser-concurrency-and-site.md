# claw-browser 并发与 Site 机制完整说明

本文面向维护者与高频使用者，聚焦 `claw-browser` 在真实自动化场景里的并发行为和 `site` 适配器机制。

范围按优先级组织：

1. 并发处理总览
2. 多 Session
3. 多 Tab
4. 多 Profile
5. Site 机制与并发控制

---

## 1. 并发处理总览

`claw-browser` 的并发单位不是“单条命令”，而是“Session 内命令流 + Browser Target（Tab）”。

核心结论：

- Session 之间天然隔离，可以并行运行
- 同一 Session 内，大多数命令是串行执行
- `wait` 系列命令被设计为可并发执行，不再阻塞整个 Session 队列
- 需要精确命中某个 Tab 的命令，应显式使用 `--tab-id`

关键实现位置：

- 会话 daemon 与 IPC: `src/connection/index.ts`
- daemon 执行队列: `src/daemon/index.ts`
- 命令路由与 tab 绑定: `src/browser/executor.ts`
- Tab 管理: `src/browser/tabs.ts`, `src/cdp/browser.ts`
- wait 实现: `src/browser/wait.ts`

---

## 2. 多 Session 机制

## 2.1 Session 生命周期

每个 Session 对应一个独立 daemon 进程。

常用入口：

- `claw-browser start <session>`
- `claw-browser stop <session>`
- `claw-browser --session <session> <command> ...`

daemon 就绪由会话级 IPC 文件体现：

- Windows: `<session>.port`, `<session>.pid`, `<session>.version`
- Unix: `<session>.sock`, `<session>.pid`, `<session>.version`

默认目录是 `~/.claw-browser/`。

## 2.2 隔离边界

Session 隔离粒度包括：

- daemon 进程
- 浏览器连接状态
- Tab 集合与 active tab 指针
- 运行时状态文件
- site 域名 tab 池状态（按 session 单独存储）

这意味着不同 Session 之间不会共享命令队列，也不会争抢同一个 domain lease 文件。

## 2.3 并发建议

- 需要高吞吐并发任务时，优先拆到多个 Session
- 不同业务域名或不同账号隔离，优先按 Session 维度拆分
- 需要强顺序一致性的任务，保留在单 Session 内执行

---

## 3. 多 Tab 机制

## 3.1 Tab 数据模型

`BrowserManager` 内部维护 `pages[]`，每个 page 都有：

- `targetId`（tab id）
- `sessionId`（CDP session）
- `url`, `title`, `targetType`

并维护：

- `activePageIndex`
- `tab label` 映射
- `tN` 短 ID 解析

## 3.2 Tab 命令行为

常用命令：

- `tab list`
- `tab new [url]`
- `tab <target>` (`target` = `tN` | tab label | tab-id)
- `tab close [tN|label|tab-id]`
- `window new [url]`

默认多数页面命令作用于 active tab。

## 3.3 `--tab-id` 的语义

常规命令：

- `executor` 会先把 active tab 切换到 `tabId`，再执行命令

`wait` 系列命令：

- 不再切换全局 active tab
- 仅把命令绑定到该 tab 对应的 `sessionId`
- 这样可避免并发场景下，`wait` 影响其他命令的 tab 路由

这对“一个 Session 同时盯多个 tab”非常关键。

## 3.4 wait 并发与 tab

当前 `wait` 家族包括：

- `wait`
- `waitforurl`
- `waitforloadstate`
- `waitforfunction`
- `waitfordownload`

在 daemon 队列中，这些 action 被标记为 non-blocking，可并行执行，不占用主串行队列。

实践上意味着：

- 一个 tab 上执行长时间 `wait`
- 同 Session 里其他 tab 仍可继续执行 click、eval、snapshot 等命令

---

## 4. 多 Profile 机制

## 4.1 默认 profile 策略

未显式传 `--profile` 时，会使用会话级持久目录：

- `~/.claw-browser/browser/<session>`

这使同一 Session 重启后仍可复用 cookies 和登录状态。

## 4.2 自定义 profile

传入 `--profile <path>` 后，Chrome 使用该目录作为 `--user-data-dir`。

建议：

- Profile 尽量一对一绑定到 Session
- 避免多个活跃 Session 同时写同一个 profile 目录

原因：

- Chrome 用户数据目录是状态密集型目录
- 并发写入容易引起锁冲突、异常退出后状态不一致

## 4.3 推荐分层

高稳定方案：

- “并发执行隔离”放到 Session 维度
- “账号态隔离”放到 profile 维度
- 一般采用 `1 Session : 1 Profile` 映射

---

## 5. Site 机制

`site` 是把“领域任务脚本”封装为可复用适配器，并在执行时做 domain 级 tab 资源调度。

## 5.1 适配器发现与来源

扫描来源：

- 本地目录: `~/.claw-browser/sites`
- 社区目录: `~/.claw-browser/agent-sites`

同名覆盖规则：

- local 优先级高于 community

元数据支持两种方式：

- `/* @meta ...json... */`
- `// @name`, `// @description`, `// @domain` 等标签

## 5.2 site 命令

- `claw-browser site list`
- `claw-browser site search <query>`
- `claw-browser site info <name>`
- `claw-browser site update`
- `claw-browser site <adapter> [args...]`

执行本质：

1. 解析 adapter 参数
2. 组装 JS 脚本
3. 通过 `evaluate` 下发到目标 tab 执行

## 5.3 Domain Tab Pool 设计

当 adapter 声明 `domain` 且未显式传 `--tab-id` 时，进入 domain tab 池调度。

目标：

- 优先复用已打开且空闲的同域 tab
- 无可复用 tab 时，按上限新建
- 到达上限时排队等待

默认每域上限：

- `2`（可用 `CLAW_BROWSER_SITE_MAX_TABS_PER_DOMAIN` 覆盖）

## 5.4 锁与状态文件

目录：

- `~/.claw-browser/site-tab-pool/`

文件：

- `<session>.json` 记录 domain queue 与 leases
- `<session>.lock` 目录锁，保护状态更新原子性

关键字段：

- `queue`: lease 请求队列（FIFO）
- `leases`: 已持有 tab 的租约，包含 `pid`, `tabId`, `createdTemp`

并发安全点：

- 所有 acquire/release 都在 `withPoolLock` 内执行
- 启动时会清理死进程 lease，防止僵尸占位

## 5.5 acquire 流程

简化流程：

1. 请求入队
2. 仅队首请求有资格继续
3. 查找同域可复用 tab（排除当前 leases 占用）
4. 若可复用则直接分配 lease
5. 若不可复用且未达上限，创建新 tab 并分配 lease
6. 若达上限，保留队列并重试等待

创建临时 tab 时，当前实现会短暂 sleep 以提升目标站点稳定性。

## 5.6 release 流程

释放时：

- 从 leases 移除
- 从 queue 清理对应 leaseId
- 若该 lease 为 `createdTemp=true`，会自动关闭对应 tab
- domain 下无 lease 且无排队时，清理该 domain 节点

## 5.7 与 `--tab-id` 的关系

如果传了 `--tab-id`，`site` 会直接在该 tab 上执行，不进入 domain 池。

这允许你在更高层调度器中自行管理 tab 生命周期。

---

## 6. 典型并发模式

## 模式 A：多 Session 并行抓取

- 每个任务一个 Session
- 每个 Session 一个独立 profile
- 适合高吞吐和强隔离

## 模式 B：单 Session 多 tab 协作

- 一个 Session 内开多个 tab
- 每条命令带 `--tab-id` 精确路由
- `wait` 可并发，不再卡住整个 Session

## 模式 C：site 驱动的同域池化

- 对同域任务使用 `site <adapter>`
- 让 domain tab pool 自动复用、排队、限流
- 适合批量同站点任务

---

## 7. 常见问题与排查

## 7.1 `wait --load networkidle` 行为异常

先确认版本包含以下行为：

- `networkidle` 被单独识别
- wait 支持命令级超时
- wait 系列为 non-blocking action

## 7.2 同 Session 命令互相影响 tab

优先检查是否缺少 `--tab-id`。

在并发命令流中，不建议依赖“当前 active tab”作为隐式路由。

## 7.3 site 卡在排队

检查：

- `CLAW_BROWSER_SITE_MAX_TABS_PER_DOMAIN` 是否过小
- 是否存在长时间不释放的任务
- 进程是否异常退出导致 lease 未清理（一般会被下次清理回收）

## 7.4 profile 冲突

若多个 Session 共用同一 profile path，出现随机失败或状态污染，建议改为独立 profile。

---

## 8. 维护建议

- 对有状态自动化任务，固定使用 `--session` + `--profile`
- 对并发任务，默认每条命令附带 `--tab-id`
- 对同站点批处理，优先使用 site 机制而不是手写 tab 复用逻辑
- 对长等待场景，显式设置 timeout，避免默认超时引发误判
