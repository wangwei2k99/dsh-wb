import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { __testing, apply } from "./index.js";
import {
  workBuddyApiKeyEntries,
  activeWorkBuddySession,
  workBuddySessionAccounts,
  createWorkBuddyApiKeyStore,
  createWorkBuddySessionStore,
  createWorkBuddySessionRoutingState,
  parseWorkBuddyApiKeys,
  parseWorkBuddySession,
  parseWorkBuddySessions,
  refreshWorkBuddySession,
  serializeWorkBuddyApiKeys,
  serializeWorkBuddySession,
  serializeWorkBuddySessions,
  serializeWorkBuddySessionRouting,
  parseWorkBuddySessionRouting,
  sessionNeedsRefresh,
  upsertWorkBuddyApiKey,
  upsertWorkBuddySession,
} from "./workbuddy-auth.js";
import { authenticationMode, installWorkBuddyWeb, __testing as webTesting } from "./workbuddy-web.js";
import { __testing as creditsTesting, fetchWorkBuddyCredits } from "./workbuddy-credits.js";
import { probeEndpoint } from "./workbuddy-discovery.js";
import { effectiveSessionWindow, resolveSessionWindow } from "./session-tiers.js";

test("插件展示元信息由 locale 提供，且经 exports 暴露给 DSH 读取", () => {
  const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
  const pkg = readJson("./package.json");
  const zh = readJson("./locale/zh.json");
  const en = readJson("./locale/en.json");
  // DSH 从 <包名>/locale/<语言>.json 的 meta 读标题，缺字段才回退到包名。
  assert.equal(zh.meta.title, "wangwei2k99/dsh-workbuddy");
  assert.equal(en.meta.title, zh.meta.title);
  assert.ok(zh.meta.description.length > 0 && en.meta.description.length > 0);
  // 没在 exports 里声明 ./locale/*，DSH 解析不到文件，标题会退回包名。
  assert.equal(pkg.exports["./locale/*"], "./locale/*");
  assert.ok(pkg.files.includes("locale/zh.json") && pkg.files.includes("locale/en.json"));
});

test("桌面端页面可调用本机认证接口，外部来源仍被拒绝", () => {
  const req = (address, origin) => ({ socket: { remoteAddress: address }, headers: { origin } });
  assert.equal(webTesting.localPost(req("127.0.0.1", "dsh-app://app")), true);
  assert.equal(webTesting.localPost(req("127.0.0.1", "dsh-app://evil")), false);
  assert.equal(webTesting.localPost(req("192.0.2.1", "dsh-app://app")), false);
  const desktop = { socket: { remoteAddress: "127.0.0.1" }, headers: { "user-agent": "Mozilla/5.0 @deepseek-ai/dsh-desktop/0.2.0-rc.2 Electron/44.0.0" } };
  assert.equal(webTesting.localPost(desktop), true);
  assert.equal(webTesting.localPost({ ...desktop, socket: { remoteAddress: "192.0.2.1" } }), false);
  assert.equal(webTesting.localPost({ ...desktop, headers: { "user-agent": "Mozilla/5.0" } }), false);
});

test("自定义 OpenAI Provider 可从端点读取模型目录，并优先使用本次输入的 Key", async () => {
  const previous = globalThis.fetch;
  let observed;
  globalThis.fetch = async (url, options) => {
    observed = { url, options };
    return new Response(JSON.stringify({ data: [
      { id: "model-a", name: "Model A", context_window: 128000, max_output_tokens: 8192 },
      { id: "" },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const models = await probeEndpoint({ provider: "my-provider", api: "openai-responses", apiKey: "new-key" }, {
      profiles: () => new Map([["my-provider", { baseURL: "https://example.test/v1/", headers: { "x-extra": "yes" } }]]),
      resolveCredential: () => { throw new Error("输入新 Key 时不应读取旧凭证"); },
    });
    assert.equal(observed.url, "https://example.test/v1/models");
    assert.equal(observed.options.headers.get("authorization"), "Bearer new-key");
    assert.equal(observed.options.headers.get("x-extra"), "yes");
    assert.deepEqual(models, [{ id: "model-a", name: "Model A", contextWindow: 128000, maxTokens: 8192 }]);
  } finally {
    globalThis.fetch = previous;
  }
});

test("自定义 Anthropic Provider 使用对应端点和认证头", async () => {
  const previous = globalThis.fetch;
  let observed;
  globalThis.fetch = async (url, options) => {
    observed = { url, options };
    return new Response(JSON.stringify({ data: [{ id: "claude-test", display_name: "Claude Test" }] }), { status: 200 });
  };
  try {
    const models = await probeEndpoint({ provider: "anthropic-custom", baseURL: "https://example.test", api: "anthropic-messages" }, {
      profiles: () => new Map([["anthropic-custom", { headers: { authorization: "Bearer stale" } }]]),
      resolveCredential: async () => ({ value: "saved-key" }),
    });
    assert.equal(observed.url, "https://example.test/v1/models?limit=1000");
    assert.equal(observed.options.headers.get("x-api-key"), "saved-key");
    assert.equal(observed.options.headers.get("authorization"), null);
    assert.equal(observed.options.headers.get("anthropic-version"), "2023-06-01");
    assert.deepEqual(models, [{ id: "claude-test", name: "Claude Test" }]);
  } finally {
    globalThis.fetch = previous;
  }
});

test("富模型目录忽略非对象项，超限响应被拒绝", async () => {
  const previous = globalThis.fetch;
  const discovery = () => probeEndpoint({ baseURL: "https://example.test/v1" }, {
    profiles: () => new Map(), resolveCredential: async () => undefined,
  });
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ models: {
      "model-b": { name: "Model B", limit: { context: 64000 }, top_provider: { max_completion_tokens: 4096 } },
      invalid: "not-a-model",
    } }), { status: 200 });
    assert.deepEqual(await discovery(), [{ id: "model-b", name: "Model B", contextWindow: 64000, maxTokens: 4096 }]);
    globalThis.fetch = async () => new Response("oversized", { status: 200, headers: { "content-length": String(4 * 1024 * 1024 + 1) } });
    await assert.rejects(discovery(), (error) => error.code === "DISCOVERY_FAILED" && /4 MiB/.test(error.message));
  } finally {
    globalThis.fetch = previous;
  }
});

test("模型探测的失败保留可操作错误，且不回显凭证", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
  try {
    await assert.rejects(
      probeEndpoint({ provider: "custom", baseURL: "https://example.test/v1", apiKey: "secret-value" }, {
        profiles: () => new Map(), resolveCredential: async () => undefined,
      }),
      (error) => error.code === "DISCOVERY_FAILED" && /401/.test(error.message) && !error.message.includes("secret-value"),
    );
    await assert.rejects(
      probeEndpoint({ baseURL: "https://example.test/v1", api: "unsupported" }, {
        profiles: () => new Map(), resolveCredential: async () => undefined,
      }),
      (error) => error.code === "DISCOVERY_UNSUPPORTED",
    );
  } finally {
    globalThis.fetch = previous;
  }
});

test("当前 DSH 适配器在无 WebUI 的调用前拉取新模型并完成 prepareCall", async () => {
  const previous = globalThis.fetch;
  let adapter;
  let discover;
  let requestCount = 0;
  const ctx = {
    inject() {},
    get(key) {
      if (key === "launchEnvironment") return { get: () => undefined };
      if (key === "credentials") return {
        resolve: async (ref) => String(ref).includes("WORKBUDDY_API_KEY") ? { value: "test-key" } : undefined,
      };
      return undefined;
    },
    llm: {
      registerConfigurableProviders: () => ({ replace() {} }),
      registerAdapter: (_providers, value) => { adapter = value; return { replace() {} }; },
      registerModelDiscovery: (_ns, value) => { discover = value; },
    },
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://copilot.tencent.com/v3/config");
    assert.equal(new Headers(options.headers).get("x-ide-name"), "CodeBuddy");
    requestCount += 1;
    return new Response(JSON.stringify({ code: 0, data: {
      agents: [{ name: "cli", models: ["deepseek-v4.1-flash"] }],
      models: [{ id: "deepseek-v4.1-flash", name: "Deepseek V4.1 Flash", maxInputTokens: 128000, maxOutputTokens: 8192 }],
    } }), { status: 200 });
  };
  try {
    apply(ctx, { providers: {} });
    const prepared = await adapter.prepareCall("workbuddy-cn", "deepseek-v4.1-flash");
    assert.equal(prepared.model.id, "deepseek-v4.1-flash");
    assert.equal(typeof prepared.stream, "function");
    assert.equal(requestCount, 1);
    const controller = new AbortController();
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://example.test/v1/models");
      assert.strictEqual(options.signal, controller.signal);
      return new Response(JSON.stringify({ data: [{ id: "custom-model" }] }), { status: 200 });
    };
    assert.deepEqual(await discover({ baseURL: "https://example.test/v1", apiKey: "test-key" }, controller.signal), [{ id: "custom-model" }]);
  } finally {
    globalThis.fetch = previous;
  }
});

