import { AsyncLocalStorage } from "node:async_hooks";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { LlmError, assertUsableApiKey, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { Config, PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import * as dshSettings from "@deepseek-ai/dsh-settings";
import { createProvider, normalizeContext } from "@earendil-works/pi-ai";
import * as openAICompletionsApi from "@earendil-works/pi-ai/api/openai-completions";
import * as openAIResponsesApi from "@earendil-works/pi-ai/api/openai-responses";
import * as anthropicMessagesApi from "@earendil-works/pi-ai/api/anthropic-messages";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  codeBuddyHeaders,
  conversationHeaders,
  IDENTITY_CLI,
  IDENTITY_WORKBUDDY,
  normalizeIdentity,
  workBuddyIdentityHeaders,
  WORKBUDDY_SESSION_REF,
  WORKBUDDY_SESSIONS_REF,
  WORKBUDDY_SESSION_ROUTING_REF,
  LEGACY_SESSION_REF,
  LEGACY_SESSIONS_REF,
  activeWorkBuddySession,
  createWorkBuddySessionStore,
  createWorkBuddySessionRoutingState,
  parseWorkBuddySession,
  parseWorkBuddySessions,
  parseWorkBuddySessionRouting,
  refreshWorkBuddySession,
  serializeWorkBuddySession,
  serializeWorkBuddySessionRouting,
  serializeWorkBuddySessions,
  sessionCacheDeadline,
  sessionNeedsRefresh,
  upsertWorkBuddySession,
} from "./workbuddy-auth.js";
import { installWorkBuddyWeb } from "./workbuddy-web.js";
import { probeEndpoint } from "./workbuddy-discovery.js";
import { installSessionTiers } from "./session-tiers.js";

export { Config };

export const name = "dsh-workbuddy";
// 只硬依赖 llm：它是本插件的核心（注册 provider）。
// agents 不是必需的 —— 会话级档位靠它拿 sessionId，拿不到就不启用档位，
// 但模型接入必须照常工作。写进 inject 会让整个插件在缺该服务时变 INACTIVE。
export const inject = ["llm"];

const NS = typeof dshSettings.settingsNamespace === "function" ? dshSettings.settingsNamespace("llm-pi-ai") : "llm-pi-ai";
const PROVIDER = "workbuddy-cn";
const LEGACY_PROVIDER = "codebuddy-cn";
const WORKBUDDY_PROVIDERS = new Set([PROVIDER, LEGACY_PROVIDER]);
const WORKBUDDY_PROVIDER_PATTERN = /(?:^|-)(?:work-?buddy|code-?buddy)(?:-|$)/;
const DISPLAY_NAME = "WorkBuddy 中国区";
const API_KEY_ENV = "WORKBUDDY_API_KEY";
const LEGACY_API_KEY_ENV = "CODEBUDDY_API_KEY";
const BASE_URL = "https://copilot.tencent.com/v2";
const CONFIG_URL = "https://copilot.tencent.com/v3/config";
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const traceContext = new AsyncLocalStorage();
let nextTraceId = 0;
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVELS = ["off", ...EFFORTS];
const COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens",
  thinkingFormat: "openai",
};
const IDENTITY_SENTENCE_RE = /\bYou are an?(?:\s+AI)?(?:\s+coding)?\s+(?:agent\s+powered by|assistant\s+built on)[^\r\n]*?(?:\.(?=\s|$)|(?=\r?\n|$))/gi;
// codebuddy2api 的渠道改写：外来身份句整句换成这句，句前标记和句后指令保留。
// 删掉身份句再补 "You are a helpful assistant." 仍会被判成非官方渠道。
const CODEBUDDY_CLI_SENTENCE = "You are CodeBuddy, Tencent's official CLI.";
const CLAUDE_CODE_SENTENCE_RE = /You are Claude Code, Anthropic's official CLI for Claude\./gi;
const CLAUDE_CODE_LINE_RE = /^[ \t]*You are Claude Code\b[^\r\n]*/gim;
const PRS_BRANCH_FROM = "main branch (you will usually use this for prs)";
const PRS_BRANCH_TO = "main branch (you will usually use this for pr)";
const AT_PATH_FROM = "Tokens prefixed with @ are paths";
const AT_PATH_TO = "An @ prefix marks paths";

function requestBodyText(body) {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return undefined;
}

function rewriteChannelIdentity(text) {
  return text
    .replace(IDENTITY_SENTENCE_RE, CODEBUDDY_CLI_SENTENCE)
    .replace(CLAUDE_CODE_SENTENCE_RE, CODEBUDDY_CLI_SENTENCE)
    .replace(CLAUDE_CODE_LINE_RE, CODEBUDDY_CLI_SENTENCE)
    .replaceAll(AT_PATH_FROM, AT_PATH_TO);
}

function sanitizeWorkBuddyRequest(init, identity = IDENTITY_CLI) {
  const rawBody = requestBodyText(init?.body);
  if (rawBody === undefined) return init;
  let body;
  try { body = JSON.parse(rawBody); } catch { return init; }
  if (!Array.isArray(body?.messages)) return init;
  // 自称跟随出站身份：令牌登录模拟 WorkBuddy 桌面端，API Key 模式沿用 CodeBuddy。
  const productName = normalizeIdentity(identity) === IDENTITY_WORKBUDDY ? "WorkBuddy" : "CodeBuddy";
  // 改写系统提示里的宿主品牌，避免把 DSH 标识发给上游。
  //   1. 外来身份句整句换成 CodeBuddy CLI 身份句（对齐 codebuddy2api）
  //   2. "DeepSeek Harness" 全称改成当前出站身份
  //   3. 独立大写缩写 "DSH"
  // 第 3 条用负向断言排除功能性标识：dsh-xxx / dsh_xxx / @deepseek-ai/dsh-* /
  // 路径 .dsh/ / 环境变量 DSH_XXX / 命令行 dsh。这些必须原样保留，
  // 否则模型会拼错包名、路径或命令。
  const rewrite = (text) => {
    const rewritten = rewriteChannelIdentity(text)
      .replaceAll(PRS_BRANCH_FROM, PRS_BRANCH_TO)
      .replace(/^You are interacting with the user through the /gim, "The user is interacting through the ")
      .replace(/\bDeepSeek[ -]Harness\b/gi, productName)
      .replace(/\bDSH\b(?![-_A-Za-z0-9])/g, productName);
    if (rewritten === text) return text;
    return rewritten.trim() || CODEBUDDY_CLI_SENTENCE;
  };
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!["system", "developer", "assistant"].includes(message?.role)) return message;
    const rewriteContent = message.role === "assistant" ? rewriteChannelIdentity : rewrite;
    const role = message.role === "developer" ? "system" : message.role;
    let content = message.content;
    if (typeof content === "string") content = rewriteContent(content);
    else if (Array.isArray(content)) {
      const parts = content.map((part) => {
        if (typeof part?.text !== "string") return part;
        const text = rewriteContent(part.text);
        return text === part.text ? part : { ...part, text };
      });
      if (parts.some((part, index) => part !== content[index])) content = parts;
    }
    if (content === message.content && role === message.role) return message;
    changed = true;
    return { ...message, role, content };
  });
  return changed ? { ...init, body: JSON.stringify({ ...body, messages }) } : init;
}

/**
 * DSH 的「上下文溢出」分类由适配器负责（`agent/request-error` 监听器只在收到
 * `CONTEXT_WINDOW_EXCEEDED` 时才做头部裁剪并重试）。它判定溢出靠的是**英文措辞**
 * （`context_length_exceeded` / `context window` / `prompt too long` …），
 * 中文说明它一律不认。所以凡是上下文超限，错误文本里必须带上这个标记，
 * 否则自动压缩永远不触发，用户只能自己删会话。
 */
const CONTEXT_OVERFLOW_CODE = "CONTEXT_WINDOW_EXCEEDED";
const CONTEXT_OVERFLOW_MARKER = "context_length_exceeded";
/**
 * 单次响应至少要留出的输出预算。上游对「prompt + max_tokens > 窗口」的请求
 * **不会报错**，而是只回 1 个 token 并把 finish_reason 标成 `length`——
 * DSH 会显示成「已达到输出 token 上限」，用户反复点继续也拿不到正文。
 * 所以低于这个预算的请求没有意义，直接判为上下文溢出、交给 DSH 压缩。
 */
const MIN_OUTPUT_TOKENS = 1024;
/** 图片按固定预算估算：上游按视觉 token 计费，这里只求量级正确。 */
const IMAGE_TOKEN_ESTIMATE = 1600;
/** 「静默超窗」的正文长度上限：超过它就属于正常的上限截断，不能再改判成溢出。 */
const SILENT_OVERFLOW_MAX_TEXT = 8;
/**
 * DSH 自动压缩时给摘要调用打的用途标记（`compaction-basic` 的 `summarizeWithLlm`
 * 固定传 `purpose: "compaction"`，`dsh-llm` 的 `adapterStream` 会把它原样带到
 * 适配器 options 上）。压缩请求是「自救」性质的，不能按普通请求的窗口规则拦。
 */
const COMPACTION_PURPOSE = "compaction";

/** 按字符估算 token：CJK 约 1 字 1 token，其余约 4 字符 1 token。 */
function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let wide = 0;
  let narrow = 0;
  // 用码元遍历（charCodeAt）代替 for-of：for-of 每字符都要走迭代器协议
  // 并按 code point 解码，长上下文下开销明显；这里只在遇到代理对时
  // 额外跳过一个码元，语义与原实现一致。
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0x2e80) {
      wide += 1;
      // 高位代理：与紧随的低位代理同属一个 code point，一并跳过。
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      }
    } else {
      narrow += 1;
    }
  }
  return wide + Math.ceil(narrow / 4);
}

/**
 * 估算一次请求的输入体积（system 提示、历史消息、工具调用参数都算在内）。
 *
 * 只用于「是否放得下」的量级判断，不追求精确：ASCII 按 4 字符 1 token，
 * CJK 按 1 字 1 token（略偏保守，留出余量）。真正的兜底是 `silentContextOverflow`
 * ——即使这里低估了，上游回「1 个 token + length」时仍会被改判成溢出。
 */
function estimateContextTokens(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  let total = 0;
  for (const message of messages) {
    // 每条消息的 role / 分隔符等固定开销。
    total += 4;
    const content = message?.content;
    if (typeof content === "string") {
      total += estimateTextTokens(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text": total += estimateTextTokens(block.text); break;
        case "thinking": total += estimateTextTokens(block.thinking); break;
        case "image": total += IMAGE_TOKEN_ESTIMATE; break;
        case "toolCall": total += estimateTextTokens(block.name)
          + estimateTextTokens(JSON.stringify(block.arguments ?? {})); break;
        default: break;
      }
    }
  }
  return total;
}

