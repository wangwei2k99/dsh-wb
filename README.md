# DSH WorkBuddy Provider

在 DeepSeek Harness（DSH）桌面端和 WebUI 中使用 WorkBuddy 中国区模型，支持 API Key 和账号登录。

> 本插件是第三方适配工具，不属于 WorkBuddy 或 DSH 官方项目。使用前需准备有效账号或 API Key。
> 不需要安装本机 WorkBuddy CLI。模型可用范围及用量以当前账号权限和服务返回结果为准。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| **两种认证方式** | API Key 与浏览器账号登录，可随时切换 |
| **多凭据管理** | 保存多个 API Key 或登录账号，随时切换、删除 |
| **会话级凭据** | 不同会话可分别绑定账号或 Key，互不干扰 |
| **会话级档位** | 每个会话单独选择上下文窗口与输出档位，同时开多个会话互不覆盖 |
| **模型管理** | 从上游拉取可用模型，支持添加、编辑、删除、恢复在线目录 |
| **模型参数** | 按模型配置上下文窗口、最大输出 Token、思考档位 |
| **四种使用场景** | 简短问答 / 日常编码 / 超长文档 / 大型项目，一键写入窗口与输出预算 |
| **账号用量** | 令牌模式下查看剩余积分、今日请求次数、积分用量 |
| **多端支持** | 桌面、Web、Headless 均可使用，兼容 ModLens 包装模型 |
| **与旧插件共存** | 自动接管旧版插件的 provider 归属，无需手动卸载 |

## 环境要求

- 已安装 DSH，支持已声明兼容的旧版和 `0.2.x` 系列。当前包版本 `0.2.1-rc.3` 与 DSH 主线对齐。
- Node.js `>= 22.19.0`
- Windows / Linux / macOS

DSH 升级到新版本系列后，请先确认插件兼容性（见 `package.json` 的 `dsh.compatibility`）。

## 安装与更新

### 桌面端

在 **设置 → 插件 → 添加插件** 中安装：

```text
github:wangwei2k99/dsh-wb
```

也可以在终端执行，更新时使用同一条命令：

```powershell
dsh plugin --profile desktop add github:wangwei2k99/dsh-wb
```

> **为什么不是 `@wangwei2k99/dsh-workbuddy@latest`**：这个包没有发布到 npm registry，
> `@latest` / `npx` 形式会直接失败。Profile 里记录的也是 `github:` 源，
> 上面两条命令与实际生效的安装方式一致。

### Web / Headless / 全部 Profile

一键安装或更新**所有已存在的 Profile**（先克隆本仓库，再在仓库根目录执行）：

```powershell
node cli.js install
```

这条命令会扫描 `~/.dsh/profiles` 下所有真实 Profile（含 `desktop`），逐个清理旧包并安装。
用 `link:` 本地链接安装的 Profile 会自动跳过（那是开发/调试用的，不该被改成发布源）。

> **关于 DSH 插件页的「更新」按钮**：它只对**官方按需插件**生效。
> 宿主只在包出现在官方 catalog 里时才生成 `installTarget`，拿不到这个字段时点「更新」
> 会直接静默返回、没有任何提示——本插件是第三方 GitHub 包，所以点了不会有反应。
> 这是 DSH 的设计，不是插件故障。
>
> **正确的更新方式**是重跑 `node cli.js install`，或对单个 Profile 执行
> `dsh plugin --profile desktop add github:wangwei2k99/dsh-wb`。
> 两者都会拉取 GitHub 默认分支的最新提交，因此不依赖发布的版本号。

仅安装 Web Profile：

```powershell
dsh plugin --profile web add github:wangwei2k99/dsh-wb
```

**安装或更新后，完整退出并重新启动 DSH。** 只刷新页面不会完成更新。
更新可保留已有模型、账号和 Key 配置。

> **从旧包名升级**：包名已由 `@axiaohungry/dsh-llm-workbuddy` 改为 `@wangwei2k99/dsh-workbuddy`。
> 建议先移除旧包再安装新包；`node cli.js install` 会自动清理旧包名和旧行 id。
>
> ```powershell
> dsh plugin --profile desktop remove @axiaohungry/dsh-llm-workbuddy
> dsh plugin --profile desktop add github:wangwei2k99/dsh-wb
> ```

