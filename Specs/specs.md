# boady — 架构 Spec

Nov 21, 2026 · @River

## 概述

本工具让用户在手机（以及电脑）上用 Claude Code 做 CircuitPython 和 MicroPython 的 agent coding：Claude Code 跑在后端，前端负责对话界面和 USB 板子连接，登录使用 Claude 订阅账号，不需要 API key。电脑和手机共用同一套前端和同一个后端，只维护一套逻辑。

**分阶段路线**

1. **第一步（本文主体）**：手机后端跑在 Termux 里，一行命令安装；只支持 USB 连接板子。
2. **未来路线**：
   - 集成 Linux：APK 内置 Linux 环境（proot + rootfs），不再依赖 Termux。
   - BLE 与 WiFi 连接：通过 CircuitPython Web Workflow / BLE Workflow、MicroPython WebREPL 连接板子。

**范围（第一版）**

- 与 Claude Code 对话，流式显示回复与工具调用，前端审批权限
- 两种项目类型：CircuitPython、MicroPython
- 项目文件的镜像、浏览与编辑
- USB 串口控制台，以及基于串口输出的实时绘图
- 库管理（circup / mpremote mip）
- GitHub 备份

**非目标**

- 支持 Claude Code 的全部工具（Bash 只在白名单内开放）
- 一个项目内混用 CircuitPython 与 MicroPython
- VS Code 扩展作为前端（会多出一套前端逻辑，已否决）
- 多用户或把订阅登录提供给他人
- iPad / iOS（浏览器无 Web Serial，原生串口需 DriverKit 与按厂商 ID 授权，且无法本地运行后端）

## 总体架构

系统分为前端和后端两个进程：前端负责界面和 USB 硬件，后端负责 Claude Code、文件镜像、库管理和 git，两者之间只有一条 WebSocket。

&#91;embedded content: 总体架构 · 前端、后端、板子与外部服务\]

会话消息由前端发向后端，硬件 RPC 由后端发向前端；前端不接触 MCP，后端不直接碰 USB。

**部署形态**

- **手机（第一步）**：后端在 Termux，前端为 APK（可后台运行）。手机 Chrome 网页不是支持的形态（预检中 Pixel 10 Pro 的 Chrome 无法连接 USB 串口）；共用的网页代码在手机 Chrome 上即使能用也只算附带，不做测试。
- **手机（未来）**：后端在 APK 内置的 Linux 沙盒中，前后端同属一个 App。
- **电脑**：后端在本机，前端为桌面 Chrome 网页；也是主要的调试环境。

## 后端

后端是一个 Python 服务（下称“Python 壳”），用 Claude Agent SDK 控制本机的 `claude` CLI。手机上跑在 Termux 里，电脑上直接跑在本机，同一份代码。

**组件**

- **Claude Code CLI**：agent 本体。Termux 上走兼容方案安装，设 `DISABLE_AUTOUPDATER=1` 锁定版本；升级由前端触发，切到已验证版本。SDK 用 `cli_path` 指向这个可用的 `claude`。
- **Python 壳**：会话管理（创建、恢复、中断；启动时按项目类型注入 `src/prompts/` 中的系统提示）、权限审批、MCP 工具定义、镜像维护、串口环形缓冲区、git 与库管理调度、登录流程、WebSocket 服务。
- **文件镜像**：每个项目一个目录，同时是 git 仓库；Claude Code 的 cwd 指向它。
- **成熟工具**：circup（CircuitPython）、mpremote（仅用于 MicroPython 装库）、git、gh，只在后端运行。

**工具配置（全部由后端包办，前端不接触 MCP）**

- 自带文件工具（Read、Edit、Write、Glob、Grep）保留，作用在镜像上。
- Bash 只放行 git、circup、mpremote mip，或将它们封装为自定义工具后禁用 Bash。
- 硬件工具用 SDK 的进程内工具（`create_sdk_mcp_server` + `@tool`）定义，见「MCP 工具与前后端分工」。

**权限审批**

三层：静态规则（`allowed_tools` / `disallowed_tools` / `permission_mode`）、动态审批（`can_use_tool` 推给前端弹窗，等待结果）、Hooks（仅用于 PreToolUse 硬拦截与审计日志）。不设任何自动触发同步或 git 操作的 hook。

- 默认放行：镜像内读写、库安装到镜像（circup、mpremote mip）、git status/diff/log、`read_repl` / `read_data`、`write_repl` / `write_data`、`sync_from_device`、`compare_with_device`
- 需确认：git commit/reset/push 等会改变仓库的操作、`sync_to_device`、镜像以外的任何操作
- 代码文件只通过 `sync_to_device` 上板；REPL 写入修改板上文件的风险由系统提示约束，并由上传前的干净检查兜底（见「MCP 工具与前后端分工」）。

## MCP 工具与前后端分工

MCP 只提供抽象过的文件与串口接口：项目类型（CircuitPython / MicroPython）与传输方式（MSC / 串口）的差异全部由前端消化，后端和 MCP 不区分。

**分工**

| 事项 | 前端 | 后端 |
| --- | --- | --- |
| 板上文件 | 按项目类型与传输方式读出、写入、删除；计算板上文件的哈希；raw REPL 文件协议参照 mpremote，在前端用 TypeScript 实现一份，浏览器与 APK 共用 | 维护镜像 `src/`；把同步请求交给前端，把前端返回的文件写入镜像 |
| 串口 | 打开 REPL 串口与数据串口（如有），使用统一的安全 DTR/RTS 设置；把两个串口的输出原样推给后端；执行写入请求。REPL 的读写与项目类型、传输方式、工作流程都无关 | 为两个串口各保存一个环形缓冲区；处理写入互斥 |
| 设备识别 | 只上报板子插拔与 USB 描述符 | 启动识别调用，由 agent 经 REPL 认出板子；查项目表 |
| MCP | 不接触 | 把上面的能力包装成 MCP 工具，直接提供给 agent（Claude Code）调用 |