test("桌面端 prepared stream 能发送文本并收到首个模型输出", async () => {
  const previous = globalThis.fetch;
  let expectedSystem;
  let expectedTools;
  let adapter;
  const ctx = {
    inject() {},
    get(key) {
      if (key === "launchEnvironment") return { get: () => undefined };
      if (key === "credentials") return {
        resolve: async (ref) => String(ref).includes("WORKBUDDY_API_KEY") ? { value: "test-key" } : undefined,
      };
      return undefined;
    },
    llm: {
      registerConfigurableProviders: () => ({ replace() {} }),
      registerAdapter: (_providers, value) => { adapter = value; return { replace() {} }; },
      registerModelDiscovery() {},
    },
  };
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/v3/config")) return new Response(JSON.stringify({ code: 0, data: {
      agents: [{ name: "cli", models: ["deepseek-v4.1-flash"] }],
      models: [{ id: "deepseek-v4.1-flash", maxInputTokens: 128000, maxOutputTokens: 8192 }],
    } }), { status: 200 });
    assert.match(String(url), /\/v2\/chat\/completions$/);
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer test-key");
    assert.equal(new Headers(options.headers).get("x-api-key"), "test-key");
    assert.equal(new Headers(options.headers).get("x-ide-name"), "CodeBuddy");
    const body = JSON.parse(options.body);
    if (expectedSystem) {
      assert.ok(body.messages.some(message => message.role === "system" && message.content.includes("You are CodeBuddy, an AI coding assistant.")));
    }
    if (expectedTools) assert.equal(body.tools.length, expectedTools.length);
    for (const message of body.messages.filter((entry) => ["system", "developer"].includes(entry.role))) {
      assert.doesNotMatch(JSON.stringify(message.content), /agent powered by|assistant built on/i);
    }
    return new Response([
      'data: {"id":"test","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
      'data: {"id":"test","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    apply(ctx, { providers: {} });
    const prepared = await adapter.prepareCall("workbuddy-cn", "deepseek-v4.1-flash");
    for (const request of [
      { messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }] },
      { messages: [{ role: "system", content: [{ type: "text", text: "You are an AI agent powered by DeepSeek Harness.\n保留工作要求。" }] }, { role: "user", content: [{ type: "text", text: "你好" }] }] },
      { tools: [{ name: "test", description: "test", parameters: { type: "object", properties: {} } }], messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }] },
      { system: "You are a coding agent powered by the deepseek-v4.1-flash model.", maxTokens: 128, purpose: "title", messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }] },
    ]) {
      expectedSystem = request.system;
      expectedTools = request.tools;
      const chunks = [];
      for await (const chunk of prepared.stream({ provider: "workbuddy-cn", model: "deepseek-v4.1-flash", sessionId: "desktop-test", ...request })) chunks.push(chunk);
      assert.ok(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "你好"), JSON.stringify(chunks));
      assert.ok(chunks.some((chunk) => chunk.type === "finish" && chunk.reason?.kind === "stop"), JSON.stringify(chunks));
    }
    globalThis.fetch = async () => Response.json({ code: 11128, msg: "private-server-message" }, { status: 400 });
    const failures = [];
    for await (const chunk of prepared.stream({ provider: "workbuddy-cn", model: "deepseek-v4.1-flash", messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }] })) failures.push(chunk);
    const failure = failures.find((chunk) => chunk.type === "finish" && chunk.reason?.kind === "error");
    assert.ok(failure);
    assert.match(failure.reason.failure.message, /11128/);
    assert.doesNotMatch(failure.reason.failure.message, /private-server-message/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("新旧 DSH 配置都注册 WorkBuddy，next 使用插件条目命名空间", () => {
  const registered = [];
  const directories = [];
  const discoveries = [];
  const listeners = new Map();
  const injected = [];
  const ctx = {
    fiber: { entry: { options: { id: "dsh-workbuddy" } } },
    inject(names, callback) { injected.push({ names, callback }); },
    on(event, callback) { listeners.set(event, callback); },
    llm: {
      registerConfigurableProviders(entries) {
        directories.push(entries);
        return { replace(next) { directories.push(next); } };
      },
      registerAdapter(providers) {
        registered.push(providers);
        return { replace(next) { registered.push(next); } };
      },
      registerModelDiscovery(ns) { discoveries.push(ns); },
    },
  };
  const reactive = { providers: { get: () => ({
    "custom-gateway": { api: "openai-completions", baseURL: "https://example.test/v1", models: [{ id: "custom-model" }] },
  }) } };
  assert.ok(__testing.providerSettings(reactive)["custom-gateway"]);
  apply(ctx, reactive);
  assert.deepEqual(registered[0], ["workbuddy-cn"]);
  assert.deepEqual(directories[0].map((entry) => entry.provider), ["workbuddy-cn"]);
  assert.equal(directories[0][0].settingsNs, "dsh-workbuddy");
  assert.deepEqual(discoveries, ["dsh-workbuddy"]);
  assert.ok(listeners.has("loader/volatile-update"));
  assert.ok(injected.some(({ names }) => names.includes("settings")));

  const legacy = { ...ctx, on: undefined, inject() {} };
  registered.length = directories.length = discoveries.length = 0;
  apply(legacy, { providers: {} });
  assert.deepEqual(registered[0], ["workbuddy-cn"]);
  assert.equal(directories[0][0].settingsNs, "llm-pi-ai");
  assert.deepEqual(discoveries, ["llm-pi-ai"]);
});

test("认证模式写入新旧 DSH 各自的配置命名空间", async () => {
  for (const modern of [false, true]) {
    const ns = modern ? "llm-workbuddy" : "llm-pi-ai";
    const calls = [];
    const service = {
      ...(modern
        ? { describe: () => [{ ns, value: { providers: {} } }] }
        : { get: () => ({ providers: {} }) }),
      mutate: async (target, ops) => { calls.push({ target, ops }); },
    };
    await webTesting.setMode(webTesting.settingsAccess(service, ns), "token");
    assert.equal(calls[0].target, ns);
    assert.deepEqual(calls[0].ops[0].path, ["providers", "workbuddy-cn"]);
  }
});

test("新版 WorkBuddy 卡片保留旧版认证入口并提供模型编辑", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  assert.match(client, /settings\.models\.provider-card/);
  assert.match(client, /for \(const key of \["dsh-workbuddy", "llm-workbuddy"\]\)/);
  assert.match(client, /name: "plugins\.detail\.section",\s*id: "dsh-workbuddy"/);
  assert.match(client, /mount\(input\)/);
  assert.match(client, /mountModelEditor\(models\)/);
  assert.equal(webTesting.validModelOverrides([{ id: "glm-5.3", contextWindow: 262144, maxTokens: 32768 }]), true);
  assert.equal(webTesting.validModelOverrides([{ id: "duplicate" }, { id: "duplicate" }]), false);
  assert.equal(webTesting.validModelOverrides([{ id: "bad", maxTokens: -1 }]), false);
});

test("空会话按部署默认模型回落，不把模型名写死", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  // 新会话投影是 { lastUsed: null, next: null }，必须回落到部署默认值，
  // 否则用量条与上下文窗口控件都会因取不到 provider/model 而不渲染。
  assert.match(client, /selection\?\.next \?\? selection\?\.lastUsed/);
  // 默认值来源是宿主的 agentDefaultModel（经本插件自己的路由下发），
  // 不依赖客户端内部服务模型的私有字段。
  assert.match(client, /status\?\.defaultSelection/);
  assert.match(client, /function useDefaultSelection/);
  // 回落链里不允许出现写死的 provider/model 名。
  assert.doesNotMatch(client, /const DEFAULT_PROVIDER = "workbuddy-cn"/);
  assert.doesNotMatch(client, /const DEFAULT_MODEL = "deepseek/);
});

test("默认模型来自宿主 agentDefaultModel，而非模型列表首项", () => {
  const web = readFileSync(new URL("./workbuddy-web.js", import.meta.url), "utf8");
  // 宿主 buildModelCatalog 的默认值就是 currentSelection()：
  // 增删模型或调整顺序都不该改变它。
  assert.match(web, /get\("agentDefaultModel"\)/);
  assert.match(web, /currentSelection\?\.\(\)/);
  assert.match(web, /defaultSelection: defaultSelection\(\) \?\? null/);
});

test("provider 与 model 必须来自同一次解析，避免跨代际拼装", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  assert.match(client, /function resolveSelection\(selection, fallback\)/);
  assert.match(client, /source: "projected"/);
  assert.match(client, /source: "default"/);
  assert.match(client, /source: "none"/);
  // 旧实现各读一次来源，可能 provider 与 model 来自不同快照。
  assert.doesNotMatch(client, /selectedProvider\(/);
  assert.doesNotMatch(client, /selectedModelId\(/);
});

test("档位写会话覆盖，不再写全局配置", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  // 档位写的是本会话的覆盖值：不动 profile 配置，两个会话因此互不影响。
  assert.match(client, /authRequest\("session-tier", \{/);
  assert.match(client, /sessionId,/);
  // 旧实现走 context-window 写全局模型定义，正是「两边一起变」的根因。
  assert.doesNotMatch(client, /authRequest\("context-window", \{\s*model: modelId,\s*contextWindow: budget\.contextWindow/);
});

test("没有会话 id 时档位控件只读", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  // 覆盖值必须挂在某个会话上，没有会话 id 就无处可写。
  assert.match(client, /const readOnly = sessionKey === undefined/);
  assert.match(client, /if \(readOnly\) return;/);
  assert.match(client, /disabled: busy \|\| readOnly/);
  // 只读时不宣称有菜单。
  assert.match(client, /"aria-haspopup": readOnly \? undefined : "menu"/);
});

test("会话覆盖先读后写，且提供恢复默认", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  // 初值优先用本会话覆盖，没有再回落到模型级默认值。
  assert.match(client, /tier\?\.override \?\? null/);
  assert.match(client, /override\?\.contextWindow/);
  // 撤销入口只在存在覆盖时出现，并写 null 清除。
  assert.match(client, /contextWindow: null \}\)/);
  assert.match(client, /hasOverride && createElement/);
});

