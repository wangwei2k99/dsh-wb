#!/usr/bin/env python3
"""反推 WorkBuddy / CodeBuddy 端点的真实输入上下文上限。

原理
----
1. 标定：先用中等长度文本测出「字符/Token」比例。
2. 倍增：从起始值开始成倍加大输入，直到某次请求失败。
3. 二分：在「最后成功」与「首次失败」之间二分，收敛出边界。

判定「失败」的三种信号
--------------------
- HTTP 状态码 >= 400（如 413 / 400 / 429）
- 流内返回业务错误（code != 0 或 error 字段）
- 静默截断：服务端回报的 prompt_tokens 明显小于实际发送量

成本控制
--------
每次请求 max_tokens=1，只消耗输入 token；脚本在首个硬失败处停止，
且永不发送超过 --cap 的输入。
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# Windows 控制台默认不是 UTF-8，中文输出会乱码；强制改流编码并降级失败。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

ENDPOINT = "https://copilot.tencent.com/v2/chat/completions"
CREDENTIALS = os.path.join(os.path.expanduser("~"), ".dsh", ".credentials.yaml")
FILLER = "The quick brown fox jumps over the lazy dog. "
CPT_FALLBACK = 4.5          # 英文经验值：约 4.5 字符/token
TRUNCATE_RATIO = 0.90       # 观测 token 低于预期 90% 视为被截断


def die(msg):
    print(f"[错误] {msg}", file=sys.stderr)
    sys.exit(2)


def load_key(explicit=None):
    """优先 --key，其次环境变量，最后读 DSH 凭据库的 activeId。"""
    if explicit and explicit.strip():
        return explicit.strip()
    env = os.environ.get("WORKBUDDY_API_KEY")
    if env and env.strip():
        return env.strip()
    if not os.path.exists(CREDENTIALS):
        die(f"找不到凭据文件 {CREDENTIALS}，请用 --key 或设置 WORKBUDDY_API_KEY")
    text = open(CREDENTIALS, encoding="utf-8").read()
    active = re.search(r'"activeId"\s*:\s*\\?"?dsh:([A-Za-z0-9_]+)', text)
    pairs = dict(re.findall(
        r"(WORKBUDDY_API_KEY_[A-Za-z0-9_]+)\s*:\s*(ck_[A-Za-z0-9._-]+)", text))
    if active and active.group(1) in pairs:
        return pairs[active.group(1)]
    if len(pairs) == 1:
        return next(iter(pairs.values()))
    die("凭据库里有多个 Key，无法确定用哪个，请用 --key 指定")


def probe(key, model, tokens, cpt, timeout):
    """发送一次探测请求，返回结果字典。"""
    chars = max(1, int(tokens * cpt))
    content = (FILLER * (chars // len(FILLER) + 1))[:chars]
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": 1,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    req = urllib.request.Request(
        ENDPOINT, data=json.dumps(payload).encode("utf-8"), method="POST")
    req.add_header("authorization", f"Bearer {key}")
    req.add_header("content-type", "application/json")
    req.add_header("accept", "text/event-stream")

    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            observed = None
            error = None
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                body = line[5:].strip()
                if not body or body == "[DONE]":
                    continue
                try:
                    obj = json.loads(body)
                except ValueError:
                    continue
                if isinstance(obj.get("usage"), dict):
                    value = obj["usage"].get("prompt_tokens")
                    if isinstance(value, int):
                        observed = value
                if obj.get("code") not in (None, 0) or obj.get("error"):
                    error = obj
            elapsed = time.time() - started
            if error is not None:
                return {"ok": False, "kind": "biz-error", "detail": error,
                        "elapsed": elapsed, "observed": observed, "sent": chars}
            return {"ok": True, "kind": "ok", "detail": None,
                    "elapsed": elapsed, "observed": observed, "sent": chars}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        return {"ok": False, "kind": "http", "status": exc.code,
                "detail": body[:500], "elapsed": time.time() - started,
                "observed": None, "sent": chars}
    except Exception as exc:                     # 超时、连接重置等
        return {"ok": False, "kind": "network", "detail": str(exc),
                "elapsed": time.time() - started, "observed": None, "sent": chars}


def verdict(result, expected_tokens):
    """把一次探测结果归一化为 ok / fail / truncated。"""
    if not result["ok"]:
        return "fail", result
    observed = result["observed"]
    if observed is not None and expected_tokens > 2000:
        if observed < expected_tokens * TRUNCATE_RATIO:
            return "truncated", result
    return "ok", result


def describe(result):
    kind = result["kind"]
    if kind == "http":
        return f"HTTP {result['status']}: {result['detail'][:160]}"
    if kind == "biz-error":
        detail = result["detail"]
        code = detail.get("code")
        msg = detail.get("msg") or detail.get("error") or detail
        return f"业务错误 code={code}: {str(msg)[:160]}"
    if kind == "network":
        return f"网络异常: {str(result['detail'])[:160]}"
    return "成功"


def report(step, tokens, state, result, budget):
    budget[0] += tokens
    observed = result.get("observed")
    seen = f"{observed}" if isinstance(observed, int) else "-"
    print(f"{step:>3}. {tokens:>9,} tokens  ->  {state:<9} "
          f"实际={seen:>9}  耗时={result['elapsed']:6.2f}s  "
          f"累计={budget[0]:,}")
    if state != "ok":
        print(f"     原因: {describe(result)}")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser(
        description="二分探测 WorkBuddy 端点的真实输入上下文上限")
    parser.add_argument("--model", default="deepseek-v4.1-flash")
    parser.add_argument("--start", type=int, default=8192,
                        help="起始输入 token 数（默认 8192）")
    parser.add_argument("--cap", type=int, default=262144,
                        help="探查上限，不会发送超过此值（默认 262144）")
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--key", default=None, help="显式指定 API Key")
    args = parser.parse_args()

    key = load_key(args.key)
    budget = [0]

    print(f"端点: {ENDPOINT}")
    print(f"模型: {args.model}")
    print(f"范围: {args.start:,} ~ {args.cap:,} tokens")
    print("=" * 78)

    # ---- 1. 标定字符/token 比例 ----
    print("\n[1/3] 标定字符/Token 比例")
    cal_chars = 9000
    cal = probe(key, args.model, int(cal_chars / CPT_FALLBACK), CPT_FALLBACK, args.timeout)
    state, _ = verdict(cal, int(cal_chars / CPT_FALLBACK))
    if state != "ok" or not cal.get("observed"):
        print(f"      标定失败（{describe(cal)}），改用经验值 {CPT_FALLBACK}")
        cpt = CPT_FALLBACK
    else:
        cpt = cal["sent"] / cal["observed"]
        print(f"      {cal['sent']:,} 字符 -> {cal['observed']:,} tokens "
              f"=> {cpt:.3f} 字符/token")
    budget[0] += int(cal_chars / CPT_FALLBACK)

    # ---- 2. 倍增搜索，找到第一个失败点 ----
    print("\n[2/3] 倍增搜索边界")
    last_ok = 0
    first_fail = None
    tokens = args.start
    step = 0
    while tokens <= args.cap:
        step += 1
        result = probe(key, args.model, tokens, cpt, args.timeout)
        state, result = verdict(result, tokens)
        report(step, tokens, state, result, budget)
        if state == "ok":
            last_ok = tokens
            tokens *= 2
        else:
            first_fail = tokens
            break

    if first_fail is None:
        print(f"\n      在 --cap {args.cap:,} 以内全部成功，未触及上限。")
        print(f"      如需继续，可加大 --cap 重跑。")
        print("=" * 78)
        print(f"结论: 真实上限 >= {last_ok:,} tokens（未探到边界）")
        print(f"累计消耗输入约 {budget[0]:,} tokens")
        return

    # ---- 3. 二分收敛 ----
    print(f"\n[3/3] 二分收敛（{last_ok:,} 成功 / {first_fail:,} 失败）")
    lo, hi = last_ok, first_fail
    while hi - lo > max(2048, int(lo * 0.05)):
        mid = (lo + hi) // 2
        step += 1
        result = probe(key, args.model, mid, cpt, args.timeout)
        state, result = verdict(result, mid)
        report(step, mid, state, result, budget)
        if state == "ok":
            lo = mid
        else:
            hi = mid

    print("=" * 78)
    print(f"结论: 最大可用输入约 {lo:,} tokens（下一个失败点 {hi:,}）")
    print(f"      换算约 {int(lo * cpt):,} 字符")
    print(f"      累计消耗输入约 {budget[0]:,} tokens")
    print()
    print("建议配置:")
    print(f"  contextWindow: {lo}")
    print(f"  maxTokens:     32000   # 输出上限与输入窗口独立，保守取值")


if __name__ == "__main__":
    main()