### 与旧插件共存

历史版本（`dsh-llm-workbuddy`、`dsh-llm-codebuddy` 等）与本插件都注册同一个 provider
`workbuddy-cn`，而 DSH 的 llm 注册是先到先得、后到者抛 `DUPLICATE_*`。
如果机器上还留着旧插件，**不必手动卸载**：本插件启动时会在进程内完成选举，接管 provider 归属。

具体行为：

1. **停用旧行**：把旧插件所在的 loader 行在**内存里**标记为 disabled，并释放它的 fiber。
   不写回 `cordis.yml` / `cordis.patch.yml`，配置文件不会被改动。
2. **等待卸载完成再注册**：fiber 卸载是异步的，本插件会等旧插件真正卸载完再重新注册。
3. **守夜窗口**：启动后约 12 秒内周期性复查，处理比本插件更晚加载完的旧插件。
4. **重复安装**：同一个包装了多行时只有第一行生效，其余静默退出，不产生重复注册告警。
5. **HTTP 路由用新路径**：登录/状态接口为 `/dsh-workbuddy/auth/*`，避免与旧插件争抢路由。
6. **设置卡片两种 id 都认**：按新 id 或旧 id 安装都能显示。

已知边界：

- 只解决**同一进程内**的冲突。两个 DSH 实例各自独立。
- 旧插件若在守夜窗口（约 12 秒）之后才被动态加载，这一次不会接管，重启即可。
- 被停用的旧行会在启动日志留下 `unload plugin …`，属正常现象。

## 使用方法

### 1. 打开配置

桌面端进入 **设置 → 插件 → WorkBuddy 插件详情**。
WebUI 进入 **设置 → 模型**，添加或编辑 **WorkBuddy 中国区**。
具体入口可能随 DSH 版本略有不同。

### 2. 选择认证方式

**API Key**

1. 选择 `API Key` 模式。
2. 在"新增 API Key"中粘贴 Key，可填写便于识别的名称。
3. 点击"添加并使用"，或从下拉列表中选择已有 Key。

也可选择环境变量 `WORKBUDDY_API_KEY`；兼容已有的 `CODEBUDDY_API_KEY`。
API Key 模式不显示账号令牌积分。

**令牌登录**

1. 选择 `令牌登录`。
2. 点击登录或添加账号，在浏览器中完成登录。
3. 返回 DSH，选择要使用的账号。

支持保存多个账号。删除账号会移除该账号的本地登录凭据。

### 3. 选择模型

点击"获取可用模型"，选择需要的模型，再点击"保存模型"。
可按需修改模型名称、使用场景和思考档位。

更换账号或 Key 后建议重新获取可用模型。手动添加模型时请确认模型 ID 和账号权限。
"恢复在线目录"会取消手工覆盖的模型列表。

### 4. 可选：为会话单独选择凭据

打开"会话级账号/API Key"开关后，可在新会话或输入框附近选择凭据。

- 未绑定会话首次调用时使用当前默认选择。
- 已绑定会话继续使用自己的选择，不随全局默认值变化。
- 可单独切换或解除当前会话绑定。
- 关闭开关后使用全局选择；重新开启后恢复已有绑定。

### 5. 可选：为每个会话单独设置档位

档位原本写在模型定义里、是全局的——同时跑「大型项目」和「日常编码」两个会话时，
改其中一个会把另一个也改掉。现在档位按会话独立记录：

| 场景 | 行为 |
| --- | --- |
| A 会话选「大型项目」 | 只影响 A，B 会话仍是原档位 |
| B 会话选「日常编码」 | 只影响 B，A 会话不受影响 |
| 新开会话 | 不带覆盖，使用模型定义里的默认档位 |

**只改内存，不写配置**：覆盖值仅存在于宿主进程内存中，按 `sessionId` 记录。
不改 `cordis.patch.yml`，不写会话日志，也不碰模型定义。

两条边界（宿主机制决定）：

- 只影响**之后发出的请求**。正在执行的那一步保持启动时的窗口，下一轮才生效。
- **重启 DSH 后覆盖消失**，回到模型默认档位。需要长期固定请改模型定义。