function contextOverflowError(estimated, window) {
  return new LlmError(
    `WorkBuddy 上下文已超出模型窗口（${CONTEXT_OVERFLOW_MARKER}）：本轮输入约 ${estimated} token，`
    + `模型窗口 ${window} token，已没有输出空间。请调大「上下文窗口」或新建会话；`
    + `DSH 收到该错误后会自动压缩上下文并重试。`,
    CONTEXT_OVERFLOW_CODE,
  );
}

/**
 * 发请求前把「输入体积 + 最大输出」收敛到模型窗口内。
 *
 * 输入本身已经塞满窗口时直接抛溢出错误（交给 DSH 自动压缩），
 * 还有空间但放不下完整 maxTokens 时按剩余空间收敛，避免上游只回 1 个 token。
 *
 * 唯一的例外是压缩摘要请求（`purpose === "compaction"`）。DSH 自动压缩要先把
 * 「被压缩的那段历史」原样回放给模型写摘要，所以摘要请求的体积约等于整个上下文，
 * 而它预留的输出是 `compaction-basic.maxTokens`（默认 65536）。旧逻辑对摘要请求
 * 也照常收敛/拦截，于是产生两类失败，实测会话日志里 7 次压缩失败全部命中：
 *
 *   1. 输入已塞满窗口 → 抛 CONTEXT_WINDOW_EXCEEDED → 压缩失败并抛回原始错误，
 *      该会话此后永远无法被压缩（日志 turn 78、turn 111）；
 *   2. 还有一点余量 → 把 maxTokens 削到「窗口 - 输入」这个残余值，摘要写到一半
 *      就被输出上限截断，`compaction-basic` 报 incomplete checkpoint
 *      （日志 turn 71-75，30 万窗口下 maxTokens 被削到 4996）。
 *
 * 因此压缩请求完全不受这道检查约束，原样发出，由上游按真实容量裁决。
 */
/**
 * 会话档位读取器。由 `installSessionTiers` 装上之后写入。
 * 只按显式 sessionId 查，避免并发请求落到「当前焦点会话」。
 */
let sessionTierWindow = (_sessionId) => undefined;

function sessionContextWindow(model, sessionId) {
  const modelWindow = positiveInteger(model?.contextWindow);
  const requested = positiveInteger(sessionTierWindow(sessionId));
  return requested ?? modelWindow;
}

function boundContextBudget(model, context, options) {
  if (options?.purpose === COMPACTION_PURPOSE) return options;
  const window = positiveInteger(model?.contextWindow);
  if (!window) return options;
  const estimated = estimateContextTokens(context);
  const requested = positiveInteger(options?.maxTokens, model?.maxTokens) ?? MIN_OUTPUT_TOKENS;
  if (estimated + MIN_OUTPUT_TOKENS <= window) {
    const room = window - estimated;
    return requested > room ? { ...options, maxTokens: room } : options;
  }
  throw contextOverflowError(estimated, window);
}

/**
 * 上游在没有输出预算时不会报错，而是回 1 个 token + `finish_reason: length`。
 * 这种响应 DSH 只会显示「已达到输出 token 上限」，永远不会自愈——改判成上下文
 * 溢出，触发 DSH 的自动压缩重试。
 *
 * 判据要求「几乎没正文」：真正写完一大段后被上限截断也是 `length`，不能误判，
 * 因此除了 token 数还要看正文长度（上游偶尔不上报 usage，这条是兜底）。
 */
function silentContextOverflow(message, options) {
  if (message?.stopReason !== "length") return false;
  const output = Number(message?.usage?.output ?? 0);
  const requested = Number(options?.maxTokens ?? 0);
  let textLength = 0;
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === "text" && typeof block.text === "string") textLength += block.text.length;
  }
  return Number.isFinite(output) && output <= 1 && requested >= MIN_OUTPUT_TOKENS
    && textLength <= SILENT_OVERFLOW_MAX_TEXT;
}

async function normalizeWorkBuddyError(response, trace, detail = "") {
  if (response.ok || !response.body) return response;
  const reader = response.clone().body.getReader();
  try {
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        // 超限说明不是我们要识别的短 JSON 错误体，直接放弃；
        // reader 的释放统一由下方 finally 负责。
        return response;
      }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const code = String(data?.code ?? data?.error?.code ?? "");
    if (!/^\d{1,9}(?:-\d{1,9})?$/.test(code)) return response;
    // `11128` 是重载错误码，必须按 message 分支，否则会误诊：
    //   msg 含 "conversation id missing" / "request illegal"
    //        -> 渠道校验：缺少会话头族（X-Conversation-* 三件套缺一不可）
    //   msg 含 "unapproved channel"
    //        -> 提示词命中渠道名单。命中点可以不在第一行，与会话头无关
    //   msg 含 "first message is not system prompt"
    //        -> 请求体形状问题，与身份无关
    const upstreamMsg = String(data?.msg ?? data?.message ?? data?.error?.message ?? "");
    const msgLower = upstreamMsg.toLowerCase();
    const channelFailure = /conversation id missing|request illegal/.test(msgLower);
    const promptOpeningFailure = /unapproved channel|illegal api invocation/.test(msgLower);
    const bodyShapeFailure = /first message is not system prompt/.test(msgLower);

    // 不同业务码的处置方式完全不同，混成一句"请求失败"会误导用户：
    //   11140 —— 账号级限制（"账号存在异常行为，已被限制使用"），
    //            重新登录或换 Key 都无效，只能等上游解除
    //   11115 —— 上下文超限，与凭据无关
    //   11101 —— 请求形态不合法（如非流式）
    const overflowHint = `：上下文已超出模型窗口（${CONTEXT_OVERFLOW_MARKER}）。DSH 会自动压缩上下文后重试；反复出现请调大「上下文窗口」或新建会话。`;
    const hints = {
      11140: "：账号已被上游限制使用。这不是登录失效，重新登录或更换 Key 都无法恢复，需等上游解除限制或联系官方支持。",
      11115: overflowHint,
      11101: "：请求形态不被接受（该接口要求流式请求）。",
    };
    let hint = hints[code] ?? "";
    if (code === "11128" || code === "11-128") {
      hint = channelFailure
        ? "：渠道校验未通过（缺少会话标识头族）。请确认插件版本已包含 X-Conversation-* 三件套。"
        : promptOpeningFailure
          ? `：提示词命中上游渠道名单（不一定在第一行）。这与会话头无关。${detail}`
          : bodyShapeFailure
            ? "：请求体首条消息必须是 system 提示。"
            : "：上游拒绝该请求，请查看业务提示。";
    }
    // 其它业务码也可能是上下文超限（上游换措辞时不留死角），按 msg 兜底识别。
    if (!hint && /context[\s_-]*(?:length|window)|prompt\s+(?:is\s+)?too\s+(?:long|large)|maximum\s+context/i.test(upstreamMsg)) {
      hint = overflowHint;
    }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json");
    traceEvent(trace, "http.error-code", { status: response.status, upstreamCode: code });
    // The SDK expects error.message; WorkBuddy's top-level code/msg otherwise becomes "no body".
    return new Response(JSON.stringify({ error: { code, message: `WorkBuddy 请求失败（HTTP ${response.status}，业务码 ${code}）${hint}` } }), {
      status: response.status, statusText: response.statusText, headers,
    });
  } catch {
    return response;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function systemOpeningDetail(body) {
  const text = requestBodyText(body);
  if (!text) return "";
  let parsed;
  try { parsed = JSON.parse(text); } catch { return ""; }
  if (!Array.isArray(parsed?.messages)) return "";
  const lines = [];
  for (const message of parsed.messages) {
    if (message?.role !== "system" && message?.role !== "developer") continue;
    const content = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => part?.text).filter((part) => typeof part === "string").join("\n")
        : "";
    const line = content.trim().split("\n", 1)[0].slice(0, 80);
    if (line) lines.push(line);
    if (lines.length >= 2) break;
  }
  return lines.length ? ` 发出的开头：${lines.join(" | ")}` : "";
}

function chatIdentityHeaders(trace, existing) {
  const headerOptions = {
    userId: trace?.workBuddyUserId,
    conversationKey: trace?.sessionId,
  };
  // 身份在 resolveApiKey 之后才写进上下文。发请求时再读，
  // 避免选项创建时还是 CLI、令牌身份的会话头因此整组丢失。
  const identity = trace?.identity ?? IDENTITY_CLI;
  const generated = identity === IDENTITY_WORKBUDDY
    ? workBuddyIdentityHeaders(headerOptions)
    : conversationHeaders(headerOptions);
  return { identity, identityHeaders: adoptConversationHeaders(generated, existing) };
}

function adoptConversationHeaders(generated, existing) {
  const present = existing ? new Headers(existing) : undefined;
  if (!present) return generated;
  const out = { ...generated };
  const keep = (key) => {
    const value = present.get(key);
    if (value) out[key] = value;
  };
  keep("x-conversation-id");
  const turn = present.get("x-conversation-request-id") || present.get("x-root-request-id");
  if (turn) {
    out["x-conversation-request-id"] = present.get("x-conversation-request-id") || turn;
    out["x-root-request-id"] = present.get("x-root-request-id") || turn;
  }
  const message = present.get("x-conversation-message-id") || present.get("x-request-id");
  if (message) {
    out["x-conversation-message-id"] = present.get("x-conversation-message-id") || message;
    out["x-request-id"] = present.get("x-request-id") || message;
  }
  for (const key of Object.keys(generated)) keep(key);
  return out;
}

function workBuddyRequestOptions(options) {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const initial = chatIdentityHeaders(traceContext.getStore());
  const baseHeaders = codeBuddyHeaders(options?.headers, initial.identity, { identityHeaders: initial.identityHeaders });
  return {
    ...options,
    timeoutMs: options?.timeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
    headers: baseHeaders,
    fetch: async (input, init) => {
      const trace = traceContext.getStore();
      const started = Date.now();
      traceEvent(trace, "http.start");
      try {
        const identity = trace?.identity ?? IDENTITY_CLI;
        const prepared = sanitizeWorkBuddyRequest(init, identity);
        const callerHeaders = prepared?.headers === undefined ? options?.headers : prepared.headers;
        const { identityHeaders } = chatIdentityHeaders(trace, callerHeaders);
        const merged = codeBuddyHeaders(callerHeaders, identity, { identityHeaders });
        const response = await fetchImpl(input, { ...prepared, headers: merged });
        traceEvent(trace, "http.headers", { elapsedMs: Date.now() - started, status: response.status });
        return await normalizeWorkBuddyError(response, trace, response.ok ? "" : systemOpeningDetail(prepared?.body));
      } catch (error) {
        traceEvent(trace, "http.error", { elapsedMs: Date.now() - started, ...errorFields(error) });
        throw error;
      }
    },
  };
}

