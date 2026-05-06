---
name: claw-browser
description: 基于真实浏览器登录态的信息获取与自动化操作工具。支持页面导航、元素交互、信息提取、Tab/Session 管理、Site Adapter 调用与网络调试。
allowed-tools: Bash(claw-browser:*)
---

# claw-browser - 信息获取与浏览器自动化

## 核心价值

通过浏览器 + 用户登录态，可以完成：
- 页面访问与导航：公开网页、登录后页面、内部系统
- 页面操作自动化：点击、输入、等待、滚动、对话框处理
- 信息提取与调试：snapshot、get/eval、network/console/errors
- 会话与并发管理：session、tab、`--tab-id` 精准路由

## 快速开始

```bash
claw-browser tab new https://example.com
claw-browser tab list
claw-browser --tab-id <tab-id-or-prefix> snapshot -i
claw-browser --tab-id <tab-id-or-prefix> click "@e2"
claw-browser --tab-id <tab-id-or-prefix> fill "@e3" "hello"
claw-browser --tab-id <tab-id-or-prefix> get title
claw-browser --tab-id <tab-id-or-prefix> screenshot
```

## 核心工作流

1. `tab new` 打开页面并创建 tab
2. `tab list` 获取 `tab-id`
3. `--tab-id ... snapshot -i` 获取可交互元素（`@eN`）
4. 用 `--tab-id` + `@eN` 执行交互（`click`、`fill`、`press` 等）
5. 页面变化后重新 `--tab-id ... snapshot -i`
6. 用 `--tab-id` + `get` / `eval` / `screenshot` 采集结果

## 命令速查

默认规则：
- 除 `tab list/new/switch/close`、`window new`、`state list/show/rename/clear/clean`、`inspect`、`stream enable/disable/status`、`install`、`upgrade`、`chat` 外，命令都必须带 `--tab-id <tab-id-or-prefix>`。
- 下方命令如未显式写出 `--tab-id`，按简写展示；实际执行时请写成：`claw-browser --tab-id <tab-id-or-prefix> <command> ...`。

### 导航

```bash
claw-browser open <url>
claw-browser goto <url>
claw-browser navigate <url>
claw-browser back
claw-browser forward
claw-browser reload
```

### 元素交互

```bash
claw-browser click <selector-or-ref>
claw-browser dblclick <selector-or-ref>
claw-browser fill <selector-or-ref> <text>
claw-browser setvalue <selector-or-ref> <value>
claw-browser type <selector-or-ref> <text>
claw-browser hover <selector-or-ref>
claw-browser focus <selector-or-ref>
claw-browser check <selector-or-ref>
claw-browser uncheck <selector-or-ref>
claw-browser select <selector-or-ref> <value...>
claw-browser drag <source> <target>
claw-browser upload <selector-or-ref> <files...>
claw-browser download <selector-or-ref> <path>
```

### 键盘与鼠标

```bash
claw-browser press <key>
claw-browser key <key>
claw-browser keydown <key>
claw-browser keyup <key>
claw-browser keyboard type <text>
claw-browser keyboard inserttext <text>
claw-browser mouse move <x> <y>
claw-browser mouse down [button]
claw-browser mouse up [button]
claw-browser mouse wheel <dy> [dx]
claw-browser scroll [direction] [amount] [--selector <selector>]
claw-browser scrollintoview <selector>
claw-browser scrollinto <selector>
```

### 等待

```bash
claw-browser wait [<ms>|<selector>]
claw-browser waitforurl <pattern>
claw-browser waitforloadstate <load|domcontentloaded|networkidle>
claw-browser waitforselector <selector>
claw-browser waitforfunction <expression>
```

### 页面信息与截图

```bash
claw-browser snapshot [-i|-c|-u|-d <n>|-s <selector>]
claw-browser screenshot [selector|path] [--full-page|-f] [--annotate]
claw-browser pdf <path>
claw-browser eval <script>
claw-browser evaluate <script>

claw-browser get text <selector>
claw-browser get html <selector>
claw-browser get value <selector>
claw-browser get attr <selector> <attr>
claw-browser get title
claw-browser get url
claw-browser get cdp-url
claw-browser get count <selector>
claw-browser get box <selector>
claw-browser get styles <selector>

claw-browser is visible <selector>
claw-browser is enabled <selector>
claw-browser is checked <selector>
```