**MCP 工具（服务名 boady）**

| 工具 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `sync_from_device` | 无 | 新增 / 修改 / 删除的文件列表 | 把板上全部文件拉到镜像 `src/`，结果留在 git 工作区；镜像有未提交修改时先提醒用户，用户拒绝则返回“用户拒绝” |
| `compare_with_device` | 无 | 自上次同步以来板上改动的文件、板与镜像的差异 | 把板上文件拉到缓冲区对比，不写镜像；默认放行 |
| `sync_to_device` | 无 | 写入 / 删除的文件列表 | 把镜像 `src/` 同步到板子；需审批 |
| `read_repl` | `since`（游标，可选）、`tail`（最近 N 行，可选）、`wait_for`（字符串，可选）、`timeout_ms` | 文本、新游标、是否等到 `wait_for` | 读 REPL 串口历史 |
| `write_repl` | `data`（文本，用 `\x01`–`\x04` 转义表示 Ctrl-A–D） | 写入时的游标 | 写 REPL 串口 |
| `read_data` | 同 `read_repl` | 同 `read_repl` | 读数据串口历史 |
| `write_data` | 同 `write_repl` | 同 `write_repl` | 写数据串口 |

**规则**

- REPL 的读写对任何项目类型、任何工作流程都一样。
- 游标是单调递增的字节位置。写入工具返回写入时的游标，agent 用它作为读取的 `since`，只看写入之后的输出，避免读到上一次的 Traceback。读取不清空缓冲区。
- 每个串口同一时刻只有一个写入者（用户控制台或 agent）；agent 写入期间控制台只读。读取不受限。
- 数据串口：CircuitPython 在 boot.py 中 `usb_cdc.enable(console=True, data=True)` 后出现第二个 CDC 接口；MicroPython 通常没有。没有数据串口时，`read_data` / `write_data` 返回明确错误。
- 前端未连接或板子未插入时，所有工具立即返回“设备未连接”。
- 运行、软复位、内存试跑等操作由 agent 用 `write_repl` 组合完成（如 Ctrl-C、Ctrl-D），写在 `src/prompts/` 的系统提示里。DTR/RTS 不对 agent 开放。
- **REPL 写入会修改板上文件**：板上运行的代码（包括 agent 经 `write_repl` 执行的代码）可以写文件。系统提示要求 agent 不经 REPL 修改代码文件——代码一律改镜像再经 `sync_to_device` 上板；因此被 REPL 或板上程序改动的多为非代码文件（数据、日志、配置）。
- **上传前确认板上干净**：agent 调用 `sync_to_device` 之前，先用 `compare_with_device` 把板上文件拉到后端的缓冲区里对比，不写镜像（镜像里 agent 尚未提交的修改不会被覆盖）。后端在每次拉取和上传后记下板上文件的哈希作为基准，对比结果列出自上次同步以来板上被改动的文件及差异；有改动则先向用户说明，由用户决定保留（用 `sync_from_device` 拉入镜像并 commit）还是丢弃（直接上传覆盖），再上传。（主人决定，2026-11-24，取代先拉取到镜像的做法。）
- 工具参数与返回的具体 JSON 形式由实现方定，记入 `additional_specs.md`。

## 项目类型

项目类型只有 CircuitPython 与 MicroPython 两种，由项目仓库根目录的配置文件 `boady.json` 决定（如 `{"type": "circuitpython"}`），这是项目类型的唯一依据。

- 建立项目时设定，之后不能更改；一个项目内不会混用两种类型。
- Python 壳与 agent 都直接读取这个文件；后端项目表里的类型只是它的缓存。
- 类型必须在连接板子之前确定，前端据此选择文件读写逻辑。
- 克隆的仓库没有 `boady.json` 时，由 agent 根据代码做出最好的判断并写入（视同建立项目）。如果代码不足以判定类型，或 agent 认为仓库结构与项目文件结构差别太大，则判定该仓库不合格，克隆失败。
- 连接板子后，若 agent 认出的运行时与 `boady.json` 不一致，立即终止所有进程（agent 的运行与全部硬件操作）并提醒用户，然后回到引导页，让用户换一个项目或新建项目。

| 影响范围 | CircuitPython | MicroPython |
| --- | --- | --- |
| 前端：板上文件读写 | 系统已挂载 CIRCUITPY 时走 MSC；挂载不了直接走串口 raw REPL（先在运行时切换写权限） | 只走串口 raw REPL（不支持 MSC） |
| agent 工作方式：系统提示（src/prompts） | code.py 自动重载、`boot_out.txt` | boot.py / main.py、内存试跑、软复位 |
| agent 工作方式：项目 CLAUDE.md 模板 | CircuitPython 版 | MicroPython 版 |
| 库管理（后端，写入镜像） | circup | mpremote mip |

REPL 串口的读写两种类型完全相同；唯一差别是数据串口通常只在 CircuitPython 上存在。

项目类型只影响前端的数据逻辑、agent 的工作方式与后端的装库工具。MCP 工具、协议、镜像、git、登录与安全都不区分项目类型——MCP 拿到的是抽象过的文件与串口接口。

## 项目文件结构

每个项目是一个 git 仓库，只有 `src/` 会同步到单片机，对应板子的根目录；其余文件只存在于仓库中。

