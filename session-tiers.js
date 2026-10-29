/**
 * 会话级档位覆盖。
 *
 * 问题：档位（contextWindow / maxTokens）存在 profile 的模型定义里，是全局的。
 * 同时开两个会话时改动会互相影响 —— 大项目会话被改成日常编码的窗口，或者反过来。
 *
 * 做法：只在宿主内存里按 sessionId 记录覆盖值，不动 profile 配置，也不写会话日志。
 * 覆盖值经由三条官方seam 生效，全部有契约，不 patch 任何原型：
 *
 *   1. `agent/request` waterfall（官方描述就是「替换冻结的调用配置」）
 *      —— 签名带 `agent`，直接拿到 sessionId；返回改过的 config 即可。
 *      宿主随后把 config 写进 `request/header`，所以压缩策略、token 计量
 *      看到的都是覆盖后的 `maxTokens`。
 *   2. `prepareCall` 的 `configure` 回调
 *      —— 官方认可的改变 `maxTokens` 的位置，冻结的 prepared call 内部
 *      仍自洽（适配器的 stream 会校验请求配置等于解析后的配置）。
 *   3. 返回的冻结调用对象上替换 `context.contextWindow`
 *      —— 这一步让 `request/context` 事件、token 计量、压缩阈值看到同一个窗口。
 *      依据是宿主 `resolveCallWithInfo` 里 `context: info.context`，
 *      而 `info` 就是适配器 `prepareCall` 返回的模型信息。
 *
 * 当前会话通过官方的 `ctx.agents.currentInitiator()` 取得，
 * 其 `Agent.id` 即 SessionId。新会话不携带覆盖，回到 profile 默认值。
 *
 * 覆盖只影响之后发出的请求：正在执行的 step 保持它启动时的窗口。
 * 这是宿主机制决定的，不是本模块的取舍。
 */

/** 单会话最小完成预留，低于它会触发上游只回 1 个 token。 */
const MIN_COMPLETION_TOKENS = 256;
/** 会话覆盖表的上限，防止长时间运行后无限增长。 */
const MAX_TRACKED_SESSIONS = 512;

/**
 * 写入时的上限收敛。`base` 是上游目录天花板（contextWindowMax），不是配置里的工作窗口。
 *
 * @param base 上游允许的最大窗口
 * @param requested 本会话请求的窗口
 */
export function resolveSessionWindow(base, requested) {
  const hasBase = Number.isInteger(base) && base > 0;
  const hasRequest = Number.isInteger(requested) && requested > 0;
  if (!hasRequest) return { base: hasBase ? base : undefined, effective: hasBase ? base : undefined, changed: false };
  const effective = hasBase ? Math.min(requested, base) : requested;
  return { base: hasBase ? base : undefined, effective, changed: hasBase ? effective !== base : true };
}

/**
 * 发请求时的生效窗口。
 * 配置里的窗口只是没选档时的默认值。覆盖在写入时已经按上游上限截过，
 * 这里必须允许比配置窗口更大，否则输入框选了 1M，请求仍按配置里的 200K 发。
 *
 * @param profileWindow 模型配置上的 contextWindow
 * @param requested 本会话已保存的窗口
 */
export function effectiveSessionWindow(profileWindow, requested) {
  const hasProfile = Number.isInteger(profileWindow) && profileWindow > 0;
  const hasRequest = Number.isInteger(requested) && requested > 0;
  if (!hasRequest) {
    return { base: hasProfile ? profileWindow : undefined, effective: hasProfile ? profileWindow : undefined, changed: false };
  }
  return {
    base: hasProfile ? profileWindow : undefined,
    effective: requested,
    changed: !hasProfile || requested !== profileWindow,
  };
}

/**
 * 把完成预留压进窗口内。
 *
 * 压缩策略会按窗口留 headroom；若 maxTokens 仍是旧的大值，压缩会因
 * 「预留之后没有消息预算」直接报错。所以预算必须同时满足：
 *   - 不超过窗口的 completionRatio（给输入留主导权）
 *   - 留出 headroom 给压缩摘要（否则压缩无法插入摘要消息）
 *
 * headroom 按窗口等比缩放，不写死绝对值：写死 64K 在 32K 窗口上会把
 * 输出压到 8K，正好推翻「小窗口也要够用的输出预算」这个目标。
 *
 * @param requested 原本请求的 maxTokens，未定时按上限给
 * @param window 本会话生效的窗口
 * @param settings 含 completionRatio 与 headroomRatio
 */
