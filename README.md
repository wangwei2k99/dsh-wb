# DSH WorkBuddy Provider

在 DeepSeek Harness（DSH）桌面端和 WebUI 中使用 WorkBuddy 中国区模型，支持 API Key 和账号登录。

> 本插件是第三方适配工具，不属于 WorkBuddy 或 DSH 官方项目。使用前需准备有效账号或 API Key。

## 功能

| 功能 | 说明 |
| --- | --- |
| 两种认证方式 | 支持 API Key、浏览器账号登录，可随时切换 |
| 多凭据管理 | 添加、切换和删除多个 API Key 或登录账号 |
| 会话独立选择 | 可为不同会话分别指定账号或 API Key |
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
@wangwei2k99/dsh-workbuddy
```

也可以在终端执行，更新时使用同一条命令：

```powershell
dsh plugin --profile desktop add @wangwei2k99/dsh-workbuddy@latest
```

### Web / Headless

一键安装或更新这两个 Profile：

```powershell
npx --yes @wangwei2k99/dsh-workbuddy@latest install
```

仅安装 Web Profile：

```powershell
dsh plugin --profile web add @wangwei2k99/dsh-workbuddy@latest
```

**安装或更新后，完整退出并重新启动 DSH。** 只刷新页面不会完成更新。
更新可保留已有模型、账号和 Key 配置。

> **从旧包名升级**：包名已由 `@axiaohungry/dsh-llm-workbuddy` 改为
> `@wangwei2k99/dsh-workbuddy`（npm 不允许非 scoped 包名带 `/`，所以要带 `@`）。
> 先移除旧包再安装新包，两者不要并存：
>
> ```powershell
> dsh plugin --profile desktop remove @axiaohungry/dsh-llm-workbuddy
> dsh plugin --profile desktop add @wangwei2k99/dsh-workbuddy@latest
> ```
>
> `npx … install` 会自动清理旧包名。

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
可按需修改模型名称、上下文窗口、最大输出 Token 和思考档位。

「上下文窗口」按该模型的上游上限分三档（上限的 1/5、1/2、上限，例如 1M 的模型是
200K / 500K / 1M）；「最大输出 Token」同样三档（上限的 1/4、1/2、上限，例如
128K 的模型是 32K / 64K / 128K）。上限来自
`GET /v3/config` 的 `maxInputTokens` / `maxOutputTokens`，改模型或换账号后重新
「获取模型」即可刷新。

更换账号或 Key 后，建议重新获取可用模型。手动添加模型时，请确认模型 ID 和账号权限。
“恢复在线目录”会取消手工覆盖的模型列表。

档位取值的实测与推荐见
[模型上下文档位实测与建议](docs/模型上下文档位实测与建议.md)。

### 4. 可选：为会话单独选择凭据

打开“会话级账号/API Key”开关后，可在新会话或输入框附近选择凭据。

- 未绑定会话首次调用时，使用当前默认选择。
- 已绑定会话继续使用自己的选择，不随全局默认值变化。
- 可单独切换或解除当前会话绑定。
- 关闭开关后使用全局选择；重新开启后恢复已有绑定。

账号模型权限不同时，还需选择该账号可用的模型。

## 近期解决的问题

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
| 不显示积分，或显示“暂不可用” | 确认使用令牌模式；积分服务暂时不可用不一定影响模型调用 |
| 思考档位选项与其他模型不同 | 属于正常情况，按该模型显示的可用选项选择 |
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

## 卸载

桌面 Profile：

```powershell
dsh plugin --profile desktop remove @wangwei2k99/dsh-workbuddy
```

Web / Headless 安装器：

```powershell
npx --yes @wangwei2k99/dsh-workbuddy@latest uninstall
```

卸载后重启 DSH。安装器默认保留凭据，便于后续重新安装。

## License

[MIT](./LICENSE)