```
<project>/
├── src/            # 同步到单片机
│   ├── code.py / main.py 等 Python 代码
│   ├── lib/        # 库
│   └── CIRCUIT.md  # 硬件设计、接口、外设
├── boady.json      # 项目配置：项目类型（建立时设定，不可更改）
├── CLAUDE.md       # 参考资料链接、单片机项目的通用工作方式
├── DESIGN.md       # 项目目标、设计理念、项目架构
└── README.md       # 项目概要、版本依赖、如何用 agent 工具开发
```

**约定**

- Claude Code 的 cwd 是项目根目录，启动时自动读取 CLAUDE.md；镜像同步、circup `--path`、mpremote mip 都只作用于 `src/`。
- 项目类型只记在 `boady.json`。项目 CLAUDE.md 只写参考资料链接与单片机项目的通用工作方式（如先在 REPL 里测试，再写进代码），并指向 `boady.json`。关于 boady 的 MCP 工具、同步与 git 规则等 App 自身的内容不写在这里，而是放在 boady 的 `src/prompts/` 中，由后端作为系统提示注入，随 boady 升级而更新。
- CIRCUIT.md 放在 `src/` 里，会随代码一起写入板子，硬件说明跟着板子走；代价是占用一点闪存。
- 不设 `.gitignore`：`src/` 里的全部文件都入库，包括 `src/lib/` 与 `boot_out.txt`，保证任一版本检出后即可原样同步到板子。操作系统生成的系统文件与 ID 文件不同步，因而不会出现在镜像里。
- 新建项目时生成全部四个文档的骨架，由 agent 与用户在开发中共同维护。

## 板子、项目与会话

每个项目固定绑定一个 Claude session id；板子通过 UID 关联到项目，连接板子即打开对应项目并恢复其会话。App 里没有会话管理界面，也没有在标签里管理多个项目的界面。

**板子 UID**

- 认出板子由 agent 直接从 REPL 完成，不依赖前端的文件逻辑，也不需要预先知道项目类型。
- **CircuitPython**：读 `microcontroller.cpu.uid`（与 `boot_out.txt` 中 `UID:` 一行相同，如 `4150325537323115`）。`Board ID:` 是板子型号，不用于区分板子。
- **MicroPython**：读 `machine.unique_id()`（多数移植支持）；不支持时由 agent 经 REPL 在板子根目录写入 ID 文件 `/.boady_id`（内容为 UUID）。
- 同时读出运行时类型（`sys.implementation.name`）与 `.mpy` 版本。
- 不依赖 USB 序列号：转串口芯片板子的 USB 序列号属于转串口芯片，而且常常没有。
- ID 文件不参与同步，也不入库。

**识别调用**：板子连接后，后端启动一次独立的一次性 agent 调用（不使用任何项目的会话，只开放 `read_repl` / `write_repl`），要求按固定格式返回 UID、运行时类型与 `.mpy` 版本。后端据此查项目表；项目确定后，前端按 `boady.json` 启用对应的文件读写逻辑。若识别出的运行时与项目的 `boady.json` 不一致，立即终止所有进程并提醒用户，然后回到引导页。

**项目表**

后端在自己的数据目录（不在任何项目仓库内）持久保存每个项目的 `{ 项目目录, 项目类型（boady.json 的缓存）, Claude session id, 板子 UID（未连接过则为空）, .mpy 版本（MicroPython，连接时读取 sys.implementation._mpy）}`。

- **session id 在项目创建时产生，永久保存**：新建或克隆项目时立即建立 Claude 会话并记录 session id；此后每次打开项目都用它以 `resume` 恢复。一个项目只有这一个会话，不增加也不减少；后端重启、前端断开、手机重启后都不能丢失。
- **绑定板子**：项目创建后第一次连接的板子，其 UID 写入该项目。
- Claude Code 按工作目录保存会话记录，项目目录路径创建后不得改变，否则 `resume` 会找不到会话。产品上没有修改项目路径的需求，因此不提供重命名或移动项目的功能。

**连接板子时**

1. 由识别调用读出 UID 与运行时类型，在项目表中查找。
2. 若当前打开的项目尚未绑定板子（刚新建或克隆），绑定到这块板子并直接继续工作。
3. 否则，恰有一个项目绑定了该 UID：直接打开。
4. 多个项目绑定了同一 UID（先后新建或克隆了项目并连了同一块板子）：在引导页让用户选择项目。两个项目都保留。
5. 没有任何项目绑定该 UID：进入引导页新建或克隆项目。
6. 项目确定后，恢复其会话，再按「文件镜像与同步」拉取板上文件。

**引导页**

新建、克隆和选择项目都在独立的引导页完成，不在标签 UI 里。创建项目只支持两条路：

1. **新建**：App 创建本地 git 项目（选择项目类型，按项目文件结构生成骨架）；可选推送到 GitHub，推送时由 App 用 `gh repo create` 创建远端仓库（默认私有）。
2. **克隆**：克隆一个已有的项目仓库，在其基础上工作；没有 boady.json 时由 agent 判断类型，判断不了或结构差别太大则判定仓库不合格（见「项目类型」）。

引导页的项目列表可以删除旧项目：从项目表移除，并删除其本地目录（需二次确认，不影响 GitHub 远端）。删除功能主要用于清理手机上的本地存储；需要的代码应已推送到 GitHub，删除后可通过克隆重新开始。

## 前端与 UI 职责

前端只有一份 React 网页代码，电脑和手机共用；界面与底层之间有一个适配层，连接和硬件的实现可替换。

**运行形态**