test("会话级档位只动内存，按 sessionId 隔离", () => {
  const tiers = readFileSync(new URL("./session-tiers.js", import.meta.url), "utf8");
  // 官方 waterfall：签名带 agent，直接拿 sessionId，无需 patch 原型猜会话。
  assert.match(tiers, /ctx\.on\("agent\/request"/);
  // 覆盖值只存在 Map 里，不写配置、不写会话日志。
  assert.match(tiers, /const overrides = new Map\(\)/);
  assert.doesNotMatch(tiers, /settings\.mutate/);
  assert.doesNotMatch(tiers, /credentials\.set/);
  // 窗口必须与完成预留自洽，否则压缩会抛「没有消息预算」。
  assert.match(tiers, /export function clampCompletion/);
  assert.match(tiers, /export function resolveSessionWindow/);
  // 写入时按上游上限收敛。发请求时用已保存的会话窗口，允许大于配置里的默认窗口。
  assert.match(tiers, /Math\.min\(requested, base\)/);
  assert.match(tiers, /effectiveSessionWindow\(modelInfo\?\.context\?\.contextWindow/);
  assert.match(tiers, /agent\?\.session\?\.id/);
  assert.match(tiers, /agent\?\.id/);
});

test("会话窗口可以大于配置默认值，写入仍不超过上游上限", () => {
  const raised = effectiveSessionWindow(200_000, 1_000_000);
  assert.equal(raised.effective, 1_000_000);
  assert.equal(raised.changed, true);
  const unchanged = effectiveSessionWindow(200_000, 200_000);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.effective, 200_000);
  assert.equal(resolveSessionWindow(1_000_000, 2_000_000).effective, 1_000_000);
});

test("清除会话档位必须显式传 null，缺字段不能当清除", () => {
  const web = readFileSync(new URL("./workbuddy-web.js", import.meta.url), "utf8");
  // 漏传 contextWindow 若被当成清除，会静默抹掉用户的设置。
  assert.match(web, /Object\.hasOwn\(body, "contextWindow"\) && body\.contextWindow === null/);
  assert.match(web, /explicitClear/);
  assert.match(web, /必须是正整数，或显式传 null 清除/);
});

test("下拉菜单与官方原生菜单同档表面色", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  // 官方菜单表面色是 --dsw-specific-menu（暗色 #43454a73），不是 bg-overlay。
  // 用 bg-overlay 会比原生菜单亮一大截，并排时明显不一致。
  assert.doesNotMatch(client, /background:\s*var\(--dsw-alias-bg-overlay/);
  assert.match(client, /\.wb-cw-menu::before \{[\s\S]{0,400}?background: var\(--dsw-specific-menu/);
  // 半透明表面必须配毛玻璃，缺了它会显得偏实偏亮。
  assert.match(client, /backdrop-filter: var\(--dsw-menu-backdrop-filter/);
  // 官方下拉用 radius-lg，不是 md。
  assert.match(client, /border-radius: var\(--dsw-radius-lg, 16px\)/);
  // 描边用伪元素画 .5px，直接写 border 会挤动内容。
  assert.match(client, /\.wb-cw-menu::after \{[\s\S]{0,200}?border: \.5px solid var\(--dsw-alias-border-l1/);
});

test("headroom 按窗口等比缩放，不写死绝对值", () => {
  const tiers = readFileSync(new URL("./session-tiers.js", import.meta.url), "utf8");
  // 写死 64K headroom 会把 32K 窗口的输出压到 8K，违背输出预算目标。
  assert.match(tiers, /headroomRatio/);
  assert.doesNotMatch(tiers, /headroomTokens: 65_536/);
});

test("新版模型接口只修改 WorkBuddy 条目并保留认证模式", async () => {
  const routes = new Map();
  let providers = { "workbuddy-cn": {} };
  let revision = 4;
  const settings = {
    describe: () => [{ ns: "llm-workbuddy", value: { providers }, revision }],
    mutate: async (ns, ops, expected) => {
      assert.equal(ns, "llm-workbuddy");
      assert.equal(expected, revision);
      assert.deepEqual(ops[0].path, ["providers", "workbuddy-cn", "models"]);
      providers = { "workbuddy-cn": { ...providers["workbuddy-cn"], models: ops[0].value } };
      revision++;
    },
  };
  installWorkBuddyWeb({ inject: (_services, callback) => callback({
    settings,
    credentials: {},
    llm: { discoverModels: async () => [{ id: "glm-5.3" }] },
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => {}; } },
    effect: (callback) => callback(),
  }) }, "llm-workbuddy");
  const handler = routes.get("/dsh-workbuddy/auth/models");
  async function call(method, body) {
    let response;
    const req = {
      method,
      url: "/dsh-workbuddy/auth/models",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { origin: "http://localhost:3000" },
      async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); },
    };
    await handler(req, {
      writeHead(status) { response = { status }; },
      end(text) { response.body = JSON.parse(text); },
    });
    return response;
  }
  assert.deepEqual((await call("GET")).body, { ok: true, models: null, catalog: {}, revision: 4 });
  assert.deepEqual((await call("POST", { action: "discover" })).body.models, [{ id: "glm-5.3" }]);
  const saved = await call("POST", { action: "save", revision: 4, models: [{ id: "glm-5.3" }] });
  assert.equal(saved.status, 200);
  assert.deepEqual(providers["workbuddy-cn"], { models: [{ id: "glm-5.3" }] });
  assert.equal((await call("POST", { action: "save", models: [{ id: "bad", maxTokens: -1 }] })).status, 400);
});

test("旧版接管 pi-ai，新版保留内置 pi-ai 供自定义 Provider 使用", () => {
  const patch = readFileSync(new URL("./cordis.patch.yml", import.meta.url), "utf8");
  const expression = patch.match(/disabled: !!js >-\r?\n((?: {4}[^\r\n]+\r?\n)+)/)?.[1]
    .trim().replace(/\r?\n\s*/g, " ");
  assert.ok(expression);
  const disabled = new Function("ctx", "process", `return (${expression})`);
  const ctx = { get: () => ({ installAnchor: "dsh-package.json" }) };
  const host = (version) => ({ getBuiltinModule: () => ({ readFileSync: () => JSON.stringify({ version }) }) });
  assert.equal(disabled(ctx, host("0.1.6")), true);
  assert.equal(disabled(ctx, host("0.1.7-rc.1")), false);
  assert.equal(disabled(ctx, host("0.1.8")), false);
  assert.equal(disabled(ctx, host("0.2.0-rc.2")), false);
  assert.equal(disabled(ctx, host("0.2.1-rc.2")), false);
  assert.equal(disabled({ get: () => undefined }, host("0.1.8")), true);
});

test("客户端兼容包装 Provider 并将 WorkBuddy 用量并入统计行", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const web = readFileSync(new URL("./workbuddy-web.js", import.meta.url), "utf8");
  assert.match(client, /WORKBUDDY_PROVIDER_PATTERN/);
  assert.match(client, /isWorkBuddyProvider\(provider\)/);
  assert.match(client, /isModLensWorkBuddyProvider/);
  assert.match(client, /data-workbuddy-modlens-hint/);
  assert.match(client, /出现 429 时请检查视觉引擎与额度/);
  assert.match(client, /data-composer-stats/);
  assert.match(client, /display: grid !important/);
  assert.match(client, /会话级账号\/API Key/);
  assert.match(client, /新会话默认凭证/);
  assert.match(client, /data-workbuddy-new-session-selector/);
  assert.match(client, /发送时自动绑定所选凭证/);
  assert.match(client, /解除绑定/);
  assert.match(client, /window\.confirm/);
  assert.match(client, /sessionId/);
  assert.match(client, /const hasTokenAccount = state\?\.mode === "token"/);
  assert.match(client, /state\.routingEnabled && sessionId \? createElement/);
  assert.match(client, /const seats = Array\.from\(document\.querySelectorAll\("\[data-composer-seat\]"\)\)/);
  // 非 hero 相位只清理残留面板，不应额外做一次全文档扫描。
  assert.ok(client.includes("if (document.querySelector(`[${PENDING_MARKER}]`))"));
  // enhance 必须经 rAF 合帧，避免流式输出时每个 token 都全量扫描 DOM。
  assert.match(client, /function scheduleEnhance\(\)/);
  assert.match(client, /new MutationObserver\(scheduleEnhance\)/);
  assert.match(client, /ctx\.slots\.inject\("plugins\.detail\.section"/);
  // 添加模型默认「日常编码」，并按该模型上游上限截断，不再按比例切档。
  assert.ok(
    client.includes("presetBudget(model.id, DEFAULT_PRESET, caps[model.id])"),
    "添加模型时应落到日常编码档",
  );
  assert.match(client, /label: "简短问答"/);
  assert.match(client, /label: "日常编码"/);
  assert.match(client, /label: "超长文档"/);
  assert.match(client, /label: "大型项目"/);
  assert.match(client, /"deepseek-v4\.1-flash"/);
  assert.match(client, /"kimi-k3\.1-pro"/);
  assert.match(client, /"kimi-k3\.1-pro-highspeed"/);
  assert.match(client, /"glm-5\.3"/);
  assert.doesNotMatch(client, /ceiling \/ 5/);
  assert.doesNotMatch(client, /ceiling \/ 4/);
  assert.match(web, /contextWindowMax: cap\?\.contextWindow/);
  assert.match(web, /maxTokens: body\.maxTokens/);
  assert.match(web, /catalog: await catalogCaps\(\)/);
  assert.match(client, /subject\?\.kind === "bundle" && BUNDLE_NAMES\.has\(subject\.pkg\?\.name\)/);
  assert.match(index, /const legacyAdapter = typeof adapter\.prepareCall !== "function"/);
  assert.match(index, /adapter\.prepareCall = async \(provider, model, signal\)/);
  assert.match(index, /persistDefaultSessionBinding/);
  assert.match(index, /bindings: \{ \.\.\.latest\.bindings, \[sessionId\]: binding \}/);
  assert.match(web, /take\(`\$\{ROUTE\}\/unbind`, unbind\)/);
  assert.match(web, /const effectiveBinding = sessionBinding;/);
  assert.match(web, /const displayedBinding = effectiveBinding \?\? suggestedBinding/);
});

test("旧版适配器对未知 replay 状态降级为普通历史", () => {
  const legacy = {
    kind: "pi-ai",
    version: 1,
    api: "openai-completions",
    provider: "workbuddy-cn",
    model: "model",
    stopReason: "stop",
    blocks: [],
  };
  const modern = { response: { kind: "pi-ai", version: 2 }, blocks: [] };
  const options = {
    messages: [
      { source: { kind: "model", replayState: modern }, content: [] },
      { source: { kind: "model", replayState: legacy }, content: [] },
      { source: { kind: "model", replayState: { kind: "other", version: 1 } }, content: [] },
    ],
  };

  const normalized = __testing.stripUnsupportedReplay(options);
  assert.equal(normalized.messages[0].source.replayState, undefined);
  assert.deepEqual(normalized.messages[1].source.replayState, legacy);
  assert.equal(normalized.messages[2].source.replayState, undefined);
  assert.notStrictEqual(normalized, options);
  assert.ok(options.messages[0].source.replayState.response);
});

test("直接 Provider 和 ModLens 包装 Provider 都能归一化 WorkBuddy replay 身份", () => {
  const replay = {
    kind: "pi-ai",
    version: 1,
    api: "openai-completions",
    provider: "workbuddy-cn",
    model: "model",
    stopReason: "stop",
    blocks: [],
  };
  const wrapped = {
    provider: "modlens-workbuddy-cn",
    messages: [{
      role: "assistant",
      content: [],
      source: { kind: "model", provider: "modlens-workbuddy-cn", replayState: replay },
    }],
  };
  const normalized = __testing.normalizeWorkBuddyReplay(wrapped);
  assert.notStrictEqual(normalized, wrapped);
  assert.equal(normalized.messages[0].source.provider, "workbuddy-cn");
  assert.equal(normalized.messages[0].source.replayState.provider, "workbuddy-cn");
  assert.equal(wrapped.messages[0].source.provider, "modlens-workbuddy-cn");
  assert.equal(wrapped.messages[0].source.replayState.provider, "workbuddy-cn");

  const direct = {
    provider: "workbuddy-cn",
    messages: [{
      role: "assistant",
      content: [],
      source: { kind: "model", provider: "workbuddy-cn", replayState: replay },
    }],
  };
  assert.strictEqual(__testing.normalizeWorkBuddyReplay(direct), direct);
});

test("中断工具错误只移除最后一次助手消息的 replayState", () => {
  const replay = {
    kind: "pi-ai",
    version: 1,
    api: "openai-completions",
    provider: "workbuddy-cn",
    model: "model",
    stopReason: "toolUse",
    blocks: [{ type: "tool-call" }],
  };
  const options = {
    provider: "workbuddy-cn",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "earlier" }], source: { kind: "model", provider: "workbuddy-cn", replayState: { ...replay, blocks: [{ type: "text" }] } } },
      { role: "assistant", content: [{ type: "tool-call", id: "call-1", name: "pwsh", arguments: "{}" }], source: { kind: "model", provider: "workbuddy-cn", replayState: replay } },
      { role: "user", content: [{ type: "tool-result", toolCallId: "call-1", isError: true, content: [{ type: "text", text: "unknown outcome" }] }] },
      { role: "system", content: [{ type: "text", text: "interrupted" }] },
    ],
  };
  const normalized = __testing.prepareWorkBuddyOptions(options);
  assert.equal(normalized.messages[0].source.replayState.kind, "pi-ai");
  assert.equal(normalized.messages[1].source.replayState, undefined);
  assert.equal(normalized.messages[2].content[0].isError, true);
});

