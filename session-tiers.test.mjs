/**
 * 会话级档位的纯逻辑验证：不依赖宿主，直接跑 resolveSessionWindow / clampCompletion。
 */
import assert from "node:assert/strict";
import { clampCompletion, normalizeSessionSettings, resolveSessionWindow } from "./session-tiers.js";

const settings = normalizeSessionSettings(undefined);
console.log("settings =", JSON.stringify(settings));

// 1) 请求窗口小于模型基准：按请求值生效，标记 changed。
{
  const r = resolveSessionWindow(1_000_000, 200_000);
  assert.equal(r.effective, 200_000);
  assert.equal(r.changed, true);
  assert.equal(r.base, 1_000_000);
  console.log("1 ok", JSON.stringify(r));
}

// 2) 请求超过基准：不允许放大，回落到基准且不算改变。
{
  const r = resolveSessionWindow(200_000, 1_000_000);
  assert.equal(r.effective, 200_000);
  assert.equal(r.changed, false);
  console.log("2 ok", JSON.stringify(r));
}

// 3) 请求等于基准：无覆盖，changed false（不产生多余的 request 改写）。
{
  const r = resolveSessionWindow(200_000, 200_000);
  assert.equal(r.effective, 200_000);
  assert.equal(r.changed, false);
  console.log("3 ok", JSON.stringify(r));
}

// 4) 没有请求值：不改变任何东西。
{
  const r = resolveSessionWindow(1_000_000, undefined);
  assert.equal(r.changed, false);
  assert.equal(r.effective, 1_000_000);
  console.log("4 ok", JSON.stringify(r));
}

// 5) 输出预算被压进窗口内，但小窗口也要保住足够的输出。
{
  const small = clampCompletion(128_000, 32_000, settings);
  const large = clampCompletion(128_000, 1_000_000, settings);
  assert.ok(small < large, `小窗口的输出预算应更小: ${small} vs ${large}`);
  assert.ok(small >= 256, `不得低于最小完成预留: ${small}`);
  // 32K 窗口下仍要能拿到接近一半的输出，否则等于推翻了 32K 输出的意义。
  assert.ok(small >= 16_000, `32K 窗口的输出预算过低: ${small}`);
  console.log("5 ok small =", small, "large =", large);
}

// 6) 请求的 maxTokens 比上限小的时候保持不动（尊重调用方）。
{
  const v = clampCompletion(1_000, 1_000_000, settings);
  assert.equal(v, 1_000);
  console.log("6 ok", v);
}

// 7) 窗口小到极限也不产生非正数预算。
{
  for (const w of [1, 100, 512, 1024]) {
    const v = clampCompletion(undefined, w, settings);
    assert.ok(Number.isInteger(v) && v >= 256, `窗口 ${w} 得到非法预算 ${v}`);
  }
  console.log("7 ok 极小窗口兜底正常");
}

// 8) 配置越界值被夹回合法区间。
{
  const bad = normalizeSessionSettings({ completionRatio: 99, headroomRatio: 99 });
  assert.equal(bad.completionRatio, 0.9);
  assert.equal(bad.headroomRatio, 0.5);
  console.log("8 ok", JSON.stringify(bad));
}

console.log("\n全部纯逻辑断言通过");