export function clampCompletion(requested, window, settings) {
  const safeWindow = Math.max(2 * MIN_COMPLETION_TOKENS, Math.floor(window));
  const headroom = Math.min(
    Math.floor(safeWindow / 2),
    Math.max(MIN_COMPLETION_TOKENS, Math.floor(safeWindow * settings.headroomRatio)),
  );
  const ratioLimit = Math.max(MIN_COMPLETION_TOKENS, Math.floor(safeWindow * settings.completionRatio));
  const budgetLimit = Math.max(MIN_COMPLETION_TOKENS, safeWindow - headroom);
  const limit = Math.min(ratioLimit, budgetLimit);
  if (!Number.isFinite(requested)) return limit;
  const value = Math.floor(requested);
  if (value < 1) return limit;
  return Math.min(value, limit);
}

/** 规整配置，给出稳定的默认值。 */
export function normalizeSessionSettings(input) {
  const source = input !== null && typeof input === "object" ? input : {};
  return {
    completionRatio: clampNumber(source.completionRatio, 0.05, 0.9, 0.5),
    headroomRatio: clampNumber(source.headroomRatio, 0.01, 0.5, 0.08),
  };
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function prototypeOf(value) {
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) return undefined;
    return proto;
  } catch {
    return undefined;
  }
}

/**
 * 安装会话级档位覆盖。
 *
 * @param ctx host 上下文
 * @param config 插件的档位配置（completionRatio / headroomRatio）
 * @returns 该会话档位的读写接口，以及安装是否成功
 */
