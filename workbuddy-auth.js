import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const WORKBUDDY_SESSION_REF = "WORKBUDDY_LOGIN_SESSION";
export const WORKBUDDY_SESSIONS_REF = "WORKBUDDY_LOGIN_SESSIONS";
export const WORKBUDDY_SESSION_ROUTING_REF = "WORKBUDDY_SESSION_ROUTING";
export const WORKBUDDY_API_KEYS_REF = "WORKBUDDY_API_KEYS";
export const LEGACY_SESSION_REF = "CODEBUDDY_LOGIN_SESSION";
export const LEGACY_SESSIONS_REF = "CODEBUDDY_LOGIN_SESSIONS";
export const LEGACY_API_KEYS_REF = "CODEBUDDY_API_KEYS";

function normalizeWorkBuddySessionBinding(binding) {
  if (!binding || typeof binding !== "object") return undefined;
  if (binding.mode === "token" && typeof binding.accountId === "string" && binding.accountId.trim()) {
    return { mode: "token", accountId: binding.accountId.trim() };
  }
  if (binding.mode === "api-key" && typeof binding.apiKeyRef === "string" && binding.apiKeyRef.trim()) {
    return { mode: "api-key", apiKeyRef: binding.apiKeyRef.trim() };
  }
  return undefined;
}

export function createWorkBuddySessionRoutingState(enabled = false, bindings = {}, lastUsed) {
  const normalized = {};
  if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
    for (const [sessionId, binding] of Object.entries(bindings)) {
      if (typeof sessionId !== "string" || !sessionId.trim() || !binding || typeof binding !== "object") continue;
      const value = normalizeWorkBuddySessionBinding(binding);
      if (value) normalized[sessionId] = value;
    }
  }
  const recent = normalizeWorkBuddySessionBinding(lastUsed);
  return {
    version: 1,
    enabled: enabled === true,
    bindings: normalized,
    ...(recent ? { lastUsed: recent } : {}),
  };
}

export function serializeWorkBuddySessionRouting(state) {
  return JSON.stringify(createWorkBuddySessionRoutingState(state?.enabled, state?.bindings, state?.lastUsed));
}

export function parseWorkBuddySessionRouting(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("WorkBuddy 会话级认证配置已损坏，请重新设置", { cause: error });
  }
  return createWorkBuddySessionRoutingState(parsed?.enabled, parsed?.bindings, parsed?.lastUsed);
}

const BASE_URL = "https://copilot.tencent.com/v2/plugin";

/**
 * 两套出站身份。
 *
 * CLI 身份是 CodeBuddy 官方命令行客户端的头族，API Key 模式沿用；
 * WorkBuddy 身份对应独立桌面客户端，令牌登录时使用。
 *
 * 版本号取自官方客户端抓包：国内版桌面端 5.8.3、内置 CLI 2.161.0；
 * CodeBuddy CLI 2.171.0（本插件此前使用的值）。
 */
export const IDENTITY_CLI = "cli";
export const IDENTITY_WORKBUDDY = "workbuddy";

/**
 * WorkBuddy 桌面客户端版本。
 *
 * 这是全局唯一的真实版本来源：登录页的 `version` 参数、身份头
 * `X-IDE-Version`、User-Agent 都必须取自同一个值，否则出站请求会出现
 * 「登录页面自称 5.9.2、请求头却自称 5.8.3」这类自相矛盾，
 * 正是风控识别非官方客户端最常用的信号。
 *
 * 5.9.2 来自官方桌面客户端的真实登录链接（`version=5.9.2`）。
 */
const WORKBUDDY_DESKTOP_VERSION = "5.9.2";
/** 客户端内置 CLI 子进程版本，UA 末段用它；与桌面端版本相互独立。 */
const WORKBUDDY_EMBEDDED_CLI_VERSION = "2.161.0";
const WORKBUDDY_USER_AGENT =
  `WorkBuddy/${WORKBUDDY_DESKTOP_VERSION} WorkBuddy/${WORKBUDDY_DESKTOP_VERSION} CLI/${WORKBUDDY_EMBEDDED_CLI_VERSION}`;