test("非 WorkBuddy Provider 不会被 replay 兜底改写", () => {
  const options = {
    provider: "opencode-go-live",
    messages: [{
      role: "assistant",
      content: [],
      source: { kind: "model", provider: "opencode-go-live", replayState: { kind: "pi-ai", version: 1 } },
    }],
  };
  assert.strictEqual(__testing.normalizeWorkBuddyReplay(options), options);
});

test("会话级认证状态只保存账号或 API Key 引用", () => {
  const state = createWorkBuddySessionRoutingState(true, {
    "session-a": { mode: "token", accountId: "user:user-a" },
    "session-b": { mode: "api-key", apiKeyRef: "WORKBUDDY_API_KEY_DSH_B" },
    ignored: { mode: "token", accountId: "" },
    secret: { mode: "api-key", apiKey: "should-not-persist" },
  }, { mode: "token", accountId: "user:user-a" });
  const restored = parseWorkBuddySessionRouting(serializeWorkBuddySessionRouting(state));
  assert.equal(restored.enabled, true);
  assert.deepEqual(restored.lastUsed, { mode: "token", accountId: "user:user-a" });
  assert.deepEqual(restored.bindings, {
    "session-a": { mode: "token", accountId: "user:user-a" },
    "session-b": { mode: "api-key", apiKeyRef: "WORKBUDDY_API_KEY_DSH_B" },
  });
  assert.equal(JSON.stringify(restored).includes("should-not-persist"), false);
});

test("直连与 ModLens 转发都保留明确会话绑定，默认值只供未绑定会话首次固化", () => {
  const first = createWorkBuddySessionRoutingState(true, {
    "session-a": { mode: "token", accountId: "user:user-a" },
  }, { mode: "token", accountId: "user:user-b" });
  const changedDefault = createWorkBuddySessionRoutingState(true, first.bindings, { mode: "token", accountId: "user:user-c" });
  assert.deepEqual(__testing.sessionBindingFor(first, "session-a"), { mode: "token", accountId: "user:user-a" });
  assert.deepEqual(__testing.sessionBindingFor(changedDefault, "session-a"), { mode: "token", accountId: "user:user-a" });
  // ModLens 保留原始 options.sessionId 后再转发到 workbuddy-cn，因而与直连走同一绑定解析。
  assert.deepEqual(__testing.sessionBindingFor(changedDefault, "session-a"), __testing.sessionBindingFor(first, "session-a"));
  assert.equal(__testing.sessionBindingFor(changedDefault, "session-missing"), undefined);
  assert.equal(__testing.sessionBindingFor(changedDefault, undefined), undefined);
});

test("忽略由其他插件负责的 Provider", () => {
  const builtins = new Map([["deepseek", {}]]);

  assert.equal(__testing.ownsProvider("workbuddy-cn", builtins), true);
  assert.equal(__testing.ownsProvider("codebuddy-cn", builtins), true);
  assert.equal(__testing.ownsProvider("deepseek", builtins), true);
  assert.equal(__testing.ownsProvider("opencode-go-live", builtins), false);
});

test("完整的自定义 Provider 配置由插件注册为通用路由", () => {
  const provider = __testing.genericProvider("txcodingplan", {
    displayName: "Deepseek-v4-flash",
    api: "openai-completions",
    baseURL: "https://chatapi.weixin.qq.com/openai/v1",
    models: [{ id: "Deepseek-v4-flash", name: "Deepseek-v4-flash", maxTokens: 48000 }],
  });

  assert.equal(provider.id, "txcodingplan");
  assert.equal(provider.getModels()[0].provider, "txcodingplan");
  assert.equal(provider.getModels()[0].api, "openai-completions");
  assert.equal(__testing.ownsProvider("txcodingplan", new Map(), { api: "openai-completions", baseURL: "https://example.com", models: [{ id: "model" }] }), true);
});

test("API Key 和登录令牌使用各自的认证头", () => {
  assert.deepEqual(__testing.authenticationHeaders({ value: "api-key", kind: "api-key" }), { authorization: "Bearer api-key", "x-api-key": "api-key" });
  assert.deepEqual(__testing.authenticationHeaders({ value: "login-token", kind: "bearer" }), { authorization: "Bearer login-token" });
});

test("WorkBuddy 自有认证助手兼容新旧 DSH 的 signal 调用约定", async () => {
  const auth = __testing.workBuddyApiKeyAuth();
  const credential = { type: "api_key", key: "login-token" };

  // Older DSH calls resolve without a signal. This must not dereference it.
  assert.deepEqual(await auth.resolve({ credential }), {
    auth: { apiKey: "login-token" },
    source: "DSH credential",
  });

  // Newer DSH supplies an AbortSignal. The same resolver must remain valid.
  const controller = new AbortController();
  assert.deepEqual(await auth.resolve({ credential, signal: controller.signal }), {
    auth: { apiKey: "login-token" },
    source: "DSH credential",
  });
});

test("登录请求头不修改 DSH 冻结的配置对象", () => {
  const headers = __testing.runtimeHeaders(Object.freeze({ existing: "value" }));
  headers["X-User-Id"] = "user";
  assert.deepEqual(headers, { existing: "value", "X-User-Id": "user" });
});