function errorFields(error) {
  const safe = (value) => typeof value === "string" && /^[A-Za-z_][A-Za-z_0-9-]{0,39}$/.test(value) ? value : undefined;
  return {
    ...(safe(error?.name) ? { errorName: safe(error.name) } : {}),
    ...(safe(error?.code) ? { errorCode: safe(error.code) } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  };
}

function traceEvent(trace, stage, details = {}) {
  if (!trace) return;
  console.info("[dsh-workbuddy]", JSON.stringify({ request: trace.id, stage, ...details }));
}

/**
 * 统一包装上游事件流：补 trace，并把「只回 1 个 token 的 length」改判成上下文溢出。
 * `stream` 与 `streamSimple` 两条入口都必须经过这里——DSH 的适配器走哪条取决于版本。
 */
function watchWorkBuddyStream({ model, normalized, bounded, stream, trace }) {
  const started = Date.now();
  return (async function* () {
    traceEvent(trace, "model.start");
    let first = true;
    let completed = false;
    let failed = false;
    try {
      for await (const chunk of stream) {
        if (chunk?.type === "done" && silentContextOverflow(chunk.message, bounded)) {
          const estimated = estimateContextTokens(normalized);
          traceEvent(trace, "model.context-overflow", { estimated, contextWindow: model?.contextWindow });
          throw contextOverflowError(estimated, model?.contextWindow);
        }
        if (first) {
          first = false;
          traceEvent(trace, "model.first-chunk", { elapsedMs: Date.now() - started });
        }
        yield chunk;
      }
      completed = true;
      traceEvent(trace, "model.done", { elapsedMs: Date.now() - started });
    } catch (error) {
      failed = true;
      traceEvent(trace, "model.error", { elapsedMs: Date.now() - started, ...errorFields(error) });
      throw error;
    } finally {
      if (!completed && !failed) traceEvent(trace, "model.cancelled", { elapsedMs: Date.now() - started });
    }
  })();
}

function workBuddyStream(model, context, options, open) {
  const trace = traceContext.getStore();
  const normalized = normalizeContext(context);
  // 压缩阈值和溢出判定都用本会话的窗口。从高档切到低档时，
  // 目录里的模型窗口仍是高档，不换这条就会一直认为还放得下。
  const sessionWindow = sessionContextWindow(model, options?.sessionId);
  const budgetModel = sessionWindow === model?.contextWindow ? model : { ...model, contextWindow: sessionWindow };
  const bounded = boundContextBudget(budgetModel, normalized, options);
  const stream = open(model, normalized, workBuddyRequestOptions(bounded));
  return watchWorkBuddyStream({ model: budgetModel, normalized, bounded, stream, trace });
}

function observedWorkBuddyStream(model, context, options) {
  return workBuddyStream(model, context, options, openAICompletionsApi.streamSimple);
}

const workBuddyApi = {
  ...openAICompletionsApi,
  stream: (model, context, options) => workBuddyStream(model, context, options, openAICompletionsApi.stream),
  streamSimple: observedWorkBuddyStream,
};

const FALLBACK_MODELS = [
  ["hy3", "Hy3", 192000, 64000, true],
  ["glm-5.2", "GLM-5.2", 1000000, 48000, false],
  ["glm-5.1", "GLM-5.1", 200000, 48000, false],
  ["glm-5v-turbo", "GLM-5v-Turbo", 200000, 64000, true],
  ["minimax-m3-pay", "MiniMax-M3", 512000, 128000, true],
  ["minimax-m2.7", "MiniMax-M2.7", 200000, 48000, true],
  ["kimi-k3-2", "Kimi-K3", 1000000, 32000, true],
  ["kimi-k2.7", "Kimi-K2.7-Code", 256000, 32000, true],
  ["kimi-k2.6", "Kimi-K2.6", 256000, 32000, true],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", 1000000, 50000, true],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", 1000000, 50000, true],
].map(([id, modelName, contextWindow, maxTokens, images]) =>
  workBuddyModel({ id, name: modelName, contextWindow, maxTokens, images }),
);

function workBuddyModel({ provider = PROVIDER, id, name: modelName, contextWindow, maxTokens, images, reasoning = true, thinkingLevelMap = { off: null }, defaultReasoningEffort, thinkingFormat }) {
  return {
    id,
    name: modelName,
    api: "openai-completions",
    provider,
    baseUrl: BASE_URL,
    reasoning,
    ...(reasoning ? { thinkingLevelMap: { ...thinkingLevelMap } } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    input: images ? ["text", "image"] : ["text"],
    cost: { ...NO_COST },
    contextWindow,
    maxTokens,
    compat: { ...COMPAT, ...(thinkingFormat ? { thinkingFormat } : {}) },
  };
}

function remoteReasoning(raw, fallback) {
  const reasoning = raw.supportsReasoning ?? fallback?.reasoning ?? raw.onlyReasoning === true;
  if (!reasoning) return { reasoning: false };
  const declared = raw.thinkingLevelMap && typeof raw.thinkingLevelMap === "object" ? raw.thinkingLevelMap : undefined;
  const thinkingLevelMap = declared
    ? Object.fromEntries(THINKING_LEVELS.map((level) => [level,
        Object.hasOwn(declared, level) && (typeof declared[level] === "string" || declared[level] === null) ? declared[level] : null]))
    : { ...(fallback?.thinkingLevelMap ?? {}), ...(raw.onlyReasoning === true ? { off: null } : {}) };
  const effort = raw.reasoning?.effort;
  const defaultReasoningEffort = EFFORTS.includes(effort) && thinkingLevelMap[effort] !== null ? effort : undefined;
  return {
    reasoning: true,
    thinkingLevelMap,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(typeof raw.thinkingFormat === "string" ? { thinkingFormat: raw.thinkingFormat } : {}),
  };
}

function configuredReasoning(entry, base) {
  if (entry.reasoningEfforts === false) return { reasoning: false };
  if (!entry.reasoningEfforts || typeof entry.reasoningEfforts !== "object") {
    return base ? {
      reasoning: base.reasoning,
      thinkingLevelMap: base.thinkingLevelMap,
      defaultReasoningEffort: base.defaultReasoningEffort,
      thinkingFormat: base.compat?.thinkingFormat,
    } : { reasoning: false };
  }
  const map = {};
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(entry.reasoningEfforts, level)) map[level] = null;
    else if (!(level === "off" && entry.reasoningEfforts[level] === null)) map[level] = entry.reasoningEfforts[level];
  }
  return { reasoning: true, thinkingLevelMap: map, thinkingFormat: entry.compat?.thinkingFormat };
}

function positiveInteger(...values) {
  return values.find((value) => Number.isSafeInteger(value) && value > 0);
}