/** 国内版端点的 X-Domain 值。 */
const WORKBUDDY_DOMAIN_CN = "copilot.tencent.com";

const IDENTITY_CLI_HEADERS = {
  "user-agent": "CLI/2.171.0 CodeBuddy/2.171.0",
  "x-product": "SaaS",
  "x-ide-type": "CLI",
  "x-ide-name": "CodeBuddy",
  "x-ide-version": "2.171.0",
};

/** 与账号无关的静态桌面端头；随请求变化的头由 buildIdentityHeaders 追加。 */
const IDENTITY_WORKBUDDY_HEADERS = {
  "user-agent": WORKBUDDY_USER_AGENT,
  "x-product": "SaaS",
  "x-ide-type": "WorkBuddy",
  "x-ide-name": "WorkBuddy",
  "x-ide-version": WORKBUDDY_DESKTOP_VERSION,
  "x-agent-intent": "craft",
  "x-agent-purpose": "conversation",
  "x-agent-type": "main",
  // 桌面端固定发送 true（官方 personal/enterprise 默认值在桌面端为 true）。
  "x-private-data": "true",
  "x-domain": WORKBUDDY_DOMAIN_CN,
};

/** 32 位无连字符 hex（UUIDv7 去连字符），对应官方 X-Request-ID 等。 */
function messageId() {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

/** 带连字符的 UUID，对应官方 X-Conversation-ID。 */
function conversationId() {
  return globalThis.crypto.randomUUID();
}

/** 16 hex 的随机 span id。 */
function spanId() {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 桌面端 5.8.4 抓包的链路头族：traceparent + b3 + X-B3-* + X-Trace-ID。
 * 桌面端主请求默认不带 X-B3-ParentSpanId，b3 为三段。
 */
function traceHeaders() {
  const trace = messageId();
  const span = spanId();
  return {
    "x-trace-id": trace,
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1`,
    "x-b3-traceid": trace,
    "x-b3-spanid": span,
    "x-b3-sampled": "1",
  };
}

/**
 * 会话头族。上游渠道校验要求这三项同时存在，缺任意一项都是 400 / 11128。
 * API Key（CLI 身份）和令牌登录都要带，不能只加在桌面端身份上。
 *
 * @param {object} [options]
 * @param {string} [options.userId] 参与派生稳定会话 ID
 * @param {string} [options.conversationKey] 同一会话多轮复用同一个会话 ID
 */
export function conversationHeaders(options = {}) {
  const userId = String(options.userId ?? "").trim() || "anonymous";
  const conversation = options.conversationKey
    ? stableConversationId(userId, options.conversationKey)
    : conversationId();
  const message = messageId();
  // 一轮 user send 内 X-Conversation-Request-ID 与 X-Root-Request-ID 同值。
  const turnRequest = messageId();
  return {
    "x-conversation-id": conversation,
    "x-conversation-request-id": turnRequest,
    "x-root-request-id": turnRequest,
    "x-conversation-message-id": message,
    "x-request-id": message,
  };
}

/**
 * 构造 WorkBuddy 桌面端身份头。
 *
 * 覆盖官方 `build_identity_headers(PRODUCT_DESKTOP)` 的完整头集，除静态头外
 * 还包含会话头族（X-Conversation-* / X-Request-ID）与链路头族。
 * 缺少会话头会触发上游渠道校验（400 / `conversation id missing`）。
 *
 * @param {object} [options]
 * @param {string} [options.userId] 账号 user id；缺省为 anonymous
 * @param {string} [options.conversationKey] 稳定的会话键，用于复用会话 ID
 */
export function workBuddyIdentityHeaders(options = {}) {
  const userId = String(options.userId ?? "").trim() || "anonymous";
  return {
    "x-user-id": userId,
    ...conversationHeaders({ ...options, userId }),
    ...traceHeaders(),
  };
}

/**
 * 按「账号 + 会话键」稳定派生会话 ID，同一会话多轮复用，
 * 避免每个请求都成为一次性会话（与人类客户端画像不符）。
 */
function stableConversationId(userId, sessionKey) {
  const digest = createHash("sha256").update(`${userId}|${sessionKey}`).digest("hex").slice(0, 32);
  const chars = [...digest];
  chars[12] = "4";
  chars[16] = "a";
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 把身份写法收敛成 IDENTITY_* 之一；未知值回落到 CLI。 */
export function normalizeIdentity(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === IDENTITY_WORKBUDDY || normalized === "wb" || normalized === "desktop") {
    return IDENTITY_WORKBUDDY;
  }
  return IDENTITY_CLI;
}

/**
 * 合并出站身份头。
 *
 * CLI 与 WorkBuddy 都覆盖各自的静态头。调用方传入 `identityHeaders` 时两边都会合并
 * （聊天请求用它带上会话头族）。未传入时只有 WorkBuddy 身份自动补会话头与链路头。
 *
 * @param {HeadersInit} [input] 已有请求头
 * @param {string} [identity] IDENTITY_CLI 或 IDENTITY_WORKBUDDY
 * @param {object} [options]
 * @param {Record<string,string>} [options.identityHeaders] 预构造的动态身份头
 */
export function codeBuddyHeaders(input, identity = IDENTITY_CLI, options = {}) {
  const headers = new Headers(input);
  for (const key of [...headers.keys()]) {
    if (key.startsWith("x-stainless-")) headers.delete(key);
  }
  const isWorkBuddy = normalizeIdentity(identity) === IDENTITY_WORKBUDDY;
  const profile = isWorkBuddy ? IDENTITY_WORKBUDDY_HEADERS : IDENTITY_CLI_HEADERS;
  for (const [key, value] of Object.entries(profile)) headers.set(key, value);
  const dynamic = options.identityHeaders ?? (isWorkBuddy ? workBuddyIdentityHeaders(options) : undefined);
  if (dynamic) {
    for (const [key, value] of Object.entries(dynamic)) headers.set(key, value);
  }
  return Object.fromEntries(headers);
}
const REQUEST_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  ...codeBuddyHeaders(),
};

/**
 * 登录相关接口（auth/state、auth/token、login/account）需要浏览器侧头族。
 *
 * 对齐参考实现 workbuddy2api-hub 的 `start_login` / `poll_login`：
 * UA 用两段式 `WorkBuddy/<桌面端版本>`（billing_ua，而非会话用的三段式 chat_ua），
 * 并带上 Origin / Referer / X-Requested-With。
 *
 * 实测：`platform` 才决定登录页域名，Origin 不影响（四种组合均 200）；
 * 但登录页落在 workbuddy.cn 时，Origin 也声明为 workbuddy.cn 更自洽。
 */
const LOGIN_ORIGIN = "https://www.workbuddy.cn";
const LOGIN_HEADERS = {
  accept: "application/json, text/plain, */*",
  "content-type": "application/json",
  "x-requested-with": "XMLHttpRequest",
  "user-agent": `WorkBuddy/${WORKBUDDY_DESKTOP_VERSION}`,
  origin: LOGIN_ORIGIN,
  referer: `${LOGIN_ORIGIN}/`,
};
const NO_ACCOUNT_HEADERS = {
  "X-No-Authorization": "true",
  "X-No-User-Id": "true",
  "X-No-Enterprise-Id": "true",
  "X-No-Department-Info": "true",
};
const NO_ID_HEADERS = {
  "X-No-User-Id": "true",
  "X-No-Enterprise-Id": "true",
  "X-No-Department-Info": "true",
};

function calculateExpiresAt(auth, now = Date.now()) {
  const result = { ...auth };
  if (!result.expiresAt && Number.isFinite(result.expiresIn)) result.expiresAt = now + result.expiresIn * 1000;
  if (!result.refreshExpiresAt && Number.isFinite(result.refreshExpiresIn)) result.refreshExpiresAt = now + result.refreshExpiresIn * 1000;
  return result;
}

async function responseBody(response, action) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${action}返回了无法解析的数据`, { cause: error });
  }
}

async function request(path, options, action) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, options);
  } catch (error) {
    if (options.signal?.aborted) throw new Error(`${action}已取消`, { cause: error });
    throw new Error(`${action}无法连接 WorkBuddy 中国站`, { cause: error });
  }
  const body = await responseBody(response, action);
  if (!response.ok || body?.code !== 0) throw new Error(`${action}失败（${body?.message ?? body?.msg ?? response.status}）`);
  return body.data;
}