- **浏览器模式**（电脑 Chrome）：网页自己连 WebSocket，硬件用 Web Serial 和 File System Access。电脑端必备。Android 上只测试 APK 模式，手机 Chrome 不做测试。
- **APK 模式**：原生外壳 + WebView 加载同一份网页（可用 Capacitor 搭建）。WebSocket 连接与 USB 由原生前台服务持有，WebView 通过 JS bridge 与服务通信；切到后台不影响 agent。串口用 usb-serial-for-android（在 Android 上提供与 Web Serial 同形的 `navigator.serial` shim），MSC 用 SAF。
- **无硬件模式**：只有对话与镜像编辑，用于调试界面。
- **模拟器（仅供测试）**：没有真实设备时，前端可以启动一块虚拟 Raspberry Pi Pico（rp2040js 模拟器运行 MicroPython / CircuitPython 官方固件），经同一条串口路径当作板子使用（识别、同步、控制台、绘图）。没有 MSC、数据串口与真实引脚。硬件相关的自动化测试也跑在这个模拟器上。详见 additional\_specs.md D36。

前端打开串口时使用统一的安全 DTR / RTS 设置（不触发复位），与项目类型无关，也不对 agent 开放。

后端不区分前端模式，三者都是同一条 WebSocket。

各界面的职责见「UI 初步设计」中的标签页与引导页。

## UI 初步设计

每个功能是一个标签页，同时最多打开两个；标签栏的位置和分屏方向只由屏幕方向决定，分屏顺序固定跟随标签顺序。

&#91;embedded content: UI 线框 · 竖屏与横屏的标签栏和分屏\]

示例中同时打开了“对话”（第 1 个）和“串口”（第 4 个），对话始终在上方或左方。

**标签页（顺序固定）**

1. **对话**：输入、流式回复、工具调用与结果、中断当前轮；权限审批内嵌在对话中
2. **文件**：镜像文件树、代码查看与编辑
3. **版本**：git 状态与 diff（包括连接时拉回的板上变化）、commit / reset / push、提交历史
4. **串口**：REPL 串口与数据串口的控制台；agent 写入期间只读
5. **绘图**：读 REPL 串口输出，遵循 Mu 编辑器的绘图约定——每行一个数字元组（如 (1.2, 3.4)）即一个数据点，元组的每个位置是一条曲线；实时滚动
6. **库**：已装 / 可更新 / 搜索安装（circup 或 mip，按项目类型）
7. **设备**：连接状态、板子 UID、当前项目与类型、同步通道（MSC / 串口）、固件信息、拉取与同步按钮
8. **设置**：界面语言、Claude 与 GitHub 登录、配对、后端启停与升级、保活引导、进入引导页

顺序的考虑：git 改为全部手动操作，因此单独设「版本」标签，紧邻「文件」；「串口」排在「绘图」前，两者同时打开时控制台在上方或左方。项目的新建、克隆、选择、删除不在标签里，只在引导页。

对话标签不可见时，有待审批请求或 agent 一轮结束，在对话图标上显示角标。

**启动时**：打开上次使用的项目（未连板子时为无硬件状态，可对话与编辑镜像）；还没有任何项目时进入引导页。连上板子后按「板子、项目与会话」的流程切换到对应项目。

**各标签内部（初稿，主人试用后补充）**

- **对话**：顶部是项目名与设备连接状态；中间是消息流，工具调用显示为可展开的卡片，审批请求显示为带“允许 / 拒绝”的卡片；底部是输入框与发送按钮，agent 运行中变为中断按钮。
- **文件**：镜像文件树（按 git 状态标出修改）与代码编辑器（Python 语法高亮，手动保存）。竖屏时文件树与编辑器二选一显示，横屏时文件树在左、编辑器在右。
- **版本**：改动文件列表（新增 / 修改 / 删除），点击查看 diff；操作按钮为 commit（填写说明）、reset（单个文件或全部，需确认）、push；下方是提交历史。
- **串口**：REPL 与数据两个子页（没有数据串口时只有 REPL）；终端输出、输入行，以及 Ctrl-C、Ctrl-D、清屏按钮；agent 写入期间显示只读提示。
- **绘图**：折线图，每条曲线对应元组中的一个位置；有暂停 / 继续与清空按钮，只显示最近一段数据。
- **库**：已装库列表（版本、是否可更新），搜索框与结果列表；安装、更新、卸载按钮。
- **设备**：状态卡（是否连接、UID、运行时与固件版本、当前项目、同步通道），拉取与同步两个按钮，上次同步的时间与改动摘要。
- **设置**：分组列表——语言、账号（Claude、GitHub）、后端（状态、启停、升级、配对）、保活引导、进入引导页。
- **引导页**：项目列表（名称、类型、绑定的板子、最近打开时间），可打开或删除；“新建”（填名称、选类型）与“克隆”（填仓库地址）两个入口。

**标签栏**

- **竖屏**：在左侧，只显示图标。
- **横屏**：在上侧，显示图标加标题。
- 已打开的一个或两个标签都高亮。

**打开标签**

| 操作 | 结果 |
| --- | --- |
| 单击 / 单指点按一个标签 | 只打开这一个，退出分屏 |
| 触摸屏：两指同时按住两个标签 | 同时打开这两个 |
| 键盘：按住 Ctrl / Cmd 点一个标签 | 打开最近选中的两个标签（包括刚点的这个） |

前端维护一个“最近选中”列表，每次选中（无论哪种操作）都把该标签移到最前；Ctrl / Cmd 点击取列表前两项。Ctrl / Cmd 点击当前已单独打开的标签时不变。

**分屏**

- 竖屏上下分屏，横屏左右分屏，两个分屏各占一半，不可拖动。
- 内容顺序与标签顺序一致：排在前面的标签在上方（竖屏）或左方（横屏），不可调整。
- 旋转屏幕时保持已打开的标签，只切换布局方向。
- 电脑浏览器按窗口宽高比套用同一规则：宽大于高即为横屏。

**软键盘**