function text(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function modelsFromConfig(data) {
  const agents = Array.isArray(data?.agents) ? data.agents : data?.agent?.agents;
  const cli = Array.isArray(agents) ? agents.find((agent) => agent?.name === "cli") : undefined;
  const allowed = Array.isArray(cli?.models) ? cli.models : [];
  const source = Array.isArray(data?.models) ? data.models : [];
  const byId = new Map(source.map((model) => [model?.id, model]));
  return allowed.flatMap((id) => {
    const raw = byId.get(id);
    if (!raw) return [];
    const fallback = FALLBACK_MODELS.find((model) => model.id === id);
    const contextWindow = positiveInteger(raw.maxInputTokens, raw.maxAllowedSize, fallback?.contextWindow);
    const maxTokens = positiveInteger(raw.maxOutputTokens, fallback?.maxTokens);
    if (!contextWindow || !maxTokens) return [];
    return [workBuddyModel({
      id,
      name: text(raw.name, fallback?.name, id),
      contextWindow,
      maxTokens,
      images: raw.supportsImages === true || fallback?.input.includes("image") === true,
      ...remoteReasoning(raw, fallback),
    })];
  });
}

function authenticationHeaders(credential) {
  const value = assertUsableApiKey(credential.value, name, credential.ref ?? API_KEY_ENV);
  return { authorization: `Bearer ${value}`, ...(credential.kind === "bearer" ? {} : { "x-api-key": value }) };
}

async function fetchWorkBuddyModels(credential, signal) {
  let response;
  try {
    response = await fetch(CONFIG_URL, {
      headers: {
        accept: "application/json",
        ...authenticationHeaders(credential),
        ...codeBuddyHeaders(),
      },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new LlmError("WorkBuddy 模型列表获取已取消", "ABORTED", { cause: error });
    throw new LlmError("无法连接 WorkBuddy 模型配置接口", "DISCOVERY_FAILED", { cause: error });
  }
  if (!response.ok) throw new LlmError(`WorkBuddy 模型配置接口返回 ${response.status}`, "DISCOVERY_FAILED");
  const body = await response.json();
  if (body?.code !== 0) throw new LlmError(`WorkBuddy 模型配置接口错误：${body?.msg ?? body?.code}`, "DISCOVERY_FAILED");
  const models = modelsFromConfig(body.data);
  if (models.length === 0) throw new LlmError("WorkBuddy 没有返回 CLI 可用模型", "DISCOVERY_FAILED");
  return models;
}

/**
 * WorkBuddy's credential is already resolved by the DSH adapter.  Do not
 * reuse pi-ai's DeepSeek envApiKeyAuth here: newer pi-ai releases require a
 * signal argument while older DSH adapters call auth resolvers without one.
 * This small adapter accepts both contracts and keeps bearer/API-key values
 * opaque to the provider implementation.
 */
function workBuddyApiKeyAuth() {
  return {
    name: `${DISPLAY_NAME} API Key`,
    login: async (interaction) => {
      const signal = interaction?.signal;
      signal?.throwIfAborted?.();
      const key = await interaction.prompt({ type: "secret", message: `Enter ${DISPLAY_NAME} API Key` });
      signal?.throwIfAborted?.();
      return { type: "api_key", key };
    },
    resolve: async ({ credential, signal } = {}) => {
      signal?.throwIfAborted?.();
      if (!credential?.key) return undefined;
      return {
        auth: { apiKey: credential.key },
        ...(credential.env ? { env: credential.env } : {}),
        source: "DSH credential",
      };
    },
  };
}

function workBuddyProvider(models, provider = PROVIDER) {
  return createProvider({
    id: provider,
    name: DISPLAY_NAME,
    baseUrl: BASE_URL,
    auth: { apiKey: workBuddyApiKeyAuth() },
    models: models.map((model) => ({ ...model, provider })),
    api: workBuddyApi,
  });
}

const GENERIC_APIS = Object.freeze({
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
});
const GENERIC_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function genericApiKeyAuth(provider) {
  return {
    name: `${provider} API Key`,
    resolve: async ({ credential, signal } = {}) => {
      signal?.throwIfAborted?.();
      if (!credential?.key) return undefined;
      return { auth: { apiKey: credential.key }, source: "DSH credential" };
    },
  };
}

function genericModel(provider, source, entry) {
  const reasoningEfforts = entry.reasoningEfforts;
  const reasoning = reasoningEfforts !== false && reasoningEfforts && typeof reasoningEfforts === "object";
  const thinkingLevelMap = reasoning
    ? Object.fromEntries(GENERIC_LEVELS.filter((level) => Object.hasOwn(reasoningEfforts, level)).map((level) => [level, reasoningEfforts[level]]))
    : undefined;
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    api: source.api,
    provider,
    baseUrl: source.baseURL,
    input: Array.isArray(entry.input) && entry.input.length > 0 ? [...entry.input] : [...source.defaultInput ?? ["text"]],
    cost: { ...NO_COST },
    // 兜底值与设置面板「添加模型」的默认档位保持一致（200K / 32K），
    // 避免同一条模型在不同入口显示成不同窗口。
    contextWindow: entry.contextWindow ?? source.defaultContextWindow ?? 200000,
    maxTokens: entry.maxTokens ?? source.defaultMaxTokens ?? 32000,
    ...(reasoning ? { reasoning: true, thinkingLevelMap } : {}),
    ...(entry.compat ?? source.compat ? { compat: { ...(source.compat ?? {}), ...(entry.compat ?? {}) } } : {}),
  };
}

function genericProvider(provider, source = {}) {
  const api = GENERIC_APIS[source.api];
  if (!api || !source.baseURL || !Array.isArray(source.models) || source.models.length === 0) return undefined;
  return createProvider({
    id: provider,
    name: source.displayName ?? provider,
    baseUrl: source.baseURL,
    headers: source.headers,
    auth: { apiKey: genericApiKeyAuth(provider) },
    models: source.models.map((entry) => genericModel(provider, source, entry)),
    api,
  });
}

function resolvedProfile(provider, source, piProvider, configuredMaxTokens = new Map(), requestContext) {
  const apiKeyEnv = source.apiKeyEnv === undefined ? undefined : credentialRef(source.apiKeyEnv);
  return {
    ...source,
    headers: runtimeHeaders(source.headers, requestContext),
    provider,
    displayName: source.displayName ?? piProvider.name ?? provider,
    // dsh-llm-pi-ai reads this map for every exact model during catalog
    // resolution. WorkBuddy profiles have no per-model validation failures
    // here, but must still provide the empty map for the shared adapter API.
    modelErrors: new Map(),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    streamIdleTimeoutMs: source.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(source.retryPolicy, `${name}: provider "${provider}" retryPolicy`),
    configuredMaxTokens,
    piProvider,
  };
}

function selectBuiltinModels(base, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return base;
  const byId = new Map(base.getModels().map((model) => [model.id, model]));
  const selected = entries.flatMap((entry) => {
    const model = byId.get(entry.id);
    if (!model) return [];
    return [{
      ...model,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
      ...(Array.isArray(entry.input) && entry.input.length ? { input: [...entry.input] } : {}),
    }];
  });
  return { ...base, getModels: () => selected };
}

function selectWorkBuddyModels(base, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return base;
  const byId = new Map(base.map((model) => [model.id, model]));
  return entries.map((entry) => {
    const model = byId.get(entry.id);
    const reasoning = configuredReasoning(entry, model);
    return workBuddyModel({
      id: entry.id,
      name: entry.name ?? model?.name ?? entry.id,
      contextWindow: entry.contextWindow ?? model?.contextWindow ?? 200000,
      maxTokens: entry.maxTokens ?? model?.maxTokens ?? 32000,
      images: entry.input?.includes("image") ?? model?.input.includes("image") ?? false,
      ...reasoning,
    });
  });
}

function ownsProvider(provider, builtins, source) {
  return WORKBUDDY_PROVIDERS.has(provider) || builtins.has(provider) || genericProvider(provider, source) !== undefined;
}

function runtimeHeaders(headers, requestContext) {
  const base = { ...(headers ?? {}) };
  if (!requestContext) return base;
  return new Proxy(base, {
    ownKeys(target) {
      const extra = requestContext.getStore()?.headers ?? {};
      return [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(extra)])];
    },
    getOwnPropertyDescriptor(target, property) {
      const extra = requestContext.getStore()?.headers ?? {};
      if (!Reflect.has(target, property) && !Reflect.has(extra, property)) return undefined;
      return { configurable: true, enumerable: true, writable: true, value: this.get(target, property) };
    },
    get(target, property, receiver) {
      const extra = requestContext.getStore()?.headers ?? {};
      return Reflect.has(extra, property) ? extra[property] : Reflect.get(target, property, receiver);
    },
  });
}

function sessionBindingFor(routing, sessionId) {
  if (!routing?.enabled) return undefined;
  const id = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
  return id && Object.hasOwn(routing.bindings, id) ? routing.bindings[id] : undefined;
}

function normalizedProviderName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isWorkBuddyProviderName(value) {
  const normalized = normalizedProviderName(value);
  return normalized.length > 0 && WORKBUDDY_PROVIDER_PATTERN.test(normalized);
}

function directWorkBuddyProvider(value) {
  const normalized = normalizedProviderName(value);
  if (normalized === PROVIDER || normalized === LEGACY_PROVIDER) return normalized;
  return undefined;
}

function interruptedToolTailAssistantIndex(messages) {
  let tailIndex = messages.length - 1;
  while (tailIndex >= 0 && messages[tailIndex]?.role === "system") tailIndex -= 1;
  if (tailIndex < 0) return -1;
  const tail = messages[tailIndex];
  if (tail?.role !== "user" || !Array.isArray(tail.content)) return -1;
  if (!tail.content.some((block) => block?.type === "tool-result" && block.isError === true)) return -1;
  for (let index = tailIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return Array.isArray(message.content) && message.content.some((block) => block?.type === "tool-call") ? index : -1;
  }
  return -1;
}

/**
 * Make WorkBuddy replay metadata safe across direct and wrapped provider ids.
 * The returned messages are request-only copies; durable session history is
 * never rewritten. An interrupted tool result deliberately loses only the
 * preceding assistant replayState so the model receives ordinary history.
 */
function normalizeWorkBuddyReplay(options) {
  if (!Array.isArray(options?.messages)) return options;
  const currentProvider = options.provider;
  if (!isWorkBuddyProviderName(currentProvider)) return options;
  const interruptedIndex = interruptedToolTailAssistantIndex(options.messages);
  let changed = false;
  const messages = options.messages.map((message, index) => {
    const source = message?.source;
    const state = source?.replayState;
    if (message?.role !== "assistant" || !source || state?.kind !== "pi-ai" || state?.version !== 1) return message;

    let nextSource = source;
    const sourceProvider = source.provider;
    const replayProvider = state.provider;
    if (isWorkBuddyProviderName(sourceProvider) && isWorkBuddyProviderName(replayProvider)) {
      const canonical = directWorkBuddyProvider(replayProvider)
        ?? directWorkBuddyProvider(sourceProvider)
        ?? directWorkBuddyProvider(currentProvider);
      if (canonical && (sourceProvider !== canonical || replayProvider !== canonical)) {
        nextSource = {
          ...nextSource,
          provider: canonical,
          replayState: { ...state, provider: canonical },
        };
      }
    }

    if (index === interruptedIndex && nextSource.replayState !== undefined) {
      const { replayState: _ignored, ...withoutReplay } = nextSource;
      nextSource = withoutReplay;
    }
    if (nextSource === source) return message;
    changed = true;
    return { ...message, source: nextSource };
  });
  return changed ? { ...options, messages } : options;
}

// The rc.6 pi-ai adapter rejects replay metadata it does not understand. A
// newer DSH may persist a v2 envelope, so let old adapters use the durable
// message content as provider-neutral history instead of failing the request.
function stripUnsupportedReplay(options) {
  if (!Array.isArray(options?.messages)) return options;
  let changed = false;
  const messages = options.messages.map((message) => {
    const source = message?.source;
    const state = source?.replayState;
    if (state === undefined || (state?.kind === "pi-ai" && state?.version === 1)) return message;
    changed = true;
    const { replayState: _ignored, ...sourceWithoutReplay } = source;
    return { ...message, source: sourceWithoutReplay };
  });
  return changed ? { ...options, messages } : options;
}

function prepareWorkBuddyOptions(options, legacyReplay = true) {
  const normalized = normalizeWorkBuddyReplay(options);
  return legacyReplay ? stripUnsupportedReplay(normalized) : normalized;
}

function workBuddySource(config, source) {
  const providers = providerSettings(config);
  return Object.hasOwn(providers, PROVIDER) || Object.hasOwn(providers, LEGACY_PROVIDER)
    ? source
    : { ...source, apiKeyEnv: source.apiKeyEnv ?? API_KEY_ENV };
}

function providerSettings(config) {
  return typeof config?.providers?.get === "function" ? config.providers.get() : config?.providers ?? {};
}

function installSettingsCompat(ctx, ns, schema, entry, hooks) {
  if (typeof entry?.providers?.get === "function") {
    return ctx.inject(["settings"], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
    });
  }
  if (typeof dshSettings.installSettingsSection === "function") {
    return dshSettings.installSettingsSection(ctx, ns, schema, entry, hooks);
  }
  return ctx.inject(["settings"], (settingsCtx) => {
    if (!settingsCtx.settings || typeof settingsCtx.settings.installSection !== "function") {
      throw new Error(`${name}: DSH settings service does not provide installSection`);
    }
    return settingsCtx.settings.installSection(ctx, ns, schema, entry, hooks);
  });
}