test("CodeBuddy identity wins at the final HTTP boundary without changing credentials", async () => {
  for (const original of [
    { Authorization: "Bearer private", "User-Agent": "DeepSeek Harness", "X-Stainless-Lang": "js", "X-Stainless-Runtime": "node", existing: "value" },
    new Headers({ authorization: "Bearer private", "user-agent": "OpenAI/JS", "x-stainless-package-version": "test", existing: "value" }),
  ]) {
    const before = [...new Headers(original)];
    let sent;
    const options = __testing.workBuddyRequestOptions({ fetch: async (_url, init) => { sent = init; return new Response("ok"); } });
    await options.fetch("https://copilot.tencent.com/v2/chat/completions", { headers: original });
    const headers = new Headers(sent.headers);
    assert.equal(headers.get("user-agent"), "CLI/2.171.0 CodeBuddy/2.171.0");
    assert.equal(headers.get("x-product"), "SaaS");
    assert.equal(headers.get("x-ide-type"), "CLI");
    assert.equal(headers.get("x-ide-name"), "CodeBuddy");
    assert.equal(headers.get("x-ide-version"), "2.171.0");
    assert.equal(headers.get("authorization"), "Bearer private");
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(headers.get("existing"), "value");
    assert.match(headers.get("x-conversation-id"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(headers.get("x-conversation-request-id"), /^[0-9a-f]{32}$/);
    assert.equal(headers.get("x-root-request-id"), headers.get("x-conversation-request-id"));
    assert.match(headers.get("x-conversation-message-id"), /^[0-9a-f]{32}$/);
    assert.equal(headers.get("x-request-id"), headers.get("x-conversation-message-id"));
    assert(![...headers.keys()].some(key => key.startsWith("x-stainless-")));
    assert.deepEqual([...new Headers(original)], before);
  }
});
test("模型请求恢复 WorkBuddy 官方 User-Agent", () => {
  const options = Object.freeze({ headers: Object.freeze({ "user-agent": "deepseek-harness", existing: "value" }) });
  const resolved = __testing.workBuddyRequestOptions(options);

  assert.equal(resolved.headers["user-agent"], "CLI/2.171.0 CodeBuddy/2.171.0");
  assert.equal(resolved.headers.existing, "value");
  assert.equal(resolved.timeoutMs, 300_000);
  assert.equal(options.headers["user-agent"], "deepseek-harness");

  assert.equal(__testing.workBuddyRequestOptions({ timeoutMs: 12_000 }).timeoutMs, 12_000);
});

test("WorkBuddy 出站身份句只改写系统指令，保留用户、工具和原始请求", async () => {
  const fingerprint = "You are an AI agent powered by DeepSeek Harness.";
  const plain = "DeepSeek Harness；You are an AI agent.；保留这些文本";
  const body = {
    model: "deepseek-v4.1-flash", stream: true, temperature: 0.5,
    messages: [
      { role: "system", content: `${fingerprint}\n保留开发约束。 ${plain}` },
      { role: "developer", content: [
        { type: "text", text: "YOU ARE A CODING AGENT POWERED BY THE deepseek-v4.1-flash MODEL." },
        { type: "text", text: "You are an AI assistant built on DeepSeek.\n保留工具说明。" },
        { type: "image_url", image_url: { url: "data:image/png;base64,test" } },
      ] },
      { role: "user", content: fingerprint },
      { role: "assistant", content: fingerprint, tool_calls: [{ id: "call-1", type: "function", function: { name: "run", arguments: JSON.stringify({ text: fingerprint }) } }] },
      { role: "tool", tool_call_id: "call-1", content: fingerprint },
    ],
    tools: [{ type: "function", function: { name: "run", description: fingerprint, parameters: { type: "object" } } }],
  };
  const init = Object.freeze({ method: "POST", body: JSON.stringify(body), headers: Object.freeze({ authorization: "Bearer test-key" }) });
  const response = new Response("streaming-success");
  let sent;
  const options = __testing.workBuddyRequestOptions({ fetch: async (_url, value) => { sent = value; return response; } });
  assert.strictEqual(await options.fetch("https://copilot.tencent.com/v2/chat/completions", init), response);
  const actual = JSON.parse(sent.body);
  const expected = structuredClone(body);
  expected.messages[0].content = `You are a helpful assistant.\n\nYou are CodeBuddy, an AI coding assistant.\n保留开发约束。 ${plain.replaceAll("DeepSeek Harness", "CodeBuddy")}`;
  expected.messages[1].content[0].text = "You are a helpful assistant.\n\nYou are CodeBuddy, an AI coding assistant.";
  expected.messages[1].content[1].text = "You are a helpful assistant.\n\nYou are CodeBuddy, an AI coding assistant.\n保留工具说明。";
  assert.deepEqual(actual, expected);
  assert.equal(init.body, JSON.stringify(body));
  assert.equal(new Headers(sent.headers).get("authorization"), "Bearer test-key");
  assert.deepEqual(init.headers, { authorization: "Bearer test-key" });
  const cleaned = sent;
  await options.fetch("https://copilot.tencent.com/v2/chat/completions", cleaned);
  assert.deepEqual(sent, cleaned);
});


test("WorkBuddy uses CodeBuddy runtime branding only in instruction roles", async () => {
  const branded = 'You are interacting with the user through the DeepSeek Harness Web GUI.\nThe runtime context names the DeepSeek Harness implementation checkout.';
  const blocks = [{ type: "text", text: branded }, { type: "text", text: "保留权限、工作目录和工具规则。" }];
  const body = { model: "deepseek-v4.1-flash", stream: true, messages: [
    { role: "system", content: branded },
    { role: "developer", content: blocks },
    { role: "user", content: branded },
    { role: "assistant", content: branded },
    { role: "tool", tool_call_id: "test", content: branded },
  ], tools: [{ type: "function", function: { name: "read", description: branded } }] };
  const original = JSON.stringify(body);
  let sent;
  const options = __testing.workBuddyRequestOptions({ fetch: async (_url, init) => {
    sent = init;
    return new Response("ok");
  } });
  await options.fetch("https://copilot.tencent.com/v2/chat/completions", { body: original });
  const expected = structuredClone(body);
  expected.messages[0].content = branded.replaceAll("DeepSeek Harness", "CodeBuddy");
  expected.messages[1].content[0].text = expected.messages[0].content;
  assert.deepEqual(JSON.parse(sent.body), expected);
  assert.equal(JSON.stringify(body), original);
  assert.equal(blocks[0].text, branded);
  const clean = sent;
  await options.fetch("https://copilot.tencent.com/v2/chat/completions", clean);
  assert.deepEqual(sent, clean);
});
test("DSH 缩写替换为产品名，功能性标识（包名/路径/命令/环境变量）保持原样", async () => {
  const system = [
    "This is a DSH plugin.",
    "DeepSeek Harness provides tools.",
    "Install with dsh plugin add @wangwei2k99/dsh-workbuddy",
    "Working directory: D:\\GITHUB\\dsh-workbuddy",
    "Config: /home/user/.dsh/profiles/web",
    "Env: DSH_DEBUG=1",
  ].join("\n");

  let sent;
  const options = __testing.workBuddyRequestOptions({ fetch: async (_url, init) => {
    sent = init;
    return new Response("ok");
  } });
  await options.fetch("https://copilot.tencent.com/v2/chat/completions", {
    body: JSON.stringify({
      model: "deepseek-v4.1-flash",
      stream: true,
      messages: [{ role: "system", content: system }],
    }),
  });

  const actual = JSON.parse(sent.body).messages[0].content;
  // 独立缩写与全称都被替换
  assert.doesNotMatch(actual, /\bDSH\b/);
  assert.doesNotMatch(actual, /DeepSeek Harness/);
  // 功能性标识必须逐字保留：替换它们会让模型拼错包名/路径/命令
  assert.match(actual, /dsh plugin add @wangwei2k99\/dsh-workbuddy/);
  assert.match(actual, /D:\\GITHUB\\dsh-workbuddy/);
  assert.match(actual, /\/home\/user\/\.dsh\/profiles\/web/);
  assert.match(actual, /DSH_DEBUG=1/);
});
test("WorkBuddy 上游业务码可见，错误正文不会泄露，成功响应保持流式", async () => {
  const original = Response.json({ code: 11128, msg: "secret-value", displayTips: { zh: "private" } }, { status: 400 });
  const options = __testing.workBuddyRequestOptions({ fetch: async () => original });
  const response = await options.fetch("https://copilot.tencent.com/v2/chat/completions", {});
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.match(text, /11128/);
  // msg 为任意未知字符串时不猜测具体原因，只如实提示查看业务消息。
  assert.doesNotMatch(text, /secret-value|private/);
  assert.equal((await original.json()).code, 11128);

  // 11128 是重载错误码，必须按 msg 区分：渠道校验 vs 请求体形状。
  const channel = Response.json({ code: 11128, msg: "conversation id missing" }, { status: 400 });
  const channelText = await __testing.workBuddyRequestOptions({ fetch: async () => channel })
    .fetch("https://copilot.tencent.com/v2/chat/completions", {}).then((r) => r.text());
  assert.match(channelText, /渠道校验/);
  assert.match(channelText, /X-Conversation/);

  const opening = Response.json({ code: 11128, msg: "Illegal API invocation from an unapproved channel" }, { status: 400 });
  const openingText = await __testing.workBuddyRequestOptions({ fetch: async () => opening })
    .fetch("https://copilot.tencent.com/v2/chat/completions", {}).then((r) => r.text());
  assert.match(openingText, /系统提示开头/);
  assert.doesNotMatch(openingText, /缺少会话标识头族/);

  const shape = Response.json({ code: 11128, msg: "first message is not system prompt" }, { status: 400 });
  const shapeText = await __testing.workBuddyRequestOptions({ fetch: async () => shape })
    .fetch("https://copilot.tencent.com/v2/chat/completions", {}).then((r) => r.text());
  assert.match(shapeText, /首条消息必须是 system/);

  for (const body of ["not-json", JSON.stringify({ msg: "unknown" }), "x".repeat(32_768)]) {
    const error = new Response(body, { status: 400 });
    const result = await __testing.workBuddyRequestOptions({ fetch: async () => error }).fetch("https://copilot.tencent.com/v2/chat/completions", {});
    assert.strictEqual(result, error);
  }
  const quota = await __testing.workBuddyRequestOptions({ fetch: async () => Response.json({ error: { code: 11101 } }, { status: 429 }) }).fetch("https://copilot.tencent.com/v2/chat/completions", {});
  assert.equal(quota.status, 429);
  assert.match(await quota.text(), /11101/);
});

test("上下文超窗时按剩余空间收敛 maxTokens，塞满窗口则抛出可识别的溢出错误", () => {
  const model = { contextWindow: 200_000, maxTokens: 128_000 };
  const options = { maxTokens: 128_000 };
  // 窗口充裕：请求参数保持原样。
  const roomy = { messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }] };
  assert.strictEqual(__testing.boundContextBudget(model, roomy, options), options);
  // 放不下完整输出：按剩余空间收敛，避免上游只回 1 个 token + finish_reason=length。
  const tight = { messages: [{ role: "assistant", content: [{ type: "text", text: "字".repeat(150_000) }] }] };
  const bounded = __testing.boundContextBudget(model, tight, options);
  assert.ok(bounded.maxTokens >= 1024 && bounded.maxTokens <= 50_000, String(bounded.maxTokens));
  // 输入已经塞满窗口：抛 CONTEXT_WINDOW_EXCEEDED，交给 DSH 自动压缩后重试。
  const over = { messages: [{ role: "assistant", content: [{ type: "text", text: "字".repeat(210_000) }] }] };
  assert.throws(() => __testing.boundContextBudget(model, over, options), (error) => {
    assert.equal(error.code, "CONTEXT_WINDOW_EXCEEDED");
    // DSH 的溢出分类只认英文措辞，标记缺失就不会触发自动压缩。
    assert.match(error.message, /context_length_exceeded/);
    return true;
  });

  /*
   * 压缩摘要请求必须原样放行。实测日志里 7 次压缩失败分两类，都是本函数造成的：
   *   turn 78 / 111 —— 输入塞满窗口，抛错后压缩失败并抛回原始错误；
   *   turn 71-75   —— 把 maxTokens 削到「窗口 - 输入」的残余值，摘要写到一半被截断。
   */
  const compaction = { maxTokens: 65_536, purpose: "compaction" };
  // 输入已超出窗口：原样返回同一个对象，既不抛错也不改动 maxTokens。
  assert.strictEqual(__testing.boundContextBudget(model, over, compaction), compaction);
  // 输入只剩少量余量（曾经会被削到 4996 那类）：同样必须保持完整输出预留，
  // 否则摘要会在输出上限处被截断（compaction-basic 报 incomplete checkpoint）。
  const nearFull = { messages: [{ role: "assistant", content: [{ type: "text", text: "字".repeat(195_000) }] }] };
  assert.strictEqual(__testing.boundContextBudget(model, nearFull, compaction), compaction);
  // 普通请求仍然拦：只有压缩才有豁免，别的用途一律照旧。
  assert.throws(() => __testing.boundContextBudget(model, over, options), /context_length_exceeded/);
  assert.throws(() => __testing.boundContextBudget(model, over, { maxTokens: 128_000, purpose: "chat" }), /context_length_exceeded/);
  // 普通请求仍按剩余空间收敛，这条防线没有因为豁免而失效。
  const nearModel = { ...model, contextWindow: 200_000 };
  const clamped = __testing.boundContextBudget(nearModel, nearFull, { maxTokens: 128_000 });
  assert.ok(clamped.maxTokens > 0 && clamped.maxTokens < 128_000, String(clamped.maxTokens));
  // 模型没配窗口时行为不变。
  assert.strictEqual(__testing.boundContextBudget({ maxTokens: 1000 }, over, compaction), compaction);
});

