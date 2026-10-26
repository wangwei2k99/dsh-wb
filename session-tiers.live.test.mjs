/**
 * 会话级档位的真实链路测试。
 *
 * 这里不跑语法断言，而是用最小的宿主替身把 `installSessionTiers` 真正装起来，
 * 然后走一遍 `agent/request` 与 `prepareCall` —— 只有这样才能区分
 * 「拦截装上了」和「拦截真的改变了窗口」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { installSessionTiers } from "./session-tiers.js";

/**
 * 造一个最小宿主：llm 服务带原型方法，agents 能返回指定会话。
 * 形状照着真实宿主的 `prepareCall(config, signal, configure)` 来。
 */
function host({ baseWindow = 1_000_000, baseMaxTokens = 128_000 } = {}) {
  const handlers = new Map();
  const agent = { id: "sess-A" };
  const llmPrototype = {
    resolveModelInfo(provider, model) {
      return Promise.resolve({
        context: { contextWindow: baseWindow },
        defaultMaxTokens: baseMaxTokens,
      });
    },
    prepareCall(config, signal, configure) {
      // 真实宿主会先取模型信息，再用 configure 选具体控制项。
      return this.resolveModelInfo(config.provider, config.model).then((info) => {
        const controls = typeof configure === "function" ? configure({ ...config }, info) : { ...config };
        const maxTokens = controls.maxTokens ?? info.defaultMaxTokens;
        return Object.freeze({
          config: Object.freeze({ ...controls, maxTokens }),
          context: Object.freeze({ ...info.context }),
        });
      });
    },
  };
  const llm = Object.create(llmPrototype);
  const agents = {
    currentInitiator: () => agent,
    withInitiator: (_a, fn) => fn(),
  };
  const ctx = {
    llm,
    agents,
    effect(fn) {
      return fn();
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  };
  return { ctx, handlers, agent, llmPrototype, baseWindow, baseMaxTokens };
}

test("无覆盖时完全不改变模型信息", async () => {
  const h = host();
  const { api } = installSessionTiers(h.ctx, undefined);
  const prepared = await h.ctx.llm.prepareCall({ provider: "workbuddy-cn", model: "m" });
  assert.equal(prepared.context.contextWindow, h.baseWindow);
  assert.equal(prepared.config.maxTokens, h.baseMaxTokens);
  assert.equal(api.stats().hits.applied, 0);
});

test("有覆盖时窗口被改小，且输出预算随之收敛", async () => {
  const h = host();
  const { api } = installSessionTiers(h.ctx, undefined);
  api.write("sess-A", { contextWindow: 32_000, maxTokens: 32_000 });

  const prepared = await h.ctx.llm.prepareCall({ provider: "workbuddy-cn", model: "m" });
  assert.equal(prepared.context.contextWindow, 32_000, "窗口必须被覆盖为 32K");
  // 32K 窗口放不下 32K 输出，必须收敛到窗口内且留出压缩 headroom。
  assert.ok(prepared.config.maxTokens <= 32_000, `预算不得超过窗口: ${prepared.config.maxTokens}`);
  assert.ok(prepared.config.maxTokens >= 8_000, `预算过低: ${prepared.config.maxTokens}`);
  assert.equal(api.stats().hits.applied >= 1 || api.read("sess-A") !== null, true);
});

test("覆盖不允许放大窗口", async () => {
  const h = host({ baseWindow: 200_000, baseMaxTokens: 32_000 });
  const { api } = installSessionTiers(h.ctx, undefined);
  api.write("sess-A", { contextWindow: 1_000_000 });

  const prepared = await h.ctx.llm.prepareCall({ provider: "workbuddy-cn", model: "m" });
  assert.equal(prepared.context.contextWindow, 200_000, "不得把窗口放大到超过模型上限");
});

test("两个会话各自独立，互不影响", async () => {
  const h = host();
  const { api } = installSessionTiers(h.ctx, undefined);
  api.write("sess-A", { contextWindow: 32_000, maxTokens: 16_000 });
  api.write("sess-B", { contextWindow: 1_000_000, maxTokens: 128_000 });

  const a = await h.ctx.llm.prepareCall({ provider: "workbuddy-cn", model: "m" });
  assert.equal(a.context.contextWindow, 32_000);

  // 切到 B 会话再看一次。
  const original = h.ctx.agents.currentInitiator;
  h.ctx.agents.currentInitiator = () => ({ id: "sess-B" });
  const b = await h.ctx.llm.prepareCall({ provider: "workbuddy-cn", model: "m" });
  h.ctx.agents.currentInitiator = original;
  assert.equal(b.context.contextWindow, 1_000_000);

  // A 的覆盖没有被 B 影响。
  assert.equal(api.read("sess-A").override.contextWindow, 32_000);
});

test("清除覆盖后回到模型默认值", async () => {
  const h = host();
  const { api } = installSessionTiers(h.ctx, undefined);
  api.write("sess-A", { contextWindow: 32_000 });
  api.write("sess-A", null);
  const prepared = await h.ctx.llm.prepareCall({ provider: "workbuddy-cn", model: "m" });
  assert.equal(prepared.context.contextWindow, h.baseWindow);
});

test("agent/request 拦截会把输出预算写进冻结配置", async () => {
  const h = host();
  const { api } = installSessionTiers(h.ctx, undefined);
  api.write("sess-A", { contextWindow: 32_000, maxTokens: 32_000 });
  const handler = h.handlers.get("agent/request");
  assert.equal(typeof handler, "function", "必须注册 agent/request 拦截");

  const config = await handler(
    { agent: { id: "sess-A" } },
    () => Promise.resolve({ provider: "workbuddy-cn", model: "m", maxTokens: 128_000 }),
  );
  assert.equal(config.provider, "workbuddy-cn", "不得丢失 provider");
  assert.equal(config.model, "m", "不得丢失 model");
  assert.ok(config.maxTokens <= 32_000, `预算必须收敛到窗口内: ${config.maxTokens}`);
});

test("没有会话身份时不干预请求", async () => {
  const h = host();
  installSessionTiers(h.ctx, undefined);
  h.ctx.agents.currentInitiator = () => undefined;
  const handler = h.handlers.get("agent/request");
  const config = await handler(
    { agent: { id: "sess-A" } },
    () => Promise.resolve({ provider: "p", model: "m", maxTokens: 128_000 }),
  );
  // 没有覆盖，原样返回。
  assert.equal(config.maxTokens, 128_000);
});

test("卸载后原型方法被精确还原", async () => {
  const h = host();
  const before = h.llmPrototype.prepareCall;
  const { api } = installSessionTiers(h.ctx, undefined);
  assert.notEqual(h.llmPrototype.prepareCall, before, "安装后应替换");
  api.dispose();
  assert.equal(h.llmPrototype.prepareCall, before, "卸载后必须还原");
});

test("非法覆盖被拒绝，不会写入脏数据", async () => {
  const h = host();
  const { api } = installSessionTiers(h.ctx, undefined);
  const bad = api.write("sess-A", { contextWindow: 1000, maxTokens: 999999 });
  assert.equal(bad.ok, false, "输出大于窗口必须被拒");
  const missing = api.write("sess-A", { maxTokens: 1000 });
  assert.equal(missing.ok, false, "缺窗口必须被拒");
  assert.equal(api.read("sess-A").override, null, "拒绝后不得留下覆盖");
});

test("agent/request 内部出错时原样放行，不拖垮请求", async () => {
  const h = host();
  const { api } = installSessionTiers(h.ctx, undefined);
  api.write("sess-A", { contextWindow: 32_000 });
  const handler = h.handlers.get("agent/request");
  // 构造一个会让档位逻辑炸掉的 payload：agent 的 id 取值器抛错。
  const hostile = {
    agent: {
      get id() {
        throw new Error("boom");
      },
    },
  };
  const original = { provider: "p", model: "m", maxTokens: 128_000 };
  const config = await handler(hostile, () => Promise.resolve(original));
  // 关键：不能抛，也不能把配置改坏。
  assert.deepEqual(config, original, "出错时必须原样返回宿主配置");
});

test("prepareCall 内部出错时退回原方法，模型调用照常", async () => {
  const h = host();
  const { api } = installSessionTiers(h.ctx, undefined);
  api.write("sess-A", { contextWindow: 32_000 });
  // 让 currentInitiator 抛错，模拟档位逻辑自身失败。
  h.ctx.agents.currentInitiator = () => {
    throw new Error("boom");
  };
  const prepared = await h.ctx.llm.prepareCall({ provider: "workbuddy-cn", model: "m" });
  // 档位没生效可以接受，但请求必须成功，且窗口是模型原本的值。
  assert.equal(prepared.context.contextWindow, h.baseWindow, "出错时应回落到模型默认窗口");
  assert.ok(Number.isInteger(prepared.config.maxTokens), "必须仍返回可用的 maxTokens");
});

test("宿主自身失败不被吞掉", async () => {
  // 先让底层方法失败，再安装，验证包装层不会把宿主的错误吞掉或改判。
  const h = host();
  const failing = function failing() {
    return Promise.reject(new Error("provider exploded"));
  };
  h.llmPrototype.prepareCall = failing;
  installSessionTiers(h.ctx, undefined);
  await assert.rejects(
    () => h.ctx.llm.prepareCall({ provider: "p", model: "m" }),
    /provider exploded/,
    "宿主的失败原因必须原样上抛，不能被吞掉",
  );
});

test("缺 agents 服务时干净降级，模型调用照常", async () => {
  // agents 不在 inject 里，缺失时插件必须照常工作，只是没有会话级档位。
  const h = host();
  const ctx = { llm: h.ctx.llm, effect: h.ctx.effect, on: h.ctx.on };
  const { installed, api } = installSessionTiers(ctx, undefined);
  assert.equal(installed, true, "缺 agents 不应让安装失败");
  const prepared = await ctx.llm.prepareCall({ provider: "workbuddy-cn", model: "m" });
  assert.equal(prepared.context.contextWindow, h.baseWindow, "模型调用必须照常");
  const write = api.write("sess-A", { contextWindow: 32_000 });
  assert.equal(write.ok, false, "没有会话身份时写覆盖应被拒绝而不是抛错");
});

test("未声明的服务属性访问会抛错时仍能安装", () => {
  // 真实 cordis 对未 inject 的服务，属性访问直接抛
  // `cannot get property "agents" without inject`。
  // 这里复现那个语义：一旦代码直接读 ctx.agents 就会炸掉整个插件。
  const h = host();
  const ctx = new Proxy(
    { llm: h.ctx.llm, effect: h.ctx.effect, on: h.ctx.on },
    {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "get") return () => undefined;
        throw new Error(`cannot get property "${String(key)}" without inject`);
      },
    },
  );
  // 关键：不能抛。
  const { installed } = installSessionTiers(ctx, undefined);
  assert.equal(installed, true, "访问未声明服务不得让安装失败");
});

console.log("session-tiers 真实链路测试开始");