### 网络、存储与环境设置

```bash
claw-browser network route <url> [--abort|--body <json>]
claw-browser network unroute [url]
claw-browser network requests [--filter <text>] [--type <resourceType>] [--method <method>] [--status <status>]
claw-browser network request <requestId>
claw-browser network har <start|stop> [path]
claw-browser responsebody <requestId>

claw-browser cookies get
claw-browser cookies set ...
claw-browser cookies clear

claw-browser storage get <local|session> [key]
claw-browser storage set <local|session> <key> <value>
claw-browser storage clear <local|session>

claw-browser set viewport <width> <height> [scale]
claw-browser set offline <on|off>
claw-browser set headers <json>
claw-browser set media <light|dark|no-preference>
claw-browser set credentials <username> <password>
claw-browser set device <name>
claw-browser set geo <lat> <lng>
claw-browser set timezone <timezoneId>
claw-browser set locale <locale>
claw-browser set permissions <permission...>
claw-browser set content <html>
claw-browser set useragent <ua>
```

### Tab 与窗口

```bash
claw-browser tab list
claw-browser tab new [--label <name>] [url]
claw-browser tab <label|tab-id>
claw-browser tab switch <label|tab-id>
claw-browser tab close [<label|tab-id>]
claw-browser window new [--label <name>] [url]
```

并发/多 tab 操作建议：

```bash
claw-browser --tab-id <tab-id-or-prefix> <command> ...
```

### Session 与连接

```bash
claw-browser connect <cdp-port|cdp-url> [session]
claw-browser session start [session]
claw-browser session stop [session]
claw-browser session stop-all
claw-browser session list
claw-browser profiles
```

### Site Adapter

```bash
claw-browser site list
claw-browser site search <query>
claw-browser site info <adapter-name>
claw-browser site update
claw-browser site <adapter-name> [args...]
```

### 其它常用命令

```bash
claw-browser frame <selector|main>
claw-browser dialog <accept|dismiss|status> [text]
claw-browser route <pattern>
claw-browser unroute [pattern]
claw-browser inspect
claw-browser highlight <selector>
claw-browser selectall
claw-browser bringtofront
claw-browser find <kind> <query> <action> [value]
claw-browser clipboard read
claw-browser clipboard write <text>
claw-browser console [--clear]
claw-browser errors [--clear]
claw-browser stream enable [--port <port>]
claw-browser stream disable
claw-browser stream status
claw-browser help
claw-browser version
```

## 全局选项

```bash
--session <name>            # 选择 session
--profile <path|name>       # 指定浏览器 profile
--tab-id <id-or-prefix>     # 大多数命令必填：将命令路由到指定 tab
--cdp <url>                 # 连接指定 CDP endpoint
--provider <name>           # provider 选择
--device <name>             # 设备配置
--headers <json>            # 默认导航请求头
--default-timeout <ms>      # wait 类命令默认超时
--headed                    # 有头模式
--headless                  # 无头模式（覆盖 --headed）
--annotate                  # 截图标注模式
--json, -j                  # JSON 输出
```

## Ref 使用说明

`snapshot` / `snapshot -i` 输出中的 `@eN` 是元素引用标识。

注意：
- 页面发生导航或显著变化后，旧 ref 可能失效
- 推荐在每次关键操作后重新 `snapshot -i`
- PowerShell 下建议对 ref 加引号，例如 `"@e21"`

## 最佳实践

- 点击或者有可能打开/跳转到新页面时，多用`tab list`查看tab列表，避免使用错误的tab id
- 多 tab 并发时始终带 `--tab-id`，避免命令落到错误标签页
- 使用 tab-id 前缀时需保证唯一，否则会报前缀歧义
- 需要结构化输出时使用 `--json`