**档位天花板是上游目录，不是配置里的窗口**：模型定义里的 `contextWindow` 只是
「没选档时的默认值」，会话可以选到比它更大的档；真正的天花板是该模型在上游目录里的
`maxInputTokens`（界面通过 `contextWindowMax` 拿到）。写入时会按这个上限收敛，
超过时如实提示并标记 `clamped`，不会让你选一个永远不会生效的数字。

所以「模型定义写 200K、会话选 1M」是正常的：请求按 1M 发，配置只影响默认档。

## 使用场景档位

四档：**简短问答 / 日常编码（默认）/ 超长文档 / 大型项目**。选中一档同时写入上下文窗口和最大输出。
前三档是固定工作点，大型项目写入该模型的上游上限（`GET /v3/config` 的
`maxInputTokens` / `maxOutputTokens`）。改模型或换账号后重新「获取模型」即可刷新。

| 模型 | 简短问答 | 日常编码 | 超长文档 | 大型项目 |
| --- | --- | --- | --- | --- |
| `deepseek-v4.1-flash` | 32K / 16K | 200K / 32K | 300K / 32K | 1M / 128K |
| `kimi-k3.1-pro` | 32K / 16K | 200K / 32K | 400K / 32K | 1M / 32K |
| `kimi-k3.1-pro-highspeed` | 32K / 16K | 200K / 32K | 400K / 32K | 1M / 32K |
| `glm-5.3` | 64K / 32K | 200K / 64K | 400K / 64K | 1M / 128K |

- **Kimi**：网关输出天花板 32K，所以后三档输出都是 32K，差别只在窗口。
  Pro 与 Highspeed 是同一能力、只是预填速度不同，故共用同一组窗口档位。
- **GLM-5.3**：思考不能关闭，官方编码预算常用 64K 输出，窗口档位与 Kimi 对齐。
- **DeepSeek**：输出天花板 128K，前三档只留 16K 或 32K，避免一次扣掉全部输入预算。

完整实测数据与建议见 [模型上下文档位实测与建议](docs/模型上下文档位实测与建议.md)。

## 错误码与自愈行为

插件会把上游业务码翻译成可操作的提示，并尽量让 DSH 能自动恢复。

| 现象 | 含义 | 插件行为 |
| --- | --- | --- |
| 每轮只回 1 个 token，提示「已达到输出 token 上限」 | 输入把窗口塞满，上游不报错而是直接结束 | 改判为上下文溢出（`CONTEXT_WINDOW_EXCEEDED` + `context_length_exceeded` 标记），触发 DSH 自动压缩并重试 |
| 输入 + 最大输出放不下但还有余量 | 上游会静默截断 | 按剩余空间收敛 `max_tokens`，让请求仍能拿到回答 |
| `11115` 上下文超限 | 与凭据无关 | 文本带 `context_length_exceeded`，让 DSH 能识别并压缩 |
| `11158` 模型无权限 | 账号类型不允许该模型 | 提示带出模型名与账号类型，说明换 Key 无效、需改选模型或找管理员 |
| `11128` 渠道校验 | 会话头族缺失 / 提示词命中名单 / 请求体形状 | 按上游原文分三种情况给出对应提示 |
| `14003` / HTTP 429 限流 | 账号级频率或并发限制 | 说明不是 Key、权限或超窗问题；有 `Retry-After` 时按它给出等待秒数 |
| 其它未识别业务码 | 未知 | 原样透出上游 `msg`（超 200 字截断），便于定位 |

### 上下文溢出：为什么只回 1 个 token

上游对「输入 + `max_tokens` 超过模型窗口」的请求**不报错**，而是立刻结束，
`finish_reason` 标成 `length`，正文只有 1 个 token 甚至为空。
DSH 把 `length` 显示成「已达到输出 token 上限」，于是看起来像输出被截断，
实际是**输入把窗口塞满了**。此时反复点「继续」不会有进展，调大「最大输出 Token」也没用——
该动的是「上下文窗口」或新建会话。

### 压缩摘要请求不受窗口限制

DSH 自动压缩的做法是把「要被压缩的那段历史」原样回放给模型写摘要，
所以摘要请求的体积几乎等于整个上下文。这道窗口检查若也作用于摘要请求，会让压缩本身无法完成：