test("上游只回 1 个 token 的 length 判定为上下文溢出，11115 错误带机器可读标记", async () => {
  const options = { maxTokens: 128_000 };
  assert.equal(__testing.silentContextOverflow({ stopReason: "length", usage: { output: 1 } }, options), true);
  assert.equal(__testing.silentContextOverflow({ stopReason: "length", usage: { output: 0 } }, options), true);
  // 正常结束、或确实输出了正文时不能误判。
  assert.equal(__testing.silentContextOverflow({ stopReason: "stop", usage: { output: 1 } }, options), false);
  assert.equal(__testing.silentContextOverflow({ stopReason: "length", usage: { output: 900 } }, options), false);
  // 真的写了一整段后被上限截断，同样是 length，不能被改判成上下文溢出。
  const truncated = {
    stopReason: "length",
    usage: { output: 8000 },
    content: [{ type: "text", text: "这是完整的正文，只是被输出上限截断了。" }],
  };
  assert.equal(__testing.silentContextOverflow(truncated, options), false);
  assert.equal(__testing.silentContextOverflow({ stopReason: "length", usage: { output: 1 }, content: [{ type: "text", text: "需要" }] }, options), true);

  const response = await __testing.workBuddyRequestOptions({ fetch: async () => Response.json({ code: 11115, msg: "prompt is too long" }, { status: 400 }) })
    .fetch("https://copilot.tencent.com/v2/chat/completions", {});
  const body = await response.json();
  assert.match(body.error.message, /11115/);
  assert.match(body.error.message, /context_length_exceeded/);

  // 上游换措辞但仍是上下文超限时也要命中标记。
  const wording = await __testing.workBuddyRequestOptions({ fetch: async () => Response.json({ code: 20001, msg: "maximum context length exceeded" }, { status: 400 }) })
    .fetch("https://copilot.tencent.com/v2/chat/completions", {});
  assert.match((await wording.json()).error.message, /context_length_exceeded/);
});

test("上游返回 1 个 token + length 时改判为上下文溢出，正常结束则原样透传", async () => {
  const model = {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek-V4.1-Flash",
    api: "openai-completions",
    provider: "workbuddy-cn",
    baseUrl: "https://copilot.tencent.com/v2",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 128_000,
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens", thinkingFormat: "openai" },
  };
  const context = { messages: [{ role: "user", content: [{ type: "text", text: "继续" }] }] };
  const reply = (chunks) => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => reply([
      { id: "cmb-1", choices: [{ index: 0, delta: { content: "需要" }, finish_reason: null }] },
      { id: "cmb-1", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 86_693, completion_tokens: 1, total_tokens: 86_694 } },
    ]);
    await assert.rejects(
      async () => { for await (const chunk of __testing.workBuddyApi.streamSimple(model, context, { maxTokens: 128_000, apiKey: "k" })) void chunk; },
      (error) => {
        assert.equal(error.code, "CONTEXT_WINDOW_EXCEEDED");
        assert.match(error.message, /context_length_exceeded/);
        return true;
      },
    );

    globalThis.fetch = async () => reply([
      { id: "cmb-2", choices: [{ index: 0, delta: { content: "好的" }, finish_reason: null }] },
      { id: "cmb-2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]);
    const events = [];
    for await (const chunk of __testing.workBuddyApi.streamSimple(model, context, { maxTokens: 128_000, apiKey: "k" })) events.push(chunk.type);
    assert.equal(events.at(-1), "done");
  } finally {
    globalThis.fetch = previous;
  }
});

test("显式空配置启用令牌模式，未配置时仍使用 API Key", () => {
  assert.equal(__testing.workBuddySource({}, {}).apiKeyEnv, "WORKBUDDY_API_KEY");
  assert.equal(__testing.workBuddySource({ providers: { "workbuddy-cn": {} } }, {}).apiKeyEnv, undefined);
  assert.equal(__testing.workBuddySource({ providers: { "codebuddy-cn": {} } }, {}).apiKeyEnv, undefined);
});

test("WebUI 可以区分 API Key 与令牌认证模式", () => {
  assert.equal(authenticationMode({ providers: {} }), "api-key");
  assert.equal(authenticationMode({ providers: { "workbuddy-cn": { apiKeyEnv: "WORKBUDDY_API_KEY" } } }), "api-key");
  assert.equal(authenticationMode({ providers: { "workbuddy-cn": {} } }), "token");
  assert.equal(authenticationMode({ providers: { "codebuddy-cn": {} } }), "token");
});

test("登录会话可以安全序列化并按过期时间刷新", () => {
  const session = {
    auth: { accessToken: "access", refreshToken: "refresh", expiresAt: 2_000_000 },
    account: { userId: "user", enterpriseId: "enterprise", ignored: "not-stored" },
  };
  const restored = parseWorkBuddySession(serializeWorkBuddySession(session));
  assert.deepEqual(restored.account, { userId: "user", enterpriseId: "enterprise" });
  assert.equal(sessionNeedsRefresh(restored, 1_000_000), false);
  assert.equal(sessionNeedsRefresh(restored, 1_900_000), true);
});

test("多个登录账号可以持久化、去重并切换", () => {
  const first = { auth: { accessToken: "access-1", refreshToken: "refresh-1" }, account: { userId: "user-1" } };
  const second = { auth: { accessToken: "access-2", refreshToken: "refresh-2" }, account: { userId: "user-2" } };
  const store = upsertWorkBuddySession(upsertWorkBuddySession(createWorkBuddySessionStore(), first), second);
  const restored = parseWorkBuddySessions(serializeWorkBuddySessions({ ...store, activeId: store.sessions[0].id }));
  assert.equal(restored.sessions.length, 2);
  assert.equal(activeWorkBuddySession(restored).account.userId, "user-1");
  assert.deepEqual(workBuddySessionAccounts(restored).map((entry) => entry.label), ["user-1", "user-2"]);
  assert.equal(JSON.stringify(workBuddySessionAccounts(restored)).includes("refresh-1"), false);
  const replaced = upsertWorkBuddySession(restored, { ...first, auth: { accessToken: "access-1-new", refreshToken: "refresh-1-new" } });
  assert.equal(replaced.sessions.length, 2);
  assert.equal(replaced.sessions.find((entry) => entry.id === "user:user-1").auth.accessToken, "access-1-new");
});

test("新增登录账号统一生成账号名称和 UID 展示字段", () => {
  const session = {
    auth: { accessToken: "access-new", refreshToken: "refresh-new" },
    account: { account: { uid: "new-user-id", nickname: "新账号" } },
  };
  const store = upsertWorkBuddySession(createWorkBuddySessionStore(), session);
  const [account] = workBuddySessionAccounts(store);

  assert.equal(account.label, "新账号");
  assert.equal(account.accountName, "新账号");
  assert.equal(account.userId, "new-user-id");
  assert.equal(account.account.displayName, "新账号");
  assert.equal(account.account.userId, "new-user-id");
});

test("账号接口缺少名称时从 UIN 或登录令牌补齐展示信息", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "jwt-user-id", preferred_username: "jwt-account" })).toString("base64url");
  const session = {
    auth: { accessToken: `header.${payload}.signature`, refreshToken: "refresh-jwt" },
    account: { uin: "uin-account" },
  };
  const store = upsertWorkBuddySession(createWorkBuddySessionStore(), session);
  const [account] = workBuddySessionAccounts(store);

  assert.equal(account.label, "uin-account");
  assert.equal(account.userId, "jwt-user-id");
  assert.equal(account.account.displayName, "uin-account");
  assert.equal(account.account.uin, "uin-account");
});