- 横屏（含平板）：无特殊处理。
- 竖屏、未分屏：无特殊处理。
- 竖屏、上下分屏：键盘弹出时只显示光标所在的那一半，另一半暂时隐藏；键盘收起后恢复上下分屏。
- 键盘弹出后可见区域可能变得宽大于高，此时不切换为横屏布局。横竖屏判定以键盘弹出前的窗口尺寸为准（即布局视口，不用随键盘缩小的可视视口），只在旋转屏幕或窗口尺寸变化时重新判定。

**界面语言**：从第一版起支持英文与中文，在设置中切换，默认英文。界面文字全部走语言资源文件，不写死在代码里。

## 通信协议

前后端之间只有一条 WebSocket（JSON 文本帧，文件内容用二进制帧或 base64），只绑定 localhost，连接时必须携带配对 token。消息分两类：会话消息由前端发起，硬件 RPC 由后端发起。

| 消息 | 方向 | 说明 |
| --- | --- | --- |
| `hello` / `auth` | 前 → 后 | 配对 token、前端模式、硬件能力（是否有串口 / MSC） |
| `device.attached` / `device.detached` | 前 → 后 | 板子插入 / 拔出；attached 携带 USB 描述符（VID/PID、是否有 MSC）。后端据此启动识别调用、查项目表 |
| `project.select_required` | 后 → 前 | 需要用户在引导页选择、新建或克隆项目（未知板子，或同一 UID 对应多个项目），携带候选项目列表 |
| `project.*` | 前 → 后 | 引导页操作：新建 / 克隆 / 选择 / 删除项目；打开项目时按其 session id 恢复会话 |
| `user_message` | 前 → 后 | 用户输入 |
| `interrupt` | 前 → 后 | 中断当前轮，并撤回未完成的硬件 RPC |
| `agent_event` | 后 → 前 | 流式文本、工具调用、工具结果、轮次结束 |
| `permission_request` / `permission_reply` | 后 → 前 / 前 → 后 | `can_use_tool` 审批，带请求 ID |
| `state` | 后 → 前 | 当前项目、设备状态、镜像文件树变化、git 状态与 diff、库列表、登录状态 |
| `action` | 前 → 后 | 用户直接操作：编辑镜像文件、同步、git 操作、安装库、登录 |
| `hw.request` | 后 → 前 | 硬件 RPC：写 REPL / 数据串口、读出板上全部文件、按清单写入与删除板上文件（前端按项目类型与传输方式执行） |
| `hw.response` | 前 → 后 | 按请求 ID 回传结果或错误 |
| `hw.cancel` | 后 → 前 | 撤回未完成的硬件请求 |
| `serial.data` | 前 → 后 | REPL 串口与数据串口的输出分别推入后端的两个环形缓冲区 |

**规则**

- 每个 `hw.request` 带超时；超时或前端断开时，后端给工具返回明确错误。
- `interrupt` 必须连带撤回本轮的硬件请求，避免旧操作与新一轮同步交叉。
- 串口同一时刻只有一个使用者（用户控制台 / agent 工具），后端加锁，前端控制台在锁定期间只读。
- 重连后前端发 `hello`，后端重发完整 `state` 快照及当前轮的未决审批。
- 同一时刻只允许一个前端连接；新前端通过认证后，后端通知并断开旧前端。不支持多人协作。

## 文件镜像与同步

镜像是项目文件的唯一主来源，板子是部署目标：agent 和用户都只编辑镜像，何时把改动推到板子由用户或 agent 决定。

**同步规则**

1. **连接时拉取**：板子连接后，把板上文件拉到镜像的 `src/`。板上文件可能新于镜像，对镜像来说就是一次新的写入，留在 git 工作区里；用户按 git 的逻辑选择 commit 或 reset 这些变化，不另设冲突处理。拉取会覆盖镜像中未提交的修改：任何一次拉取（连接时、用户点拉取、agent 调用 sync\_from\_device），只要镜像 src/ 有未提交的修改，都先提醒用户并列出这些文件，由用户同意或拒绝。用户可以先拒绝、commit，再拉取，用 git diff 对比板上与镜像的差别。
2. **编辑不推送**：单次编辑只改镜像，避免 CircuitPython 每改一处就自动重载一次。
3. **同步时机**：只由用户（设备标签的同步按钮）或 agent（`sync_to_device`）决定，没有任何触发器、hook、定时器等自动机制。典型情形：用户克隆了一个项目、连上板子后手动同步；agent 写好全部程序后自己触发同步。同步后如何运行（自动重载、软复位、内存试跑）由 agent 按系统提示决定。
4. **增量**：按文件哈希只传改动的文件。拉取和同步两个方向都是全量镜像，包括新增与删除。
5. **通道选择（前端）**：MicroPython 项目只走串口 raw REPL，不支持 MSC。CircuitPython 项目：系统已挂载 CIRCUITPY（电脑上一般可以，手机视机型而定），且用户选中的盘经 UID 核对属于这块板子，就走 MSC；否则直接走串口 raw REPL（先在运行时切换写权限）。当前通道是前端的显式状态，同一时刻只有一方写盘。

后端只维护镜像；板子一侧的读出、哈希比较、写入与删除都由前端完成。同步到板子时，后端发送镜像的文件清单（路径与哈希），前端与板上文件比较后，只向后端索取有变化的文件内容并写入，再删除镜像中不存在的文件。

**同步范围**：不设任何过滤规则，`src/` 与板子根目录的全部文件在两个方向上都同步（包括 `boot_out.txt` 与 `lib/`）。只有两类例外：

- Windows 与 macOS 在 U 盘上生成的系统文件（如 `.DS_Store`、`._*`、`.Trashes`、`.fseventsd`、`.Spotlight-V100`、`System Volume Information`、`Thumbs.db`）不同步。
- MicroPython 板子的 ID 文件（`/.boady_id`）不同步：它代表物理板子，如果随项目进入仓库，把项目同步到另一块板子时会把身份一起复制。

