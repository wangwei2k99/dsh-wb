# DSH WorkBuddy Provider

在 DeepSeek Harness（DSH）桌面端和 WebUI 中使用 WorkBuddy 中国区模型，支持 API Key 和账号登录。

> 本插件是第三方适配工具，不属于 WorkBuddy 或 DSH 官方项目。使用前需准备有效账号或 API Key。

## 功能

| 功能 | 说明 |
| --- | --- |
| 两种认证方式 | 支持 API Key、浏览器账号登录，可随时切换 |
| 多凭据管理 | 添加、切换和删除多个 API Key 或登录账号 |
| 会话独立选择 | 可为不同会话分别指定账号或 API Key |
| **会话独立档位** | **每个会话可单独选择上下文窗口与输出档位，同时开多个会话互不影响** |
| 模型管理 | 获取可用模型，添加、编辑、删除模型或恢复在线目录 |
| 模型参数 | 按模型配置上下文窗口、最大输出 Token 和思考档位 |
| 账号用量 | 令牌模式下查看剩余积分、今日请求次数和积分用量 |
| 多端支持 | 支持桌面、Web 和 Headless 使用方式，兼容 ModLens 包装模型 |

不需要安装本机 WorkBuddy CLI。模型可用范围及用量以当前账号权限和服务返回结果为准。

## 环境要求

- 已安装 DSH，支持已声明兼容的旧版和 `0.2.x` 系列。
- Node.js `>= 22.19.0`。
- 支持 Windows、Linux、macOS。

DSH 升级到新版本系列后，请先确认插件兼容性。

## 参考资料（更新时先看这里）

插件对 WorkBuddy 上游协议的理解，主要依赖以下外部资料。**上游接口随时可能变化，
更新本插件前请先核对这些来源的最新状态。**