test("API Key 目录只保存引用和展示元数据，不保存密钥值", () => {
  const store = upsertWorkBuddyApiKey(createWorkBuddyApiKeyStore(), {
    id: "dsh:WORKBUDDY_API_KEY_DSH_TEST",
    ref: "WORKBUDDY_API_KEY_DSH_TEST",
    label: "DSH API Key 1",
  });
  const restored = parseWorkBuddyApiKeys(serializeWorkBuddyApiKeys(store));
  assert.deepEqual(workBuddyApiKeyEntries(restored).map((entry) => entry.ref), ["WORKBUDDY_API_KEY_DSH_TEST"]);
  assert.equal(JSON.stringify(workBuddyApiKeyEntries(restored)).includes("secret"), false);
  const noActive = createWorkBuddyApiKeyStore(restored.entries, null);
  assert.equal(noActive.activeId, null);
});

test("插件直接调用官方刷新接口且不复用旧过期时间", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ code: 0, data: { accessToken: "new-access", expiresIn: 3600 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const refreshed = await refreshWorkBuddySession({
      auth: { accessToken: "old-access", refreshToken: "refresh", expiresAt: 1 },
      account: { uid: "user", enterpriseId: "enterprise" },
    });
    assert.equal(request.url, "https://copilot.tencent.com/v2/plugin/auth/token/refresh");
    assert.equal(new Headers(request.options.headers).get("x-ide-name"), "CodeBuddy");
    assert.equal(new Headers(request.options.headers).get("user-agent"), "CLI/2.171.0 CodeBuddy/2.171.0");
    assert.equal(request.options.headers["X-Refresh-Token"], "refresh");
    assert.equal(request.options.headers["X-Enterprise-Id"], "enterprise");
    assert.equal(refreshed.auth.accessToken, "new-access");
    assert.ok(refreshed.auth.expiresAt > Date.now() + 3_500_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("模型目录保留逐模型思考能力和默认档位", () => {
  const models = __testing.modelsFromConfig({
    agents: [{ name: "cli", models: ["reasoning", "plain"] }],
    models: [
      { id: "reasoning", name: "Reasoning", maxInputTokens: 1000, maxOutputTokens: 100, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: "high" } },
      { id: "plain", name: "Plain", maxInputTokens: 1000, maxOutputTokens: 100, supportsReasoning: false },
    ],
  });

  assert.deepEqual(models.map((model) => model.id), ["reasoning", "plain"]);
  assert.equal(models[0].reasoning, true);
  assert.equal(models[0].thinkingLevelMap.off, null);
  assert.equal(models[0].thinkingLevelMap.xhigh, undefined);
  assert.equal(models[0].defaultReasoningEffort, "high");
  assert.equal(models[1].reasoning, false);
});

test("自定义模型可覆盖自己的思考档位", () => {
  const [model] = __testing.selectWorkBuddyModels([], [{
    id: "custom",
    contextWindow: 1000,
    maxTokens: 100,
    reasoningEfforts: { off: null, medium: "balanced" },
  }]);

  assert.equal(model.reasoning, true);
  assert.equal(Object.hasOwn(model.thinkingLevelMap, "off"), false);
  assert.equal(model.thinkingLevelMap.medium, "balanced");
  assert.equal(model.thinkingLevelMap.high, null);
});

test("积分查询复用 WorkBuddy billing 接口并汇总有效资源", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (String(url).includes("get-user-resource")) {
      return new Response(JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [
        { CycleCapacityRemainPrecise: 12.5, CapacityRemainPrecise: 100, PackageName: "月度包" },
        { CapacityRemain: 7 },
      ] } } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, data: { total: 2, data: [
      { requestId: "r1", requestTime: Date.now(), credit: 1.25 },
      { requestId: "r2", requestTime: Date.now() - 1000, credit: 2.75 },
    ] } }), { status: 200 });
  };
  try {
    const result = await fetchWorkBuddyCredits({ auth: { accessToken: "token" }, account: { userId: "user" } });
    assert.equal(result.credits, 19.5);
    assert.equal(result.todayUsage.count, 2);
    assert.equal(result.todayUsage.used, 4);
    assert.equal(result.creditError, null);
    assert.equal(requests[0].url, "https://www.codebuddy.cn/v2/billing/meter/get-user-resource");
    assert.equal(requests[0].options.headers.authorization, "Bearer token");
    assert.equal(requests[1].url, "https://www.codebuddy.cn/billing/meter/get-user-request-usage");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("企业积分响应支持不限量和周期重置时间", () => {
  const result = creditsTesting.enterpriseUsage({ data: { limitNum: -1, cycleResetTime: "2026-09-01 00:00:00" } });
  assert.equal(result.unlimited, true);
  assert.equal(result.credits, null);
  assert.ok(Number.isFinite(result.cycleResetTime));
});

test("积分查询只接受受信任的 WorkBuddy billing 域名", () => {
  assert.equal(creditsTesting.normalizeHost("https://www.codebuddy.cn"), "https://www.codebuddy.cn");
  assert.equal(creditsTesting.normalizeHost("https://evil.example"), "https://www.codebuddy.cn");
  assert.deepEqual(creditsTesting.buildCreditResourceBody(new Date(2026, 7, 31, 9, 8, 7)), {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: "2026-08-31 09:08:07",
    PackageEndTimeRangeEnd: "2127-08-31 09:08:07",
  });
});

test("客户端 bundle 可加载且 apply 能注册全部槽位", async () => {
  // 客户端 bundle 通过 window.__ModuleLoader__ 注册，运行时由浏览器提供。
  // 这里用最小 stub 复现该契约，确保：
  //   1) 模块顶层代码（含 ensureStyles 的模板字符串）不抛错
  //   2) apply(ctx) 能注册所有槽位
  // 曾出现过的真实故障：CSS 注释里写了反引号，把模板字符串提前截断，
  // 导致 ensureStyles 抛 TypeError、整个插件加载失败（UI 显示 failed）。
  const captured = {};
  const stubReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    Fragment: "Fragment",
  };
  const makeNode = () => ({
    style: {}, dataset: {}, textContent: "",
    setAttribute() {}, append() {}, appendChild() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
  });

  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    mutationObserver: globalThis.MutationObserver,
    event: globalThis.Event,
  };
  globalThis.window = {
    __ModuleLoader__: { load: (definition) => Object.assign(captured, definition) },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };
  globalThis.document = {
    ...makeNode(),
    createElement: makeNode,
    getElementById: () => null,
    head: makeNode(),
    body: makeNode(),
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.Event = class { constructor(type) { this.type = type; } };

  try {
    const { registerHooks } = await import("node:module").catch(() => ({}));
    void registerHooks;

    // client.js 是 CommonJS 风格（require("react")），用动态 import 会走 ESM 解析，
    // 这里改用 createRequire 以保持与 DSH 运行时一致的加载路径。
    const { createRequire } = await import("node:module");
    const requireClient = createRequire(import.meta.url);
    const reactPath = requireClient.resolve("react");
    requireClient.cache[reactPath] = {
      id: reactPath, filename: reactPath, loaded: true, exports: stubReact,
    };

    // 清掉可能的残留缓存后加载
    const clientPath = requireClient.resolve("./client.js");
    delete requireClient.cache[clientPath];
    requireClient(clientPath);

    assert.equal(captured.id, "@wangwei2k99/dsh-workbuddy", "模块应以包名注册");
    assert.equal(typeof captured.factory, "function", "factory 应为函数");

    const client = captured.factory((name) => {
      if (name === "react") return stubReact;
      throw new Error(`unexpected require: ${name}`);
    });
    assert.equal(typeof client.apply, "function");

    const registered = [];
    const ctx = {
      slots: {
        inject(_key, callback) { callback(); },
        register(meta, component) {
          registered.push({ id: meta.id ?? meta.key, component });
          return { dispose() {} };
        },
      },
      effect(callback) { callback(); return () => {}; },
      get: () => undefined,
      on: () => () => {},
    };
    // 不能抛错：任何抛错都会让 DSH 标记整个插件 failed
    client.apply(ctx);

    const ids = registered.map((r) => r.id).sort();
    assert.deepEqual(ids, [
      "dsh-workbuddy",
      "dsh-workbuddy",
      "llm-workbuddy",
      "workbuddy-context-window",
      "workbuddy-credits",
    ]);
    for (const entry of registered) {
      assert.equal(typeof entry.component, "function", `${entry.id} 应为组件函数`);
    }
  } finally {
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
    if (saved.mutationObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = saved.mutationObserver;
    if (saved.event === undefined) delete globalThis.Event;
    else globalThis.Event = saved.event;
  }
});

test("token 估算对代理对与全角字符的计数与逐 code point 遍历一致", () => {
  // estimateTextTokens 用 charCodeAt 遍历（比 for-of 快约 4 倍），
  // 这里用逐 code point 的参考实现锁定语义，防止优化改坏计数。
  function reference(text) {
    if (typeof text !== "string" || text.length === 0) return 0;
    let wide = 0;
    let narrow = 0;
    for (const char of text) {
      if (char.codePointAt(0) >= 0x2e80) wide += 1;
      else narrow += 1;
    }
    return wide + Math.ceil(narrow / 4);
  }

  const cases = [
    "", "abc", "你好世界", "hello 世界", "😀😀", "a😀b",
    "\u2e80\u2e80", "\u2e7f", "\uFF00\uFF01", "ｆｕｌｌ",
    "x".repeat(100), "中".repeat(50),
    "日本語のテキスト", "한국어 텍스트",
    "\uD840\uDC00", "\uD800", "\uDC00", "\uD800\uD800\uDC00",
    "\uDBFF\uDFFF", "混合 mixed テキスト 😀 \u2e80",
  ];
  for (const text of cases) {
    assert.equal(
      __testing.estimateTextTokens(text),
      reference(text),
      `估算结果与参考实现不一致: ${JSON.stringify(text)}`,
    );
  }

  // 随机组合覆盖代理对边界。
  const pool = ["a", "Z", " ", "中", "あ", "한", "😀", "\u2e80", "\u2e7f", "\uD800", "\uDC00", "ｆ", "\uFF01"];
  for (let round = 0; round < 500; round += 1) {
    let sample = "";
    const length = Math.floor(Math.random() * 10);
    for (let index = 0; index < length; index += 1) {
      sample += pool[Math.floor(Math.random() * pool.length)];
    }
    assert.equal(
      __testing.estimateTextTokens(sample),
      reference(sample),
      `随机样本估算不一致: ${JSON.stringify(sample)}`,
    );
  }
});

/* ─────────────── 与历史插件共存：识别对手、停用、异步抢占 ───────────────
 *
 * 这些用例守住"装了历史包也以本插件为准"的语义。真实运行时里 llm 的注册是
 * 先到先得、后到者抛 DUPLICATE_*，而 fiber 的卸载是异步的（目录键要等 disposer
 * 跑完才删），所以这里同时覆盖：识别（isRivalOptions）、停用（clearRivals）、
 * 以及"必须等卸载落地才能重试"的顺序约束。
 */

/** 造一棵和 loader 同形的条目树：{ store: { [id]: { options, fiber, subtree } } }。 */
function fakeLoader(rows) {
  const store = Object.create(null);
  for (const row of rows) store[row.options.id] = { options: row.options, fiber: row.fiber, subtree: row.subtree };
  return { store };
}

/** 造一个能被 ctx.loader 取到的假 ctx（resident 认 store 形态）。 */
function ctxWith(loader, extra = {}) {
  return { loader, get: () => undefined, ...extra };
}

test("识别需要被取代的行：历史包一律算，非 loader 形态下不误伤其它插件", () => {
  const { isRivalOptions } = __testing;

  // 历史包写法各异的包名与 id 都要认出来。
  for (const name of ["dsh-llm-workbuddy", "@scope/dsh-llm-workbuddy", "dsh-llm-codebuddy", "workbuddy", "@x/codebuddy-cn"]) {
    assert.equal(isRivalOptions({ name }, "any"), true, `应判定为对手: ${name}`);
  }
  // 只有 id、没有包名时（老版本 profile 里的行）也要认。
  assert.equal(isRivalOptions({ id: "dsh-llm-workbuddy" }, "dsh-llm-workbuddy"), true);
  // 本包自己算"重复副本"，由 includeOwn 决定是否计入。
  assert.equal(isRivalOptions({ name: "@wangwei2k99/dsh-workbuddy" }, "x", true), true);
  assert.equal(isRivalOptions({ name: "@wangwei2k99/dsh-workbuddy" }, "x", false), false);
  // 分组行、空行、无关插件都不能被停用。
  assert.equal(isRivalOptions({ group: true, name: "dsh-llm-workbuddy" }, "x"), false);
  assert.equal(isRivalOptions(undefined, "x"), false);
  assert.equal(isRivalOptions({ name: "@deepseek-ai/dsh-llm-deepseek" }, "llm-deepseek"), false);
  assert.equal(isRivalOptions({ name: "dsh-pi-ai" }, "llm-pi-ai"), false);
});

test("停用对手行只在内存里改 disabled，并按 fiber 存活与否决定是否释放", () => {
  const dead = { uid: null, state: 4, dispose() { throw new Error("不该释放已卸载的 fiber"); } };
  const live = { uid: 7, state: 2, disposed: 0, dispose() { this.disposed += 1; this.uid = null; this.state = 4; } };
  const rival = { options: { id: "dsh-llm-workbuddy", name: "dsh-llm-workbuddy" }, fiber: live };
  const stale = { options: { id: "dsh-llm-codebuddy", name: "dsh-llm-codebuddy" }, fiber: dead };
  const keep = { options: { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" } };
  const ctx = ctxWith(fakeLoader([rival, stale, keep]));

  const outcome = __testing.clearRivals(ctx, { includeOwn: false }, { stop: true });
  assert.equal(outcome.released, 1, "只有活着的那一个需要释放");
  assert.equal(outcome.pending.length, 1, "释放动作要交回一个可等待的 Promise");
  assert.equal(rival.options.disabled, true);
  assert.equal(stale.options.disabled, true);
  assert.equal(live.disposed, 1);
  assert.equal(keep.options.disabled, undefined, "无关插件绝不能被停用");

  // stop:false 只停用、不释放（用于"本插件已抢注成功"的收尾场景）。
  const other = { options: { id: "dsh-llm-workbuddy", name: "dsh-llm-workbuddy" }, fiber: { uid: 9, state: 2, dispose() { this.hit = true; } } };
  const quiet = __testing.clearRivals(ctxWith(fakeLoader([other])), { includeOwn: false }, { stop: false });
  assert.equal(quiet.released, 0);
  assert.deepEqual(quiet.pending, []);
  assert.equal(other.options.disabled, true);
  assert.equal(other.fiber.hit, undefined);
});

test("stopFiber 把异步卸载的完成时机交回调用方，且永不抛", () => {
  const events = [];
  const fiber = {
    uid: 3,
    state: 2,
    dispose() {
      // 复刻 cordis 的 _unload()：至少过几个微任务才真正删掉目录键。
      return Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => { events.push("disposed"); this.uid = null; this.state = 5; });
    },
  };
  const task = __testing.stopFiber(fiber);
  assert.equal(typeof task?.then, "function", "必须返回可等待的 Promise");
  assert.deepEqual(events, [], "同步阶段还不能认为已经卸载完");
  return task.then(() => {
    assert.deepEqual(events, ["disposed"]);
  });
});

test("stopFiber 对缺失/抛错/同步返回的 fiber 都返回已完成的 Promise", async () => {
  assert.equal(__testing.stopFiber(undefined), undefined);
  assert.equal(__testing.stopFiber({}), undefined);
  await __testing.stopFiber({ uid: 1, state: 2, dispose() { throw new Error("boom"); } });
  await __testing.stopFiber({ uid: 1, state: 2, dispose() { /* 同步完成 */ } });
});

test("stopRival 永不抛错，没有对手时返回空结果", () => {
  const empty = __testing.stopRival(ctxWith(fakeLoader([])), { includeOwn: false });
  assert.equal(empty.released, 0);
  assert.deepEqual(empty.pending, []);

  // ctx 完全没有 loader 能力时也不能炸。
  assert.deepEqual(__testing.stopRival({}, { includeOwn: false }).pending, []);
  assert.deepEqual(__testing.stopRival(undefined, undefined).pending, []);
});

test("rivalLlm 只把启用中的对手算作竞争，停用后立刻消失", () => {
  const rival = { options: { id: "dsh-llm-workbuddy", name: "dsh-llm-workbuddy" }, fiber: { uid: 2, state: 2 } };
  const ctx = ctxWith(fakeLoader([rival]));
  const mine = { includeOwn: false };
  assert.equal(__testing.rivalLlm(ctx, mine), true);
  __testing.clearRivals(ctx, mine, { stop: false });
  assert.equal(__testing.rivalLlm(ctx, mine), false, "停用后不应再被判为竞争");
});

test("同一进程内第二个本包副本认输，但仍会停用并释放对手", () => {
  const owner = { uid: 11, state: 2 };
  const rival = { options: { id: "dsh-llm-workbuddy", name: "dsh-llm-workbuddy" }, fiber: { uid: 12, state: 2 } };
  const loader = fakeLoader([rival]);

  // 第一次调用：抢占所有权（elected 在模块层，等价于进程级）。
  const first = __testing.electWorkBuddy(ctxWith(loader), { fiber: owner, includeOwn: false });
  assert.equal(first.won, true);

  // 同一个 fiber 再来一次仍然算赢（自激不会导致自己认输）。
  assert.equal(__testing.electWorkBuddy(ctxWith(loader), { fiber: owner, includeOwn: false }).won, true);

  // 另一个活着的副本必须认输。
  const second = __testing.electWorkBuddy(ctxWith(loader), { fiber: { uid: 13, state: 2 }, includeOwn: false });
  assert.equal(second.won, false);
  assert.equal(second.reason, "live-owner");

  // 原主已经卸载（uid=null）时，新来的副本可以接管。
  owner.uid = null;
  assert.equal(__testing.electWorkBuddy(ctxWith(loader), { fiber: { uid: 14, state: 2 }, includeOwn: false }).won, true);
});

test("duplicateOf 认出 DUPLICATE_* 与各版本措辞，不误判无关错误", () => {
  const { duplicateOf } = __testing;
  assert.equal(duplicateOf({ code: "DUPLICATE_DIRECTORY" }), true);
  assert.equal(duplicateOf({ code: "DUPLICATE_ADAPTER" }), true);
  assert.equal(duplicateOf({ code: "DUPLICATE_DISCOVERY" }), true);
  assert.equal(duplicateOf({ message: 'configurable provider "workbuddy-cn" is already declared' }), true);
  assert.equal(duplicateOf({ message: "an adapter for provider workbuddy-cn is already registered" }), true);
  assert.equal(duplicateOf({ code: "INVALID_DIRECTORY", message: "provider is invalid" }), false);
  assert.equal(duplicateOf({ message: "network unreachable" }), false);
  assert.equal(duplicateOf(null), false);
});

test("回收超时常量与重试次数保持在可接受的启动预算内", () => {
  assert.ok(__testing.RECLAIM_TIMEOUT_MS > 0 && __testing.RECLAIM_TIMEOUT_MS <= 10_000);
  assert.ok(__testing.RECLAIM_ATTEMPTS >= 1 && __testing.RECLAIM_ATTEMPTS <= 5);
});