/* ─────────────────────── 与历史插件共存时的选举 ───────────────────────
 *
 * 同一个 DSH 进程里可能同时存在本插件与历史包（dsh-llm-workbuddy /
 * dsh-llm-codebuddy …），也可能存在本包的两条安装行。它们都要注册 provider
 * "workbuddy-cn"，而 llm 服务的注册是先到先得、后到者抛 DUPLICATE_*，于是
 * "谁先 apply 谁生效"——这不该由 YAML 里的行序决定。这里加两层机制：
 *
 *   1. 选举：在根上下文的全局 symbol 上记录所有者。本包的多个副本之间只有
 *      第一个真正 apply 的那条生效，其余把自身所在的行停用（只在内存里）后
 *      静默退出，因此不会再产生重复注册。
 *   2. 抢占：历史包不认识这套约定，无法协作。于是安装前先停用它们所在的行并
 *      释放其 fiber；若对手已经抢注成功，则释放对手后重试安装。
 *
 * 全部改动只落在内存（entry.options.disabled / 释放 fiber），绝不写回
 * cordis.yml 或 cordis.patch.yml —— 那两份文件属于用户，写错会直接破坏启动。
 * 被停用的行在内存中已是 disabled，因此启动诊断（inactiveEntries）与客户端
 * 包扫描（cm-index）都会跳过它们，不会再出现 "did not activate" 或
 * "resolves from multiple active Loader sources"。
 */
const ELECTION_KEY = Symbol.for("dsh-workbuddy.election");
const ELECTION_OWNER = "@wangwei2k99/dsh-workbuddy";
const ELECTION_DEPTH = 32;
const ELECTION_ENTRY_LIMIT = 4096;
// 守夜节奏：前段密集（对手可能刚 apply 完，甚至还在 import），后段稀疏，总时长约 12s。
const ELECTION_TICK_PLAN = [120, 250, 400, 700, 1_200, 2_000, 3_000, 4_000];
// 对手 fiber 的卸载是异步的：目录条目要等它的 disposer 跑完才释放，所以重试前必须
// 等"卸载真正完成"，同步重试只会再撞一次。超时兜底，避免被一个卡死的对手拖住。
const RECLAIM_TIMEOUT_MS = 3_000;
const RECLAIM_ATTEMPTS = 3;
// 释放自己的注册句柄同样是异步的（effect 的 disposer 要过几个微任务才删键），
// 所以重试前再让出一拍，避免把自己的残留当成"对手又抢注了"。
const RECLAIM_RETRY_MS = 40;
const OWN_PACKAGES = new Set(["@wangwei2k99/dsh-workbuddy", "dsh-workbuddy"]);
const RIVAL_PACKAGE_PATTERN = /(?:work|code)-?buddy/i;
const RIVAL_ID_PATTERN = /(?:work|code)-?buddy/i;
const RIVAL_CONFLICT_CODES = new Set(["DUPLICATE_DIRECTORY", "DUPLICATE_ADAPTER", "DUPLICATE_DISCOVERY"]);

/** 从条目 name 里取出包名：去掉 npm: 前缀与 @version 后缀，本地路径行返回 undefined。 */
function packageOf(value) {
  if (typeof value !== "string") return undefined;
  let spec = value.trim();
  if (!spec) return undefined;
  if (spec.startsWith("npm:")) spec = spec.slice(4);
  if (/^(?:\.{0,2}[\\/]|[a-zA-Z]:[\\/]|file:|node:|https?:)/.test(spec)) return undefined;
  const at = spec.lastIndexOf("@");
  if (at > 0) spec = spec.slice(0, at);
  return spec || undefined;
}

/** 复刻 loader 的条目 id（嵌套条目带父级前缀），失败时退回原始 id。 */
function entryIdOf(entry) {
  try {
    const id = entry?.id;
    if (typeof id === "string") return id;
  } catch {}
  const raw = entry?.options?.id;
  return typeof raw === "string" ? raw : undefined;
}

/** 只把"还在跑"的 fiber 当作竞争者：已 disposed（4）与已卸载（5）都不算。 */
function isLiveFiber(fiber) {
  if (!fiber || typeof fiber !== "object") return false;
  if (fiber.uid === null || fiber.uid === undefined) return false;
  return fiber.state === 1 || fiber.state === 2;
}

/** 找出真正持有根上下文的那个 Context（它自己拥有 data 属性 fiber）。 */
function contextRoot(ctx) {
  try {
    let current = ctx;
    for (let depth = 0; current && depth <= ELECTION_DEPTH; depth++) {
      if (typeof current !== "object" && typeof current !== "function") break;
      const descriptor = Object.getOwnPropertyDescriptor(current, "fiber");
      if (descriptor && descriptor.value !== undefined) return current.root ?? current;
      current = Object.getPrototypeOf(current);
    }
  } catch {}
  try { return ctx?.get?.("fiber", false)?.ctx?.root; } catch {}
  return undefined;
}

/**
 * 找到根上下文与进程内的 loader。
 *
 * 条目存储树挂在 loader 上（`tree.store`）：loader 本身就是顶层 EntryTree，
 * 一条顶层 store 加 `entry.subtree` 递归就能走到进程里的每一行。找不到时
 * 两个字段都是 undefined，调用方按"没有对手"处理。
 */
function resident(ctx, mine) {
  let root;
  try { root = contextRoot(ctx); } catch {}
  const usable = (value) => value && typeof value === "object" && value.store && typeof value.store === "object" ? value : undefined;
  const probes = [
    () => ctx?.loader,
    () => ctx?.get?.("loader", false),
    () => mine?.entry?.loader,
    () => mine?.entry?.parent?.tree,
    () => root?.loader,
    () => root?.get?.("loader", false),
  ];
  let loader;
  for (const probe of probes) {
    try { loader = usable(probe()); } catch {}
    if (loader) break;
  }
  return { root, loader };
}

/** 收集进程内所有 loader 条目（含嵌套子组），只读不写。 */
function collectEntries(ctx, mine) {
  const entries = [];
  const seenEntries = new Set();
  const seenTrees = new Set();
  const add = (entry, depth) => {
    if (!entry || typeof entry !== "object" || seenEntries.has(entry)) return;
    if (entries.length >= ELECTION_ENTRY_LIMIT) return;
    seenEntries.add(entry);
    entries.push(entry);
    if (entry.subtree) visit(entry.subtree, depth + 1);
  };
  const visit = (tree, depth) => {
    if (!tree || typeof tree !== "object" || depth > ELECTION_DEPTH || seenTrees.has(tree)) return;
    seenTrees.add(tree);
    const store = tree.store;
    if (!store || typeof store !== "object") return;
    let list;
    try { list = Object.values(store); } catch { return; }
    for (const entry of list) add(entry, depth);
  };
  const { loader } = resident(ctx, mine);
  visit(loader, 0);
  return entries;
}

function isSelfEntry(entry, mine) {
  if (!mine || !entry) return false;
  if (mine.entry !== undefined && entry === mine.entry) return true;
  if (mine.fiber === undefined || mine.fiber === null) return false;
  return entry.fiber === mine.fiber;
}

/**
 * 是否需要被本插件取代的那一行：历史 workbuddy/codebuddy 包，
 * 以及（知道哪一行是自己时才计入）本包的重复副本。
 */
function isRivalOptions(options, id, includeOwn = true) {
  if (!options || typeof options !== "object") return false;
  if (options.group) return false;
  const pkg = packageOf(options.name);
  if (pkg) {
    if (OWN_PACKAGES.has(pkg)) return includeOwn;
    return RIVAL_PACKAGE_PATTERN.test(pkg);
  }
  if (!includeOwn) return false;
  return RIVAL_ID_PATTERN.test(String(id ?? options.id ?? ""));
}

function rivalEntries(ctx, mine) {
  const result = [];
  const includeOwn = mine?.includeOwn !== false;
  for (const entry of collectEntries(ctx, mine)) {
    if (isSelfEntry(entry, mine)) continue;
    const options = entry?.options;
    if (!isRivalOptions(options, entryIdOf(entry), includeOwn)) continue;
    result.push(entry);
  }
  return result;
}

/** 停用一行：只改内存里的 options，绝不触发 tree.write()。 */
function disableEntry(entry) {
  const options = entry?.options;
  if (!options || typeof options !== "object") return;
  try { options.disabled = true; } catch {}
}

/**
 * 释放一个 fiber，返回"卸载真正完成"的 Promise（吞掉对手 disposer 的错误）。
 *
 * 这一点是与旧版实现的关键差别：`fiber.dispose()` 只把 fiber 标成 disposing，
 * 它注册的 llm 目录/适配器要等 disposer 跑完（`_unload()`，异步）才被删除。
 * 因此"释放对手 → 立刻重试注册"必然再撞一次 DUPLICATE_*。
 */
function stopFiber(fiber) {
  if (!fiber || typeof fiber !== "object" || typeof fiber.dispose !== "function") return undefined;
  let task;
  try { task = fiber.dispose(); } catch { return undefined; }
  if (task && typeof task.then === "function") return Promise.resolve(task).then(() => {}, () => {});
  return Promise.resolve();
}

/**
 * 停用所有历史包/重复副本所在的行，返回 `{ released, pending }`。
 *
 * `stop: false` 只停用行、不释放 fiber —— 用于"本插件已经抢注成功"的场景：
 * 此时对手的 fiber 要么已经失败、要么还在 import 途中，释放它没有意义，
 * 但把行停用可以让启动诊断（inactiveEntries）与客户端包扫描（cm-index）
 * 直接跳过它，从而不再出现重复注册与重复来源的告警。
 *
 * `pending` 是每个被释放 fiber 的卸载完成 Promise，调用方必须等它落地之后
 * 才能重试注册。
 */
function clearRivals(ctx, mine, options = {}) {
  const stop = options.stop !== false;
  const pending = [];
  for (const entry of rivalEntries(ctx, mine)) {
    const fiber = stop && isLiveFiber(entry.fiber) ? entry.fiber : undefined;
    disableEntry(entry);
    if (!fiber) continue;
    const task = stopFiber(fiber);
    if (task) pending.push(task);
  }
  return { released: pending.length, pending };
}

/**
 * 认出"本行"：真实运行时是 loader 条目（`fiber.entry`）；测试或非 loader 场景
 * 下退化成一份假条目，这样选举逻辑永远有东西可用、也永远知道自己是哪一行。
 */
function resolveSelf(ctx, settingsNs) {
  let fiber;
  try { fiber = ctx?.fiber; } catch {}
  let entry;
  try { entry = fiber?.entry; } catch {}
  const real = entry && typeof entry === "object" ? entry : undefined;
  return {
    entry: real ?? { options: { id: settingsNs, name: ELECTION_OWNER, disabled: false } },
    fiber,
    // 认得出自己的真实行，才允许把"本包的重复副本"也当成对手；
    // 否则（假条目）宁可保守，只处理历史包。
    includeOwn: Boolean(real),
  };
}