| 资料 | 用途 | 注意 |
| --- | --- | --- |
| [workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | 目前最完整的第三方协议逆向参考：出站身份头族（`wb_identity.py`）、接口路径、请求体处理、模型目录、积分与限流。解包官方客户端 + 抓包交叉验证 | ⚠️ 上游自 2026-10-23 起收紧非官方客户端识别；该项目已转为低频维护 |
| [WorkBuddy 官方文档](https://www.workbuddy.cn/docs/workbuddy/) | 产品能力、上下文窗口档位、模型清单等官方口径 | 面向官方客户端，不含 API 细节 |
| [Kimi Code 模型配置](https://www.kimi.com/code/docs/kimi-code/models.html) | Kimi 模型的上下文窗口、思考档位映射 | 官方规格 |
| [DeepSeek 官方公告](https://www.deepseek.com/en/news/) | DeepSeek 模型规格与版本变更 | 官方口径 |

**使用 `workbuddy2api-hub` 时的边界：**

- 它是**独立项目**，与本插件无代码依赖；参考其协议结论，不要直接搬代码。
- 该项目明确声明「仅用于协议学习、研究与个人自用」，并提示上游可能随时进一步收紧。
- 其中的身份版本号（如桌面端 `5.8.3`、内置 CLI `2.161.0`）来自特定时点抓包，
  上游升级后需重新核对。

本插件自身的实测数据（上下文上限、身份头族连通性）记录在
[模型上下文档位实测与建议](docs/模型上下文档位实测与建议.md)。

### 为什么不用 DSH 原生登录通道

DSH 通过 authorization seam 提供了原生的 OAuth 登录能力：provider 登录后凭据存入
harness credential store 的 `llm-pi-ai/<provider id>` 记录，由宿主负责刷新。
**本插件没有走这条路，是有意的：**

- pi-ai 的 provider catalog 里**没有 WorkBuddy**。原生通道只对 catalog 内、
  且自带 login 的 provider 生效。
- 该通道要求 provider id 符合记录语法（小写连字符标识符），否则写入时以
  `LlmError('UNSTORABLE_PROVIDER_ID')` 拒绝。
- WorkBuddy 的登录是「浏览器 OAuth + `state` 轮询」的私有流程，与 pi-ai 的
  login 契约不匹配。

因此本插件自行实现登录（`workbuddy-auth.js`），把令牌写入 DSH credentials
（`WORKBUDDY_LOGIN_SESSION` 等引用），而非 `llm-pi-ai/*` 记录。这样仍满足
「凭据由 DSH 托管、不落配置文件」的要求，只是绕过了原生 login 契约。

> 能力边界：这也意味着**登录会话的刷新由本插件负责**（`/auth/token/refresh`），
> 不走宿主的跨进程刷新锁。多进程同时刷新同一账号时，后写者覆盖先写者，
> 但两者拿到的令牌都有效，不会互相踢下线。

## 安装与更新

### 桌面端

在 **设置 → 插件 → 添加插件** 中安装：

```text
github:wangwei2k99/dsh-workbuddy
```

也可以在终端执行，更新时使用同一条命令：

```powershell
dsh plugin --profile desktop add github:wangwei2k99/dsh-workbuddy
```

> **为什么不是 `@wangwei2k99/dsh-workbuddy@latest`**：这个包目前**没有发布到
> npm registry**（查询返回 404），`@latest` / `npx` 形式会直接失败。桌面 Profile
> 里记录的也是 `github:` 源，上面两条命令与实际生效的安装方式一致。
> 等包正式发布到 npm 之后，把 `github:…` 换成 `@wangwei2k99/dsh-workbuddy@latest` 即可。

### Web / Headless / 桌面

一键安装或更新**所有已存在的 Profile**（先克隆本仓库，再在仓库根目录执行）：

```powershell
node cli.js install
```

> 以前这条命令只处理 `web` 和 `headless`，桌面版用的 `desktop` Profile 会被漏掉——
> 于是 `install` 跑完，日常在用的那个 Profile 里旧插件依然存在。
> 现在会扫描 `~/.dsh/profiles` 下所有真实的 Profile（含 `desktop`），逐个清理旧包并安装。

仅安装 Web Profile：

```powershell
dsh plugin --profile web add github:wangwei2k99/dsh-workbuddy
```

**安装或更新后，完整退出并重新启动 DSH。** 只刷新页面不会完成更新。
更新可保留已有模型、账号和 Key 配置。

> **从旧包名升级**：包名已由 `@axiaohungry/dsh-llm-workbuddy` 改为
> `@wangwei2k99/dsh-workbuddy`（npm 不允许非 scoped 包名带 `/`，所以要带 `@`）。
> 建议先移除旧包再安装新包：
>
> ```powershell
> dsh plugin --profile desktop remove @axiaohungry/dsh-llm-workbuddy
> dsh plugin --profile desktop add github:wangwei2k99/dsh-workbuddy
> ```
>
> `node cli.js install` 会自动清理旧包名和旧行 id。

### 与旧插件共存时以本插件为准

历史版本（`dsh-llm-workbuddy`、`dsh-llm-codebuddy` 等）与本插件都注册同一个
provider `workbuddy-cn`，而 DSH 的 llm 注册是先到先得、后到者抛 `DUPLICATE_*`。
如果机器上还留着旧插件，**不必手动卸载**：本插件启动时会做进程内选举，
无条件接管 provider 归属。

具体行为：

1. **停用旧行**：把旧插件所在的 loader 行在**内存里**标记为 disabled，并释放它的
   fiber。不写回 `cordis.yml` / `cordis.patch.yml`，你的配置文件不会被改动。
2. **等待卸载完成再注册**：fiber 的卸载是异步的（目录键要等 disposer 跑完才删），
   所以本插件会等旧插件真正卸载完再重新注册，而不是立刻重试。
3. **守夜窗口**：启动后约 12 秒内周期性复查，处理"比本插件更晚才加载完"的旧插件。
4. **重复安装**：同一个包装了多行时，只有第一行生效，其余行停用后静默退出，
   不会再产生重复注册告警。
5. **HTTP 路由也用新路径**：登录/状态接口由 `/dsh-llm-workbuddy/auth/*` 改为
   `/dsh-workbuddy/auth/*`，避免和仍在运行的旧插件争抢同一条路由
   （webserver 对同路径重复注册会直接抛错）。
6. **设置卡片两种 id 都认**：设置页的扩展卡片按 `settingsNs`（即 loader 行 id）
   精确匹配，本插件同时注册 `dsh-workbuddy` 和 `llm-workbuddy` 两个 key，
   按新 id 或旧 id 安装都能显示。

已知边界：

- 只解决**同一进程内**的冲突。两个 DSH 实例各自独立，互不影响。
- 旧插件如果在守夜窗口结束（约 12 秒）之后才被动态加载，这一次不会被接管，
  重启 DSH 即可。
- 被停用的旧行会在启动日志里留下 `unload plugin …`，这是正常现象，不带告警。


## 使用方法

### 1. 打开配置

桌面端进入 **设置 → 插件 → WorkBuddy 插件详情**。
WebUI 进入 **设置 → 模型**，添加或编辑 **WorkBuddy 中国区**。
具体入口可能随 DSH 版本略有不同。

### 2. 选择认证方式

**API Key**

1. 选择 `API Key` 模式。
2. 在“新增 API Key”中粘贴 Key，可填写便于识别的名称。
3. 点击“添加并使用”，或从下拉列表中选择已有 Key。

也可选择环境变量 `WORKBUDDY_API_KEY`；兼容已有的 `CODEBUDDY_API_KEY`。
API Key 模式不显示账号令牌积分。

**令牌登录**

1. 选择 `令牌登录`。
2. 点击登录或添加账号，在浏览器中完成登录。
3. 返回 DSH，选择要使用的账号。

支持保存多个账号。删除账号会移除该账号的本地登录凭据。

### 3. 选择模型

点击“获取可用模型”，选择需要的模型，再点击“保存模型”。
可按需修改模型名称、使用场景和思考档位。

使用场景四档：简短问答、日常编码、超长文档、大型项目。选中一档会同时写入上下文窗口和最大输出。前三档是固定工作点，大型项目写入该模型的上游上限。上限来自 `GET /v3/config` 的 `maxInputTokens` / `maxOutputTokens`，改模型或换账号后重新「获取模型」即可刷新。具体数字见 [模型上下文档位实测与建议](docs/模型上下文档位实测与建议.md) 第 5 节。

更换账号或 Key 后，建议重新获取可用模型。手动添加模型时，请确认模型 ID 和账号权限。
“恢复在线目录”会取消手工覆盖的模型列表。

### 4. 可选：为会话单独选择凭据

打开“会话级账号/API Key”开关后，可在新会话或输入框附近选择凭据。

- 未绑定会话首次调用时，使用当前默认选择。
- 已绑定会话继续使用自己的选择，不随全局默认值变化。
- 可单独切换或解除当前会话绑定。
- 关闭开关后使用全局选择；重新开启后恢复已有绑定。

账号模型权限不同时，还需选择该账号可用的模型。

### 5. 可选：为每个会话单独设置档位

**解决的问题**：档位原本写在模型定义里，是全局的。同时跑「大型项目」和「日常编码」
两个会话时，改其中一个会把另一个也改掉——两边互相覆盖。

现在档位按会话独立记录，两个会话各自停在自己的档位上：

| 场景 | 行为 |
| --- | --- |
| A 会话选「大型项目」 | 只影响 A，B 会话仍是原档位 |
| B 会话选「日常编码」 | 只影响 B，A 会话不受影响 |
| 新开会话 | 不带覆盖，使用模型定义里的默认档位 |
| 点「恢复默认」 | 清除本会话覆盖，回到模型默认值 |

**它只改内存，不写配置**：覆盖值仅存在于宿主进程内存中，按 `sessionId` 记录。
不改 `cordis.patch.yml`，不写会话日志，也不碰你的模型定义。

**两条边界**（宿主机制决定，不是本插件的取舍）：

- 只影响**之后发出的请求**。正在执行的那一步保持它启动时的窗口，下一轮才生效。
- **重启 DSH 后覆盖消失**，回到模型默认档位。需要长期固定的档位，请改模型定义。

**档位不会被放大**：会话覆盖值永远不超过模型自身的窗口上限。想用更大窗口，
要么选「大型项目」，要么在模型定义里调高上限。

## 近期解决的问题

**会话级档位与稳定性（当前版本）**

- **档位改为按会话独立**：原先档位存在模型定义里，是全局的，同时开两个会话会
  互相覆盖。现在按 `sessionId` 在宿主内存里记录覆盖值，两个会话各停各的档位。
  走的是三条官方 seam（`agent/request` waterfall、`prepareCall` 的 `configure`
  回调、冻结调用对象上的 `context.contextWindow`），不 patch 任何宿主原型。
- **下拉菜单配色对齐官方**：档位菜单原先用 `--dsw-alias-bg-overlay`（暗色
  `#61666b`），比原生权限、模型菜单亮一大截，并排时深浅明显不一致。现在照官方
  写法改用 `--dsw-specific-menu`（`#43454a73`）配 `backdrop-filter`、`radius-lg`
  和 `::after` 画的 `.5px` 描边。半透明表面必须配毛玻璃，否则会显得偏实偏亮。
- **修复会让插件整体不激活的崩溃**：cordis 对未在 `inject` 中声明的服务，
  属性访问是**直接抛错**而非返回 `undefined`。此前为不硬依赖 `agents` 把它移出
  `inject`，却仍直接读取 `ctx.agents`，导致 `apply` 抛错、整个插件不激活
  （模型接入一起失效）。现在可选服务统一按「先 try 属性访问，失败退回 `ctx.get`」
  读取。
- **附加功能不再能拖垮主流程**：`agent/request` 是 waterfall，处理函数抛错会让
  整个请求失败；`prepareCall` 是全局替换，抛错会让所有模型调用失败。档位逻辑
  现在整体包了兜底，自身异常时原样放行宿主配置；但**宿主自身的失败仍原样上抛**，
  不会被吞成成功。

`0.2.1-rc.4` 主要改善：

- 会话体积超过「上下文窗口」后，每轮只回 1 个 token 并提示「已达到输出 token 上限」，
  点「继续」也拿不到正文（见下一节）。现在按剩余空间收敛输出预算；放不下时抛
  `CONTEXT_WINDOW_EXCEEDED`，由 DSH 自动压缩后重试。
- 上游 `11115` 等上下文超限错误补上 `context_length_exceeded` 标记——DSH 只认英文
  措辞，缺标记时不会触发自动压缩。
- 插件页标题改为 `wangwei2k99/dsh-workbuddy`：DSH 从 `locale/<语言>.json` 的
  `meta.title` 读取展示元信息，缺省时才回退到包名。仓库地址同步为
  `github.com/wangwei2k99/dsh-workbuddy`。
- 包名同步改为 `@wangwei2k99/dsh-workbuddy`（标题下方那行显示的就是包名），
  旧包名保留在迁移列表里，安装/卸载时自动清理。
- 「上下文窗口」按上游 `maxInputTokens` 分三档（1/5、1/2、上限），「最大输出 Token」
  按 `maxOutputTokens` 分三档（1/4、1/2、上限）——超出上限的档位不再出现，
  「48K 上限的模型却选了 128K」这种上游只会静默截断的组合被彻底堵掉。

`0.2.1-rc.3` 主要改善：

- 部分会话出现 `400 / 11128`、请求失败的问题。
- 新旧 DSH 版本下系统指令、工具调用的兼容性。
- API Key 和令牌两种方式的调用一致性。

已完成自动化检查，并验证两种认证方式均可获取模型、发送请求及接收回复。
上游服务或 DSH 发生变化时，仍可能需要更新插件。

## 上下文溢出：为什么只回 1 个 token

上游对「输入 + `max_tokens` 超过模型窗口」的请求**不报错**，而是立刻结束，
`finish_reason` 标成 `length`，正文只有 1 个 token 甚至为空。

DSH 把 `length` 显示成「已达到输出 token 上限」，于是看起来像「输出被截断」，
实际是**输入把窗口塞满了**。此时反复点「继续」不会有任何进展，调大「最大输出
Token」也没有用——真正该动的是「上下文窗口」或直接新建会话。

插件现在会在发请求前处理这件事：

- 输入 + 最大输出放不下时，**按剩余空间收敛 `max_tokens`**，让请求仍能拿到回答。
- 输入本身已经塞满窗口时，抛出 `CONTEXT_WINDOW_EXCEEDED`，由 DSH 自动压缩上下文
  后重试；压缩也救不回来时给出明确提示，而不是让界面一直停在「输出 token 上限」。
- 上游已经返回了「1 个 token + `length`」时，同样改判为上下文溢出。
- 业务码 `11115` 等上下文超限错误的文本里固定带 `context_length_exceeded` 标记
  ——DSH 只按英文措辞识别溢出，缺这个标记就不会触发自动压缩。

**压缩摘要请求不受窗口限制。** DSH 自动压缩的做法是把「要被压缩的那段历史」原样回放
给模型写摘要，所以摘要请求的体积几乎等于整个上下文；它的输出预留取
`compaction-basic.maxTokens`（默认 65536）。这道窗口检查若也作用于摘要请求，会让压缩
本身无法完成，而且是两种不同的失败：

| 上下文状态 | 旧行为 | 结果 |
| --- | --- | --- |
| 输入已塞满窗口 | 抛 `CONTEXT_WINDOW_EXCEEDED` | 压缩失败并抛回原始错误，该会话此后**永远无法被压缩** |
| 输入只剩少量余量 | 把 `maxTokens` 削到「窗口 − 输入」 | 摘要写到一半被输出上限截断，报 incomplete checkpoint |

因此 `purpose` 为 `compaction` 的调用会原样发出，由上游按真实容量裁决，不再用本地估算
替上游下结论。

实测依据（单个会话日志，28479 条事件，100 次压缩事务、93 次成功、7 次失败）：
失败全部命中上表两类——turn 78 / turn 111 是第一类，报的正是本插件这段话；
turn 71–75 是第二类，30 万窗口下 `maxTokens` 被削到约 4996。93 次成功说明触发链本身
没问题，被阻断的一直是「压缩需要先发出一次满窗请求」这一步。

典型触发场景：把「上下文窗口」从 1M 调到 200K（或更小），而会话里已经积累了几十万
token 的历史。

## 常见问题

| 问题 | 处理方法 |
| --- | --- |
| 找不到 WorkBuddy 提供方或设置入口 | 确认安装到正在使用的 Profile，完整重启 DSH 后再查看插件详情或模型设置 |
| 更新后仍是旧版本或旧界面 | 重新执行对应 Profile 的更新命令，完整退出并重新打开 DSH |
| API Key 下拉列表没有新 Key | 在插件自己的“新增 API Key”区域提交，点击“添加并使用” |
| 登录成功但调用使用了其他账号 | 检查是否启用了会话级凭据，并核对当前会话的绑定 |
| 获取模型失败或找不到模型 | 核对当前账号或 Key，重新获取目录；手动添加时检查模型 ID 和账号权限 |
| 返回 `401 / 403` | 检查 Key 是否有效、账号是否过期，以及是否具有目标模型权限；必要时重新登录 |
| 返回 `400 / 11128` | 更新到最新版本并完整重启；仍失败时记录业务码、插件版本和使用的模型后反馈 |
| 返回 `500`、空响应或请求长时间无结果 | 更新并重启，检查网络；使用包装模型时，也检查相应服务状态 |
| 每轮都提示「已达到输出 token 上限」，正文为空或只有几个字 | 会话体积已超出模型窗口。插件会把这种响应改判成上下文溢出并触发自动压缩；反复出现时调大「上下文窗口」或新建会话，调大「最大输出 Token」无效 |
| 报错说「已自动压缩并重试」，但界面只看到失败、没有压缩 | 旧版的窗口检查也拦住了压缩摘要请求（压缩需要先发出一次越窗请求才能完成），形成死锁。更新并完整重启后，`purpose` 为 `compaction` 的请求不再受限 |
| 不显示积分，或显示“暂不可用” | 确认使用令牌模式；积分服务暂时不可用不一定影响模型调用 |
| 思考档位选项与其他模型不同 | 属于正常情况，按该模型显示的可用选项选择 |
| 改了某个会话的档位，另一个会话也跟着变 | 更新到支持会话级档位的版本并完整重启。旧版档位存在模型定义里，是全局的 |
| 会话档位菜单不可点（灰掉） | 该位置拿不到 `sessionId`（如后台任务）。档位要绑定到具体会话，切到正常会话窗口再设置 |
| 重启后之前设的会话档位没了 | 属正常行为：覆盖值只在宿主内存中，不落盘。需要长期固定请改模型定义 |
| ModLens 模型慢、超时或返回 `429` | 检查 ModLens 视觉引擎的登录、网络和额度；纯文本任务可先切换 WorkBuddy 直连验证 |

查看桌面 Profile 的安装版本：

```powershell
dsh plugin --profile desktop list --depth 0
```

Web 用户将 `desktop` 改为 `web`。ModLens 用户也可运行：

```powershell
modlens doctor --json
```

反馈问题时，请提供插件版本、DSH 版本、模型名称、认证方式和脱敏后的错误信息。
**不要公开 API Key、登录令牌或未经脱敏的完整日志。**

## 开发与测试

### 三层测试

| 层次 | 命令 | 依赖真实上游 |
| --- | --- | --- |
| 语法 + 单元 + 链路 | `npm run check` | 否 |
| 端到端 | `npm run e2e` | **是** |
| 全部 | `npm test` | 是 |

`npm run check` 覆盖 91 项断言（68 单测 + 15 真实链路 + 8 纯逻辑），全部基于
自建 mock，不联网、不花钱，适合每次改代码就跑。

### 为什么还要端到端测试

mock 覆盖再多也替代不了真链路。曾经有一个让**整个插件不激活**的崩溃：
cordis 对未在 `inject` 中声明的服务，属性访问是**直接抛错**而非返回 `undefined`，
而当时 91 项 mock 测试全部通过——因为 mock 里 `ctx` 是个普通对象，怎么读都不抛。

`npm run e2e` 起一个真实的 `dsh headless` 进程，断言：进程退出码为 0、
上游返回 200、拿到模型正文、无 `MISSING_CREDENTIAL`、插件正常激活。
上面那个崩溃能让它稳定报错，这是它存在的意义。

### 准备 e2e profile

端到端测试需要一个装了本插件、配好 provider 和凭据的 profile。
**不要复用 desktop**（日常在用，重启影响你），建议单独建一个：

```powershell
dsh --profile workbuddy-e2e --from-default-profile headless --dump-config
dsh plugin --profile workbuddy-e2e add <本仓库路径>
```

然后在 `~/.dsh/profiles/workbuddy-e2e/cordis.patch.yml` 里写：

```yaml
# credentials 在 headless 模板里默认 disabled。不启用它，
# 插件读不到 apiKeyEnv 指向的凭据，请求会以 MISSING_CREDENTIAL 失败。
- id: credentials
  name: "@deepseek-ai/dsh-credentials-local"
  disabled: false
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: workbuddy-cn
    model: deepseek-v4.1-flash
- id: dsh-workbuddy
  name: "@wangwei2k99/dsh-workbuddy"
  config:
    providers:
      workbuddy-cn:
        apiKeyEnv: WORKBUDDY_API_KEY        # 指向 DSH 已托管的凭据引用，不要写明文
        models:
          - id: deepseek-v4.1-flash
            name: deepseek-v4.1-flash
            contextWindow: 32000
            maxTokens: 16000
            input:
              - text
```

profile 名不同时用环境变量指定：

```powershell
$env:WORKBUDDY_E2E_PROFILE = "my-profile"
node e2e.test.mjs
```

找不到 `dsh` 时可用 `DSH_BIN` 指定完整路径。
脚本在前置条件不满足时会**明确报错并退出（码 2）**，不会静默跳过。

> **成本**：每次 e2e 约 2 次上游请求，prompt 极短，耗时 4 秒左右。
> 因为它会产生真实调用费用，所以**没有**放进 `npm run check`。

## 卸载

桌面 Profile：

```powershell
dsh plugin --profile desktop remove @wangwei2k99/dsh-workbuddy
```

Web / Headless 安装器（在仓库根目录执行）：

```powershell
node cli.js uninstall
```

卸载后重启 DSH。安装器默认保留凭据，便于后续重新安装。

## License

[MIT](./LICENSE)