export function installSessionTiers(ctx, config) {
  const settings = normalizeSessionSettings(config);
  /** sessionId -> { contextWindow?, maxTokens? } 用户在本会话选定的档位 */
  const overrides = new Map();
  /** sessionId -> { contextWindow, maxTokens } 由最近一次解析推出的实际值 */
  const resolved = new Map();

  // 读取可选服务。
  //
  // 注意两件事：
  //  1. cordis 对未在 inject 中声明的服务，**属性访问会直接抛**
  //     `cannot get property "xxx" without inject`，而不是返回 undefined；
  //     一旦抛出去，整个插件就不激活，连模型接入都一起没了。
  //  2. 已声明（inject 里）的服务用属性访问才有值，`ctx.get` 未必有实现。
  //
  // 所以顺序是：先 try 属性访问，失败再退回 `ctx.get`，两者都失败就当作没有。
  const read = (key) => {
    try {
      const direct = ctx[key];
      if (direct !== undefined && direct !== null) return direct;
    } catch {
      // 未声明服务：属性访问抛错，落到 ctx.get。
    }
    try {
      return typeof ctx.get === "function" ? ctx.get(key) : undefined;
    } catch {
      return undefined;
    }
  };
  const agents = read("agents");
  const llm = read("llm");
  const llmPrototype = prototypeOf(llm);
  /**
   * 解掉本模块遗留的包装层。
   *
   * 为什么要这一步：同一个原型可能被多次安装（插件装成多行、fiber 重启时旧实例
   * 还没 dispose 完、热重载）。裸着包装会互相套娃，而卸载逻辑各自只认自己的
   * `patched` 引用，先卸载内层后外层再还原时，会把内层那个**已卸载的**包装装回去，
   * 于是 `maxTokens` 逻辑在插件卸载后继续残留，且层数只增不减。
   *
   * 做法：包装函数上打一个标记，安装前沿着 `__wbTiersOriginal` 一路剥到底。
   */
  const unwrapOwn = (fn) => {
    let current = fn;
    const seen = new Set();
    while (typeof current === "function" && current.__wbTiersWrapped === true && !seen.has(current)) {
      seen.add(current);
      const inner = current.__wbTiersOriginal;
      if (typeof inner !== "function") break;
      current = inner;
    }
    return current;
  };
  const originalPrepareCall = unwrapOwn(llmPrototype?.prepareCall);
  const canPatchPrepare = typeof originalPrepareCall === "function";

  /**
   * 宿主上「会话」可能落在 agent.session.id，也可能就是 agent.id。
   * 输入框写入用的是插槽传来的 sessionId。两条请求路径必须把这两个都试过，
   * 否则覆盖写在一个 id 上，压缩或发请求却用另一个 id 去查，等于没生效。
   */
  const agentSessionKeys = (agent) => {
    const keys = [];
    const push = (value) => {
      if (typeof value === "string" && value !== "" && !keys.includes(value)) keys.push(value);
    };
    push(agent?.session?.id);
    push(agent?.id);
    return keys;
  };

  /** 当前正在跑的会话；不在会话里（如后台任务）返回 undefined。 */
  const currentSessionId = () => {
    try {
      const keys = agentSessionKeys(agents?.currentInitiator?.());
      return keys[0];
    } catch {
      return undefined;
    }
  };

  const overrideOf = (sessionId) => {
    if (sessionId === undefined) return undefined;
    const requested = overrides.get(sessionId);
    return requested === undefined ? undefined : { sessionId, requested };
  };

  const overrideFor = (agent) => {
    for (const id of agentSessionKeys(agent)) {
      const found = overrideOf(id);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const activeOverride = () => {
    try {
      return overrideFor(agents?.currentInitiator?.());
    } catch {
      return undefined;
    }
  };

  const remember = (sessionId, entry) => {
    resolved.delete(sessionId);
    resolved.set(sessionId, entry);
    while (resolved.size > MAX_TRACKED_SESSIONS) {
      const oldest = resolved.keys().next();
      if (oldest.done === true) break;
      resolved.delete(oldest.value);
    }
  };

  const disposers = [];
  /**
   * 调用计数：用来在真实运行时确认拦截确实被宿主走到，
   * 而不是仅仅「装上但从未触发」。
   */
  const hits = { agentRequest: 0, prepareCall: 0, applied: 0 };
  /**
   * `ctx.effect` 是宿主提供的生命周期注册点；精简过的宿主或测试替身可能没有。
   * 缺它就退化成「直接装、卸载时手动还原」，绝不因为缺这个方法让整个插件 apply 抛错。
   */
  const effect = (setup) => {
    if (typeof ctx.effect === "function") {
      disposers.push(ctx.effect(setup, "workbuddy: session tier"));
      return;
    }
    const dispose = setup();
    if (typeof dispose === "function") disposers.push(dispose);
  };

  /**
   * seam 1：官方 `agent/request` waterfall。
   * 在宿主把 config 冻结成 request/header 之前把 maxTokens 收敛掉。
   *
   * 这是 waterfall：处理函数抛错会让整个请求失败。档位只是附加功能，
   * 因此任何自身异常都必须吞掉并原样放行，绝不拖垮对话。
   */
  effect(() => {
    if (typeof ctx.on !== "function") return () => {};
    const stop = ctx.on("agent/request", async (payload, next) => {
      const config = await next();
      try {
        hits.agentRequest += 1;
        const active = overrideFor(payload?.agent) ?? activeOverride();
        if (active === undefined || config === null || typeof config !== "object") return config;
        // 窗口信息要等 prepareCall 才拿得到；这里先按本会话窗口收紧输出预留，
        // 保证 request/header 与压缩策略看到的预算和覆盖窗口自洽。
        const window = active.requested.contextWindow;
        const maxTokens = clampCompletion(active.requested.maxTokens ?? config.maxTokens, window, settings);
        hits.applied += 1;
        remember(active.sessionId, { contextWindow: window, maxTokens });
        // 压缩策略读的是这次请求的窗口，不是模型目录里的高档。
        // 只改 maxTokens 会让阈值停留在高档，从高档切到低档时不会压缩。
        if (config.maxTokens === maxTokens && config.contextWindow === window) return config;
        return { ...config, maxTokens, contextWindow: window };
      } catch {
        // 出任何问题都退回宿主原本的配置。
        return config;
      }
    });
    return () => stop?.();
  }, "workbuddy: session tier agent/request");

  /**
   * seam 2 + 3：包装 `prepareCall`。
   * `configure` 回调里收紧 maxTokens；返回后替换 `context.contextWindow`，
   * 让 request/context 事件与压缩阈值看到同一个窗口。
   */
  if (canPatchPrepare) {
    effect(() => {
      /**
       * 这是全局替换 `llm.prepareCall`：一旦它抛错，所有模型调用都会失败。
       * 因此除了业务分支，整体还要再包一层 —— 档位逻辑出问题时退回原方法，
       * 用户可以没有档位，但不能不能对话。
       */
      const patched = function prepareCallWithSessionTier(callConfig, signal, configure) {
        try {
          const active = overrideFor(callConfig?.agent)
            ?? overrideOf(typeof callConfig?.sessionId === "string" ? callConfig.sessionId : undefined)
            ?? activeOverride();
          if (active === undefined) return originalPrepareCall.call(this, callConfig, signal, configure);
          hits.prepareCall += 1;
          let resolution;
          const configureCall = (controls, modelInfo) => {
            try {
              resolution = effectiveSessionWindow(modelInfo?.context?.contextWindow, active.requested.contextWindow);
              const seeded = typeof configure === "function" ? configure(controls, modelInfo) : controls;
              if (resolution.changed !== true) return seeded;
              const maxTokens = clampCompletion(
                active.requested.maxTokens ?? seeded?.maxTokens ?? modelInfo?.defaultMaxTokens,
                resolution.effective,
                settings,
              );
              return { ...seeded, maxTokens };
            } catch {
              // configure 出错就交回宿主原本的选值逻辑。
              return typeof configure === "function" ? configure(controls, modelInfo) : controls;
            }
          };
          return Promise.resolve(originalPrepareCall.call(this, callConfig, signal, configureCall)).then(
            (prepared) => {
              try {
                if (resolution === undefined || resolution.changed !== true || prepared === null || prepared === undefined) return prepared;
                // 在这里计数：只有真正改掉了窗口才算「生效」。
                // 之前 applied 只在 agent/request 里加，导致 prepareCall 单独生效时
                // stats 仍显示 applied:0，排查时容易误判成「装了但没起作用」。
                hits.applied += 1;
                remember(active.sessionId, {
                  contextWindow: resolution.effective,
                  maxTokens: clampCompletion(prepared?.config?.maxTokens, resolution.effective, settings),
                });
                if (prepared.context === undefined || prepared.context === null) return prepared;
                /*
                 * 除了 context.contextWindow，还要同步 prepared.model.contextWindow。
                 *
                 * 两者是不同消费者的入参：
                 *   - `context.contextWindow` → 宿主的 request/context 事件、token 计量、压缩阈值
                 *   - `model.contextWindow`   → 适配器自己（`boundContextBudget` 用它判断
                 *                               「输入 + 输出放不放得下」，溢出报错文案里的
                 *                               「模型窗口 N token」也取自这里）
                 *
                 * 只改前者会得到一个割裂的状态：DSH 按 1M 排压缩，适配器却按模型定义的
                 * 300K 判溢出，于是用户明明选了 1M，仍然收到「模型窗口 300000 token」。
                 */
                const nextModel = prepared.model && typeof prepared.model === "object"
                  ? Object.freeze({ ...prepared.model, contextWindow: resolution.effective })
                  : prepared.model;
                return Object.freeze({
                  ...prepared,
                  ...(nextModel === undefined ? {} : { model: nextModel }),
                  context: Object.freeze({ ...prepared.context, contextWindow: resolution.effective }),
                });
              } catch {
                return prepared;
              }
            },
            // 宿主的失败原因原样上抛，不改判、不吞掉错误本身。
            (error) => { throw error; },
          );
        } catch {
          // 兜底：任何同步异常都退回宿主原本的方法，保证模型调用照常进行。
          return originalPrepareCall.call(this, callConfig, signal, configure);
        }
      };
      // 打标记，供后续安装时识别并剥掉本模块的旧包装（见 unwrapOwn）。
      patched.__wbTiersWrapped = true;
      patched.__wbTiersOriginal = originalPrepareCall;
      llmPrototype.prepareCall = patched;
      return () => {
        // 只有自己还在链顶时才还原。
        //
        // 不在链顶有两种情况，都不该动原型：
        //   1. 本实例已被更晚的安装剥掉（安装时会 unwrapOwn，链上至多一层本模块包装），
        //      此时原型上是别人的包装，拆了会把新实例一起废掉；
        //   2. 别的插件在本模块之上又包了一层，从下面无法摘除自己。
        // 之前这里写的是「不在链顶就 unwrapOwn 整条链」，结果先卸载旧实例会把
        // 新实例的包装一并剥掉（测试里表现为 dispose 后原型直接回到原始方法）。
        if (llmPrototype.prepareCall === patched) llmPrototype.prepareCall = originalPrepareCall;
      };
    }, "workbuddy: session tier prepareCall");
  }

  if (typeof ctx.on === "function") {
    effect(() => {
      const stop = ctx.on("agent/disposed", (payload) => {
        const sessionId = payload?.agent?.id;
        if (typeof sessionId === "string") {
          overrides.delete(sessionId);
          resolved.delete(sessionId);
        }
      });
      return () => stop?.();
    }, "workbuddy: session tier cleanup");
  }

  /**
   * 读写接口。`sessionId` 缺省时取当前会话。
   */
  const api = {
    /** 该会话当前的覆盖值与由它推出的实际预算。 */
    read(sessionId) {
      const id = typeof sessionId === "string" && sessionId !== "" ? sessionId : currentSessionId();
      if (id === undefined) return { sessionId: null, override: null, resolved: null };
      return {
        sessionId: id,
        override: overrides.get(id) ?? null,
        resolved: resolved.get(id) ?? null,
      };
    },
    /** 设置覆盖；`tier` 为 null 时清除（回到 profile 默认值）。 */
    write(sessionId, tier) {
      // 没有 agents 就取不到「当前会话」，请求路径永远查不到这份覆盖。
      // 此时写入会变成静默失效：接口成功、实际不生效。宁可明确拒绝。
      if (typeof agents?.currentInitiator !== "function") {
        return { ok: false, error: "当前宿主未提供 agents 服务，会话级档位不可用" };
      }
      const id = typeof sessionId === "string" && sessionId !== "" ? sessionId : currentSessionId();
      if (id === undefined) return { ok: false, error: "no active session" };
      if (tier === null || tier === undefined) {
        overrides.delete(id);
        resolved.delete(id);
        return { ok: true, sessionId: id, override: null, resolved: null };
      }
      const next = {};
      if (Number.isInteger(tier.contextWindow) && tier.contextWindow > 0) next.contextWindow = tier.contextWindow;
      if (Number.isInteger(tier.maxTokens) && tier.maxTokens > 0) next.maxTokens = tier.maxTokens;
      if (next.contextWindow === undefined) return { ok: false, error: "contextWindow required" };
      if (next.maxTokens !== undefined && next.maxTokens > next.contextWindow) {
        return { ok: false, error: "maxTokens must not exceed contextWindow" };
      }
      /*
       * 只按上游目录上限收敛。配置里的工作窗口（例如日常编码 200K）不是天花板，
       * 本会话可以选到比它更大的档。天花板由调用方随请求带上
       * （前端从 /context-window 的 contextWindowMax 拿到）。拿不到就不收敛。
       */
      const base = Number.isInteger(tier.contextWindowMax) && tier.contextWindowMax > 0
        ? tier.contextWindowMax
        : undefined;
      const resolvedWindow = resolveSessionWindow(base, next.contextWindow);
      const effectiveWindow = resolvedWindow.effective ?? next.contextWindow;
      const clamped = effectiveWindow !== next.contextWindow;
      next.contextWindow = effectiveWindow;
      if (next.maxTokens !== undefined) {
        next.maxTokens = Math.min(next.maxTokens, effectiveWindow);
      }
      overrides.set(id, next);
      // 覆盖值变了，之前推导出的预算不再成立，等下次请求重新解析。
      resolved.delete(id);
      while (overrides.size > MAX_TRACKED_SESSIONS) {
        const oldest = overrides.keys().next();
        if (oldest.done === true) break;
        overrides.delete(oldest.value);
      }
      return {
        ok: true,
        sessionId: id,
        override: next,
        resolved: null,
        // clamped 为 true 表示请求值被模型上限压过，调用方应据此提示用户，
        // 而不是让界面继续显示一个永远不会生效的更大数字。
        clamped,
        requestedContextWindow: clamped ? tier.contextWindow : undefined,
        contextWindowMax: base,
      };
    },
    /** 诊断用计数。 */
    stats() {
      return { overrides: overrides.size, resolved: resolved.size, preparePatched: canPatchPrepare, hits: { ...hits } };
    },
    /** 当前会话 id，供路由在客户端未显式传时使用。 */
    currentSessionId,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.();
        } catch {
          // 卸载路径不应抛出。
        }
      }
    },
  };

  return { installed: true, api };
}

/** 安装失败时的空接口，让调用方无需到处判空。 */
export function readOnlySessionTierApi() {
  return {
    read: () => ({ sessionId: null, override: null, resolved: null }),
    write: () => ({ ok: false, error: "会话级档位不可用（宿主未提供 llm 服务）" }),
    stats: () => ({ overrides: 0, resolved: 0, preparePatched: false, hits: { agentRequest: 0, prepareCall: 0, applied: 0 } }),
    currentSessionId: () => undefined,
    dispose: () => {},
  };
}