/**
 * 冲突是否来自"provider 已经被别人注册"。
 * llm 抛的是带 code 的 LlmError；不同版本措辞不同，所以再按正文兜一层。
 */
function duplicateOf(error) {
  if (!error || typeof error !== "object") return false;
  const code = error.code;
  if (typeof code === "string" && RIVAL_CONFLICT_CODES.has(code)) return true;
  const message = typeof error.message === "string" ? error.message : "";
  if (!message) return false;
  return /work-?buddy|code-?buddy/i.test(message) && /already (?:registered|declared|present|exists)/i.test(message);
}

/**
 * 选举结果。
 *
 * 为什么不放在 `ctx.root` 上：根上下文是 ReflectService 的 Proxy，`root` 与其它
 * 数据属性都没有 provide 定义，`ReflectService.handler.set` 对未 provide 的属性
 * 直接抛 "cannot set property ... without provide"。而模块级变量按 ESM 语义是
 * 每个进程一份，正好等价于"进程级选举结果"，比往 Proxy 上塞 symbol 可靠。
 */
let elected;

/**
 * 选出本进程里 WorkBuddy provider 的唯一归属者。
 * 只有"另一个活着的本包副本"能让我们认输；其它情况都归本插件。
 */
function electWorkBuddy(ctx, mine) {
  const holder = elected;
  if (holder && isLiveFiber(holder.fiber) && holder.fiber !== mine?.fiber) {
    return { won: false, owner: holder.owner, reason: "live-owner" };
  }
  elected = { owner: ELECTION_OWNER, fiber: mine?.fiber };
  return { won: true, owner: ELECTION_OWNER };
}

/** 进程里是否还有没被停用的历史包/重复副本（含"正在 import、fiber 还没建好"的行）。 */
function rivalLlm(ctx, mine) {
  try {
    for (const entry of rivalEntries(ctx, mine)) {
      if (entry?.options?.disabled === true) continue;
      return true;
    }
  } catch {}
  return false;
}

/** 停用并释放所有历史包/重复副本，返回 `{ released, pending }`（永不抛）。 */
const NO_PENDING = Object.freeze({ released: 0, pending: Object.freeze([]) });

function stopRival(ctx, mine) {
  try { return clearRivals(ctx, mine, { stop: true }); } catch { return NO_PENDING; }
}

/**
 * 装一个"守夜"effect：一段时间内周期性复查，保证晚启动的历史包也会被压下去。
 *
 * 用 ctx.effect 而不是裸 setInterval，是为了让 fiber 卸载时自动 clearTimeout；
 * 定时器都 unref，绝不拖住进程退出。整个函数对 ctx 能力缺失完全宽容（测试里的
 * 假 ctx 没有 effect），失败一律静默 —— 守夜不是功能，不能因为它报错。
 */
function armElection(ctx, run) {
  if (typeof ctx?.effect !== "function" || typeof run !== "function") return;
  try {
    ctx.effect(() => {
      const timers = new Set();
      const stop = () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      };
      let elapsed = 0;
      for (const delay of ELECTION_TICK_PLAN) {
        elapsed += delay;
        const timer = setTimeout(() => {
          timers.delete(timer);
          try { run(); } catch {}
        }, elapsed);
        timer?.unref?.();
        timers.add(timer);
      }
      return stop;
    }, "workbuddy: election");
  } catch {}
}

export const __testing = Object.freeze({ authenticationHeaders, workBuddyApiKeyAuth, workBuddyRequestOptions, workBuddySource, providerSettings, genericProvider, modelsFromConfig, ownsProvider, runtimeHeaders, stripUnsupportedReplay, normalizeWorkBuddyReplay, prepareWorkBuddyOptions, selectWorkBuddyModels, sessionBindingFor, estimateTextTokens, estimateContextTokens, boundContextBudget, silentContextOverflow, sessionContextWindow, workBuddyApi, packageOf, entryIdOf, isLiveFiber, isRivalOptions, collectEntries, rivalEntries, disableEntry, clearRivals, stopFiber, resolveSelf, duplicateOf, resident, rivalLlm, stopRival, armElection, electWorkBuddy, ELECTION_KEY, ELECTION_OWNER, RECLAIM_ATTEMPTS, RECLAIM_TIMEOUT_MS, setSessionTierWindow(reader) { sessionTierWindow = typeof reader === "function" ? reader : () => undefined; } });