| 上下文状态 | 若被拦截的后果 |
| --- | --- |
| 输入已塞满窗口 | 压缩失败并抛回原始错误，该会话此后**永远无法被压缩** |
| 输入只剩少量余量 | 摘要写到一半被输出上限截断，报 incomplete checkpoint |

因此 `purpose` 为 `compaction` 的调用会原样发出，由上游按真实容量裁决。

## 常见问题

| 问题 | 处理方法 |
| --- | --- |
| 找不到 WorkBuddy 提供方或设置入口 | 确认安装到正在使用的 Profile，完整重启 DSH 后再查看 |
| 插件页点「更新」没反应 | 该按钮只对官方按需插件生效，第三方插件不生成 `installTarget`，点了会静默返回。属 DSH 设计。改用 `node cli.js install` 或 `dsh plugin --profile desktop add github:wangwei2k99/dsh-wb` |
| 更新后仍是旧版本或旧界面 | 重新执行对应 Profile 的更新命令，完整退出并重新打开 DSH |
| API Key 下拉列表没有新 Key | 在插件自己的"新增 API Key"区域提交，点击"添加并使用" |
| 登录成功但调用使用了其他账号 | 检查是否启用了会话级凭据，并核对当前会话的绑定 |
| 获取模型失败或找不到模型 | 核对账号或 Key，重新获取目录；手动添加时检查模型 ID 和账号权限 |
| 返回 `401 / 403` | 检查 Key 是否有效、账号是否过期，以及是否有目标模型权限；必要时重新登录 |
| 返回 `400 / 11128` | 更新到最新版本并完整重启；仍失败时记录业务码、插件版本和模型后反馈 |
| 返回 `400 / 11158` | 账号类型无权使用该模型。换 Key 无效，改选其它模型或联系管理员开通权限 |
| 返回 `429 / 14003` | 账号级限流。DSH 已自动重试 5 次（500ms 起、上限 10s），全部失败说明限流窗口未过。等几十秒再试；减少并发会话更容易避免 |
| 返回 `500`、空响应或长时间无结果 | 更新并重启，检查网络；使用包装模型时也检查相应服务状态 |
| 每轮提示「已达到输出 token 上限」且正文为空 | 会话体积已超出模型窗口。调大「上下文窗口」或新建会话，调大「最大输出 Token」无效 |
| 报错说「已自动压缩并重试」但只看到失败 | 旧版窗口检查连压缩摘要请求也拦住了，形成死锁。更新并完整重启后不再受限 |
| 不显示积分，或显示"暂不可用" | 确认使用令牌模式；积分服务暂时不可用不一定影响模型调用 |
| 思考档位选项与其他模型不同 | 属正常情况，按该模型显示的可用选项选择 |
| 改了某会话档位，别的会话也变 | 更新到支持会话级档位的版本并完整重启 |
| 会话档位菜单灰掉不可点 | 该位置拿不到 `sessionId`（如后台任务）。档位要绑定到具体会话 |
| 重启后之前设的会话档位没了 | 属正常行为：覆盖值只在宿主内存中，不落盘 |
| ModLens 模型慢、超时或返回 `429` | 检查 ModLens 视觉引擎的登录、网络和额度；纯文本任务可切回 WorkBuddy 直连验证 |

查看安装版本：

```powershell
dsh plugin --profile desktop list --depth 0
```

Web 用户将 `desktop` 改为 `web`。ModLens 用户也可运行 `modlens doctor --json`。

反馈问题时，请提供插件版本、DSH 版本、模型名称、认证方式和脱敏后的错误信息。
**不要公开 API Key、登录令牌或未经脱敏的完整日志。**

## 技术说明

### 为什么不用 DSH 原生登录通道

DSH 通过 authorization seam 提供原生 OAuth 登录：provider 登录后凭据存入 harness
credential store 的 `llm-pi-ai/<provider id>` 记录，由宿主负责刷新。**本插件没有走这条路：**

- pi-ai 的 provider catalog 里**没有 WorkBuddy**，原生通道只对 catalog 内且自带 login 的 provider 生效。
- 该通道要求 provider id 符合记录语法（小写连字符标识符），否则以 `UNSTORABLE_PROVIDER_ID` 拒绝。
- WorkBuddy 的登录是「浏览器 OAuth + `state` 轮询」的私有流程，与 pi-ai 的 login 契约不匹配。

