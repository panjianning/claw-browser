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

- `claw-browser session start <session>`
- `claw-browser session stop <session>`
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
- tab label / tab-id 解析

## 3.2 Tab 命令行为

常用命令：

- `tab list`
- `tab new [url]`
- `tab <target>` (`target` = tab label | tab-id)
- `tab close [label|tab-id]`
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

传入 `--profile <path-or-name>` 后：

- 若参数看起来像路径（包含 `/`、`./`、`../`、`~` 或绝对路径），Chrome 直接使用该路径作为 `--user-data-dir`（`~` 会展开）。
- 若参数是纯名称（例如 `profile-xhs`），会映射到 `~/.claw-browser/browser/<name>`。

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

## 4.4 Pipeline/Site 并发隔离（新版）

- `pipeline run` 与 `site run` 统一使用 run 级 tab owner（owner = pipeline `runId`）。
- 同一 session 内允许多 pipeline 并发，但每个 run 只能操作自己 owner 的 tab。
- run 内新开的子 tab 会继承 opener tab 的 owner，避免并发时 tab 串扰。
- `tab list` 会返回 `ownerId` 字段，便于观察占用关系。

---

## 5. Site 机制

`site` 是把“领域任务脚本”封装为可复用适配器，并复用 pipeline 运行时 owner 机制。

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

## 5.3 Run Owner 模型

site 与 pipeline 统一走 run owner（owner = pipeline `runId`）：

- 一个 tab 同时只属于一个 owner
- owner 只能操作自己拥有的 tab
- 无 `tabId` 时默认绑定到 owner root tab

## 5.4 子 Tab 继承

当目标页通过 `window.open` / `_blank` 打开新 tab：

- 若 opener tab 属于 owner，则新 tab 自动继承该 owner
- 避免 site/pipeline 执行期间子 tab 被其他并发任务抢占

## 5.5 生命周期

1. pipeline/site 执行启动时创建 owner 并绑定 root tab
2. 执行过程中所有 browser/site 操作受 owner 约束
3. 结束后释放 owner（默认仅解绑，不自动关 tab）

## 5.6 与 `--tab-id` 的关系

如果传了 `--tab-id`，仍会先校验 owner：

- 目标 tab 无 owner 时，会绑定到当前 owner
- 目标 tab 属于其他 owner 时，命令会被拒绝

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

## 模式 C：site 驱动的 owner 隔离

- 对同域任务使用 `site <adapter>`
- 依托 owner 机制在同一 session 内并发，避免 tab 串扰
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

## 7.3 并发任务 tab 冲突

检查：

- 是否在 pipeline/site 上下文外直接发了未带 owner 的 browser 命令
- 是否手动指定了属于其他 owner 的 `tabId`
- 用 `tab list` 查看 `ownerId` 是否与当前 run 一致

## 7.4 profile 冲突

若多个 Session 共用同一 profile path，出现随机失败或状态污染，建议改为独立 profile。

---

## 8. 维护建议

- 对有状态自动化任务，固定使用 `--session` + `--profile`
- 对并发任务，默认每条命令附带 `--tab-id`
- 对同站点批处理，优先使用 site 机制而不是手写 tab 复用逻辑
- 对长等待场景，显式设置 timeout，避免默认超时引发误判