## 设备连接

第一版只支持 USB，由前端连接板子：串口是通用通道；MSC 只用于 CircuitPython，且只在系统能挂载 CIRCUITPY 时使用，电脑上一般可以，手机视机型而定。MicroPython 为简化逻辑只支持串口文件系统，即使板子提供 MSC（如 pyboard）也不用。

**串口**

- 浏览器：Web Serial；APK：usb-serial-for-android。支持 CDC-ACM（原生 USB 板）与 CH34x / CP210x / FTDI（转串口板）。
- 前端把 REPL 串口与数据串口的全部输出推入后端的环形缓冲区，供 `read_repl` / `read_data` 读取。
- 前端经 raw REPL 读写文件期间，不把这段协议数据推入缓冲区，只插入一行“同步中”的标记；避免 agent 读到协议数据，也避免绘图把它当成数据。
- 用户与 agent 互斥写入串口，控制台在锁定期间只读。
- 串口层要容忍频繁重启和重枚举；ESP32 类转串口板的 DTR/RTS 由前端用统一的安全设置处理，复位等运行操作由 agent 经 write\_repl 按系统提示处理。

**MSC**

- 浏览器：File System Access 的目录选择器，只能使用系统已挂载的盘（电脑上可靠，Android 视机型而定）。
- APK：SAF，同样只能使用系统已挂载的盘；不做用户态读写（libaums + FatFs）。
- 挂载不了就直接走串口，不做额外处理。
- 选盘与核对：前端无法自动发现已挂载的盘。第一次在设备标签里让用户选一次 CIRCUITPY（授权可记住），读盘上 `boot_out.txt` 的 UID 与识别调用的结果核对，一致才走 MSC；没选或不一致就走串口。
- 自动重载：经 MSC 同步前，前端先经 REPL 关闭自动重载（`supervisor.runtime.autoreload = False`），避免多文件写到一半就重载；同步后如何运行由 agent 决定。该属性在重启后是否保持由实现方查证；实测效果不理想再另议。

**串口写文件**

- **MicroPython**：文件系统对代码始终可写，前端直接经 raw REPL 读写（协议参照 `mpremote fs` 的实现）。
- **CircuitPython**：CIRCUITPY 通过 USB 暴露时对板上代码是只读的，前端需先在运行时切换（新版固件）：
  1. Ctrl-C 中断 code.py，Ctrl-A 进入 raw REPL
  2. `storage.unsafe_disable_usb_drive()`，然后 `storage.remount("/", readonly=False)`
  3. 分块写入文件（转义、校验、超时重试）
  4. 按需 `storage.enable_usb_drive()` 还盘，最后 Ctrl-D 软重启
- 连接后先探测 `hasattr(storage, "unsafe_disable_usb_drive")`；老固件不能在线切换，就提示用户离线切换（升级固件，或在 boot.py 中写入 `storage.disable_usb_drive()` 后重启），总能写入。每次写入前重新检查写权限。没有 MSC 接口的板子跳过第 2 步。

**目标手机：Pixel 10 Pro**

- 支持 OTG 主机模式；Termux 里跑 Claude Code 已有实例。
- **串口预检结果**（Pixel 7 上曾遇到串口封闭）：Chrome 的 Web Serial 连不上 USB 串口；Serial USB Terminal（Kai Morich，基于 usb-serial-for-android）的原生通道可用，因此手机上只走 APK 的原生通道。后端不碰 USB，`termux-usb` 不在考虑范围内。
- 高级保护的 USB 保护开启时，锁屏期间新连接被阻止；板子硬复位引起的重枚举会连不回来。agent 运行期间保持解锁，或关闭该项。

## 库管理与 Git 备份

两者都只作用于后端镜像，结果随下一次同步到达板子；一律使用成熟工具，不自己实现。

**库管理**

- **CircuitPython（circup）**：连接时把板上的 `boot_out.txt` 拉入镜像；circup 用 `--path` 指向镜像，安装 / 更新 / 卸载库到 `lib/`，bundle 缓存在后端。
- **MicroPython（mpremote mip）**：同样只写入镜像的 `src/lib/`。做法（已查证 mpremote 1.29.0 源码）：直接调用 mpremote 的 `mip._install_package(transport, package, index, target, version, mpy)`，传入一个自写的本地 transport。mip 模块对 transport 只用到 `fs_exists`、`fs_mkdir`、`fs_hashfile`、`fs_writefile`、`exec`、`eval` 六个方法：前四个映射到镜像目录，`exec` 忽略，`eval` 只被用来查询 `.mpy` 版本，返回项目表中记录的值。`target` 显式传 `lib`（对应镜像的 `src/lib/`），就不会去读板子的 `sys.path`。下载、依赖解析、`github:` 地址改写全部复用 mpremote。从未连过板子时以 `mpy=False` 安装 `.py` 源码版本。`_install_package` 是内部函数，因此锁定 mpremote 版本，升级时回归测试。
- agent 可直接调用（白名单 Bash 或封装工具），用户通过前端 `action` 调用。

**Git 备份**

- 镜像目录即 git 仓库。所有 git 操作（commit、reset、push 等）由用户手动执行，或由 agent 按用户请求执行；没有任何触发器、hook、定时器等自动机制。
- `src/` 全部入库，包括 `src/lib/`；不依赖库清单重装，检出即是板子上的完整内容。
- 恢复 / 切换版本：从仓库检出到镜像，再由用户或 agent 同步到板子。
- 凭据由 `gh` 管理（见登录），`gh auth setup-git` 让 git 使用它，不处理 SSH key。

## 安装、登录与运行

第一步：用户在 Termux 里只执行一行命令，之后的登录、启停、升级都在前端完成。

