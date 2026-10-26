window.__ModuleLoader__.load({
  id: "@wangwei2k99/dsh-workbuddy",
  factory: (require) => {
    const ROUTE = "/dsh-workbuddy/auth";
    const MARKER = "data-workbuddy-auth-switch";
    const AUTH_STATE_EVENT = "dsh-workbuddy:auth-state";
    const PENDING_MARKER = "data-workbuddy-new-session-selector";
    /**
     * 组合包可能仍以旧包名安装（改名前的 profile）。DSH 用依赖名当 bundle 名，
     * 这里两种都认，避免升级文件但没换 key 时设置面板不渲染。
     */
    const BUNDLE_NAMES = new Set(["@wangwei2k99/dsh-workbuddy", "@axiaohungry/dsh-llm-workbuddy"]);
    const WORKBUDDY_PROVIDER_PATTERN = /(?:^|-)(?:work-?buddy|code-?buddy)(?:-|$)/;
    const React = require("react");
    const { createElement, useEffect, useRef, useState } = React;

    function isWorkBuddyProvider(value) {
      const normalized = String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return normalized.length > 0 && WORKBUDDY_PROVIDER_PATTERN.test(normalized);
    }

    function isModLensWorkBuddyProvider(value) {
      const normalized = String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return /^modlens-(?:work-?buddy|code-?buddy)(?:-|$)/.test(normalized);
    }

    /** 没有目录上限时的兜底，与「日常编码」一致。 */
    const DEFAULT_CONTEXT_WINDOW = 200000;
    const DEFAULT_MAX_TOKENS = 32000;
    /** 使用场景下拉的最小宽度：四个中文字 + 箭头 + 留白。 */
    const PRESET_SELECT_WIDTH = "112px";
    /** 「窗口 / 输出」列宽，容得下 1M / 128K。 */
    const BUDGET_COLUMN_WIDTH = "120px";

    /** 预设值与已存值的归位容差：5% 以内视为同一档。 */
    const SNAP_RATIO = 0.05;

    /** 数值不属于任何档位时的占位值。 */
    const PRESET_CUSTOM = "custom";
    /** 新添加的模型默认场景。 */
    const DEFAULT_PRESET = "coding";

    /** 档位标签：1000000 写成 1M，其余整千按 K 显示。 */
    function formatTokenTier(value) {
      if (!Number.isFinite(value) || value <= 0) return "—";
      if (value >= 1000000 && value % 100000 === 0) return `${value / 1000000}M`;
      if (value % 1000 === 0) return `${value / 1000}K`;
      if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
      return String(value);
    }

    function formatBudget(contextWindow, maxTokens) {
      return `${formatTokenTier(contextWindow)} / ${formatTokenTier(maxTokens)}`;
    }

    /**
     * 四档是任务预算，不是上游上限的比例。
     * 窗口决定 DSH 何时压缩；输出是单次生成预留，思考 token 也算在里面。
     * 前三档是工作点：编码大约 200K 内召回还稳，长文放到 300K。
     * 「大型项目」是显式顶满，窗口和输出都用该模型上游上限。
     */
    const TASK_PRESETS = [
      { id: "chat", label: "简短问答", hint: "几轮对话。窗口留得短，输出只够一段回答加少量思考" },
      { id: "coding", label: "日常编码", hint: "日常改代码。窗口停在召回还稳的区间，输出留给思考和单文件" },
      { id: "document", label: "超长文档", hint: "整篇长文放进窗口。输出仍按摘要，不按整篇重写" },
      { id: "project", label: "大型项目", hint: "顶满该模型的上游窗口和输出上限" },
    ];

    /**
     * 未单列的模型共用这套目标，再按该模型自己的 maxInputTokens / maxOutputTokens 截断。
     * 小窗口模型上较高档会被截成同一组数字，界面只保留先出现的那一档。
     */
    const GENERIC_BUDGETS = {
      chat: { contextWindow: 32000, maxTokens: 16000 },
      coding: { contextWindow: 200000, maxTokens: 32000 },
      document: { contextWindow: 300000, maxTokens: 32000 },
      project: { contextWindow: 1000000, maxTokens: 128000 },
    };

    /**
     * 点名模型的前三档不走通用表。
     * Kimi 网关输出天花板是 32K。Highspeed 前三档窗口更紧，避免预填延迟吃掉速度优势。
     * GLM-5.3 不能关思考，官方编码预算常用 64K 输出，长上下文评测停在 300K。
     * 最高档不写死在表里：目录返回后直接用该模型的 maxInputTokens 和 maxOutputTokens。
     * 下面的 project 只在目录还没到时兜底。
     */
    const MODEL_BUDGETS = {
      "deepseek-v4.1-flash": {
        chat: { contextWindow: 32000, maxTokens: 16000 },
        coding: { contextWindow: 200000, maxTokens: 32000 },
        document: { contextWindow: 300000, maxTokens: 32000 },
        project: { contextWindow: 1000000, maxTokens: 128000 },
      },
      "kimi-k3.1-pro": {
        chat: { contextWindow: 32000, maxTokens: 16000 },
        coding: { contextWindow: 200000, maxTokens: 32000 },
        document: { contextWindow: 300000, maxTokens: 32000 },
        project: { contextWindow: 1000000, maxTokens: 32000 },
      },
      "kimi-k3.1-pro-highspeed": {
        chat: { contextWindow: 32000, maxTokens: 16000 },
        coding: { contextWindow: 128000, maxTokens: 32000 },
        document: { contextWindow: 256000, maxTokens: 32000 },
        project: { contextWindow: 1000000, maxTokens: 32000 },
      },
      "glm-5.3": {
        chat: { contextWindow: 64000, maxTokens: 32000 },
        coding: { contextWindow: 200000, maxTokens: 64000 },
        document: { contextWindow: 300000, maxTokens: 64000 },
        project: { contextWindow: 1000000, maxTokens: 128000 },
      },
    };

    function canonicalModelId(id) {
      return String(id ?? "").trim().toLowerCase();
    }

    /** 目标值不超过该模型上游上限，输出也不超过窗口。 */
    function clampBudget(budget, capabilities) {
      const inputCap = capabilities?.contextWindow;
      const outputCap = capabilities?.maxTokens;
      let contextWindow = budget.contextWindow;
      let maxTokens = budget.maxTokens;
      if (Number.isSafeInteger(inputCap) && inputCap > 0) contextWindow = Math.min(contextWindow, inputCap);
      if (Number.isSafeInteger(outputCap) && outputCap > 0) maxTokens = Math.min(maxTokens, outputCap);
      maxTokens = Math.min(maxTokens, contextWindow);
      return { contextWindow, maxTokens };
    }

    function presetBudget(modelId, presetId, capabilities) {
      const table = MODEL_BUDGETS[canonicalModelId(modelId)] ?? GENERIC_BUDGETS;
      const budget = table[presetId] ?? GENERIC_BUDGETS[presetId];
      if (!budget) return null;
      if (presetId !== "project") return clampBudget(budget, capabilities);
      const inputCap = Number.isSafeInteger(capabilities?.contextWindow) && capabilities.contextWindow > 0
        ? capabilities.contextWindow
        : budget.contextWindow;
      const outputCap = Number.isSafeInteger(capabilities?.maxTokens) && capabilities.maxTokens > 0
        ? capabilities.maxTokens
        : budget.maxTokens;
      return { contextWindow: inputCap, maxTokens: Math.min(outputCap, inputCap) };
    }

    /**
     * 该模型点得动的档位。截断后数字相同的档只留靠前的一个，
     * 否则点「超长文档」会被反推成「日常编码」。
     */
    function modelPresetOptions(modelId, capabilities) {
      const options = [];
      const seen = new Set();
      for (const preset of TASK_PRESETS) {
        const values = presetBudget(modelId, preset.id, capabilities);
        if (!values) continue;
        const signature = `${values.contextWindow}:${values.maxTokens}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        options.push({
          id: preset.id,
          label: preset.label,
          hint: `${preset.hint}（${formatBudget(values.contextWindow, values.maxTokens)}）`,
          ...values,
        });
      }
      return options;
    }

    /** 反推当前窗口和输出属于哪一档；对不上就是「自定义」。 */
    function matchModelPreset(model, capabilities) {
      const near = (left, right) => Number.isFinite(left) && Number.isFinite(right)
        && Math.abs(left - right) <= right * SNAP_RATIO;
      const hit = modelPresetOptions(model?.id, capabilities).find(
        (option) => near(model?.contextWindow, option.contextWindow) && near(model?.maxTokens, option.maxTokens),
      );
      return hit ? hit.id : PRESET_CUSTOM;
    }

    /** 模型列表“操作”列宽度（删除按钮所在列），表头与数据行共用。 */
    const MODEL_ACTION_COLUMN_WIDTH = 64;
    /**
     * API Key 区右侧动作按钮的固定宽度。
     * “删除”与“添加并使用”共用此值，保证上下两行按钮等宽、右缘对齐。
     * 宽度按 5 个中文字（添加并使用）+ 左右留白估算。
     */
    const KEY_ACTION_WIDTH = 108;

    /**
     * 下拉框统一样式：对齐 DSH 官方 composer 触发器。
     *
     * 规格取自 app.asar 内 dsh-client-ui-model-selection 的 .trigger 规则：
     * 透明底、无边框、label-secondary 文字、小号灰箭头。
     * 原生箭头颜色继承 color（API Key 下拉会按可用性染色），故改用固定 SVG。
     */
    const SELECT_ARROW_STYLE = Object.freeze({
      appearance: "none",
      WebkitAppearance: "none",
      MozAppearance: "none",
      border: "none",
      backgroundColor: "transparent",
      paddingRight: "26px",
      backgroundImage:
        `url("data:image/svg+xml;utf8,${encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">'
          + '<path d="M2 3.75 5 6.75l3-3" fill="none" stroke="#8b95a5" stroke-width="1.4" '
          + 'stroke-linecap="round" stroke-linejoin="round"/></svg>',
        )}")`,
      backgroundRepeat: "no-repeat",
      backgroundPosition: "right 8px center",
      backgroundSize: "10px 10px",
    });

    /**
     * 勾选框统一样式。基准 14px 放大到 1.2 倍 ≈ 17px；
     * 固定尺寸并清零默认外边距，避免与文字基线错位。
     */
    const CHECKBOX_SIZE = "17px";
    function styleCheckbox(element) {
      Object.assign(element.style, {
        accentColor: "var(--dsw-alias-brand-primary, #4f8ff7)",
        flex: "0 0 auto",
        width: CHECKBOX_SIZE,
        height: CHECKBOX_SIZE,
        margin: "0",
        cursor: "pointer",
      });
      return element;
    }

    /** 统一的聚焦描边，供输入类控件复用。 */
    const FOCUS_RING = "0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary, #4f8ff7) 22%, transparent)";

    /** 挂载一次性的样式表，承载 :hover / :focus-visible 等内联写法无法表达的状态。 */
    const STYLE_ID = "dsh-workbuddy-style";
    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
/* 空的状态胶囊不占位、不显示边框。 */
[data-wb-pill]:empty { display: none !important; }
[data-wb-ui] button[data-wb-variant="solid"]:not(:disabled):hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 86%, var(--dsw-alias-bg-base, #fff));
}
[data-wb-ui] button[data-wb-variant="danger"]:not(:disabled):hover {
  filter: brightness(1.08);
}
[data-wb-ui] button:not(:disabled):active { transform: translateY(1px); }
[data-wb-ui] button:disabled { opacity: .5; cursor: not-allowed; }
[data-wb-ui] button:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary, #4f8ff7) !important;
  box-shadow: ${FOCUS_RING};
}
[data-wb-ui] input:focus-visible,
[data-wb-ui] select:focus-visible,
[data-wb-ui] textarea:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary, #4f8ff7) !important;
  box-shadow: ${FOCUS_RING};
}
[data-wb-ui] input::placeholder { color: var(--dsw-alias-state-idle-primary, currentColor); opacity: 1; }
[data-wb-ui] ::-webkit-scrollbar { height: 8px; width: 8px; }
[data-wb-ui] ::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-border-l2, rgba(128,128,128,.4));
  border-radius: 4px;
}
[data-wb-ui] .wb-card { transition: border-color 160ms ease, box-shadow 160ms ease; }
[data-wb-ui] .wb-card:hover {
  border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.45));
  box-shadow: 0 1px 2px rgba(0,0,0,.05);
}
/*
 * 原生下拉列表的配色。
 *
 * Chromium 里 option 的弹层默认跟随系统主题（浅色），在深色界面中会变成
 * 白底 + 浅蓝高亮，与 DSH 原生控件割裂。option 只接受 color / background-color，
 * 这两条即可让弹层跟随 DSH 主题变量。
 */