因此本插件自行实现登录（`workbuddy-auth.js`），把令牌写入 DSH credentials
（`WORKBUDDY_LOGIN_SESSION` 等引用），而非 `llm-pi-ai/*` 记录。
这样仍满足「凭据由 DSH 托管、不落配置文件」的要求，只是绕过了原生 login 契约。

> 能力边界：登录会话的刷新由本插件负责（`/auth/token/refresh`），不走宿主的跨进程刷新锁。
> 多进程同时刷新同一账号时后写者覆盖先写者，但两者拿到的令牌都有效，不会互相踢下线。

### 三条官方 seam

会话档位走的是 DSH 官方扩展点，不 patch 任何宿主原型：

1. `agent/request` waterfall——替换冻结的调用配置。
2. `prepareCall` 的 `configure` 回调——在模型信息就绪后收紧 `maxTokens`。
3. 冻结调用对象上的 `context.contextWindow` 与 `model.contextWindow`——两者必须同步：
   前者供宿主的 `request/context` 事件、token 计量与压缩阈值使用，后者供适配器判断溢出。

### 附加逻辑不能拖垮主流程

`agent/request` 是 waterfall，处理函数抛错会让整个请求失败；`prepareCall` 是全局替换，
抛错会让所有模型调用失败。档位逻辑整体包了兜底，自身异常时原样放行宿主配置；
但**宿主自身的失败仍原样上抛**，不会被吞成成功。

## 参考资料

插件对 WorkBuddy 上游协议的理解依赖以下外部资料。**上游接口随时可能变化，更新前请先核对这些来源的最新状态。**

| 资料 | 用途 | 注意 |
| --- | --- | --- |
| [workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | 第三方协议逆向参考：出站身份头族、接口路径、请求体处理、模型目录、积分与限流 | ⚠️ 上游自 2026-10-23 起收紧非官方客户端识别；该项目已转为低频维护 |
| [WorkBuddy 官方文档](https://www.workbuddy.cn/docs/workbuddy/) | 产品能力、上下文档位、模型清单等官方口径 | 面向官方客户端，不含 API 细节 |
| [Kimi Code 模型配置](https://www.kimi.com/code/docs/kimi-code/models.html) | Kimi 模型的上下文窗口与思考档位映射 | 官方规格 |
| [DeepSeek 官方公告](https://www.deepseek.com/en/news/) | DeepSeek 模型规格与版本变更 | 官方口径 |

使用 `workbuddy2api-hub` 的边界：

- 它是**独立项目**，与本插件无代码依赖；参考其协议结论，不要直接搬代码。
- 该项目声明「仅用于协议学习、研究与个人自用」，并提示上游可能进一步收紧。
- 其中的身份版本号（如桌面端 `5.8.3`、内置 CLI `2.161.0`）来自特定时点抓包，上游升级后需重新核对。

本插件自身的实测数据（上下文上限、身份头族连通性、档位建议）记录在
[模型上下文档位实测与建议](docs/模型上下文档位实测与建议.md)。

## 开发与测试

| 层次 | 命令 | 依赖真实上游 |
| --- | --- | --- |
| 语法 + 单元 + 链路 | `npm run check` | 否 |
| 端到端 | `npm run e2e` | **是** |
| 全部 | `npm test` | 是 |

`npm run check` 由三段组成，全部基于自建 mock，不联网、不花钱，适合每次改代码就跑：

- `test.js`：71 项单测，覆盖协议适配、错误码翻译、认证、积分、客户端 bundle。
- `session-tiers.live.test.mjs`：20 项真实链路测试，用最小宿主替身真正装上
  `installSessionTiers`，区分「拦截装上了」和「拦截真的改变了窗口」。
- `session-tiers.test.mjs`：纯逻辑断言（窗口收敛、输出预算、id 归一）。

### 为什么还要端到端测试

mock 覆盖再多也替代不了真链路。曾经有一个让**整个插件不激活**的崩溃：
cordis 对未在 `inject` 中声明的服务，属性访问是**直接抛错**而非返回 `undefined`，
而当时所有 mock 测试全部通过——因为 mock 里 `ctx` 是普通对象，怎么读都不抛。

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