**一行安装**：`curl -fsSL https://…/install.sh | bash`

1. `pkg install` python、git、gh、openssh，并克隆 boady 仓库（公开）
2. 安装并锁定 Claude Code（兼容方案，`DISABLE_AUTOUPDATER=1`）
3. pip 安装 claude-agent-sdk、circup、mpremote 与后端依赖；之后由 run.py 启动
4. 在 `termux.properties` 写入 `allow-external-apps=true`，供 APK 用 RUN\_COMMAND 启停后端
5. 生成配对 token 并显示配对码 / 二维码
6. 启动后端并 `termux-wake-lock`

脚本办不到的：安装 Termux 与 APK；关闭 Termux 电池优化（前端跳转到系统设置页引导）。电脑上是等价的一行安装脚本。

**Termux 版本**：Termux 有持续更新的 Google Play 版（termux-play-store，支持 16KB 页、内置 termux-usb）和 F-Droid / GitHub 版。社区的 Claude Code 安装方案只在 F-Droid / GitHub 版上验证过；Play 版改了程序执行方式，Claude Code 与 RUN\_COMMAND 在其上是否可用需实测。

**Claude 登录（前端完成）**

后端在 pty 中运行 `claude setup-token`，把授权链接推给前端；用户在浏览器中授权后，把授权码贴回前端，后端写回 pty。长期 token 保存为 600 权限文件，启动时以 `CLAUDE_CODE_OAUTH_TOKEN` 传入，绕开 Termux 上 `/login` 约 24 小时失效的问题。

**GitHub 登录（前端完成）**

后端运行 `gh auth login --web`（device flow），前端显示一次性验证码并打开 `github.com/login/device`；完成后执行 `gh auth setup-git`。

**运行与保活**

- Termux 保活是前提：wake lock + 关闭电池优化，部分 ROM 需单独白名单。
- APK 模式：打开时用 RUN\_COMMAND 拉起后端；USB 连接期间开前台服务。
- 前端能识别“后端未启动”“未登录”“Claude Code 无法启动”三种状态并给出对应引导。

## 安全

手机上任何 App 都能连接 127.0.0.1 的端口，而后端持有 Claude 订阅与 GitHub 写权限，所以 WebSocket 必须配对后才能使用。

- **配对 token**：安装时生成随机 token（至少 128 位），前端首次连接时输入配对码或扫码；APK 用 RUN\_COMMAND 启动后端时可直接读取，自动配对。每次连接必须携带，前端可在设置中重置。
- **监听范围**：只绑定 localhost，电脑上同样如此。
- **凭据**：Claude 长期 token 与 gh 凭据保存在后端，文件权限 600，从不发送给前端。
- **订阅边界**：订阅登录只用于运行 Claude Code 本体，供用户本人使用；不把 token 交给其他 agent 框架，也不以产品形式向他人提供订阅登录。
- **工具边界**：Bash 白名单、镜像目录之外的操作必须审批、PreToolUse hook 做硬拦截。

## 约束、风险与待定事项

最大的风险是目标手机上串口是否可用，以及 Claude Code 在 Termux 上没有官方支持；两者都应在开工前实测。

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| Pixel 10 Pro 串口（Pixel 7 曾封闭） | 整个方案在该手机上不成立 | 已预检：Web Serial 不可用，原生通道可用；手机只用 APK |
| Claude Code 无 Android 版本，靠兼容方案运行 | 更新后可能起不来 | 锁定版本，升级经验证后由前端触发；备选 proot Ubuntu |
| Termux Play 版兼容性 | Claude Code 或 RUN\_COMMAND 不可用 | 实测；必要时指定 F-Droid / GitHub 版 |
| Termux 被系统杀掉 | agent 中断 | wake lock、电池优化引导、前端检测并用 RUN\_COMMAND 重启 |
| USB 保护（高级保护） | 锁屏时板子重枚举后连不回 | agent 运行时保持解锁或关闭该项 |
| 串口 raw REPL 写文件不稳 | 同步失败或文件损坏 | 分块 + 校验 + 重试，写后回读哈希 |
| `setup-token` 在 Termux 上的 OAuth 兼容性 | 无法登录 | 尽早验证；备选在 pty 中跑 `/login` |

**待定**

- [x] Pixel 10 Pro 串口实测：Web Serial 不可用，原生通道可用（见 additional\_specs.md）
- [ ] Termux 中 `claude setup-token` 实测（`/login` 已确认可登录）——需主人
- [ ] Termux Play 版上 Claude Code 与 RUN\_COMMAND 实测——需主人，预检阶段
- [ ] 各标签内部的布局与交互：已有初稿，主人试用后补充——需主人
- [ ] Bash 白名单还是全部封装为工具
- [ ] APK 是否用 Capacitor，还是自建原生外壳 + WebView

## 工具本身的项目：boady

本工具命名为 **boady: Your microcontroller coding buddy**，以 spec 驱动开发：本文即 `Specs/specs.md`，是唯一的事实来源。

**仓库结构**

```
boady/
├── README.md               # 对外介绍这个项目是做什么的；用户指南
├── CLAUDE.md               # agent 的工作方式；主要参考链接
├── Specs/
│   ├── specs.md            # 唯一事实来源，即本 spec
│   └── additional_specs.md # 开发过程中做出的技术或设计决定（如 plan review、prompt 中的决定）
├── src/                    # 源代码
│   ├── android/            # APK 原生外壳
│   ├── web/                # React 前端
│   ├── backend/            # Python 壳与工具
│   └── prompts/            # 全部提示词，均为 .md 文件
├── dist/                   # 构建结果，入库；它就是发布版本
└── run.py                  # 启动脚本
```

**工作逻辑**