function enterpriseHeaders(session) {
  const enterpriseId = session.account?.enterpriseId;
  return {
    ...(enterpriseId ? { "X-Enterprise-Id": enterpriseId, "X-Tenant-Id": enterpriseId } : {}),
    ...(session.auth?.domain ? { "X-Domain": session.auth.domain } : {}),
  };
}

async function poll(path, headers, action, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(1000, undefined, { signal });
    let response;
    try {
      response = await fetch(`${BASE_URL}${path}`, { headers: { ...REQUEST_HEADERS, ...LOGIN_HEADERS, ...headers }, signal });
    } catch (error) {
      if (signal?.aborted) throw new Error(`${action}已取消`, { cause: error });
      continue;
    }
    const body = await responseBody(response, action);
    if (response.ok && body?.code === 0 && body.data) return body.data;
    if (response.status === 401 || response.status === 403) throw new Error(`${action}失败（${body?.message ?? body?.msg ?? response.status}）`);
  }
  throw new Error(`${action}超时`);
}

function openBrowser(url) {
  const [command, args] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

function textValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function tokenClaims(token) {
  if (typeof token !== "string") return {};
  try {
    const payload = token.split(".")[1];
    if (!payload) return {};
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeApiKeyEntry(entry, now = Date.now()) {
  const ref = textValue(entry?.ref);
  if (!ref || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error("WorkBuddy API Key 引用无效");
  const id = textValue(entry?.id) ?? `dsh:${ref}`;
  return {
    id,
    ref,
    label: textValue(entry?.label) ?? "DSH 保存的 API Key",
    createdAt: Number.isFinite(entry?.createdAt) ? entry.createdAt : now,
    updatedAt: Number.isFinite(entry?.updatedAt) ? entry.updatedAt : now,
  };
}

export function createWorkBuddyApiKeyStore(entries = [], activeId) {
  const keys = [];
  for (const entry of entries) {
    const normalized = normalizeApiKeyEntry(entry);
    if (!keys.some((item) => item.id === normalized.id || item.ref === normalized.ref)) keys.push(normalized);
  }
  const selected = activeId === null
    ? null
    : typeof activeId === "string" && keys.some((entry) => entry.id === activeId) ? activeId : keys[0]?.id;
  return { version: 1, activeId: selected, entries: keys };
}

export function upsertWorkBuddyApiKey(store, entry, now = Date.now()) {
  const current = createWorkBuddyApiKeyStore(store?.entries ?? [], store?.activeId);
  const incoming = normalizeApiKeyEntry({ ...entry, updatedAt: now }, now);
  const index = current.entries.findIndex((item) => item.id === incoming.id || item.ref === incoming.ref);
  if (index >= 0) incoming.createdAt = current.entries[index].createdAt;
  const entries = index >= 0
    ? current.entries.map((item, position) => position === index ? incoming : item)
    : [...current.entries, incoming];
  return { version: 1, activeId: incoming.id, entries };
}

export function serializeWorkBuddyApiKeys(store) {
  const normalized = createWorkBuddyApiKeyStore(store?.entries ?? [], store?.activeId);
  return JSON.stringify(normalized);
}

export function parseWorkBuddyApiKeys(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("WorkBuddy API Key 列表已损坏，请重新配置", { cause: error });
  }
  if (!Array.isArray(parsed?.entries)) throw new Error("WorkBuddy API Key 列表格式无效，请重新配置");
  return createWorkBuddyApiKeyStore(parsed.entries, parsed.activeId);
}

export function workBuddyApiKeyEntries(store) {
  return (store?.entries ?? []).map(({ id, ref, label, createdAt, updatedAt }) => ({ id, ref, label, createdAt, updatedAt }));
}

function normalizeAccount(account, auth) {
  // The account endpoint has returned both a flat object and wrapped objects
  // across WorkBuddy versions. Keep all known wrappers in the lookup so a newly
  // added account gets the same display metadata as an imported account.
  const sources = [
    account,
    account?.account,
    account?.user,
    account?.userInfo,
    account?.profile,
    account?.data,
  ].filter((source) => source && typeof source === "object");
  const read = (...keys) => textValue(...sources.flatMap((source) => keys.map((key) => source[key])));
  const claims = tokenClaims(auth?.accessToken);
  const userId = read("userId", "uid", "user_id", "id") ?? textValue(claims.userId, claims.uid, claims.user_id, claims.sub);
  const enterpriseId = read("enterpriseId", "tenantId", "enterprise_id", "tenant_id")
    ?? textValue(claims.enterpriseId, claims.tenantId, claims.enterprise_id, claims.tenant_id);
  const email = read("email", "mail", "emailAddress") ?? textValue(claims.email, claims.mail);
  const uin = read("uin", "phoneNumber", "phone", "mobile", "mobilePhone")
    ?? textValue(claims.uin, claims.phoneNumber, claims.phone_number, claims.mobile);
  const type = read("type", "accountType", "account_type");
  const displayName = read("displayName", "name", "nickname", "username", "accountName")
    ?? uin
    ?? textValue(claims.displayName, claims.name, claims.nickname, claims.username, claims.preferred_username)
    ?? email;
  return {
    ...(userId ? { userId } : {}),
    ...(enterpriseId ? { enterpriseId } : {}),
    ...(email ? { email } : {}),
    ...(uin ? { uin } : {}),
    ...(type ? { type } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function workBuddySessionId(session) {
  const account = normalizeAccount(session?.account, session?.auth);
  if (account.userId) return `user:${account.userId}`;
  if (account.email) return `email:${account.email}`;
  if (account.enterpriseId) return `enterprise:${account.enterpriseId}`;
  const refreshToken = session?.auth?.refreshToken ?? session?.auth?.accessToken;
  if (!refreshToken) throw new Error("WorkBuddy 登录会话缺少账号标识和令牌");
  return `token:${createHash("sha256").update(refreshToken).digest("hex")}`;
}

function workBuddySessionLabel(session) {
  const account = normalizeAccount(session?.account, session?.auth);
  return account.displayName ?? account.email ?? account.userId ?? account.enterpriseId ?? `账号 ${workBuddySessionId(session).slice(-8)}`;
}

function normalizeWorkBuddySessionEntry(session, now = Date.now()) {
  const normalized = {
    auth: calculateExpiresAt(session?.auth),
    account: normalizeAccount(session?.account, session?.auth),
  };
  if (!normalized.auth.accessToken || !normalized.auth.refreshToken) throw new Error("WorkBuddy 登录会话无效");
  const id = typeof session?.id === "string" && session.id.trim() ? session.id : workBuddySessionId(normalized);
  const createdAt = Number.isFinite(session?.createdAt) ? session.createdAt : now;
  return {
    id,
    label: typeof session?.label === "string" && session.label.trim() ? session.label : workBuddySessionLabel(normalized),
    createdAt,
    updatedAt: Number.isFinite(session?.updatedAt) ? session.updatedAt : now,
    ...normalized,
  };
}

export function createWorkBuddySessionStore(entries = [], activeId) {
  const sessions = [];
  for (const entry of entries) {
    const normalized = normalizeWorkBuddySessionEntry(entry);
    if (!sessions.some((item) => item.id === normalized.id)) sessions.push(normalized);
  }
  const selected = typeof activeId === "string" && sessions.some((entry) => entry.id === activeId) ? activeId : sessions[0]?.id;
  return { version: 1, activeId: selected, sessions };
}

export function upsertWorkBuddySession(store, session, now = Date.now()) {
  const current = createWorkBuddySessionStore(store?.sessions ?? [], store?.activeId);
  const incoming = normalizeWorkBuddySessionEntry({ ...session, updatedAt: now }, now);
  const index = current.sessions.findIndex((entry) => entry.id === incoming.id);
  if (index >= 0) incoming.createdAt = current.sessions[index].createdAt;
  const sessions = index >= 0
    ? current.sessions.map((entry, position) => position === index ? incoming : entry)
    : [...current.sessions, incoming];
  return { version: 1, activeId: incoming.id, sessions };
}

export function activeWorkBuddySession(store) {
  return store?.sessions?.find((entry) => entry.id === store.activeId) ?? store?.sessions?.[0];
}

export function workBuddySessionAccounts(store) {
  return (store?.sessions ?? []).map(({ id, label, account, createdAt, updatedAt }) => ({
    id,
    label,
    accountName: label,
    userId: account?.userId ?? null,
    account,
    createdAt,
    updatedAt,
  }));
}

/**
 * 登录页所属平台。服务端按此参数决定跳转域名：
 *   CLI / Desktop / VSCode → https://copilot.tencent.com/login
 *   WorkBuddy              → https://www.workbuddy.cn/login
 * 本插件面向 WorkBuddy，令牌登录应落在 WorkBuddy 官网而非 CodeBuddy 控制台。
 */
const LOGIN_PLATFORM = "WorkBuddy";

/**
 * 登录页参数。
 *
 * 企微入口的显示条件（反编译登录 SPA 得到的确切逻辑）：
 *
 *   const MIN_WECOM_VERSION = "5.8.0";
 *   const versionOk = (platform, version) =>
 *     platform.toLowerCase() !== "workbuddy" ? true
 *       : semverGte(version, MIN_WECOM_VERSION);
 *
 *   const showWecomLogin = ({ platform, version, hostname, isMobile, ua }) => {
 *     const host = hostname.toLowerCase();
 *     return (host === "codebuddy.cn" || host.endsWith(".codebuddy.cn")
 *             || isExcludedPlatform(platform) || !versionOk(platform, version))
 *       ? false
 *       : !isMobile || isWecomUa(ua);
 *   };
 *
 * 也就是说 `platform=WorkBuddy` 时，**URL 必须带 `version` 且 ≥ 5.8.0**，
 * 否则企微入口不会渲染。此外还有一层 lamp 开关：
 * `lamp_signin_wecom=1` 强制开启，缺省则回落到服务端下发值。
 *
 * 这里补齐这两个条件：版本号取当前桌面客户端版本（5.9.2，来自官方客户端
 * 实际登录链接），并显式打开 lamp 开关。
 */
const LOGIN_LAMP_FLAGS = Object.freeze({
  // 版本号决定企微入口是否渲染（要求 >= 5.8.0），并与身份头共用同一来源。
  version: WORKBUDDY_DESKTOP_VERSION,
  // 企微入口的开关：1 强制显示。
  lamp_signin_wecom: "1",
});

/** 给 authUrl 补上登录页参数，保留原有查询串（已有同名参数不覆盖）。 */
function withLoginFlags(authUrl) {
  try {
    const url = new URL(authUrl);
    for (const [key, value] of Object.entries(LOGIN_LAMP_FLAGS)) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    // authUrl 不是合法 URL 时原样返回，避免阻断登录流程。
    return authUrl;
  }
}

export async function loginWorkBuddy(onAuthUrl, signal) {
  const state = await request(`/auth/state?platform=${encodeURIComponent(LOGIN_PLATFORM)}`, {
    method: "POST",
    headers: { ...REQUEST_HEADERS, ...LOGIN_HEADERS, ...NO_ACCOUNT_HEADERS },
    body: "{}",
    signal,
  }, "创建 WorkBuddy 登录会话");
  if (!state?.state || !state?.authUrl) throw new Error("WorkBuddy 登录接口没有返回登录地址");
  const authUrl = withLoginFlags(state.authUrl);
  try {
    await openBrowser(authUrl);
    onAuthUrl?.(authUrl, true);
  } catch {
    onAuthUrl?.(authUrl, false);
  }
  const auth = calculateExpiresAt(await poll(
    `/auth/token?state=${encodeURIComponent(state.state)}`,
    NO_ACCOUNT_HEADERS,
    "等待 WorkBuddy 登录",
    10 * 60_000,
    signal,
  ));
  if (!auth.accessToken || !auth.refreshToken) throw new Error("WorkBuddy 登录接口没有返回完整令牌");
  const account = await poll(
    `/login/account?state=${encodeURIComponent(state.state)}`,
    { ...enterpriseHeaders({ auth }), authorization: `Bearer ${auth.accessToken}`, ...NO_ID_HEADERS },
    "获取 WorkBuddy 账号",
    60_000,
    signal,
  );
  return { auth, account: normalizeAccount(account, auth) };
}

export async function refreshWorkBuddySession(session, signal) {
  if (!session?.auth?.refreshToken) throw new Error("WorkBuddy 登录会话缺少刷新令牌，请重新登录");
  const auth = await request("/auth/token/refresh", {
    method: "POST",
    headers: {
      ...REQUEST_HEADERS,
      ...enterpriseHeaders(session),
      "X-Refresh-Token": session.auth.refreshToken,
      "X-Auth-Refresh-Source": "plugin",
    },
    body: "{}",
    signal,
  }, "刷新 WorkBuddy 登录令牌");
  const fresh = calculateExpiresAt(auth);
  const merged = { ...session.auth, ...fresh, refreshToken: fresh?.refreshToken ?? session.auth.refreshToken };
  if (!merged.accessToken) throw new Error("WorkBuddy 刷新接口没有返回访问令牌");
  return { auth: merged, account: normalizeAccount(session.account, merged) };
}

export function serializeWorkBuddySession(session) {
  if (!session?.auth?.accessToken || !session?.auth?.refreshToken) throw new Error("WorkBuddy 登录会话无效");
  return JSON.stringify({ auth: calculateExpiresAt(session.auth), account: normalizeAccount(session.account, session.auth) });
}

export function serializeWorkBuddySessions(store) {
  const normalized = createWorkBuddySessionStore(store?.sessions ?? [], store?.activeId);
  if (normalized.sessions.length === 0) throw new Error("WorkBuddy 登录账号列表为空");
  return JSON.stringify(normalized);
}

export function parseWorkBuddySession(value) {
  let session;
  try {
    session = JSON.parse(value);
  } catch (error) {
    throw new Error("WorkBuddy 登录凭据已损坏，请重新登录", { cause: error });
  }
  if (!session?.auth?.accessToken || !session?.auth?.refreshToken) throw new Error("WorkBuddy 登录凭据不完整，请重新登录");
  return { auth: calculateExpiresAt(session.auth), account: normalizeAccount(session.account, session.auth) };
}

export function parseWorkBuddySessions(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("WorkBuddy 登录账号列表已损坏，请重新登录", { cause: error });
  }
  if (Array.isArray(parsed?.sessions)) return createWorkBuddySessionStore(parsed.sessions, parsed.activeId);
  if (parsed?.auth) {
    const session = parseWorkBuddySession(value);
    return createWorkBuddySessionStore([session], workBuddySessionId(session));
  }
  throw new Error("WorkBuddy 登录账号列表格式无效，请重新登录");
}

export function sessionNeedsRefresh(session, now = Date.now()) {
  const expiresAt = Number(session?.auth?.expiresAt);
  if (Number.isFinite(expiresAt)) return expiresAt <= now + 2 * 60_000;
  try {
    const payload = JSON.parse(Buffer.from(session.auth.accessToken.split(".")[1], "base64url").toString("utf8"));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 <= now + 2 * 60_000 : true;
  } catch {
    return true;
  }
}

export function sessionCacheDeadline(session, now = Date.now()) {
  const expiresAt = Number(session?.auth?.expiresAt);
  return Number.isFinite(expiresAt)
    ? Math.max(now, Math.min(expiresAt - 2 * 60_000, now + 30 * 60_000))
    : now + 5 * 60_000;
}