[data-wb-ui] option,
[data-workbuddy-context-window] option {
  background-color: var(--dsw-alias-bg-overlay, #2b2b2b);
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
/* 选中项在部分平台由系统绘制，显式给 checked 项留出可辨识的底色。 */
[data-wb-ui] option:checked,
[data-workbuddy-context-window] option:checked {
  background-color: var(--dsw-alias-brand-primary, #4f8ff7);
  color: #fff;
}
/*
 * 上下文窗口控件：规格取自 app.asar 内 dsh-client-ui-conversation 的
 * InputBar module css 的 select 规则——即 composer 工具栏原生下拉的真实样式：
 *   border-radius: var(--dsw-radius-sm)  height: 28px  max-width: 220px
 *   color: label-secondary  background-color: #0000  border: none
 *   padding: 0 20px 0 8px  font-size: 13px  font-weight: 500  line-height: 20px
 *   箭头：12px SVG，right 4px center，描边色 #81858C
 * 菜单面板与选项沿用 PermissionSelect 的 menu / option 规格。
 */
[data-workbuddy-context-window] .wb-cw-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  min-width: 0;
  height: 28px;
  padding: 0 4px 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm, 8px);
  background: 0 0;
  color: var(--dsw-alias-label-secondary, currentColor);
  /* button 默认不继承字体，必须显式声明，否则与相邻控件字号/字族不一致。 */
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  cursor: pointer;
  outline: none;
  transition: background-color .12s;
}
[data-workbuddy-context-window] .wb-cw-trigger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08));
}
[data-workbuddy-context-window] .wb-cw-trigger:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4f8ff7));
}
[data-workbuddy-context-window] .wb-cw-trigger:disabled {
  color: var(--dsw-alias-label-dimmed, currentColor);
  cursor: default;
  opacity: .6;
}
[data-workbuddy-context-window] .wb-cw-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
[data-workbuddy-context-window] .wb-cw-chevron {
  display: inline-flex;
  flex: none;
  color: var(--dsw-alias-label-caption, currentColor);
  transition: transform .12s;
}
[data-workbuddy-context-window] .wb-cw-chevron.is-open {
  transform: rotate(180deg);
}
[data-workbuddy-context-window] .wb-cw-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  width: max-content;
  min-width: 120px;
  max-width: min(280px, calc(100vw - 32px));
  max-height: min(360px, calc(100vh - 96px));
  padding: 4px;
  overflow: hidden;
  border: 0;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-overlay, #2b2b2b);
  box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.35));
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
[data-workbuddy-context-window] .wb-cw-option {
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  width: auto;
  min-width: 100%;
  min-height: 34px;
  padding: 5px 7px;
  border: none;
  border-radius: var(--dsw-radius-md, 12px);
  background: 0 0;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  outline: none;
}
[data-workbuddy-context-window] .wb-cw-option:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08));
}
[data-workbuddy-context-window] .wb-cw-option:focus-visible {
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4f8ff7));
}
[data-workbuddy-context-window] .wb-cw-option-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: auto;
}
[data-workbuddy-context-window] .wb-cw-option-detail {
  flex: none;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #9aa3b2);
}
[data-workbuddy-context-window] .wb-cw-check {
  display: grid;
  flex: 0 0 14px;
  place-items: center;
  color: var(--dsw-alias-label-primary, #e6e6e6);
}
@media (prefers-reduced-motion: reduce) {
  [data-wb-ui] * { transition: none !important; animation: none !important; }
}
`;
      document.head.append(style);
    }

    /**
     * 按钮统一体系：变体（variant）× 尺寸（size）。
     *
     * 视觉基准＝「保存模型」那种实心按钮：反色填充（深色主题白底深字、
     * 浅色主题深底白字）+ 高对比文字。参考 shadcn/ui：不用边框表达边界，
     * 主流设计系统的 border 对比度只有 1.3 左右，靠描边会让按钮"发飘"。
     *
     * 所有变体共享同一填充与文字色以保证完全一致；仅靠字重与 hover 区分
     * 主次，破坏性动作（删除）用 danger 变体。
     *
     * size:
     *   md —— 36px，表单与工具栏（默认）
     *   sm —— 30px，列表行内
     */
    const BUTTON_SIZES = {
      md: { minHeight: "36px", padding: "0 14px", fontSize: "13px", borderRadius: "8px" },
      sm: { minHeight: "30px", padding: "0 10px", fontSize: "12px", borderRadius: "7px" },
    };

    function makeButton(text, { variant = "solid", size = "md" } = {}) {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = text;
      element.dataset.wbVariant = variant;
      element.dataset.wbSize = size;
      const metrics = BUTTON_SIZES[size] ?? BUTTON_SIZES.md;
      const danger = variant === "danger";
      Object.assign(element.style, {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "6px",
        // 透明边框仅占位，保证各变体高度一致。
        border: "1px solid transparent",
        borderRadius: metrics.borderRadius,
        minHeight: metrics.minHeight,
        padding: metrics.padding,
        // 实心反色填充：label-primary 在深色主题接近白、浅色主题接近黑。
        // 兜底用中性灰而非 currentColor —— 后者在 token 缺失时会把背景刷成
        // 文字色，导致同色文字不可见。
        background: danger
          ? "var(--dsw-alias-state-error-primary, #e5534b)"
          : "var(--dsw-alias-label-primary, #6b7280)",
        color: "var(--dsw-alias-bg-base, #fff)",
        fontSize: metrics.fontSize,
        fontWeight: "500",
        lineHeight: "1.2",
        cursor: "pointer",
        whiteSpace: "nowrap",
        boxSizing: "border-box",
        font: "inherit",
        transition: "background-color 140ms ease, opacity 140ms ease, transform 80ms ease",
      });
      element.style.fontSize = metrics.fontSize;
      return element;
    }

    function button(text) {
      return makeButton(text, { variant: "solid", size: "md" });
    }

    function primaryButton(text) {
      return makeButton(text, { variant: "solid", size: "md" });
    }

    function dangerButton(text) {
      return makeButton(text, { variant: "danger", size: "md" });
    }

    function accountPicker() {
      const element = document.createElement("select");
      element.setAttribute("aria-label", "WorkBuddy 令牌账号");
      Object.assign(element.style, {
        minHeight: "36px",
        minWidth: "180px",
        maxWidth: "260px",
        flex: "1 1 220px",
        boxSizing: "border-box",
        padding: "0 10px",
        border: "1px solid var(--dsw-alias-border-l1, currentColor)",
        borderRadius: "8px",
        // 用 backgroundColor 而非 background 简写，否则会清掉下方箭头图。
        backgroundColor: "var(--dsw-alias-bg-layer-2, transparent)",
        color: "inherit",
        font: "inherit",
        fontSize: "13px",
        transition: "border-color 140ms ease, box-shadow 140ms ease",
      });
      // 与 API Key 下拉同一套箭头样式。
      Object.assign(element.style, SELECT_ARROW_STYLE);
      return element;
    }

    function textInput(type, placeholder, ariaLabel) {
      const element = document.createElement("input");
      element.type = type;
      element.placeholder = placeholder;
      element.setAttribute("aria-label", ariaLabel);
      element.autocomplete = type === "password" ? "new-password" : "off";
      Object.assign(element.style, {
        minHeight: "36px",
        minWidth: "0",
        flex: "1 1 200px",
        boxSizing: "border-box",
        padding: "0 12px",
        border: "1px solid var(--dsw-alias-border-l1, currentColor)",
        borderRadius: "8px",
        background: "var(--dsw-alias-bg-layer-2, transparent)",
        color: "inherit",
        font: "inherit",
        fontSize: "13px",
        transition: "border-color 140ms ease, box-shadow 140ms ease",
      });
      return element;
    }

    function fieldLabel(text) {
      const element = document.createElement("span");
      element.textContent = text;
      Object.assign(element.style, {
        flex: "0 0 auto",
        minWidth: "92px",
        fontSize: "12px",
        lineHeight: "20px",
        fontWeight: "500",
        letterSpacing: "0.01em",
        color: "var(--dsw-alias-label-secondary, currentColor)",
      });
      return element;
    }

    function row() {
      const element = document.createElement("div");
      Object.assign(element.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
        width: "100%",
      });
      return element;
    }

    function section() {
      const element = document.createElement("div");
      element.className = "wb-card";
      Object.assign(element.style, {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        width: "100%",
        boxSizing: "border-box",
        padding: "12px 14px",
        border: "1px solid var(--dsw-alias-border-l1, currentColor)",
        borderRadius: "12px",
        background: "var(--dsw-alias-bg-layer-1, transparent)",
      });
      return element;
    }

    function setVisible(element, visible, display = "flex") {
      element.hidden = !visible;
      element.style.setProperty("display", visible ? display : "none", "important");
    }

    /** 胶囊状状态提示的共用样式，用于各处 message / hint。 */
    const PILL_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      alignSelf: "flex-start",
      padding: "2px 10px",
      borderRadius: "999px",
      border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
      background: "color-mix(in srgb, currentColor 10%, transparent)",
      fontSize: "12px",
      fontWeight: "500",
      minHeight: "18px",
      lineHeight: "18px",
      // 默认使用成功色（绿），与“API Key 已就绪”提示保持一致；
      // 出错时由调用方覆盖为错误色。
      color: "var(--dsw-alias-state-success-primary, #3fb950)",
    };

    /**
     * 空内容时收缩为 0，避免露出一条无文字的灰框。
     * 规则定义在 ensureStyles() 的样式表里（[data-wb-pill]:empty）。
     */

    function isWorkBuddy(input) {
      const editor = input.parentElement?.parentElement;
      if (!editor) return false;
      if (isWorkBuddyProvider(editor.textContent)) return true;
      const provider = editor.parentElement?.querySelector('select[aria-label="提供方"]')?.value;
      return isWorkBuddyProvider(provider);
    }

    function accountText(account) {
      const label = account?.accountName || account?.label || account?.account?.displayName || account?.account?.email || account?.account?.userId || "未命名账号";
      const userId = account?.userId || account?.account?.userId;
      return userId && userId !== label ? `${label} · ${String(userId).slice(0, 8)}` : label;
    }

    function accountLabel(account) {
      return account?.accountName || account?.label || account?.account?.displayName || account?.account?.email || account?.account?.userId || "未命名账号";
    }

    function apiKeyText(key) {
      const label = key?.label || (key?.kind === "environment" ? `环境变量 ${key.ref}` : "DSH 保存的 API Key");
      const suffix = key?.masked ? ` · ${key.masked}` : "";
      return key?.configured === false ? `${label}（不可用）` : `${label}${suffix}`;
    }

    function apiKeyLabel(key) {
      return key?.label || (key?.kind === "environment" ? `环境变量 ${key.ref}` : "DSH 保存的 API Key");
    }

    function formatCredits(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—";
    }

    async function authRequest(path, body, sessionId, query) {
      const options = {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
      };
      if (body !== undefined) {
        options.headers = { "content-type": "application/json" };
        options.body = JSON.stringify({ ...body, ...(sessionId && body.sessionId === undefined ? { sessionId: String(sessionId) } : {}) });
      }
      const params = new URLSearchParams();
      if (sessionId && body === undefined) params.set("sessionId", String(sessionId));
      for (const [key, raw] of Object.entries(query ?? {})) {
        if (raw !== undefined && raw !== null) params.set(key, String(raw));
      }
      const search = params.toString();
      const response = await fetch(`${ROUTE}/${path}${search ? `?${search}` : ""}`, options);
      const text = await response.text();
      let result = {};
      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        result = {};
      }
      if (!response.ok || result.ok === false) {
        const error = new Error(result.message || `请求失败（${response.status}）`);
        error.status = response.status;
        throw error;
      }
      return result;
    }

    function notifyAuthState() {
      if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_STATE_EVENT));
      if (typeof document !== "undefined") {
        for (const panel of document.querySelectorAll(`[${PENDING_MARKER}]`)) {
          delete panel.dataset.loaded;
          mountPendingSelector();
        }
      }
    }

    /**
     * 部署默认模型，由本插件自己的 host 路由给出（`status.defaultSelection`）。
     *
     * 为什么不直接读客户端的 `modelDirectories`：那个服务的 `catalog.store`
     * 是内部实现，`subscribe` 之类的细节没有公开契约，依赖它会随宿主版本
     * 静默失效。改走自己的路由，来源是宿主的 `agentDefaultModel` 服务，
     * 与 `buildModelCatalog` 的默认值同源 —— 也就是 `agent-default-model`
     * 的配置，不是模型列表的第一项。
     *
     * 读不到就返回 undefined，控件不显示，绝不猜一个模型名。
     */
    // 用哨兵区分「还没请求过」和「请求过但宿主没有默认模型」，
    // 否则后者会让每个控件每次渲染都重发一次请求。
    const UNKNOWN = Symbol("workbuddy.defaultSelection.unknown");
    let defaultSelectionCache = UNKNOWN;

    function useDefaultSelection() {
      const [value, setValue] = useState(defaultSelectionCache);
      useEffect(() => {
        let disposed = false;
        if (defaultSelectionCache !== UNKNOWN) return undefined;
        authRequest("status")
          .then((status) => {
            defaultSelectionCache = status?.defaultSelection ?? undefined;
            if (!disposed) setValue(defaultSelectionCache);
          })
          .catch(() => {
            // 失败也不留 UNKNOWN，避免控件反复重试；下次载入重新尝试。
            defaultSelectionCache = undefined;
            if (!disposed) setValue(undefined);
          });
        return () => { disposed = true; };
      }, []);
      return value === UNKNOWN ? undefined : value;
    }

    /**
     * 解析「当前这件控件该针对哪个模型」，只读一次来源。
     * provider 与 model 必须同时来自同一处：宿主目录是异步刷新的，
     * 各读一次可能拼出根本不存在的组合。
     *
     * @returns `source` 区分来源：`projected` 是会话里的持久选择，
     *   `default` 是部署默认（空会话），`none` 说明还拿不到。
     */
    function resolveSelection(selection, fallback) {
      const projected = selection?.next ?? selection?.lastUsed ?? undefined;
      if (projected !== undefined) {
        return { provider: projected.provider, model: projected.model, source: "projected" };
      }
      if (fallback !== undefined) {
        return { provider: fallback.provider, model: fallback.model, source: "default" };
      }
      return { provider: undefined, model: undefined, source: "none" };
    }

    function pendingCredentialOptions(status, mode) {
      return mode === "token"
        ? (Array.isArray(status.accounts) ? status.accounts : []).map((account) => ({ id: account.id, label: accountText(account) }))
        : (Array.isArray(status.apiKeys) ? status.apiKeys : []).map((key) => ({ id: key.id, label: apiKeyText(key), disabled: key.configured === false }));
    }

    function createPendingSelector() {
      const panel = document.createElement("div");
      panel.setAttribute(PENDING_MARKER, "");
      panel.setAttribute("role", "group");
      panel.setAttribute("aria-label", "WorkBuddy 新会话凭证");
      Object.assign(panel.style, {
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        flexWrap: "wrap",
        gap: "6px",
        width: "100%",
        maxWidth: "var(--dsh-composer-card-max-width, 720px)",
        margin: "0 auto 8px",
        padding: "0 8px",
        color: "var(--dsw-alias-state-idle-primary, currentColor)",
        fontSize: "12px",
        lineHeight: "20px",
      });
      const label = document.createElement("span");
      label.textContent = "新会话默认凭证";
      const mode = document.createElement("select");
      mode.setAttribute("aria-label", "新会话认证模式");
      const credential = document.createElement("select");
      credential.setAttribute("aria-label", "新会话 WorkBuddy 凭证");
      for (const element of [mode, credential]) Object.assign(element.style, {
        boxSizing: "border-box",
        minWidth: "0",
        maxWidth: "min(240px, 100%)",
        height: "28px",
        padding: "0 6px",
        border: "1px solid var(--dsw-alias-border-l1, currentColor)",
        borderRadius: "7px",
        // 用 backgroundColor 保留下方箭头图。
        backgroundColor: "var(--dsw-alias-bg-layer-1, transparent)",
        color: "inherit",
        font: "inherit",
        fontSize: "12px",
      });
      // 这里高度只有 28px，用缩小版箭头（10px 图标 + 8px 间距）。
      for (const element of [mode, credential]) Object.assign(element.style, {
        appearance: "none",
        WebkitAppearance: "none",
        MozAppearance: "none",
        paddingRight: "26px",
        backgroundImage: SELECT_ARROW_STYLE.backgroundImage,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 8px center",
        backgroundSize: "10px 10px",
      });
      const hint = document.createElement("span");
      hint.textContent = "发送时自动绑定所选凭证";
      hint.style.color = "var(--dsw-alias-state-idle-primary, currentColor)";
      panel.append(label, mode, credential, hint);
      panel._workbuddyMode = mode;
      panel._workbuddyCredential = credential;
      panel._workbuddyHint = hint;
      const apply = async () => {
        if (panel.dataset.busy === "1") return;
        const value = credential.value;
        if (!value || credential.selectedOptions[0]?.disabled) return;
        panel.dataset.busy = "1";
        mode.disabled = true;
        credential.disabled = true;
        hint.textContent = "正在保存新会话默认凭证…";
        try {
          const next = mode.value === "token"
            ? await authRequest("token", { accountId: value })
            : await authRequest("api-key", { keyId: value });
          renderPendingSelector(panel, next);
          notifyAuthState();
        } catch (error) {
          hint.textContent = error instanceof Error ? error.message : "保存新会话凭证失败";
          hint.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
        } finally {
          delete panel.dataset.busy;
          mode.disabled = false;
          credential.disabled = false;
        }
      };
      mode.addEventListener("change", () => {
        renderPendingOptions(panel, panel._workbuddyStatus, mode.value);
        void apply();
      });
      credential.addEventListener("change", () => void apply());
      return panel;
    }

    function renderPendingOptions(panel, status, preferredMode) {
      if (!status) return;
      const tokenOptions = pendingCredentialOptions(status, "token");
      const apiOptions = pendingCredentialOptions(status, "api-key");
      const tokenAvailable = tokenOptions.length > 0;
      const apiAvailable = apiOptions.some((option) => !option.disabled);
      if (!status.routingEnabled || (!tokenAvailable && !apiAvailable)) {
        panel.hidden = true;
        panel.style.setProperty("display", "none", "important");
        return;
      }
      panel.hidden = false;
      panel.style.setProperty("display", "flex", "important");
      const suggestedMode = status.suggestedBinding?.mode;
      const modeAvailable = (value) => value === "token" ? tokenAvailable : value === "api-key" && apiAvailable;
      const mode = modeAvailable(preferredMode)
        ? preferredMode
        : modeAvailable(suggestedMode)
          ? suggestedMode
          : status.mode === "token" && tokenAvailable ? "token" : "api-key";
      const modeSelect = panel._workbuddyMode;
      const credentialSelect = panel._workbuddyCredential;
      modeSelect.replaceChildren();
      for (const [value, label, disabled] of [["token", "令牌", !tokenAvailable], ["api-key", "API Key", !apiAvailable]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.disabled = disabled;
        modeSelect.append(option);
      }
      modeSelect.value = mode;
      const options = mode === "token" ? tokenOptions : apiOptions;
      credentialSelect.replaceChildren(...options.map((entry) => {
        const option = document.createElement("option");
        option.value = entry.id;
        option.textContent = entry.label;
        option.disabled = entry.disabled === true;
        return option;
      }));
      const activeId = mode === "token"
        ? status.suggestedAccountId ?? status.activeAccountId
        : status.suggestedApiKeyId ?? status.activeApiKeyId;
      if (activeId && options.some((entry) => entry.id === activeId && !entry.disabled)) credentialSelect.value = activeId;
      panel._workbuddyHint.textContent = "发送时自动绑定所选凭证";
      panel._workbuddyHint.style.color = "var(--dsw-alias-state-idle-primary, currentColor)";
    }

    function renderPendingSelector(panel, status) {
      panel._workbuddyStatus = status;
      renderPendingOptions(panel, status, panel._workbuddyMode.value);
    }

    function mountPendingSelector() {
      if (typeof document === "undefined") return;
      const seats = Array.from(document.querySelectorAll("[data-composer-seat]"));
      // 先判 seat 再查 panel：非 hero 相位占多数，此时不应为查找面板而再扫一遍文档。
      const seat = seats.find((candidate) => candidate.closest('[data-phase="hero"]'));
      if (!seat) {
        // 仅在确实存在残留面板时才做清理扫描。
        if (document.querySelector(`[${PENDING_MARKER}]`)) {
          for (const panel of document.querySelectorAll(`[${PENDING_MARKER}]`)) panel.remove();
        }
        return;
      }
      for (const panel of seat.querySelectorAll(`[${PENDING_MARKER}]`)) {
        if (panel.parentElement !== seat) panel.remove();
      }
      const panel = seat.querySelector(`[${PENDING_MARKER}]`) ?? createPendingSelector();
      if (!panel.parentElement) seat.append(panel);
      if (panel.dataset.loading === "1" || panel.dataset.loaded === "1") return;
      panel.dataset.loading = "1";
      authRequest("status")
        .then((status) => {
          panel.dataset.loaded = "1";
          renderPendingSelector(panel, status);
        })
        .catch(() => {
          panel.hidden = true;
          panel.style.setProperty("display", "none", "important");
        })
        .finally(() => {
          delete panel.dataset.loading;
        });
    }

    function WorkBuddyCreditsDock({ useProjection, sessionId }) {
      let selection;
      try {
        selection = typeof useProjection === "function" ? useProjection("modelSelection") : undefined;
      } catch {
        selection = undefined;
      }
      // 空会话投影没有 provider：按部署默认模型判断，
      // 否则整条用量条在新会话里不渲染。
      const resolved = resolveSelection(selection, useDefaultSelection());
      const provider = resolved.provider;
      const selected = isWorkBuddyProvider(provider);
      const modlens = isModLensWorkBuddyProvider(provider);
      const [state, setState] = useState(null);

      useEffect(() => {
        let disposed = false;
        let requestId = 0;
        // 轮询与首次加载要区别对待：首次加载可以显示「读取中」，
        // 但每分钟一次的刷新若也置为 loading，界面会周期性闪一下，
        // 且丢弃已显示的数据。这里用 silent 标记静默刷新。
        const load = async (silent = false) => {
          const currentRequestId = ++requestId;
          if (!selected) {
            setState(null);
            return;
          }
          if (!silent) {
            setState({ mode: "token", creditLoading: true, credits: undefined, todayUsage: null, creditError: null, todayUsageError: null });
          }
          let status;
          try {
            status = await authRequest("status", undefined, sessionId);
          } catch {
            if (!disposed && currentRequestId === requestId && !silent) setState(null);
            return;
          }
          if (disposed || currentRequestId !== requestId) return;
          if (status.mode !== "token" || !status.activeAccountId) {
            setState({ ...status, creditLoading: false });
            return;
          }
          try {
            const result = await authRequest("credits", { accountId: status.activeAccountId }, sessionId);
            if (!disposed && currentRequestId === requestId) setState({ ...status, ...result, creditLoading: false });
          } catch (error) {
            if (!disposed && currentRequestId === requestId) {
              const message = error instanceof Error ? error.message : "查询 WorkBuddy 积分失败";
              setState({
                ...status,
                credits: null,
                creditLoading: false,
                creditError: message,
                todayUsage: null,
                todayUsageError: "查询 WorkBuddy 今日请求量失败",
              });
            }
          }
        };
        load();
        // 认证状态切换说明凭证真的变了，需要重新展示「读取中」。
        const onAuthState = () => load();
        window.addEventListener(AUTH_STATE_EVENT, onAuthState);
        // 注意不能直接把 load 交给 setInterval：定时器会把当前时间作为
        // 第一个实参传入，导致 silent 变成 truthy 而误判为静默刷新。
        const timer = window.setInterval(() => load(true), 60_000);
        return () => {
          disposed = true;
          window.removeEventListener(AUTH_STATE_EVENT, onAuthState);
          window.clearInterval(timer);
        };
      }, [provider, selected, sessionId]);

      const hasTokenAccount = state?.mode === "token" && Boolean(state.activeAccountId);
      if (!selected || !state || (!state.routingEnabled && state.mode !== "token") || (!state.routingEnabled && state.mode === "token" && !state.activeAccountId) || (!sessionId && !hasTokenAccount)) return null;
      const creditsText = state.creditLoading
        ? "剩余积分：读取中…"
        : state.unlimited
          ? "剩余积分：不限量"
          : typeof state.credits === "number" && Number.isFinite(state.credits)
            ? `剩余积分：${formatCredits(state.credits)}`
            : state.creditError
              ? "剩余积分：暂不可用"
              : "剩余积分：—";
      const today = state.todayUsage;
      const usageText = today?.synced === true
        ? `今日请求：${Number.isFinite(Number(today.count)) ? Number(today.count) : 0} 次 · 用量 ${formatCredits(today.used)} 积分`
        : state.creditLoading
          ? "今日请求：读取中…"
          : state.todayUsageError
            ? "今日请求：暂不可用"
            : "今日请求：—";
      const modlensHint = modlens ? createElement("span", {
        "data-workbuddy-modlens-hint": true,
        title: "ModLens 会先处理会话中的历史图片，首次响应可能较慢；若超时、无响应或返回 429，请检查视觉引擎登录、网络和额度。纯文本任务可切换 WorkBuddy 直连。",
        style: {
          flex: "1 1 100%",
          minWidth: 0,
          color: "var(--dsw-alias-state-idle-primary, currentColor)",
          fontSize: "11px",
          lineHeight: "16px",
          textAlign: "right",
        },
      }, "ModLens：历史图片会先处理，响应较慢或出现 429 时请检查视觉引擎与额度；纯文本可切换 WorkBuddy 直连") : null;
      const activeAccount = Array.isArray(state.accounts) ? state.accounts.find((account) => account.id === state.activeAccountId) : undefined;
      const credentialOptions = state.mode === "token"
        ? (Array.isArray(state.accounts) ? state.accounts.map((account) => createElement("option", { key: account.id, value: account.id }, accountText(account))) : [])
        : (Array.isArray(state.apiKeys) ? state.apiKeys.map((key) => createElement("option", { key: key.id, value: key.id, disabled: key.configured === false }, apiKeyText(key))) : []);
      const confirmBindingChange = (message) => typeof window === "undefined" || window.confirm(message);
      const applyBindingResult = async (result) => {
        setState(result);
        if (result.mode === "token" && result.activeAccountId) {
          try {
            const credits = await authRequest("credits", { accountId: result.activeAccountId }, sessionId);
            setState({ ...result, ...credits, creditLoading: false });
          } catch (error) {
            setState({
              ...result,
              credits: null,
              creditLoading: false,
              creditError: error instanceof Error ? error.message : "查询 WorkBuddy 积分失败",
              todayUsage: null,
              todayUsageError: "查询 WorkBuddy 今日请求量失败",
            });
          }
        }
      };
      const bindCredential = async (mode, value, failureMessage) => {
        try {
          const result = mode === "token"
            ? await authRequest("token", { accountId: value }, sessionId)
            : await authRequest("api-key", { keyId: value }, sessionId);
          await applyBindingResult(result);
        } catch (error) {
          setState({ ...state, creditError: error instanceof Error ? error.message : failureMessage });
        }
      };
      const onSessionCredentialChange = async (event) => {
        if (!state.routingEnabled || !sessionId) return;
        const value = event.target.value;
        if (!confirmBindingChange("切换后，当前已发出的请求继续使用原凭证；后续模型调用将使用新凭证。确定切换吗？")) {
          event.target.value = state.mode === "token" ? state.activeAccountId ?? "" : state.activeApiKeyId ?? "";
          return;
        }
        await bindCredential(state.mode, value, "切换会话凭证失败");
      };
      const onSessionModeChange = async (event) => {
        if (!state.routingEnabled || !sessionId) return;
        const mode = event.target.value;
        const value = mode === "token" ? state.accounts?.[0]?.id : state.apiKeys?.find((key) => key.configured)?.id;
        if (!value) return;
        if (!confirmBindingChange("切换后，当前已发出的请求继续使用原凭证；后续模型调用将使用新凭证。确定切换认证模式吗？")) {
          event.target.value = state.mode;
          return;
        }
        await bindCredential(mode, value, "切换会话认证模式失败");
      };
      const onUnbind = async () => {
        if (!state.routingEnabled || !sessionId || !state.sessionBinding) return;
        if (!confirmBindingChange("解除后，当前会话将在下一次模型调用时绑定当前默认凭证。确定解除吗？")) return;
        try {
          await applyBindingResult(await authRequest("unbind", {}, sessionId));
        } catch (error) {
          setState({ ...state, creditError: error instanceof Error ? error.message : "解除会话凭证失败" });
        }
      };
      // 与插件其余按钮保持同一套实心视觉，仅按 sm 尺寸收紧。
      const actionStyle = {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid transparent",
        padding: "0 10px",
        minHeight: BUTTON_SIZES.sm.minHeight,
        borderRadius: BUTTON_SIZES.sm.borderRadius,
        // 兜底用中性灰而非 currentColor：若 token 缺失，currentColor 会把背景
        // 刷成文字色，导致同色文字不可见。
        background: "var(--dsw-alias-label-primary, #6b7280)",
        color: "var(--dsw-alias-bg-base, #fff)",
        font: "inherit",
        fontSize: BUTTON_SIZES.sm.fontSize,
        fontWeight: "500",
        cursor: "pointer",
        lineHeight: "1.2",
        whiteSpace: "nowrap",
      };
      const bindingTone = state.sessionBinding
        ? "var(--dsw-alias-state-success-primary, #3fb950)"
        : "var(--dsw-alias-state-idle-primary, currentColor)";
      const sessionControls = state.routingEnabled && sessionId ? createElement(
        "span",
        { "data-workbuddy-session-controls": true, style: { display: "inline-flex", alignItems: "center", justifyContent: "flex-end", flex: "1 1 100%", flexWrap: "wrap", gap: "4px", minWidth: 0, maxWidth: "100%" } },
        createElement("span", {
          title: state.sessionBinding ? "当前会话已使用独立凭证" : "当前会话未绑定，下次发送将固化当前默认凭证",
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            color: bindingTone,
            fontWeight: "500",
          },
        },
        createElement("span", {
          "aria-hidden": true,
          style: { width: "6px", height: "6px", borderRadius: "50%", background: bindingTone, flex: "0 0 auto" },
        }),
        state.sessionBinding ? "已绑定" : "未绑定"),
        createElement("select", { value: state.mode, onChange: onSessionModeChange, "aria-label": "当前会话认证模式", style: { border: "0", background: "transparent", color: "inherit", font: "inherit", fontSize: "12px", minWidth: 0, maxWidth: "110px" } },
          createElement("option", { value: "token" }, "令牌"),
          createElement("option", { value: "api-key" }, "API Key"),
        ),
        createElement("select", { value: state.mode === "token" ? state.activeAccountId ?? "" : state.activeApiKeyId ?? "", onChange: onSessionCredentialChange, "aria-label": "当前会话凭证", style: { border: "0", background: "transparent", color: "inherit", font: "inherit", fontSize: "12px", minWidth: 0, maxWidth: "190px" } }, credentialOptions),
        state.sessionBinding ? createElement("button", { type: "button", "data-wb-variant": "subtle", "data-wb-size": "sm", onClick: onUnbind, title: "解除当前绑定，下次发送时重新绑定默认凭证", style: actionStyle }, "解除绑定") : null,
        createElement("span", { "aria-hidden": true, style: { opacity: 0.55, padding: "0 2px" } }, "·"),
      ) : null;
      return createElement(
        "div",
        {
          className: "dsh-workbuddy-credits",
          "data-workbuddy-credits": true,
          "data-wb-ui": "",
          "data-workbuddy-session-aware": state.routingEnabled ? true : undefined,
          role: "status",
          "aria-live": "polite",
          title: [activeAccount ? `当前账号：${accountText(activeAccount)}` : "", state.creditError, state.todayUsageError].filter(Boolean).join("；") || undefined,
          style: {
            boxSizing: "border-box",
            minWidth: 0,
            width: "100%",
            maxWidth: "100%",
            minHeight: "20px",
            padding: "0",
            display: "inline-flex",
            flexWrap: "wrap",
            gap: "2px 8px",
            flex: "0 1 auto",
            justifyContent: "flex-end",
            alignItems: "center",
            color: "var(--dsw-alias-state-idle-primary, currentColor)",
            fontSize: "12px",
            lineHeight: "18px",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "normal",
            overflow: "visible",
            textOverflow: "clip",
          },
        },
        sessionControls,
        state.mode === "token" ? createElement("span", null, creditsText) : null,
        state.mode === "token" ? createElement("span", { "aria-hidden": true, style: { opacity: 0.55, padding: "0 4px" } }, "·") : null,
        state.mode === "token" ? createElement("span", null, usageText) : createElement("span", null, "当前会话 API Key"),
        modlensHint,
      );
    }

    function installComposerDockLayout() {
      if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="dsh-workbuddy-composer-dock"]')) return;
      const style = document.createElement("style");
      style.dataset.plugin = "@wangwei2k99/dsh-workbuddy";
      style.dataset.pluginCss = "dsh-workbuddy-composer-dock";
      style.textContent = `
[data-slot="conversation.composer.dock"]:has(> [data-composer-stats]),
[data-slot="conversation.composer.dock"]:has(> [data-workbuddy-credits]) {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 0 4px 4px;
  overflow: hidden;
}
[data-slot="conversation.composer.dock"] > [data-composer-stats] {
  grid-column: 2;
  width: auto !important;
  max-width: 100%;
  min-width: 0;
  margin: 0 !important;
}
[data-slot="conversation.composer.dock"] > [data-workbuddy-credits] {
  grid-column: 3;
  justify-self: end;
  width: 100% !important;
  max-width: 100%;
  min-width: 0;
  margin: 0 !important;
}
[data-slot="conversation.composer.dock"] > [data-workbuddy-credits] > span {
  min-width: 0;
}
[data-slot="conversation.composer.dock"] > [data-workbuddy-credits] > [data-workbuddy-session-controls] {
  flex-basis: 100%;
  width: 100%;
}
@media (max-width: 760px) {
  [data-slot="conversation.composer.dock"]:has(> [data-composer-stats]),
  [data-slot="conversation.composer.dock"]:has(> [data-workbuddy-credits]) {
    display: flex !important;
    flex-wrap: wrap;
    justify-content: center;
  }
  [data-slot="conversation.composer.dock"] > [data-composer-stats],
  [data-slot="conversation.composer.dock"] > [data-workbuddy-credits] {
    flex: 0 1 auto;
  }
}
`;
      document.head.appendChild(style);
    }

    function applyCreditStatus(stats, status, activeAccount) {
      const visible = status.mode === "token" && Boolean(activeAccount);
      setVisible(stats, visible);
      if (!visible) return;
      const credit = stats.querySelector('[data-workbuddy-stat="credits"]');
      const usage = stats.querySelector('[data-workbuddy-stat="usage"]');
      credit.title = status.creditError || "";
      usage.title = status.todayUsageError || "";
      if (status.creditLoading) credit.textContent = "剩余积分：读取中…";
      else if (status.unlimited) credit.textContent = "剩余积分：不限量";
      else if (typeof status.credits === "number" && Number.isFinite(status.credits)) credit.textContent = `剩余积分：${formatCredits(status.credits)}`;
      else credit.textContent = status.creditError ? "剩余积分：暂不可用" : "剩余积分：—";
      const today = status.todayUsage;
      if (today && today.synced === true) {
        usage.textContent = `今日请求：${Number.isFinite(Number(today.count)) ? Number(today.count) : 0} 次 · 用量 ${formatCredits(today.used)} 积分`;
      } else {
        usage.textContent = status.creditLoading ? "今日请求：读取中…" : status.todayUsageError ? "今日请求：暂不可用" : "今日请求：—";
      }
    }

    function applyMode(input, keyButton, tokenButton, keySection, keySourceRow, keySelect, keyHint, newKeyInput, newKeyLabelInput, saveKeyButton, removeKeyButton, tokenSection, accountRow, accountSelect, accountName, addButton, removeButton, accountStats, routingRow, routingToggle, message, status) {
      const token = status.mode === "token";
      const apiKeys = Array.isArray(status.apiKeys) ? status.apiKeys : [];
      const activeApiKeyId = status.activeApiKeyId ?? apiKeys[0]?.id;
      const activeApiKey = apiKeys.find((key) => key.id === activeApiKeyId);
      const accounts = Array.isArray(status.accounts) ? status.accounts : [];
      const activeAccountId = status.activeAccountId ?? accounts[0]?.id;
      input.disabled = token;
      input.placeholder = token ? "当前使用 WorkBuddy 账号令牌" : "输入新的 API Key（保存到 DSH）";
      newKeyInput.disabled = token;
      newKeyLabelInput.disabled = token;
      // 模式切换：未选中用中性填充，选中用反色实心填充。
      // 两个状态都靠“填充”而非边框区分，与全站按钮同一套视觉。
      const setPressed = (element, pressed) => {
        element.setAttribute("aria-pressed", String(pressed));
        element.style.background = pressed
          ? "var(--dsw-alias-label-primary, currentColor)"
          : "var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, transparent))";
        element.style.color = pressed
          ? "var(--dsw-alias-bg-base, #fff)"
          : "var(--dsw-alias-label-secondary, currentColor)";
        element.style.borderColor = "transparent";
        element.style.boxShadow = "none";
        element.style.fontWeight = pressed ? "600" : "500";
      };
      setPressed(keyButton, !token);
      setPressed(tokenButton, token);
      setVisible(keySection, !token);
      setVisible(keySourceRow, apiKeys.length > 0);
      keySelect.replaceChildren(...apiKeys.map((key) => {
        const option = document.createElement("option");
        option.value = key.id;
        const usable = key.configured !== false;
        // apiKeyText 对不可用项已带“（不可用）”后缀，这里只补“可用”标记，
        // 避免出现“（不可用） · 不可用”的重复表述。
        option.textContent = usable ? `${apiKeyText(key)} · 可用` : apiKeyText(key);
        option.title = apiKeyLabel(key);
        option.style.color = usable
          ? "var(--dsw-alias-state-success-primary, #3fb950)"
          : "var(--dsw-alias-state-error-primary, #e5534b)";
        return option;
      }));
      if (activeApiKeyId) keySelect.value = activeApiKeyId;
      // 收起状态下 <select> 显示的文字用的是它自身的 color，不继承 option 的颜色，
      // 因此按当前选中项的可用性同步设置，保证收起/展开状态一致。
      const selectedKey = apiKeys.find((key) => key.id === keySelect.value);
      keySelect.style.color = selectedKey === undefined
        ? "var(--dsw-alias-label-primary, currentColor)"
        : selectedKey.configured === false
          ? "var(--dsw-alias-state-error-primary, #e5534b)"
          : "var(--dsw-alias-state-success-primary, #3fb950)";
      // 文案统一为“当前使用”，颜色按当前 Key 是否可用切换。
      keyHint.textContent = token
        ? ""
        : activeApiKey
          ? `当前使用：${apiKeyText(activeApiKey)}`
          : "未检测到可用 API Key，可输入新 Key 保存";
      if (!token && activeApiKey) {
        const usable = status.apiKeyConfigured && activeApiKey.configured !== false;
        keyHint.style.color = usable
          ? "var(--dsw-alias-state-success-primary, #3fb950)"
          : "var(--dsw-alias-state-error-primary, #e5534b)";
      } else if (!token) {
        keyHint.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
      }
      keyHint.title = activeApiKey ? apiKeyLabel(activeApiKey) : "";
      saveKeyButton.textContent = "添加并使用";
      removeKeyButton.hidden = !activeApiKey || activeApiKey.kind !== "dsh";
      setVisible(tokenSection, token);
      tokenButton.textContent = token ? "令牌模式" : "令牌登录";
      addButton.textContent = accounts.length ? "添加账号" : "登录 WorkBuddy";
      setVisible(accountRow, token && accounts.length > 0);
      accountSelect.replaceChildren(...accounts.map((account) => {
        const option = document.createElement("option");
        option.value = account.id;
        option.textContent = accountText(account);
        option.title = accountLabel(account);
        return option;
      }));
      if (activeAccountId) accountSelect.value = activeAccountId;
      const activeAccount = accounts.find((account) => account.id === activeAccountId);
      accountName.textContent = activeAccount ? `当前账号：${accountText(activeAccount)}` : "";
      accountName.title = activeAccount ? accountLabel(activeAccount) : "";
      removeButton.hidden = !token || !activeAccount;
      setVisible(accountStats, token && Boolean(activeAccount));
      applyCreditStatus(accountStats, status, activeAccount);
      routingToggle.checked = status.routingEnabled === true;
      routingToggle.disabled = false;
      routingRow.title = status.routingEnabled ? "已启用：每个会话可单独选择 WorkBuddy 账号或 API Key" : "关闭时使用原有的全局账号或 API Key";
      // 成功状态不再占用界面空间：清空文字后由 [data-wb-pill]:empty 隐藏。
      // 失败状态仍需提示用户，保留文字与红色。
      const healthy = token ? status.authenticated : status.apiKeyConfigured;
      if (healthy) {
        message.textContent = "";
      } else {
        message.textContent = token ? "令牌缺失，请重新登录" : "未配置 API Key，请输入后保存";
        message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
      }
    }

    async function request(path, body) {
      const options = { method: "POST" };
      if (body !== undefined) {
        options.headers = { "content-type": "application/json" };
        options.body = JSON.stringify(body);
      }
      const response = await fetch(`${ROUTE}/${path}`, options);
      const result = await response.json();
      if (!response.ok || !result.ok) {
        const error = new Error(result.message || `请求失败（${response.status}）`);
        error.status = response.status;
        throw error;
      }
      return result;
    }

    function mount(input) {
      const field = input.parentElement;
      if (!field || field.querySelector(`[${MARKER}]`)) return;
      field.setAttribute("data-workbuddy-auth-field", "");
      input.dataset.workbuddyPlaceholder = input.placeholder;
      for (const nativeNode of field.children) nativeNode.hidden = true;
      Object.assign(field.style, { display: "block", width: "100%", boxSizing: "border-box" });
      const controls = document.createElement("div");
      controls.setAttribute(MARKER, "");
      controls.setAttribute("data-wb-ui", "");
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", "WorkBuddy 认证方式");
      Object.assign(controls.style, {
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: "10px",
        width: "100%",
        maxWidth: "100%",
        // 不再额外加顶部内边距：section() 已有 12px，模型区同样靠这 12px，
        // 两处顶部间距才能一致。
        boxSizing: "border-box",
        color: "var(--dsw-alias-label-primary, currentColor)",
      });
      const modeRow = row();
      const keySection = section();
      const keySourceRow = row();
      const keyAddRow = row();
      const tokenSection = section();
      const accountRow = row();
      const tokenActionRow = row();
      const keyButton = button("API Key");
      const tokenButton = button("令牌登录");
      const keySelect = accountPicker();
      keySelect.setAttribute("aria-label", "WorkBuddy API Key 来源");
      // 复用统一下拉箭头样式（隐藏原生箭头，避免跟着绿/红文字变色）。
      Object.assign(keySelect.style, SELECT_ARROW_STYLE);
      const keySourceLabel = fieldLabel("当前 API Key");
      const newKeyLabel = fieldLabel("新增 API Key");
      const newKeyInput = textInput("password", "粘贴新的 API Key", "新增 WorkBuddy API Key");
      const newKeyLabelInput = textInput("text", "名称（可选）", "API Key 名称");
      const keyHint = document.createElement("span");
      // 令牌模式下文字会被清空，用 :empty 规则隐藏，避免露出空胶囊。
      keyHint.setAttribute("data-wb-pill", "");
      // 与状态胶囊同款外观：描边 + 半透明底，颜色按当前 Key 可用性切换。
      Object.assign(keyHint.style, {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        alignSelf: "flex-start",
        maxWidth: "100%",
        minWidth: "0",
        boxSizing: "border-box",
        padding: "2px 10px",
        borderRadius: "999px",
        border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
        background: "color-mix(in srgb, currentColor 10%, transparent)",
        overflowWrap: "anywhere",
        whiteSpace: "normal",
        fontSize: "12px",
        fontWeight: "500",
        lineHeight: "18px",
        color: "var(--dsw-alias-label-secondary, currentColor)",
        transition: "color 140ms ease, border-color 140ms ease, background-color 140ms ease",
      });
      const saveKeyButton = primaryButton("添加并使用");
      const removeKeyButton = dangerButton("删除");
      const accountSelect = accountPicker();
      const accountName = document.createElement("span");
      Object.assign(accountName.style, {
        flex: "1 1 220px",
        minWidth: "0",
        overflowWrap: "anywhere",
        whiteSpace: "normal",
        fontSize: "13px",
        color: "var(--dsw-alias-label-secondary, currentColor)",
      });
      const addButton = primaryButton("令牌登录");
      const removeButton = dangerButton("删除账号");
      const accountLabel = fieldLabel("令牌账号");
      const accountStats = document.createElement("div");
      accountStats.setAttribute("role", "status");
      accountStats.setAttribute("aria-live", "polite");
      Object.assign(accountStats.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
        width: "100%",
        minHeight: "24px",
        fontSize: "13px",
        color: "var(--dsw-alias-label-secondary, currentColor)",
      });
      const tokenHint = document.createElement("span");
      tokenHint.textContent = "令牌登录后可切换账号，并查看积分与今日请求量。";
      Object.assign(tokenHint.style, {
        display: "block",
        width: "100%",
        fontSize: "12px",
        lineHeight: "18px",
        color: "var(--dsw-alias-label-secondary, currentColor)",
      });
      const creditStat = document.createElement("span");
      creditStat.dataset.workbuddyStat = "credits";
      const usageStat = document.createElement("span");
      usageStat.dataset.workbuddyStat = "usage";
      accountStats.append(creditStat, usageStat);
      // 用 <label> 作为整行容器，使点击行内任意位置都能切换复选框。
      const routingRow = document.createElement("label");
      const routingToggle = document.createElement("input");
      routingToggle.type = "checkbox";
      routingToggle.setAttribute("aria-label", "启用会话级账号/API Key");
      styleCheckbox(routingToggle);
      const routingLabel = document.createElement("span");
      routingLabel.textContent = "会话级账号/API Key";
      Object.assign(routingLabel.style, {
        fontSize: "13px",
        lineHeight: "18px",
        color: "var(--dsw-alias-label-primary, currentColor)",
      });
      const routingHint = document.createElement("span");
      routingHint.textContent = "关闭时保持原有全局认证方式";
      Object.assign(routingHint.style, {
        fontSize: "12px",
        lineHeight: "18px",
        color: "var(--dsw-alias-state-idle-primary, currentColor)",
      });
      // 整行用 <label> 包裹：点击任意位置（含空白与提示文字）都能切换复选框。
      // 复选框必须作为 label 的后代，浏览器的原生行为才会生效。
      Object.assign(routingRow.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
        width: "100%",
        boxSizing: "border-box",
        minHeight: CHECKBOX_SIZE,
        padding: "8px 12px",
        // 灰色边框，与卡片内其它分组区块视觉一致。
        border: "1px solid var(--dsw-alias-border-l1, currentColor)",
        borderRadius: "8px",
        background: "var(--dsw-alias-bg-layer-1, transparent)",
        cursor: "pointer",
        transition: "border-color 140ms ease, background-color 140ms ease",
      });
      routingRow.append(routingToggle, routingLabel, routingHint);
      const message = document.createElement("span");
      message.setAttribute("role", "status");
      message.setAttribute("aria-live", "polite");
      message.setAttribute("data-wb-pill", "");
      Object.assign(message.style, {
        ...PILL_STYLE,
        transition: "color 140ms ease, border-color 140ms ease, background-color 140ms ease",
      });
      modeRow.append(keyButton, tokenButton);
      // “令牌登录”推到行尾，使其右缘与下方“保存模型”右缘对齐。
      tokenButton.style.marginLeft = "auto";
      keySourceRow.append(keySourceLabel, keySelect, removeKeyButton);
      // 下拉框占满中间空间，删除按钮推到最右侧。
      keySelect.style.flex = "1 1 auto";
      keySelect.style.maxWidth = "none";
      keySelect.style.minWidth = "0";
      // “删除”与下方“添加并使用”等宽：两者都固定为该宽度，不再随文字长度变化。
      removeKeyButton.style.flex = "0 0 auto";
      removeKeyButton.style.width = `${KEY_ACTION_WIDTH}px`;
      removeKeyButton.style.paddingLeft = "0";
      removeKeyButton.style.paddingRight = "0";
      keyAddRow.append(newKeyLabel, newKeyInput, newKeyLabelInput, saveKeyButton);
      saveKeyButton.style.flex = "0 0 auto";
      saveKeyButton.style.width = `${KEY_ACTION_WIDTH}px`;
      saveKeyButton.style.paddingLeft = "0";
      saveKeyButton.style.paddingRight = "0";
      keySection.append(keySourceRow, keyAddRow, keyHint);
      accountRow.append(accountLabel, accountSelect, accountName, removeButton);
      tokenActionRow.append(addButton);
      tokenSection.append(tokenHint, accountRow, accountStats, tokenActionRow);
      controls.append(modeRow, routingRow, keySection, tokenSection, message);
      field.append(controls);
      let current = { mode: "api-key", authenticated: false, accounts: [], apiKeys: [], credits: undefined, creditLoading: false, creditError: null, todayUsage: null, todayUsageError: null };
      const render = (status) => {
        const previousMode = current.mode;
        const previousAccountId = current.activeAccountId;
        const previousApiKeyId = current.activeApiKeyId;
        const previousAccounts = current.accounts;
        const previousApiKeys = current.apiKeys;
        const previousRouting = current.routingEnabled;
        current = { ...current, ...status };
        applyMode(input, keyButton, tokenButton, keySection, keySourceRow, keySelect, keyHint, newKeyInput, newKeyLabelInput, saveKeyButton, removeKeyButton, tokenSection, accountRow, accountSelect, accountName, addButton, removeButton, accountStats, routingRow, routingToggle, message, current);
        if (previousMode !== current.mode || previousAccountId !== current.activeAccountId || previousApiKeyId !== current.activeApiKeyId || previousAccounts !== current.accounts || previousApiKeys !== current.apiKeys || previousRouting !== current.routingEnabled) notifyAuthState();
      };
      render(current);
      let creditRequestId = 0;
      const loadCredits = async (accountId) => {
        const requestId = ++creditRequestId;
        if (current.mode !== "token" || !accountId) {
          render({ credits: undefined, creditLoading: false, creditError: null, todayUsage: null, todayUsageError: null });
          return;
        }
        render({ credits: undefined, creditLoading: true, creditError: null, todayUsage: null, todayUsageError: null });
        try {
          const result = await request("credits", { accountId });
          if (requestId !== creditRequestId || current.activeAccountId !== accountId) return;
          render({ ...result, creditLoading: false });
        } catch (error) {
          if (requestId !== creditRequestId || current.activeAccountId !== accountId) return;
          render({ credits: null, creditLoading: false, creditError: error instanceof Error ? error.message : "查询 WorkBuddy 积分失败", todayUsage: null, todayUsageError: "查询 WorkBuddy 今日请求量失败" });
        }
      };

      const setBusy = (busy) => {
        keyButton.disabled = busy;
        tokenButton.disabled = busy;
        keySelect.disabled = busy;
        newKeyInput.disabled = busy || current.mode === "token";
        newKeyLabelInput.disabled = busy || current.mode === "token";
        saveKeyButton.disabled = busy;
        removeKeyButton.disabled = busy;
        accountSelect.disabled = busy;
        addButton.disabled = busy;
        removeButton.disabled = busy;
        routingToggle.disabled = busy;
        keyButton.style.cursor = busy ? "progress" : "pointer";
        tokenButton.style.cursor = busy ? "progress" : "pointer";
        saveKeyButton.style.cursor = busy ? "progress" : "pointer";
        removeKeyButton.style.cursor = busy ? "progress" : "pointer";
        addButton.style.cursor = busy ? "progress" : "pointer";
        removeButton.style.cursor = busy ? "progress" : "pointer";
      };
      keyButton.addEventListener("click", async () => {
        setBusy(true);
        message.textContent = "正在切换…";
        try {
          render(await request("api-key", current.activeApiKeyId ? { keyId: current.activeApiKeyId } : undefined));
          newKeyInput.focus();
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : "切换失败";
          message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
        } finally {
          setBusy(false);
        }
      });
      keySelect.addEventListener("change", async () => {
        setBusy(true);
        message.textContent = "正在切换 API Key…";
        try {
          render(await request("api-key", { keyId: keySelect.value }));
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : "切换失败";
          message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
        } finally {
          setBusy(false);
        }
      });
      saveKeyButton.addEventListener("click", async () => {
        const value = newKeyInput.value.trim();
        if (!value) {
          message.textContent = "请输入新的 API Key";
          message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
          newKeyInput.focus();
          return;
        }
        setBusy(true);
        saveKeyButton.textContent = "添加中…";
        message.textContent = "正在保存 API Key…";
        try {
          const label = newKeyLabelInput.value.trim();
          const next = await request("api-key/add", { key: value, ...(label ? { label } : {}) });
          newKeyInput.value = "";
          newKeyLabelInput.value = "";
          render(next);
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : "保存失败";
          message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
        } finally {
          setBusy(false);
        }
      });
      newKeyInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !saveKeyButton.disabled) {
          event.preventDefault();
          saveKeyButton.click();
        }
      });
      removeKeyButton.addEventListener("click", async () => {
        if (!current.activeApiKeyId || !window.confirm("确定删除当前 DSH 保存的 API Key 吗？")) return;
        setBusy(true);
        message.textContent = "正在删除 API Key…";
        try {
          render(await request("api-key/remove", { keyId: current.activeApiKeyId }));
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : "删除失败";
          message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
        } finally {
          setBusy(false);
        }
      });
      tokenButton.addEventListener("click", async () => {
        setBusy(true);
        tokenButton.textContent = "切换中…";
        message.textContent = current.accounts?.length ? "正在切换令牌账号…" : "请在浏览器中完成 WorkBuddy 中国站登录";
        try {
          const next = await request(current.accounts?.length ? "token" : "login");
          render(next);
          await loadCredits(next.activeAccountId);
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : "登录失败";
          message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
        } finally {
          setBusy(false);
        }
      });
      addButton.addEventListener("click", async () => {
        setBusy(true);
        addButton.textContent = "等待浏览器登录…";
        message.textContent = "请在浏览器中完成 WorkBuddy 中国站登录";
        try {
          const next = await request("login");
          render(next);
          await loadCredits(next.activeAccountId);
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : "登录失败";
          message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
        } finally {
          setBusy(false);
        }
      });
      accountSelect.addEventListener("change", async () => {
        setBusy(true);
        message.textContent = "正在切换令牌账号…";
        try {
          const next = await request("token", { accountId: accountSelect.value });
          render(next);
          await loadCredits(next.activeAccountId);
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : "切换失败";
          message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
        } finally {
          setBusy(false);
        }
      });
      removeButton.addEventListener("click", async () => {
        if (!current.activeAccountId || !window.confirm("确定删除这个 WorkBuddy 登录账号吗？令牌将从 DSH 凭据中移除。")) return;
        setBusy(true);
        message.textContent = "正在删除账号…";
        try {
          const next = await request("remove", { accountId: current.activeAccountId });
          render(next);
          await loadCredits(next.activeAccountId);
        } catch (error) {
          message.textContent = error instanceof Error ? error.message : "删除失败";
          message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
        } finally {
          setBusy(false);
        }
      });
      routingToggle.addEventListener("change", async () => {
        setBusy(true);
        message.textContent = routingToggle.checked ? "正在启用会话级认证…" : "正在关闭会话级认证…";
        try {
          render(await authRequest("routing", { enabled: routingToggle.checked }));
        } catch (error) {
          routingToggle.checked = !routingToggle.checked;
          message.textContent = error instanceof Error ? error.message : "切换会话级认证失败";
          message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
        } finally {
          setBusy(false);
        }
      });
      fetch(`${ROUTE}/status`, { cache: "no-store" })
        .then((response) => response.json())
        .then((status) => {
          render(status);
          return loadCredits(status.activeAccountId);
        })
        .catch(() => {
          message.textContent = "认证状态读取失败";
          message.style.color = "var(--dsw-alias-state-error-primary, #e5534b)";
        });
    }

    function mountModelEditor(host) {
      ensureStyles();
      host.setAttribute("data-wb-ui", "");
      const actions = row();
      const fetchButton = button("获取模型");
      const saveButton = primaryButton("保存模型");
      // 保存按钮推到行尾，右缘与上方“令牌登录”对齐。
      saveButton.style.marginLeft = "auto";
      const list = document.createElement("div");
      const candidates = document.createElement("div");
      const message = document.createElement("span");
      message.setAttribute("role", "status");
      message.setAttribute("aria-live", "polite");
      message.setAttribute("data-wb-pill", "");
      Object.assign(host.style, { display: "flex", flexDirection: "column", gap: "10px", width: "100%" });
      // 网格列宽固定，窄屏时允许横向滚动，避免列被挤压变形。
      Object.assign(list.style, { display: "flex", flexDirection: "column", gap: "8px", overflowX: "auto" });
      Object.assign(message.style, {
        ...PILL_STYLE,
      });
      actions.append(fetchButton, saveButton);
      host.append(actions, list, candidates, message);
      let models = null;
      let revision;
      // 每个模型的上游容量上限（maxInputTokens / maxOutputTokens），来自 /models 的 catalog。
      let caps = {};
      let busy = false;
      const invalidReasoning = new Set();
      const say = (value, error = false) => {
        message.textContent = value;
        // 成功提示用绿色，与“API Key 已就绪”胶囊保持一致；失败仍用红色。
        message.style.color = error
          ? "var(--dsw-alias-state-error-primary, #e5534b)"
          : "var(--dsw-alias-state-success-primary, #3fb950)";
      };
      const setBusy = (value) => {
        busy = value;
        for (const control of [fetchButton, saveButton]) control.disabled = value;
      };
      const makeInput = (value, label, onChange, type = "text") => {
        const input = textInput(type, label, label);
        input.value = value ?? "";
        input.title = label;
        input.addEventListener("input", () => onChange(input.value));
        return input;
      };
      /**
       * 使用场景下拉。选中一档就同时写入该模型的 contextWindow 和 maxTokens。
       * 存量值对不上任何一档时追加「自定义」，避免看起来像已经是某一档。
       */
      const makePresetSelect = (model, capabilities, onBudget) => {
        const select = document.createElement("select");
        select.setAttribute("aria-label", `${model.id} 使用场景`);
        Object.assign(select.style, {
          minHeight: "28px",
          minWidth: "0",
          height: "28px",
          boxSizing: "border-box",
          padding: "0 6px",
          borderRadius: "6px",
          color: "var(--dsw-alias-label-secondary, currentColor)",
          font: "inherit",
          fontSize: "12px",
          cursor: "pointer",
          transition: "background-color 140ms ease",
        });
        Object.assign(select.style, SELECT_ARROW_STYLE);
        const options = modelPresetOptions(model.id, capabilities);
        const matched = matchModelPreset(model, capabilities);
        const entries = matched === PRESET_CUSTOM
          ? [...options, {
            id: PRESET_CUSTOM,
            label: "自定义",
            hint: `当前 ${formatBudget(model.contextWindow, model.maxTokens)}，不属于四档`,
          }]
          : options;
        for (const entry of entries) {
          const option = document.createElement("option");
          option.value = entry.id;
          option.textContent = entry.label;
          if (entry.hint) option.title = entry.hint;
          select.append(option);
        }
        select.value = matched;
        select.title = entries.find((entry) => entry.id === matched)?.hint ?? "使用场景";
        select.addEventListener("change", () => {
          const picked = options.find((entry) => entry.id === select.value);
          if (!picked) return;
          model.contextWindow = picked.contextWindow;
          model.maxTokens = picked.maxTokens;
          select.title = picked.hint;
          onBudget(picked);
        });
        return select;
      };
      /**
       * 表头与数据行共用同一套网格列定义，保证逐列对齐。
       * 前两列等分剩余空间，其余为固定宽度。
       */
      // 图片输入列只放一个勾选框，因此列宽可以收紧。
      const MODEL_GRID_COLUMNS = `minmax(0, 1fr) minmax(0, 1fr) ${PRESET_SELECT_WIDTH} ${BUDGET_COLUMN_WIDTH} 72px ${MODEL_ACTION_COLUMN_WIDTH}px`;
      /** 网格最小宽度：两列弹性字段各留 140px 可读宽度。 */
      const MODEL_GRID_MIN_WIDTH = "720px";
      const modelGridStyle = (element) => {
        element.style.display = "grid";
        element.style.gridTemplateColumns = MODEL_GRID_COLUMNS;
        element.style.columnGap = "8px";
        element.style.rowGap = "8px";
        element.style.alignItems = "center";
        element.style.width = "100%";
        // 小于该宽度时靠 list 的横向滚动保证列宽不被压扁；
        // 表头与数据行同值，保证滚动时仍然逐列对齐。
        element.style.minWidth = MODEL_GRID_MIN_WIDTH;
        element.style.boxSizing = "border-box";
        return element;
      };
      /**
       * 列名行。与下方 section() 使用相同内边距，并复用同一网格模板，
       * 因此各列严格对齐（不再依赖内容宽度碰巧相等）。
       */
      const modelHeader = () => {
        const header = modelGridStyle(document.createElement("div"));
        Object.assign(header.style, {
          // 复制 section() 的盒子模型（1px 边框 + 12px/14px 内边距），
          // 使内容区宽度与数据行严格一致；边框透明以保持无视觉边框。
          padding: "12px 14px",
          border: "1px solid transparent",
          fontSize: "12px",
          lineHeight: "18px",
          fontWeight: "500",
          color: "var(--dsw-alias-label-primary, currentColor)",
        });
        const label = (text, align = "start") => {
          const span = document.createElement("span");
          span.textContent = text;
          span.style.minWidth = "0";
          span.style.textAlign = align;
          span.style.overflow = "hidden";
          span.style.textOverflow = "ellipsis";
          span.style.whiteSpace = "nowrap";
          return span;
        };
        header.append(
          label("模型 ID"),
          label("显示名称"),
          label("使用场景"),
          label("窗口 / 输出"),
          label("图片输入", "center"),
          label("操作", "center"),
        );
        return header;
      };
      const render = () => {
        list.replaceChildren();
        if (models === null) {
          const hint = document.createElement("span");
          hint.textContent = "使用当前账号的在线模型目录；获取后可选择模型进行自定义。";
          list.append(hint);
          return;
        }
        list.append(modelHeader());
        for (const [index, model] of models.entries()) {
          const item = section();
          const fields = modelGridStyle(document.createElement("div"));
          // 模型 ID 是上游标识，改动会导致请求失败，因此只读；
          // 显示名称仅用于界面展示，保持可编辑。
          const id = makeInput(model.id, "模型 ID", () => {});
          id.readOnly = true;
          id.tabIndex = -1;
          Object.assign(id.style, {
            // 弱化外观，明确不可编辑，同时保留可复制的文本。
            color: "var(--dsw-alias-label-secondary, currentColor)",
            background: "transparent",
            cursor: "default",
            userSelect: "text",
          });
          id.title = "模型 ID 不可修改";
          const name = makeInput(model.name, "显示名称", (value) => { model.name = value; });
          const capabilities = caps[model.id] ?? {};
          if (Number.isFinite(capabilities.contextWindow) && model.contextWindow > capabilities.contextWindow) {
            model.contextWindow = capabilities.contextWindow;
          }
          if (Number.isFinite(capabilities.maxTokens) && model.maxTokens > capabilities.maxTokens) {
            model.maxTokens = capabilities.maxTokens;
          }
          if (!Number.isSafeInteger(model.contextWindow) || !Number.isSafeInteger(model.maxTokens)) {
            const budget = presetBudget(model.id, DEFAULT_PRESET, capabilities);
            model.contextWindow = budget.contextWindow;
            model.maxTokens = budget.maxTokens;
          }
          const params = document.createElement("span");
          params.textContent = formatBudget(model.contextWindow, model.maxTokens);
          params.title = "上下文窗口 / 最大输出";
          Object.assign(params.style, {
            fontSize: "12px",
            color: "var(--dsw-alias-label-secondary, currentColor)",
            whiteSpace: "nowrap",
          });
          const context = makePresetSelect(model, capabilities, (picked) => {
            params.textContent = formatBudget(picked.contextWindow, picked.maxTokens);
          });
          for (const input of [id, name, context]) {
            input.style.minWidth = "0";
            input.style.width = "100%";
            fields.append(input);
          }
          fields.append(params);
          const imageLabel = document.createElement("label");
          const images = document.createElement("input");
          images.type = "checkbox";
          styleCheckbox(images);
          // 列名已写“图片输入”，行内不再重复文字，只留勾选框；
          // 无障碍名称仍由 aria-label 提供。
          images.setAttribute("aria-label", `模型 ${model.id || "（未命名）"} 支持图片输入`);
          // 新模型默认支持图片输入；显式配置过 input 的沿用其值。
          images.checked = model.input === undefined ? true : model.input.includes("image") === true;
          if (model.input === undefined) model.input = ["text", "image"];
          images.addEventListener("change", () => { model.input = images.checked ? ["text", "image"] : ["text"]; });
          imageLabel.append(images);
          imageLabel.style.display = "flex";
          imageLabel.style.alignItems = "center";
          imageLabel.style.justifyContent = "center";
          imageLabel.style.minWidth = "0";
          const remove = makeButton("删除", { variant: "danger", size: "sm" });
          // 撑满操作列，使右缘严格等于列右缘，便于上方工具条对齐。
          remove.style.width = "100%";
          remove.addEventListener("click", () => { invalidReasoning.delete(model); models.splice(index, 1); render(); });
          fields.append(imageLabel, remove);
          item.append(fields);
          if (model.reasoningEfforts !== undefined) {
            const thinking = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = "模型思考档位";
            const editor = document.createElement("textarea");
            editor.setAttribute("aria-label", `${model.id} 思考档位 JSON`);
            editor.value = JSON.stringify(model.reasoningEfforts);
            editor.style.width = "100%";
            editor.addEventListener("change", () => {
              try {
                const value = JSON.parse(editor.value);
                if (value !== false && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error();
                model.reasoningEfforts = value;
                invalidReasoning.delete(model);
                say("");
              } catch { invalidReasoning.add(model); say("思考档位 JSON 格式无效", true); }
            });
            thinking.append(summary, editor);
            item.append(thinking);
          }
          list.append(item);
        }
      };
      fetch(`${ROUTE}/models`, { cache: "no-store" })
        .then((response) => response.json())
        .then((state) => {
          if (!state.ok) throw new Error(state.message);
          models = state.models?.map((model) => ({ ...model })) ?? null;
          caps = state.catalog && typeof state.catalog === "object" ? state.catalog : {};
          revision = state.revision;
          render();
        })
        .catch((error) => say(error instanceof Error ? error.message : "读取模型失败", true));
      fetchButton.addEventListener("click", async () => {
        if (busy) return;
        setBusy(true);
        say("正在获取模型…");
        try {
          const result = await request("models", { action: "discover" });
          candidates.replaceChildren();
          const choices = result.models.filter((model) => !models?.some((existing) => existing.id === model.id));
          if (!choices.length) return say("没有新的可用模型");
          const selected = new Set();
          // 结构：外层容器（竖排）里放「可滚动列表」+「独立按钮行」，
          // 这样按钮不会随候选列表一起滚走。
          const candidateList = document.createElement("div");
          Object.assign(candidateList.style, {
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            boxSizing: "border-box",
            padding: "6px",
            border: "1px solid var(--dsw-alias-border-l1, currentColor)",
            borderRadius: "10px",
            background: "var(--dsw-alias-bg-layer-1, transparent)",
            maxHeight: "320px",
            overflowY: "auto",
          });
          Object.assign(candidates.style, {
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            width: "100%",
          });
          for (const model of choices) {
            const label = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            styleCheckbox(checkbox);
            checkbox.addEventListener("change", () => checkbox.checked ? selected.add(model.id) : selected.delete(model.id));
            const primaryText = document.createElement("span");
            primaryText.textContent = model.name || model.id;
            const secondaryText = document.createElement("span");
            secondaryText.textContent = model.id;
            // 名称与 ID 分开排版：名称正常字号，ID 弱化为次要色。
            Object.assign(primaryText.style, {
              fontSize: "14px",
              fontWeight: "500",
              color: "var(--dsw-alias-label-primary, currentColor)",
            });
            Object.assign(secondaryText.style, {
              fontSize: "12px",
              color: "var(--dsw-alias-label-secondary, currentColor)",
            });
            label.append(checkbox, primaryText, secondaryText);
            Object.assign(label.style, {
              display: "grid",
              gridTemplateColumns: "auto minmax(0, 1fr) auto",
              alignItems: "center",
              gap: "10px",
              boxSizing: "border-box",
              padding: "8px 10px",
              borderRadius: "7px",
              cursor: "pointer",
              fontSize: "14px",
              transition: "background-color 120ms ease",
            });
            label.addEventListener("mouseenter", () => {
              label.style.background = "color-mix(in srgb, var(--dsw-alias-label-primary, currentColor) 7%, transparent)";
            });
            label.addEventListener("mouseleave", () => {
              label.style.background = "transparent";
            });
            candidateList.append(label);
          }
          const addSelected = primaryButton("添加选中模型");
          addSelected.addEventListener("click", () => {
            models ??= [];
            // 新模型默认「日常编码」。目录里的数字是上游天花板，不是工作值。
            models.push(...choices.filter((model) => selected.has(model.id)).map((model) => {
              const budget = presetBudget(model.id, DEFAULT_PRESET, caps[model.id]);
              return {
                ...model,
                contextWindow: budget?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
                maxTokens: budget?.maxTokens ?? DEFAULT_MAX_TOKENS,
              };
            }));
            candidates.replaceChildren();
            render();
          });
          const candidateActions = row();
          candidateActions.append(addSelected);
          candidates.append(candidateList, candidateActions);
          say(`获取到 ${result.models.length} 个模型，请选择后点“添加选中模型”，再点“保存模型”`);
        } catch (error) { say(error instanceof Error ? error.message : "获取模型失败", true); }
        finally { setBusy(false); }
      });
      saveButton.addEventListener("click", async () => {
        if (busy || models === null) return;
        if (invalidReasoning.size) return say("请先修正模型思考档位 JSON", true);
        // 模型 ID 只读，若出现空 ID 只能删除该行重新获取，故单独提示。
        if (models.some((model) => !model.id)) return say("存在缺少模型 ID 的条目，请删除后重新获取模型", true);
        if (models.some((model) => !Number.isSafeInteger(model.contextWindow ?? 1)
          || !Number.isSafeInteger(model.maxTokens ?? 1))) return say("请检查上下文窗口和 Token 数值", true);
        setBusy(true);
        try {
          const result = await request("models", { action: "save", models, revision });
          revision = result.revision;
          say("模型已保存");
        } catch (error) { say(error instanceof Error ? error.message : "保存模型失败", true); }
        finally { setBusy(false); }
      });
      render();
    }

    function WorkBuddySettingsCard({ provider, embedded = false }) {
      const root = useRef(null);
      useEffect(() => {
        if (provider?.provider !== "workbuddy-cn" || !root.current) return;
        ensureStyles();
        const host = root.current;
        host.setAttribute("data-wb-ui", "");
        // 两张卡片各自带 1px 边框，用 gap 单独控制二者间距，
        // 避免依赖各自内边距叠加（改一处会牵动另一处）。
        Object.assign(host.style, {
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          width: "100%",
          boxSizing: "border-box",
        });
        const field = section();
        const input = document.createElement("input");
        input.setAttribute("aria-label", "API 密钥");
        field.append(input);
        host.append(field);
        mount(input);
        const models = section();
        host.append(models);
        mountModelEditor(models);
        const scope = embedded ? null : host.closest("li") ?? host.closest('[role="tabpanel"]') ?? host.closest('[class*="_addPanel"]');
        const hidden = new Map();
        const hideNative = () => {
          if (!scope) return;
          for (const node of scope.querySelectorAll('[class*="_editor"], [class*="_rowActions"]')) {
            if (node.contains(host) || host.contains(node) || hidden.has(node)) continue;
            hidden.set(node, {
              hidden: node.hidden,
              display: node.style.getPropertyValue("display"),
              priority: node.style.getPropertyPriority("display"),
            });
            node.hidden = true;
            node.style.setProperty("display", "none", "important");
          }
        };
        const observer = scope ? new MutationObserver(hideNative) : undefined;
        observer?.observe(scope, { childList: true, subtree: true });
        hideNative();
        return () => {
          observer?.disconnect();
          for (const [node, previous] of hidden) {
            node.hidden = previous.hidden;
            if (previous.display) node.style.setProperty("display", previous.display, previous.priority);
            else node.style.removeProperty("display");
          }
        };
      }, [provider?.provider]);
      return provider?.provider === "workbuddy-cn"
        ? createElement("div", { ref: root, "data-workbuddy-settings-card": "" })
        : null;
    }

    function WorkBuddyPluginDetails({ subject }) {
      return subject?.kind === "bundle" && BUNDLE_NAMES.has(subject.pkg?.name)
        ? createElement(WorkBuddySettingsCard, { provider: { provider: "workbuddy-cn" }, embedded: true })
        : null;
    }

    /**
     * 一次页面扫描：给目标输入框挂载组件，并在 hero 相位补上待启用选择器。
     *
     * 只用一次 querySelectorAll 同时判定两个目标是否存在，避免调用方
     * 为每个目标各扫一遍文档。
     */
    function enhance() {
      if (typeof document === "undefined") return;
      const apiKeyInputs = document.querySelectorAll('input[aria-label="API 密钥"]');
      for (const input of apiKeyInputs) {
        if (isWorkBuddy(input)) mount(input);
      }
      mountPendingSelector();
    }

    /**
     * 把 enhance 收敛到每帧最多执行一次。
     *
     * 原先 MutationObserver 直接以 enhance 为回调：流式输出时 DOM 每秒变动
     * 数十次，而 enhance 内部是全文档 querySelectorAll —— 等于每个 token
     * 都做一次全量扫描。改为 rAF 合帧后，一帧内的任意多次变更只扫描一次，
     * 既保留挂载能力又把开销压到与刷新率同阶。
     */
    let enhanceFrame = 0;
    function scheduleEnhance() {
      if (enhanceFrame) return;
      const raf = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
      enhanceFrame = raf(() => {
        enhanceFrame = 0;
        enhance();
      });
    }

    /**
     * 输入框工具行的使用场景选择器。
     * 选中一档后同时改写 contextWindow 和 maxTokens。
     */
    function WorkBuddyContextWindowControl({ useProjection, sessionId }) {
      let selection;
      try {
        selection = typeof useProjection === "function" ? useProjection("modelSelection") : undefined;
      } catch {
        selection = undefined;
      }
      // 空会话投影没有 provider/model，沿用部署默认模型，让控件在发出第一条消息前也能显示。
      const resolved = resolveSelection(selection, useDefaultSelection());
      const provider = resolved.provider;
      const selected = isWorkBuddyProvider(provider);
      const modelId = resolved.model;
      // 档位现在写的是「本会话的覆盖」，不动 profile 配置，所以即使是部署默认模型
      // 也可以安全调整 —— 真正的边界是拿不到会话 id，那才是无处可写。
      const sessionKey = typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined;
      const readOnly = sessionKey === undefined;
      const [value, setValue] = useState(null);
      const [tokens, setTokens] = useState(null);
      // 上游天花板，用来把四档目标截断到该模型真正能装下的范围。
      const [ceiling, setCeiling] = useState(null);
      const [outputCeiling, setOutputCeiling] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      // 本会话是否已偏离 profile 默认值。菜单里据此显示「恢复默认」。
      const [hasOverride, setHasOverride] = useState(false);
      // 菜单开合状态必须与上面几个 hook 一起声明在 early return 之前：
      // React 要求每次渲染的 hook 调用顺序一致，放到 return null 之后会在
      // 缺少会话/模型时直接崩掉整个组件（表现为控件消失）。
      const [open, setOpen] = useState(false);
      const rootRef = useRef(null);

      useEffect(() => {
        let disposed = false;
        if (!selected || !modelId) {
          setValue(null);
          setTokens(null);
          setCeiling(null);
          setOutputCeiling(null);
          return () => { disposed = true; };
        }
        // 先问本会话有没有覆盖，再取模型级默认值作为上限与回落。
        Promise.all([
          authRequest("context-window", undefined, undefined, { model: modelId }),
          sessionKey === undefined
            ? Promise.resolve(null)
            : authRequest("session-tier", undefined, undefined, { sessionId: sessionKey }).catch(() => null),
        ]).then(([result, tier]) => {
            if (disposed) return;
            const override = tier?.override ?? null;
            setHasOverride(override !== null);
            setValue(
              typeof override?.contextWindow === "number"
                ? override.contextWindow
                : typeof result?.contextWindow === "number" ? result.contextWindow : DEFAULT_CONTEXT_WINDOW,
            );
            setTokens(
              typeof override?.maxTokens === "number"
                ? override.maxTokens
                : typeof result?.maxTokens === "number" ? result.maxTokens : DEFAULT_MAX_TOKENS,
            );
            setCeiling(typeof result?.contextWindowMax === "number" && result.contextWindowMax > 0 ? result.contextWindowMax : null);
            setOutputCeiling(typeof result?.maxTokensMax === "number" && result.maxTokensMax > 0 ? result.maxTokensMax : null);
          }).catch(() => {
            if (disposed) return;
            setValue(DEFAULT_CONTEXT_WINDOW);
            setTokens(DEFAULT_MAX_TOKENS);
            setCeiling(null);
            setOutputCeiling(null);
          });
        return () => { disposed = true; };
      }, [selected, modelId, sessionKey]);

      // 菜单打开时监听外部点击与 Esc 关闭。
      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (!rootRef.current?.contains(event.target)) setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
          document.removeEventListener("pointerdown", onPointerDown);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [open]);

      if (!selected || !modelId || value === null || tokens === null) return null;

      const capabilities = { contextWindow: ceiling, maxTokens: outputCeiling };
      const apply = async (budget) => {
        // 没有真实会话 id 时绝不写：此时 modelId 只是部署默认，写下去会改错对象。
        if (readOnly) return;
        if (busy || (budget.contextWindow === value && budget.maxTokens === tokens)) return;
        const previous = { contextWindow: value, maxTokens: tokens };
        setBusy(true);
        setError(null);
        setValue(budget.contextWindow);
        setTokens(budget.maxTokens);
        try {
          // 写会话级覆盖：只影响本会话，不动 profile 配置，也不影响别的会话。
          await authRequest("session-tier", {
            sessionId,
            contextWindow: budget.contextWindow,
            maxTokens: budget.maxTokens,
            model: modelId,
          });
          if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_STATE_EVENT));
          setHasOverride(true);
        } catch (cause) {
          setValue(previous.contextWindow);
          setTokens(previous.maxTokens);
          setError(cause instanceof Error ? cause.message : "设置使用场景失败");
        } finally {
          setBusy(false);
        }
      };

      const presets = modelPresetOptions(modelId, capabilities);
      const matched = matchModelPreset({ id: modelId, contextWindow: value, maxTokens: tokens }, capabilities);
      const options = matched === PRESET_CUSTOM
        ? [...presets, {
          id: PRESET_CUSTOM,
          label: "自定义",
          hint: `当前 ${formatBudget(value, tokens)}，不属于四档`,
          contextWindow: value,
          maxTokens: tokens,
        }]
        : presets;
      const current = options.find((option) => option.id === matched) ?? options[0];

      /**
       * 清除本会话覆盖，回到 profile 默认值。
       * 仅在有覆盖时才有意义，所以只在覆盖存在时渲染这一项。
       */
      const clearOverride = async () => {
        if (readOnly || busy || !hasOverride) return;
        setOpen(false);
        setBusy(true);
        setError(null);
        try {
          await authRequest("session-tier", { sessionId: sessionKey, contextWindow: null });
          const baseline = await authRequest("context-window", undefined, undefined, { model: modelId });
          setValue(typeof baseline?.contextWindow === "number" ? baseline.contextWindow : DEFAULT_CONTEXT_WINDOW);
          setTokens(typeof baseline?.maxTokens === "number" ? baseline.maxTokens : DEFAULT_MAX_TOKENS);
          setHasOverride(false);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "恢复默认失败");
        } finally {
          setBusy(false);
        }
      };

      // 结构照抄 DSH 官方 PermissionSelect：trigger 按钮 + 向上弹出的 Menu。
      // 官方用 ui-primitives 的 Menu 组件，但那是 shell 内部模块、插件无法 require，
      // 因此这里用同样的 DOM/CSS 自行实现弹出层，视觉与交互保持一致。
      const choose = (option) => {
        setOpen(false);
        if (!option || option.id === PRESET_CUSTOM || option.id === matched) return;
        void apply(option);
      };

      return createElement("div", {
        key: "context-window",
        ref: rootRef,
        "data-workbuddy-context-window": true,
        "data-workbuddy-readonly": readOnly ? "1" : undefined,
        role: "group",
        "aria-label": "WorkBuddy 使用场景",
        title: error
          ?? (readOnly
            ? `当前显示的是部署默认模型（${modelId}）的档位。发出第一条消息后，可在此调整本会话实际所用模型的档位。`
            : current.hint),
        style: {
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          minWidth: 0,
        },
      }, [
        createElement("button", {
          key: "trigger",
          type: "button",
          className: "wb-cw-trigger",
          // 只读时不宣称有弹出菜单，避免读屏与用户都以为能改。
          "aria-haspopup": readOnly ? undefined : "menu",
          "aria-expanded": readOnly ? undefined : open,
          "aria-label": readOnly
            ? `使用场景：${current.label}（部署默认模型，发出消息后可调整）`
            : `使用场景：${current.label}`,
          disabled: busy || readOnly,
          style: error
            ? { color: "var(--dsw-alias-state-error-primary, #f25a5a)" }
            : undefined,
          onClick: () => { if (!readOnly) setOpen(!open); },
        }, [
          createElement("span", { key: "label", className: "wb-cw-label" }, current.label),
          !readOnly && createElement("span", {
            key: "chevron",
            className: open ? "wb-cw-chevron is-open" : "wb-cw-chevron",
            "aria-hidden": true,
          }, createElement("svg", {
            width: 12, height: 12, viewBox: "0 0 12 12", focusable: "false",
          }, createElement("path", {
            d: "M2.5 4.5 6 8l3.5-3.5",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.5,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }))),
        ]),
        !readOnly && open && createElement("div", {
          key: "menu",
          className: "wb-cw-menu",
          role: "menu",
          "aria-label": "使用场景",
        }, options.map((option) => createElement("button", {
          key: option.id,
          type: "button",
          role: "menuitemradio",
          "aria-checked": option.id === matched,
          className: option.id === matched ? "wb-cw-option is-selected" : "wb-cw-option",
          title: option.hint,
          onClick: () => choose(option),
        }, [
          createElement("span", { key: "text", className: "wb-cw-option-text" }, option.label),
          createElement("span", { key: "detail", className: "wb-cw-option-detail" }, formatBudget(option.contextWindow, option.maxTokens)),
          option.id === matched && createElement("span", {
            key: "check",
            className: "wb-cw-check",
            "aria-hidden": true,
          }, createElement("svg", {
            width: 14, height: 14, viewBox: "0 0 14 14", focusable: "false",
          }, createElement("path", {
            d: "M2.5 7.5 5.5 10.5 11.5 4",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.6,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }))),
        ])),
        // 覆盖只作用于本会话，所以撤销入口也留在本会话的菜单里。
        hasOverride && createElement("button", {
          key: "reset",
          type: "button",
          role: "menuitem",
          className: "wb-cw-option",
          title: "只影响当前会话。恢复后本会话回到部署默认的窗口与输出",
          onClick: () => { void clearOverride(); },
        }, [
          createElement("span", { key: "text", className: "wb-cw-option-text" }, "恢复默认"),
        ])),
      ]);
    }

    function apply(ctx) {
      ensureStyles();
      installComposerDockLayout();
      /**
       * 这个 slot 是 keyed 的，key 必须等于目录行的 settingsNs——也就是本插件
       * 在 loader 里的 entry id。用户可能是按新 id（dsh-workbuddy）装，也可能是
       * 改名前的旧 id（llm-workbuddy），两个都注册，卡片才不会因为 id 不同而消失。
       */
      for (const key of ["dsh-workbuddy", "llm-workbuddy"]) {
        ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
          name: "settings.models.provider-card",
          key,
        }, WorkBuddySettingsCard));
      }
      ctx.slots.inject("plugins.detail.section", () => ctx.slots.register({
        name: "plugins.detail.section",
        id: "dsh-workbuddy",
      }, WorkBuddyPluginDetails));
      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock",
        id: "workbuddy-credits",
        order: 100,
        label: "WorkBuddy 用量",
      }, WorkBuddyCreditsDock));
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "workbuddy-context-window",
        order: 10,
        label: "WorkBuddy 上下文窗口",
      }, WorkBuddyContextWindowControl));
      ctx.effect(() => {
        // 观察器只负责“通知有变化”，真正的扫描由 scheduleEnhance 合帧执行。
        const observer = new MutationObserver(scheduleEnhance);
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener("change", scheduleEnhance, true);
        enhance();
        return () => {
          observer.disconnect();
          document.removeEventListener("change", scheduleEnhance, true);
          if (enhanceFrame) {
            const cancel = typeof cancelAnimationFrame === "function"
              ? cancelAnimationFrame
              : clearTimeout;
            cancel(enhanceFrame);
            enhanceFrame = 0;
          }
        };
      }, "llm-workbuddy: auth switch");
    }

    return { name: "dsh-workbuddy-client", inject: ["slots"], apply };
  },
});