export function apply(ctx, config) {
  const modernSettings = typeof config?.providers?.get === "function";
  const settingsNs = modernSettings ? ctx.fiber?.entry?.options?.id ?? name : NS;
  let current = () => config;
  const requestContext = new AsyncLocalStorage();
  let remoteModels;
  let generation = 0;
  let memoRaw;
  let memoProviders;
  let memoGeneration = -1;
  let memoized;
  const loginSessionPromises = new Map();
  let remoteModelsKey;
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));

  const effectiveConfig = () => {
    const raw = current() ?? {};
    const providers = providerSettings(raw);
    const configured = providers[PROVIDER] ?? providers[LEGACY_PROVIDER];
    return {
      ...raw,
      providers: {
        ...providers,
        [PROVIDER]: configured ?? { apiKeyEnv: API_KEY_ENV },
      },
    };
  };

  const profiles = () => {
    const raw = effectiveConfig();
    const configuredProviders = providerSettings(current());
    if (memoRaw === current() && memoProviders === configuredProviders && memoGeneration === generation && memoized) return memoized;
    const result = new Map();
    for (const [provider, source] of Object.entries(raw.providers)) {
      if (modernSettings && !WORKBUDDY_PROVIDERS.has(provider)) continue;
      if (!ownsProvider(provider, builtins, source)) continue;
      if (WORKBUDDY_PROVIDERS.has(provider)) {
        const sourceWithAuth = workBuddySource(current(), source);
        const models = selectWorkBuddyModels(remoteModels ?? FALLBACK_MODELS, source.models);
        const configured = new Map((source.models ?? []).flatMap((model) =>
          Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? [[model.id, model.maxTokens]] : [],
        ));
        result.set(provider, resolvedProfile(provider, {
          ...sourceWithAuth,
          headers: runtimeHeaders(sourceWithAuth.headers, requestContext),
          displayName: DISPLAY_NAME,
        }, workBuddyProvider(models, provider), configured, requestContext));
        continue;
      }
      const base = builtins.get(provider);
      if (!base) {
        const generic = genericProvider(provider, source);
        if (!generic) continue;
        const configured = new Map((source.models ?? []).flatMap((model) =>
          Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? [[model.id, model.maxTokens]] : [],
        ));
        result.set(provider, resolvedProfile(provider, source, generic, configured));
        continue;
      }
      const selected = selectBuiltinModels(base, source.models);
      const configured = new Map((source.models ?? []).flatMap((model) =>
        Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? [[model.id, model.maxTokens]] : [],
      ));
      result.set(provider, resolvedProfile(provider, source, selected, configured));
    }
    memoRaw = current();
    memoProviders = configuredProviders;
    memoGeneration = generation;
    memoized = result;
    return result;
  };

  const readSessionRouting = async () => {
    const credentials = ctx.get("credentials");
    const env = launchEnvironmentOf(ctx);
    const ref = credentialRef(WORKBUDDY_SESSION_ROUTING_REF);
    const stored = await credentials?.resolve(ref);
    const value = stored?.value ?? env.get(ref)?.value;
    return value ? parseWorkBuddySessionRouting(value) : createWorkBuddySessionRoutingState();
  };
  let routingBindingQueue = Promise.resolve();
  const persistDefaultSessionBinding = (sessionId, fallbackBinding) => {
    const task = routingBindingQueue.then(async () => {
      const latest = await readSessionRouting();
      const existing = sessionBindingFor(latest, sessionId);
      if (existing) return existing;
      const binding = latest.lastUsed ?? fallbackBinding;
      if (!binding) return undefined;
      const credentials = ctx.get("credentials");
      if (!credentials) throw new Error("DSH 凭据服务不可用，无法保存会话认证");
      await credentials.set(credentialRef(WORKBUDDY_SESSION_ROUTING_REF), serializeWorkBuddySessionRouting({
        ...latest,
        bindings: { ...latest.bindings, [sessionId]: binding },
      }));
      return binding;
    });
    routingBindingQueue = task.then(() => undefined, () => undefined);
    return task;
  };

  const resolveLoginSession = async (requestedId) => {
    const key = typeof requestedId === "string" && requestedId ? requestedId : "active";
    let promise = loginSessionPromises.get(key);
    if (!promise) {
      promise = (async () => {
        const credentials = ctx.get("credentials");
        const env = launchEnvironmentOf(ctx);
        const sessionsRef = credentialRef(WORKBUDDY_SESSIONS_REF);
        const sessionRefs = [sessionsRef, credentialRef(LEGACY_SESSIONS_REF)];
        let sessionsValue;
        for (const ref of sessionRefs) {
          const storedSessions = await credentials?.resolve(ref);
          sessionsValue = storedSessions?.value ?? env.get(ref)?.value;
          if (sessionsValue) break;
        }
        let store;
        if (sessionsValue) {
          store = parseWorkBuddySessions(sessionsValue);
        } else {
          const legacyRefs = [credentialRef(WORKBUDDY_SESSION_REF), credentialRef(LEGACY_SESSION_REF)];
          let legacyValue;
          for (const ref of legacyRefs) {
            const storedLegacy = await credentials?.resolve(ref);
            legacyValue = storedLegacy?.value ?? env.get(ref)?.value;
            if (legacyValue) break;
          }
          if (!legacyValue) throw new Error("未找到 WorkBuddy 登录凭据");
          store = createWorkBuddySessionStore([parseWorkBuddySession(legacyValue)]);
        }
        const active = typeof requestedId === "string" && requestedId
          ? store.sessions.find((entry) => entry.id === requestedId)
          : activeWorkBuddySession(store);
        if (!active) throw new Error("未找到 WorkBuddy 登录账号");
        let session = active;
        if (sessionNeedsRefresh(session)) {
          const trace = traceContext.getStore();
          const started = Date.now();
          traceEvent(trace, "auth.refresh-start");
          try {
            session = { ...session, ...(await refreshWorkBuddySession(session)), updatedAt: Date.now() };
            traceEvent(trace, "auth.refresh-done", { elapsedMs: Date.now() - started });
          } catch (error) {
            traceEvent(trace, "auth.refresh-error", { elapsedMs: Date.now() - started, ...errorFields(error) });
            throw error;
          }
          const nextStore = {
            ...store,
            sessions: store.sessions.map((entry) => entry.id === session.id ? session : entry),
          };
          await credentials?.set(sessionsRef, serializeWorkBuddySessions(nextStore));
          if (nextStore.activeId === session.id) await credentials?.set(credentialRef(WORKBUDDY_SESSION_REF), serializeWorkBuddySession(session));
        }
        return { ...session, sessionId: active.id, expiresAt: sessionCacheDeadline(session) };
      })().finally(() => {
        loginSessionPromises.delete(key);
      });
      loginSessionPromises.set(key, promise);
    }
    return promise;
  };

  const resolveCredential = async (provider, profile, context = requestContext.getStore()) => {
    context ??= {};
    const ref = profile.apiKeyEnv;
    const routing = WORKBUDDY_PROVIDERS.has(provider) ? await readSessionRouting() : createWorkBuddySessionRoutingState();
    const sessionId = context?.sessionId ? String(context.sessionId) : undefined;
    let binding = sessionBindingFor(routing, sessionId);
    if (WORKBUDDY_PROVIDERS.has(provider) && routing.enabled && sessionId && !binding) {
      let fallbackBinding;
      if (!routing.lastUsed) {
        if (ref) fallbackBinding = { mode: "api-key", apiKeyRef: ref };
        else {
          try {
            const active = await resolveLoginSession();
            fallbackBinding = { mode: "token", accountId: active.sessionId };
          } catch (error) {
            throw new LlmError(`${name}: 没有可用于当前会话的默认 WorkBuddy 凭证`, "MISSING_CREDENTIAL", { cause: error });
          }
        }
      }
      try {
        binding = await persistDefaultSessionBinding(sessionId, fallbackBinding);
      } catch (error) {
        throw new LlmError(`${name}: 无法保存当前会话的 WorkBuddy 凭证绑定`, "MISSING_CREDENTIAL", { cause: error });
      }
      if (!binding) throw new LlmError(`${name}: 没有可用于当前会话的默认 WorkBuddy 凭证`, "MISSING_CREDENTIAL");
    }
    if (WORKBUDDY_PROVIDERS.has(provider) && binding?.mode === "token") {
      let session;
      try {
        session = await resolveLoginSession(binding.accountId);
      } catch (error) {
        throw new LlmError(`${name}: 当前会话绑定的 WorkBuddy 登录账号不可用`, "MISSING_CREDENTIAL", { cause: error });
      }
      context.headers = {
        ...(session.account.userId ? { "X-User-Id": session.account.userId } : {}),
        ...(session.account.enterpriseId ? { "X-Enterprise-Id": session.account.enterpriseId, "X-Tenant-Id": session.account.enterpriseId } : {}),
        ...(session.auth.domain ? { "X-Domain": session.auth.domain } : {}),
      };
      return {
        value: assertUsableApiKey(session.auth.accessToken, name, "WorkBuddy login session"),
        kind: "bearer",
        sessionId: session.sessionId,
        userId: session.account.userId,
      };
    }
    if (WORKBUDDY_PROVIDERS.has(provider) && binding?.mode === "api-key") {
      const bindingRef = binding.apiKeyRef;
      if (!bindingRef) throw new LlmError(`${name}: 当前会话绑定的 API Key 引用无效`, "MISSING_CREDENTIAL");
      const stored = await ctx.get("credentials")?.resolve(credentialRef(bindingRef));
      const value = stored?.value ?? launchEnvironmentOf(ctx).get(credentialRef(bindingRef))?.value;
      if (value) return { value: assertUsableApiKey(value, name, bindingRef), kind: "api-key", ref: bindingRef };
      throw new LlmError(`${name}: 当前会话绑定的 API Key 不可用`, "MISSING_CREDENTIAL");
    }
    if (!ref && WORKBUDDY_PROVIDERS.has(provider)) {
      let session;
      try {
        session = await resolveLoginSession();
      } catch (error) {
        throw new LlmError(`${name}: 未找到可用的 WorkBuddy 登录令牌，请在插件详情里完成登录`, "MISSING_CREDENTIAL", { cause: error });
      }
      context.headers = {
        ...(session.account.userId ? { "X-User-Id": session.account.userId } : {}),
        ...(session.account.enterpriseId ? { "X-Enterprise-Id": session.account.enterpriseId, "X-Tenant-Id": session.account.enterpriseId } : {}),
        ...(session.auth.domain ? { "X-Domain": session.auth.domain } : {}),
      };
      return {
        value: assertUsableApiKey(session.auth.accessToken, name, "WorkBuddy login session"),
        kind: "bearer",
        sessionId: session.sessionId,
        userId: session.account.userId,
      };
    }
    if (!ref) return { value: undefined, kind: "none" };
    const stored = await ctx.get("credentials")?.resolve(ref);
    let value = stored?.value ?? launchEnvironmentOf(ctx).get(ref)?.value;
    if (!value && ref === API_KEY_ENV) {
      const legacyRef = credentialRef(LEGACY_API_KEY_ENV);
      const legacyStored = await ctx.get("credentials")?.resolve(legacyRef);
      value = legacyStored?.value ?? launchEnvironmentOf(ctx).get(legacyRef)?.value;
    }
    if (value) return { value: assertUsableApiKey(value, name, ref), kind: "api-key", ref };
    throw new LlmError(`${name}: Provider "${provider}" 缺少 API Key，请在 WebUI 的模型设置中填写`, "MISSING_CREDENTIAL");
  };

  const resolveApiKey = async (provider, profile) => {
    const trace = WORKBUDDY_PROVIDERS.has(provider) ? traceContext.getStore() : undefined;
    const started = Date.now();
    traceEvent(trace, "auth.start");
    try {
      const credential = await resolveCredential(provider, profile);
      const context = requestContext.getStore();
      if (WORKBUDDY_PROVIDERS.has(provider) && context) {
        // 令牌登录改用 WorkBuddy 桌面客户端身份；API Key 模式沿用 CLI 身份。
        context.identity = credential.kind === "bearer" ? IDENTITY_WORKBUDDY : IDENTITY_CLI;
        if (credential.kind === "api-key") context.headers["X-API-Key"] = credential.value;
        // 桌面端身份需要 X-User-Id；登录凭证带账号 userId 时透传，缺失时回落 anonymous。
        if (credential.kind === "bearer" && credential.userId) {
          context.workBuddyUserId = String(credential.userId);
        }
      }
      traceEvent(trace, "auth.done", { elapsedMs: Date.now() - started, mode: credential.kind });
      return credential.value;
    } catch (error) {
      traceEvent(trace, "auth.error", { elapsedMs: Date.now() - started, ...errorFields(error) });
      throw error;
    }
  };

  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    resolveAttachments: () => ctx.get("attachments"),
  });
  const refreshPromises = new Map();
  const refreshWorkBuddyModels = async (provider, signal) => {
    const profile = profiles().get(provider);
    const credential = await resolveCredential(provider, profile);
    const cacheKey = credential.kind === "bearer" ? `token:${credential.sessionId ?? "active"}` : `api:${credential.ref ?? API_KEY_ENV}`;
    if (remoteModels && remoteModelsKey === cacheKey) return;
    let pending = refreshPromises.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        remoteModels = await fetchWorkBuddyModels(credential, signal);
        remoteModelsKey = cacheKey;
        generation += 1;
      })().finally(() => refreshPromises.delete(cacheKey));
      refreshPromises.set(cacheKey, pending);
    }
    return pending;
  };
  const ensureWorkBuddyModel = async (provider, model, signal) => {
    if (!WORKBUDDY_PROVIDERS.has(provider)) return;
    if (profiles().get(provider)?.piProvider.getModels().some((entry) => entry.id === model)) return;
    await refreshWorkBuddyModels(provider, signal);
  };
  const sessionScopedStream = (stream, options) => {
    const context = { sessionId: options?.sessionId === undefined ? undefined : String(options.sessionId), headers: {}, id: ++nextTraceId };
    const run = (action) => traceContext.run(context, () => requestContext.run(context, action));
    const source = run(() => stream(options));
    const iterator = source[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]() { return this; },
      next(value) { return run(() => iterator.next(value)); },
      return(value) { return run(() => iterator.return?.(value) ?? Promise.resolve({ done: true, value })); },
      throw(error) { return run(() => iterator.throw?.(error) ?? Promise.reject(error)); },
    };
  };
  const adapterStream = adapter.stream.bind(adapter);
  const legacyAdapter = typeof adapter.prepareCall !== "function";
  const invokeAdapterStream = (options) => adapterStream(prepareWorkBuddyOptions(options, legacyAdapter));
  adapter.stream = (options) => sessionScopedStream(invokeAdapterStream, options);
  // `prepareCall` was added after the DSH rc.6 adapter. Keep the direct
  // `stream` path working on older hosts while wrapping prepared calls on
  // newer hosts, whose runtime dispatches through the returned stream handle.
  if (!legacyAdapter) {
    const adapterPrepareCall = adapter.prepareCall.bind(adapter);
    adapter.prepareCall = async (...args) => {
      await ensureWorkBuddyModel(args[0], args[1], args[2]);
      const prepared = await adapterPrepareCall(...args);
      return {
        ...prepared,
        stream: (options) => sessionScopedStream((preparedOptions) => prepared.stream(prepareWorkBuddyOptions(preparedOptions, false)), options),
      };
    };
  } else {
    // DSH 0.1.5 calls prepareCall unconditionally, while the rc.6 pi-ai
    // adapter shipped without it. Keep that older adapter usable by exposing
    // the same prepared-call shape from its existing methods.
    adapter.prepareCall = async (provider, model, signal) => ({
      model: await adapter.resolveModel(provider, model, signal),
      stream: (options) => sessionScopedStream(invokeAdapterStream, options),
    });
  }
  const resolveModel = adapter.resolveModel.bind(adapter);
  adapter.resolveModel = async (provider, model, signal) => {
    await ensureWorkBuddyModel(provider, model, signal);
    const resolved = await resolveModel(provider, model, signal);
    if (!WORKBUDDY_PROVIDERS.has(provider) || !resolved.reasoning) return resolved;
    const configured = profiles().get(provider)?.piProvider.getModels().find((entry) => entry.id === model);
    const effort = configured?.defaultReasoningEffort;
    if (!effort || !resolved.reasoning.efforts.some((entry) => entry.id === effort)) return resolved;
    return { ...resolved, reasoning: { ...resolved.reasoning, defaultEffort: effort } };
  };
  const listModels = adapter.listModels.bind(adapter);
  adapter.listModels = async (provider) => {
    if (WORKBUDDY_PROVIDERS.has(provider)) {
      try {
        await refreshWorkBuddyModels(provider);
      } catch {
        // Keep the built-in catalog available while the key or network is absent.
      }
    }
    return listModels(provider);
  };

  const workBuddyDirectory = () => [{
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    settingsNs,
    settingsPath: ["providers", PROVIDER],
    declared: false,
  }];
  const directoryEntries = () => modernSettings ? workBuddyDirectory() : [...workBuddyDirectory(), ...[...builtins.values()].flatMap((provider) => provider.auth?.apiKey ? [{
    provider: provider.id,
    displayName: provider.name,
    settingsNs,
    settingsPath: ["providers", provider.id],
    declared: false,
  }] : []), ...Object.entries(effectiveConfig().providers ?? {}).flatMap(([provider, source]) => {
    if (WORKBUDDY_PROVIDERS.has(provider) || builtins.has(provider) || !genericProvider(provider, source)) return [];
    return [{
      provider,
      displayName: source.displayName ?? provider,
      settingsNs,
      settingsPath: ["providers", provider],
      declared: true,
    }];
  })];

  const discoverModels = async (request, signal) => {
    const discoverySignal = signal ?? request.signal;
    if (WORKBUDDY_PROVIDERS.has(request.provider)) {
      const profile = profiles().get(request.provider);
      const credential = request.apiKey
        ? { value: request.apiKey, kind: "api-key", ref: API_KEY_ENV }
        : await resolveCredential(request.provider, profile);
      remoteModels = await fetchWorkBuddyModels(credential, discoverySignal);
      remoteModelsKey = credential.kind === "bearer" ? `token:${credential.sessionId ?? "active"}` : `api:${credential.ref ?? API_KEY_ENV}`;
      generation += 1;
      return remoteModels.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }));
    }
    const provider = builtins.get(request.provider);
    if (!provider) return probeEndpoint({ ...request, signal: discoverySignal }, { profiles, resolveCredential });
    return provider.getModels().map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));
  };

  /* ── 安装与选举 ────────────────────────────────────────────────────────
   *
   * llm 服务的注册是先到先得：第一个注册 "workbuddy-cn" 的 fiber 生效，后来者
   * 抛 DUPLICATE_*。历史包（dsh-llm-workbuddy / dsh-llm-codebuddy …）与本包的
   * 重复副本都想要这个 provider，所以"谁先 apply"不该由 YAML 行序决定。
   *
   * boot() 把顺序固定成"本插件赢"：先停用对手所在的行，再注册；注册时若仍然
   * 撞车（对手已经抢注成功），释放对手的 fiber 后重试一次；仍然撞车就认输并
   * 把自己的行停用，静默退出 —— 绝不半途留一个只注册了一半的状态。
   */
  let owned = { directory: undefined, registration: undefined, discovery: undefined };
  let mine;
  let booted = false;
  let healing = false;

  const registerOnce = () => {
    const providers = [...profiles().keys()];
    const entries = directoryEntries();
    if (owned.directory) owned.directory.replace?.(entries);
    else owned.directory = ctx.llm.registerConfigurableProviders(entries);
    if (owned.registration) owned.registration.replace?.(providers);
    else owned.registration = ctx.llm.registerAdapter(providers, adapter);
    if (!owned.discovery) {
      const handle = ctx.llm.registerModelDiscovery(settingsNs, discoverModels);
      owned.discovery = typeof handle === "function" ? handle : () => {};
    }
  };

  const releaseRegistrations = () => {
    for (const key of ["discovery", "registration", "directory"]) {
      const handle = owned[key];
      owned[key] = undefined;
      if (typeof handle !== "function") continue;
      try { handle(); } catch {}
    }
  };

  /** 注册一次；撞车则清掉自己已经注册的部分并返回 false，其它错误照旧抛出。 */
  const tryRegister = () => {
    try {
      registerOnce();
      return true;
    } catch (error) {
      if (!duplicateOf(error)) throw error;
      releaseRegistrations();
      return false;
    }
  };

  /** 只等一批卸载落地，最多 RECLAIM_TIMEOUT_MS；永不 reject、永不留悬挂定时器。 */
  const settle = (pending) => {
    const list = (Array.isArray(pending) ? pending : []).filter((task) => task && typeof task.then === "function");
    if (list.length === 0) return Promise.resolve();
    const all = Promise.all(list.map((task) => Promise.resolve(task).then(() => {}, () => {})));
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, RECLAIM_TIMEOUT_MS);
      timer?.unref?.();
      all.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const pause = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer?.unref?.();
  });

  /** 本 fiber 是否还活着（真实运行时被卸载后 uid 置 null，异步分支必须先看这一眼）。 */
  const stillActive = () => {
    const fiber = mine?.fiber;
    if (!fiber || typeof fiber !== "object") return true;
    return fiber.uid !== null;
  };

  /**
   * 对手已经抢注、我们刚把它拆掉：必须等它的 disposer 真正跑完才能重试。
   *
   * 目录是 llm 服务上的共享 Map，键是 provider 名；对手的 disposer 做的是
   * `directory.delete(provider)`，与我们是不是同一个注册句柄无关。所以"先注册、
   * 后等它卸载"会让对手的清理把**我们**刚登记的键删掉 —— 顺序只能是先等后注册。
   */
  const reclaim = async (pending, attempt) => {
    await settle(pending);
    await pause(RECLAIM_RETRY_MS);
    if (!stillActive()) return false;
    if (tryRegister()) return true;
    if (attempt >= RECLAIM_ATTEMPTS) return false;
    return reclaim(stopRival(ctx, mine).pending, attempt + 1);
  };

  /**
   * 抢占注册。`true` = 已同步抢到；`false` = 认输；Promise<boolean> = 需要等对手卸载。
   *
   * 没有对手时整条路径保持同步：测试里的假 ctx 没有 loader，`rivalLlm` 恒为 false，
   * `apply()` 返回时注册已经生效。
   */
  const installRegistrations = () => {
    const pending = rivalLlm(ctx, mine) ? stopRival(ctx, mine).pending : NO_PENDING.pending;
    if (tryRegister()) return true;
    return reclaim(pending, 1);
  };

  /**
   * 迟到的对手：历史包可能在本插件之后才 import 完成（甚至稍后被 loader 拉起）。
   * 注册冲突发生在对手的 apply 里、不会回调我们，所以额外订阅 llm/adapters-updated
   * 并在守夜窗口内周期性复查：只要发现对手的行还活着，就把重排推迟一拍执行。
   * `healing` 贯穿整段工作（含 registerOnce 内部再次触发的 emit），因此不会自激；
   * 若这一轮要走"等对手卸载"的异步路径，`healing` 会一直握到那次抢占结束，
   * 期间重复的 emit 全部被折叠掉。
   */
  const repair = (force) => {
    if (!booted || healing) return;
    if (!force && !rivalLlm(ctx, mine)) return;
    healing = true;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      healing = false;
    };
    Promise.resolve().then(() => {
      if (!booted) return finish();
      if (!force && !rivalLlm(ctx, mine)) return finish();
      const outcome = installRegistrations();
      if (outcome === true) return finish();
      if (outcome === false) {
        disableEntry(mine.entry);
        return finish();
      }
      return Promise.resolve(outcome).then((won) => {
        if (!won) disableEntry(mine.entry);
        finish();
      }, finish);
    }).catch(finish);
  };
  const deferHeal = () => repair(false);

  // Keep WorkBuddy out of the settings base layer so it appears in WebUI's
  // "Add provider" dropdown. The runtime profile above still exists as the
  // built-in implementation; selecting it only persists the credential ref.
  const refreshRegistrations = () => {
    memoRaw = undefined;
    if (!booted) return;
    if (!owned.registration || !owned.directory) {
      repair(true);
      return;
    }
    // 有对手在时不能就地 replace：停用对手会让它在异步 disposer 里删掉目录键，
    // 而目录是共享 Map、按 provider 名删，删掉的会是我们刚写进去的那一份。
    // 交给 repair 走"先等对手卸载、再重新注册"的正规路径。
    if (rivalLlm(ctx, mine)) {
      repair(true);
      return;
    }
    try {
      owned.registration.replace([...profiles().keys()]);
      owned.directory.replace(directoryEntries());
    } catch {
      // 句柄可能已被释放（对手 reload、fiber 卸载），重建整套注册比静默失效好。
      repair(true);
    }
  };

  /** 真正赢下之后才做的一次性收尾（Web 路由、设置面板、守夜）。 */
  const activate = () => {
    if (booted) return;
    booted = true;
    // 会话级档位：只改内存里的覆盖，不动 profile 配置。
    // 必须在 Web 路由之前装好，路由才能读到它的读写接口。
    const tiers = installSessionTiers(ctx, config?.sessionTiers);
    sessionTierWindow = (sessionId) => {
      if (typeof sessionId !== "string" || sessionId === "") return undefined;
      const window = tiers.api.read(sessionId)?.override?.contextWindow;
      return Number.isInteger(window) && window > 0 ? window : undefined;
    };
    // 只有真正赢下的这一份才挂 Web 路由与设置面板，避免两条 routing 抢同一路径。
    installWorkBuddyWeb(ctx, settingsNs, tiers.api);
    if (modernSettings && typeof ctx.on === "function") ctx.on("loader/volatile-update", refreshRegistrations);
    if (typeof ctx.on === "function") ctx.on("llm/adapters-updated", deferHeal);
    installSettingsCompat(ctx, settingsNs, Config, config ?? { providers: {}}, {
      setSource(source) {
        current = source;
      },
      onChange() {
        refreshRegistrations();
      },
    });
    armElection(ctx, deferHeal);
  };

  /** 位子被别人占死：停用自己的行（只在内存里）后静默退出。 */
  const surrender = () => {
    stopRival(ctx, mine);
    disableEntry(mine.entry);
  };

  const boot = () => {
    mine = resolveSelf(ctx, settingsNs);
    const election = electWorkBuddy(ctx, mine);
    if (!election.won) {
      // 另一个活着的本包副本已经生效：停用自己的行（只在内存里）后静默退出。
      // 被停用的行不会被 inactiveEntries 诊断、也不会被 refresh() 重新拉起，
      // 因此不会产生 "did not activate" 告警，也不会再去抢注一次。
      surrender();
      return;
    }
    const outcome = installRegistrations();
    if (outcome === true) {
      activate();
      return;
    }
    if (outcome === false) {
      surrender();
      return;
    }
    // 对手已经抢注成功：注册要等它卸载完才能落地，只能异步收尾。
    // apply 本身仍然同步返回，这里只是把"赢下之后做什么"推迟到抢占有结果。
    Promise.resolve(outcome).then((won) => {
      if (won && stillActive()) activate();
      else surrender();
    }, () => surrender());
  };

  boot();
}
