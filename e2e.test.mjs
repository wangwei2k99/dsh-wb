/**
 * 端到端测试：走真实宿主 + 真实上游，验证插件在真链路上不炸、且档位真的生效。
 *
 * 为什么必须有这一层：
 *   仓库里 91 项测试全部基于自建 mock。上一轮那个「插件整体不激活」的崩溃，
 *   恰恰是 mock 全过、真实宿主却直接抛 `cannot get property "agents" without
 *   inject` —— 说明 mock 覆盖再多也替代不了真链路。这个脚本补的就是那个缺口。
 *
 * 它做什么：
 *   起一个真实的 `dsh --profile <e2e> headless "<prompt>"` 进程，断言：
 *     1. 进程退出码为 0（插件没有把宿主搞崩）
 *     2. 输出里有模型正文（不是空响应/超窗截断）
 *     3. 日志里出现 `http.headers` 且 status 200（真的打到了上游）
 *     4. 没有 MISSING_CREDENTIAL / 激活失败之类的问题
 *
 * 前置条件（脚本会自己检查并明确报错，不静默跳过）：
 *   - 存在 profile `workbuddy-e2e`，且已安装本插件、配好 provider 与凭据引用
 *
 * 用法：
 *   node e2e.test.mjs            # 跑
 *   node e2e.test.mjs --keep     # 失败时保留原始输出便于排查
 *
 * 成本：每次约 2 次上游请求，prompt 极短。默认只在手动执行时运行，
 *       不放进 `npm run check`，避免每次改代码都产生真实调用费用。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROFILE = process.env.WORKBUDDY_E2E_PROFILE ?? "workbuddy-e2e";
const PROMPT = "只回复两个字：可以";
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");

let failures = 0;
const check = (ok, label, detail) => {
  if (ok) {
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : `\n       ${detail}`}`);
  }
};

/**
 * 找到 dsh 可执行文件。
 *
 * 优先用绝对路径（DSH 装在固定位置），避免依赖 PATH；环境变量 DSH_BIN 可覆盖。
 * 注意 Windows 上 dsh 是 `.cmd` 批处理包装，spawn 时必须走 shell，
 * 否则不会被当作可执行文件，status 恒为 null。
 */
function locateDsh() {
  const override = process.env.DSH_BIN;
  if (override && existsSync(override)) return override;
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"),
    join(process.env.ProgramFiles ?? "", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"),
  ];
  for (const candidate of candidates) {
    // 只判断文件存在，不用 `--version` 探测：多一次进程启动既慢，
    // 又容易因为 shell 引号/编码问题误判成「没装」。
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** profile 必须已装好插件且有 provider 配置，否则这条测试没有意义。 */
function preflight() {
  const dir = join(DSH_HOME, "profiles", PROFILE);
  const pkg = join(dir, "package.json");
  const patch = join(dir, "cordis.patch.yml");
  if (!existsSync(pkg) || !existsSync(patch)) {
    console.error(`端到端测试需要已就绪的 profile "${PROFILE}"，但没找到：\n  ${pkg}\n  ${patch}`);
    console.error("请先按 README「端到端测试」一节创建该 profile，或设置 WORKBUDDY_E2E_PROFILE 指向已有 profile。");
    process.exit(2);
  }
  const deps = JSON.parse(readFileSync(pkg, "utf8"))?.dependencies ?? {};
  const hasSelf = Object.keys(deps).some((key) => key.endsWith("dsh-workbuddy"));
  if (!hasSelf) {
    console.error(`profile "${PROFILE}" 没有安装本插件（dependencies 里找不到 dsh-workbuddy）。`);
    console.error(`请先执行：dsh plugin --profile ${PROFILE} add <本仓库路径或 github: 源>`);
    process.exit(2);
  }
}

function main() {
  const keep = process.argv.includes("--keep");
  console.log(`端到端测试（profile=${PROFILE}）`);

  preflight();
  const dsh = locateDsh();
  if (!dsh) {
    console.error("找不到 dsh 可执行文件。请设置 DSH_BIN，或确认 DSH 已安装。");
    process.exit(2);
  }

  const started = Date.now();
  // Windows 上必须经 shell 才能跑 .cmd，而 shell 会把路径里的空格当分隔符
  // （DSH 装在 "DeepSeek Harness" 这种带空格的目录下），所以整条命令要加引号。
  //
  // 注意：shell:true 时 Node 只是拼接参数、不做转义，会告警（DEP0190）。
  // 这里的参数全部来自本脚本常量（profile 名与固定 prompt），不含用户输入，
  // 所以先自行做一次最小转义再传，既消掉告警也避免被路径内容意外打断。
  const useShell = process.platform === "win32";
  const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
  const command = useShell
    ? [quote(dsh), "--profile", quote(PROFILE), "headless", quote(PROMPT)].join(" ")
    : dsh;
  const args = useShell ? [] : ["--profile", PROFILE, "headless", PROMPT];
  const run = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 16 * 1024 * 1024,
    shell: useShell,
  });
  const elapsed = Date.now() - started;
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  const combined = `${stdout}\n${stderr}`;

  if (keep && failures > 0) {
    console.log("--- 原始输出 ---");
    console.log(combined);
    console.log("--- 结束 ---");
  }

  // 1. 进程必须正常退出：插件把宿主搞崩时这里会是非 0。
  check(run.status === 0, `进程退出码为 0（实际 ${run.status}）`, tail(combined));

  // 2. 真打到了上游：日志里必须有 http.headers 且 200。
  const httpOk = /"stage":"http\.headers"[^}]*"status":200/.test(combined);
  check(httpOk, "上游返回 HTTP 200", tail(combined));

  // 3. 拿到正文。模型偶尔会用不同措辞，这里只要求出现非空中文/字母内容，
  //    并排除「只回 1 个 token 的 length」这种超窗表现。
  const body = cleanup(stdout, stderr);
  check(body.length > 0, `输出包含模型正文（${body.length} 字）`, tail(combined));
  check(!/已达到输出 token 上限/.test(combined), "未落入「输出 token 上限」截断", tail(combined));

  // 4. 不该出现凭证/激活类错误。
  check(!/MISSING_CREDENTIAL/.test(combined), "没有 MISSING_CREDENTIAL", tail(combined));
  check(!/did not activate|cannot get property/.test(combined), "插件正常激活", tail(combined));

  console.log(`\n耗时 ${(elapsed / 1000).toFixed(1)}s`);
  if (failures > 0) {
    console.log(`失败 ${failures} 项`);
    process.exit(1);
  }
  console.log("端到端测试全部通过");
}

/** 去掉插件 trace 行和宿主提示，只留模型正文。 */
function cleanup(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("[dsh-workbuddy]"))
    .filter((line) => !/^dsh:\s/.test(line))
    .filter((line) => !/^dsh web:/.test(line));
  return lines.join("\n").trim();
}

function tail(text, lines = 12) {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n       ");
}

console.log("WorkBuddy 端到端测试开始");
main();