- **spec 优先**：agent 开始任何任务前先读 `Specs/specs.md` 与 `Specs/additional_specs.md`；实现与 spec 冲突时，以 spec 为准，或先提出修改 spec，不静默偏离。
- **决定入档**：开发中在 plan review、prompt 里做出的技术或设计决定，记入 `additional_specs.md`；重要决定定期合并回 `specs.md`。
- **CLAUDE.md** 写明以上两条，以及构建、测试和发布的步骤。
- **发布即入库**：每次发布重新构建 `dist/` 并提交，不维护 GitHub Release。
- **安装与升级**：一行安装脚本克隆仓库后执行 `run.py`；`run.py` 启动后端，并由后端提供 `dist/` 中的前端页面。升级即 `git pull` 后重启。APK 的构建结果也放在 `dist/`。
- **提示词文件化**：所有提示词（包括两种项目的 CLAUDE.md 模板、系统提示）都存为 `src/prompts/` 下的 .md 文件，代码只引用文件，不写内联字符串。
- **参考链接**：CLAUDE.md 列出 Claude Agent SDK、CircuitPython / MicroPython 文档、mpremote、circup、usb-serial-for-android、Web Serial 的文档入口。
- **dist 体积**：当前不会超过 GitHub 单文件 100MB 的上限；任一文件接近 50MB（GitHub 警告线）时再评估。
- **仓库公开**：boady 仓库公开，用户安装时直接克隆。
- **提示词分层**：`src/prompts/` 存放两类内容——① 按项目类型区分的系统提示：boady 的 MCP 工具用法、运行时语义、同步与 git 规则，由后端启动会话时注入；② CircuitPython 与 MicroPython 两份项目 CLAUDE.md 模板，内容只有参考资料链接与单片机项目的通用工作方式。boady 自己的 CLAUDE.md 指明 `src/prompts/` 的路径。主人会把草稿放进 `Specs/`，实现时以草稿为参考。
- **APK 签名密钥**：存放在 boady 项目目录内，但写入 `.gitignore`，绝不入库。所有版本必须用同一把密钥签名，丢失后用户只能卸载重装，需另有备份。

## 交接说明（给实现方）

本 Spec 交给独立的 Claude Code session 实现；实现方只依据本文与 `Specs/additional_specs.md`，不依赖任何对话记录。

**规则**

- 本文由主人手动导出为 `Specs/specs.md` 后，以仓库中的版本为准，在线文档不再修改。
- 正文中已写明的内容是决定，不得静默偏离；确需改动时先提出修改 spec。
- 「待定」列表中的事项：标注“需主人”的必须问主人；其余由实现方选择合理方案，并在 `additional_specs.md` 记录决定与理由。
- 需要实物（手机、开发板）的验证由主人执行；实现方提供逐步的测试清单，并按主人回报的结果继续。
- 不确定的外部事实（库的接口、版本行为）先查官方文档或源码再用，不凭记忆假设。

**实现顺序**

| 阶段 | 内容 | 验收 | 环境 |
| --- | --- | --- | --- |
| 预检阶段（需主人） | Pixel 10 Pro 串口三项实测；Termux 中 Claude Code 能运行、`setup-token` 能登录 | 三项结果记入 additional\_specs.md；任一失败则暂停并报告 | 手机 + 板子 |
| 第一阶段：后端与对话 | 仓库骨架、run.py、Python 壳（Agent SDK 会话、系统提示注入、审批）、WebSocket 协议与配对、项目表与 session id 持久化、引导页（新建 / 克隆 / 选择 / 删除）、网页前端的对话、文件、版本、设置标签与分屏规则、中英双语 | 电脑浏览器中新建项目、对话、审批、查看 diff、手动 commit；重启后端后会话仍能恢复 | 电脑，无硬件 |
| 第二阶段：CircuitPython | 六个 MCP 工具与串口环形缓冲区、Web Serial（REPL 与数据串口）、设备事件与 UID 探测、板子绑定、前端的 CircuitPython 数据逻辑（FSA 的 MSC 与串口 raw REPL 两条通道、运行时写权限切换）、双向同步、绘图、circup、库与设备标签 | agent 修改 code.py、触发同步、读取 Traceback 并自行修复的闭环跑通；重新连接同一块板子时自动回到对应项目与会话 | 电脑 Chrome + CircuitPython 板 |
| 第三阶段：MicroPython | 前端的 MicroPython 文件读写逻辑（只有串口 raw REPL）、`machine.unique_id()` 与 ID 文件、后端 `mpremote mip` 写入镜像、MicroPython 的系统提示与项目模板 | 同第二阶段的闭环，在 MicroPython 板上跑通 | 电脑 Chrome + MicroPython 板 |
| 第四阶段：Termux | 一行安装脚本、前端内的 Claude 与 GitHub 登录、保活引导 | 与第五阶段合并验收 | 手机 + 板子 |
| 第五阶段：APK | 原生外壳 + WebView、前台服务、串口 shim、RUN\_COMMAND 启停、对话角标 | 第四、五阶段合并验收，同时测试 APK 前端与 Termux 后端：在 Pixel 10 Pro 上从零安装，用 APK 跑通第二阶段的闭环；切到后台后 agent 仍能完成同步与测试 | 手机 + 板子 |

未来路线的各项（集成 Linux、BLE 与 WiFi 连接）不在本次范围内。

**每个阶段结束时**

- 构建并更新 `dist/`，提交。
- 更新 README.md 的用户指南与 CLAUDE.md 的构建 / 测试步骤。
- 协议、同步、权限规则等不依赖硬件的逻辑写自动化测试；需要硬件的部分给出人工测试清单。
- 向主人报告：完成了什么、做了哪些记入 additional\_specs.md 的决定、需要主人实测的项目。
