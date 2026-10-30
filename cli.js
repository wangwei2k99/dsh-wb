#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseDocument } from "yaml";
import {
  WORKBUDDY_SESSION_REF,
  WORKBUDDY_SESSIONS_REF,
  LEGACY_SESSION_REF,
  LEGACY_SESSIONS_REF,
  createWorkBuddySessionStore,
  loginWorkBuddy,
  parseWorkBuddySession,
  parseWorkBuddySessions,
  serializeWorkBuddySession,
  serializeWorkBuddySessions,
  upsertWorkBuddySession,
} from "./workbuddy-auth.js";

const PACKAGE = "@wangwei2k99/dsh-workbuddy";
// 改名前的包名：安装/卸载时一并清理，避免两套并存。
const LEGACY_PACKAGES = ["dsh-llm-workbuddy", "dsh-llm-codebuddy", "@axiaohungry/dsh-llm-workbuddy"];
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
/*
 * 安装源必须是 GitHub，不能是 `@scope/name@version`。
 *
 * 这个包**没有发布到 npm registry**（查询返回 404），所以 `@wangwei2k99/dsh-workbuddy@x.y.z`
 * 这种 npm 版本号形式必然安装失败——以前 `node cli.js install` 就是死在这里。
 * 桌面 Profile 里记录的也是 `github:` 源，这里保持与之一致。
 *
 * 用 GitHub 源还有个附带好处：`plugin add` 会拉取仓库默认分支的最新提交，
 * 因此「重跑 install」天然就是「更新到最新版」，不依赖发布的版本号。
 */
const PACKAGE_SPEC = "github:wangwei2k99/dsh-wb";
const PROVIDER_PATH = ["llm-pi-ai", "providers", "workbuddy-cn"];
const LEGACY_PROVIDER_PATH = ["llm-pi-ai", "providers", "codebuddy-cn"];
const IGNORED_BUILDS = ["@google/genai", "protobufjs"];
const require = createRequire(import.meta.url);

function dshHome() {
  return resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
}

function profileHasPackage(home, profile, packageName) {
  const file = join(home, "profiles", profile, "package.json");
  if (!existsSync(file)) return false;
  const json = JSON.parse(readFileSync(file, "utf8"));
  return Boolean(json.dependencies?.[packageName] || json.devDependencies?.[packageName]);
}

function dshEnv() {
  const pnpmPackageDir = dirname(require.resolve("pnpm"));
  const pnpmBinDir = join(dirname(pnpmPackageDir), ".bin");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
  return {
    ...process.env,
    [pathKey]: `${pnpmBinDir}${delimiter}${process.env[pathKey] || ""}`,
    npm_config_ignore_workspace_root_check: "true",
  };
}

/**
 * 定位 dsh 可执行文件。
 *
 * 不能只依赖 PATH：Windows 上 DSH 桌面版把 `dsh.cmd` 放在安装目录里，
 * 默认不会加进 PATH，直接 spawn "dsh.cmd" 会报「不是内部或外部命令」，
 * `node cli.js install` 因此直接失败。这里按 e2e 测试同样的顺序找绝对路径。
 */
function dshBin() {
  const override = process.env.DSH_BIN;
  if (override && existsSync(override)) return override;
  if (process.platform !== "win32") return "dsh";
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"),
    join(process.env.ProgramFiles ?? "", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"),
    join(process.env["ProgramFiles(x86)"] ?? "", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"),
  ];
  return candidates.find((c) => existsSync(c)) ?? "dsh.cmd";
}

function runDsh(args) {
  const bin = dshBin();
  /*
   * Windows 下 `.cmd` 是批处理包装，必须走 shell 才能执行。
   *
   * 但 `shell: true` 配数组参数会触发 DEP0190（Node 只做字符串拼接、不转义，
   * 有命令注入风险）。所以这里自己构造完整命令行并逐个加引号：既保留 shell
   * 执行 .cmd 的能力，又不把未转义参数交给 cmd.exe 解析。
   * 路径含空格（`Program Files`、`DeepSeek Harness`）时也必须加引号，
   * 否则会被当成参数分隔符。
   */
  const quote = (value) => (/[\s"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  const isWin = process.platform === "win32";
  const commandLine = [bin, ...args].map(quote).join(" ");
  const result = spawnSync(isWin ? commandLine : bin, isWin ? [] : args, {
    stdio: "inherit",
    shell: isWin,
    env: dshEnv(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `dsh ${args.join(" ")} 执行失败（退出码 ${result.status}）`
      + (bin === "dsh.cmd" ? "\n找不到 dsh 可执行文件。请设置 DSH_BIN，或确认 DSH 已安装。" : ""),
    );
  }
}

function entrySettingsVersion(output) {
  const version = String(output).match(/\b(\d+)\.(\d+)\.(\d+)(?:[-.]|\b)/);
  if (!version) return undefined;
  const [, major, minor, patch] = version.map(Number);
  return major > 0 || minor > 1 || (minor === 1 && patch >= 7);
}

function usesEntrySettings() {
  const result = spawnSync(dshBin(), ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    env: dshEnv(),
  });
  if (result.error || result.status !== 0) throw new Error("无法检测 DSH 版本，请确认 dsh 命令可用（或设置 DSH_BIN）");
  const modern = entrySettingsVersion(result.stdout);
  if (modern === undefined) throw new Error("无法识别 DSH 版本，令牌已保存；请在模型设置中手动选择令牌登录");
  return modern;
}

function writeYamlDocument(file, document) {
  const temporary = join(dirname(file), `.workbuddy-${process.pid}.tmp`);
  writeFileSync(temporary, String(document), "utf8");
  renameSync(temporary, file);
}

function withPnpmBuildPolicy(file, action) {
  const document = parseDocument(readFileSync(file, "utf8"));
  if (document.errors.length) throw new Error(`无法解析 ${file}：${document.errors[0].message}`);
  const changes = [];
  for (const packageName of IGNORED_BUILDS) {
    const path = ["allowBuilds", packageName];
    if (typeof document.getIn(path) !== "boolean") {
      changes.push({ packageName, existed: document.hasIn(path), value: document.getIn(path) });
      document.setIn(path, false);
    }
  }
  if (changes.length) writeYamlDocument(file, document);
  try {
    return action();
  } finally {
    if (changes.length) {
      const current = parseDocument(readFileSync(file, "utf8"));
      for (const change of changes) {
        const path = ["allowBuilds", change.packageName];
        if (change.existed) current.setIn(path, change.value);
        else current.deleteIn(path);
      }
      if (current.getIn(["allowBuilds"])?.items?.length === 0) current.deleteIn(["allowBuilds"]);
      writeYamlDocument(file, current);
    }
  }
}

function cleanPnpmWorkspace(file) {
  if (!existsSync(file)) return;
  const document = parseDocument(readFileSync(file, "utf8"));
  if (document.errors.length) throw new Error(`无法解析 ${file}：${document.errors[0].message}`);
  const entries = document.getIn(["minimumReleaseAgeExclude"])?.items;
  if (!entries) return;
  const packageNames = [PACKAGE, ...LEGACY_PACKAGES];
  const remaining = entries.map((entry) => entry.value).filter((entry) => !packageNames.some((packageName) => String(entry).startsWith(`${packageName}@`)));
  if (remaining.length === entries.length) return;
  if (remaining.length) document.setIn(["minimumReleaseAgeExclude"], remaining);
  else document.deleteIn(["minimumReleaseAgeExclude"]);
  writeYamlDocument(file, document);
}

function cleanSettings(file) {
  if (!existsSync(file)) return undefined;
  const source = readFileSync(file, "utf8");
  const document = parseDocument(source);
  if (document.errors.length) throw new Error(`无法解析 ${file}：${document.errors[0].message}`);
  const paths = [PROVIDER_PATH, LEGACY_PROVIDER_PATH].filter((path) => document.hasIn(path));
  if (paths.length === 0) return undefined;

  for (const path of paths) document.deleteIn(path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.workbuddy-backup-${stamp}`;
  const temporary = join(dirname(file), `.settings-workbuddy-${process.pid}.tmp`);
  copyFileSync(file, backup);
  writeFileSync(temporary, String(document), "utf8");
  renameSync(temporary, file);
  return backup;
}

function enableTokenLogin(home = dshHome()) {
  const file = join(home, "settings.yaml");
  const source = existsSync(file) ? readFileSync(file, "utf8") : "{}\n";
  const document = parseDocument(source);
  if (document.errors.length) throw new Error(`无法解析 ${file}：${document.errors[0].message}`);
  if (document.hasIn(PROVIDER_PATH)) document.deleteIn([...PROVIDER_PATH, "apiKeyEnv"]);
  else if (document.hasIn(LEGACY_PROVIDER_PATH)) {
    const legacy = document.getIn(LEGACY_PROVIDER_PATH);
    const value = legacy && typeof legacy.toJSON === "function" ? legacy.toJSON() : legacy;
    document.setIn(PROVIDER_PATH, document.createNode(value && typeof value === "object" ? value : {}));
    document.deleteIn([...PROVIDER_PATH, "apiKeyEnv"]);
    document.deleteIn(LEGACY_PROVIDER_PATH);
  }
  else document.setIn(PROVIDER_PATH, {});
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(file, `${file}.workbuddy-backup-${stamp}`);
  }
  writeYamlDocument(file, document);
}

function storeLoginSession(session, home = dshHome()) {
  const file = join(home, ".credentials.yaml");
  const document = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "{}\n");
  if (document.errors.length) throw new Error(`无法解析 ${file}：${document.errors[0].message}`);
  const stored = document.get(WORKBUDDY_SESSIONS_REF)
    ?? document.get(LEGACY_SESSIONS_REF)
    ?? document.get(WORKBUDDY_SESSION_REF)
    ?? document.get(LEGACY_SESSION_REF);
  const current = stored ? parseWorkBuddySessions(stored) : createWorkBuddySessionStore();
  const next = upsertWorkBuddySession(current, session);
  document.set(WORKBUDDY_SESSIONS_REF, serializeWorkBuddySessions(next));
  document.set(WORKBUDDY_SESSION_REF, serializeWorkBuddySession(next.sessions.find((entry) => entry.id === next.activeId)));
  document.delete(LEGACY_SESSIONS_REF);
  document.delete(LEGACY_SESSION_REF);
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(file, `${file}.workbuddy-backup-${stamp}`);
  }
  writeYamlDocument(file, document);
}

async function login() {
  console.log("正在打开 WorkBuddy 中国站网页登录（无需安装 WorkBuddy CLI）……");
  const session = await loginWorkBuddy((url, opened) => {
    if (opened) console.log("浏览器登录页已打开，请在浏览器中完成登录。");
    else console.log(`无法自动打开浏览器，请手动访问：${url}`);
  });
  storeLoginSession(session);
  if (usesEntrySettings()) {
    console.log("WorkBuddy 令牌登录成功。新版 DSH 按插件条目保存配置，请在模型设置的 WorkBuddy 卡片中选择“令牌登录”；无需安装 WorkBuddy CLI。");
  } else {
    enableTokenLogin();
    console.log("WorkBuddy 令牌登录成功，Provider 已切换为令牌模式。请重启 DSH。");
  }
}

/**
 * 需要处理的 profile 列表。
 *
 * 以前只写死 `web` / `headless`，但桌面版跑的是 `desktop` profile——于是用
 * `dsh-workbuddy install` 装完之后，日常在用的那个 profile 里旧包依然保留，
 * 两个插件同进程抢同一个 provider，正好是这次要根除的冲突。
 *
 * 改成扫描 `~/.dsh/profiles` 下真实存在的 profile，一个都不漏。目录不存在时
 * 退回旧的两个名字，保持 `dsh plugin add` 自己创建 profile 的行为。
 */
function targetProfiles(home = dshHome()) {
  const root = join(home, "profiles");
  if (!existsSync(root)) return ["web", "headless"];
  const found = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(root, name, "package.json")) || existsSync(join(root, name, "pnpm-workspace.yaml")))
    .sort();
  return found.length ? found : ["web", "headless"];
}

/**
 * 该 profile 是否用本地目录链接安装本插件（`link:` 源）。
 *
 * `link:` 是开发/测试用的本地链接，指向某个源码目录。这类 profile 不该被
 * `install` 改成 GitHub 源：一是会把正在调试的本地链接覆盖掉，二是链接目标
 * 若是本仓库，pnpm 会因为 git-hosted 插件的 prepare 脚本策略直接失败，
 * 连带让整条 `install` 中断——用户只想更新日常用的那个 profile，却被一个
 * 测试 profile 卡住。
 */
function isLinkedInstall(home, profile) {
  const file = join(home, "profiles", profile, "package.json");
  if (!existsSync(file)) return false;
  try {
    const spec = JSON.parse(readFileSync(file, "utf8")).dependencies?.[PACKAGE];
    return typeof spec === "string" && spec.startsWith("link:");
  } catch {
    return false;
  }
}

function install() {
  for (const profile of targetProfiles()) {
    if (isLinkedInstall(dshHome(), profile)) {
      console.log(`跳过 ${profile}：该 profile 用 link: 本地链接安装，不属于发布态安装。`);
      continue;
    }
    runDsh(["plugin", "--profile", profile, "list", "--depth", "0"]);
    const workspace = join(dshHome(), "profiles", profile, "pnpm-workspace.yaml");
    withPnpmBuildPolicy(workspace, () => {
      for (const legacyPackage of LEGACY_PACKAGES) {
        if (profileHasPackage(dshHome(), profile, legacyPackage)) {
          runDsh(["plugin", "--profile", profile, "remove", legacyPackage]);
        }
      }
      runDsh(["plugin", "--profile", profile, "add", PACKAGE_SPEC]);
    });
  }
  console.log(`WorkBuddy Provider 已安装（本仓库版本 ${PACKAGE_VERSION}）。请重启 DSH 后进行配置。`);
  /*
   * DSH 插件页的「更新」按钮只对官方按需插件生效：宿主只在包出现在官方 catalog 里时
   * 才给出 installTarget，没有它时点更新会直接静默返回。第三方插件因此要显式说明
   * 更新方式，否则用户会以为按钮坏了。
   */
  console.log("更新方式：重跑本命令即可（会拉取 GitHub 默认分支的最新提交）。");
  console.log("DSH 插件页的「更新」按钮对第三方插件不生效，属宿主设计。");
}

function uninstall(home = dshHome()) {
  const backup = cleanSettings(join(home, "settings.yaml"));
  for (const profile of targetProfiles(home)) {
    const workspace = join(home, "profiles", profile, "pnpm-workspace.yaml");
    const installedPackages = [PACKAGE, ...LEGACY_PACKAGES].filter((packageName) => profileHasPackage(home, profile, packageName));
    if (installedPackages.length) {
      withPnpmBuildPolicy(workspace, () => {
        for (const packageName of installedPackages) {
          runDsh(["plugin", "--profile", profile, "remove", packageName]);
        }
      });
    }
    cleanPnpmWorkspace(workspace);
  }
  console.log(backup ? `WorkBuddy 配置已清理，备份：${backup}` : "未发现 WorkBuddy Provider 配置。");
  console.log("插件已卸载，API Key 和登录令牌凭据保持不变。请重启 DSH。");
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "dsh-workbuddy-cli-"));
  try {
    if (entrySettingsVersion("dsh 0.1.6") !== false || entrySettingsVersion("dsh 0.1.7-rc.1") !== true || entrySettingsVersion("dsh 0.2.0-rc.2") !== true) {
      throw new Error("DSH version detection self-test failed");
    }
    const file = join(root, "settings.yaml");
    writeFileSync(file, "llm-pi-ai:\n  providers:\n    opencode-go:\n      apiKeyEnv: OPENCODE_GO_API_KEY\n    codebuddy-cn:\n      apiKeyEnv: WORKBUDDY_CN_API_KEY\n      models:\n        - id: legacy-model\n", "utf8");
    enableTokenLogin(root);
    const tokenMode = parseDocument(readFileSync(file, "utf8"));
    if (tokenMode.hasIn([...PROVIDER_PATH, "apiKeyEnv"]) || !tokenMode.hasIn(PROVIDER_PATH) || tokenMode.hasIn(LEGACY_PROVIDER_PATH) || !tokenMode.hasIn([...PROVIDER_PATH, "models", 0, "id"])) {
      throw new Error("token login settings self-test failed");
    }
    const backup = cleanSettings(file);
    const result = parseDocument(readFileSync(file, "utf8"));
    if (!backup || !existsSync(backup) || result.hasIn(PROVIDER_PATH) || !result.hasIn(["llm-pi-ai", "providers", "opencode-go"])) {
      throw new Error("uninstall settings cleanup self-test failed");
    }
    enableTokenLogin(root);
    if (!parseDocument(readFileSync(file, "utf8")).hasIn(PROVIDER_PATH)) {
      throw new Error("token login provider creation self-test failed");
    }
    const sampleSession = {
      auth: { accessToken: "test-access-token", refreshToken: "test-refresh-token", expiresAt: Date.now() + 60_000 },
      account: { userId: "test-user" },
    };
    storeLoginSession(sampleSession, root);
    const storedSession = parseDocument(readFileSync(join(root, ".credentials.yaml"), "utf8")).get(WORKBUDDY_SESSION_REF);
    if (parseWorkBuddySession(storedSession).account.userId !== "test-user") {
      throw new Error("token credential storage self-test failed");
    }
    const storedSessions = parseDocument(readFileSync(join(root, ".credentials.yaml"), "utf8")).get(WORKBUDDY_SESSIONS_REF);
    const sessionStore = parseWorkBuddySessions(storedSessions);
    if (sessionStore.sessions.length !== 1 || sessionStore.activeId !== sessionStore.sessions[0].id) {
      throw new Error("token account list self-test failed");
    }
    const workspace = join(root, "pnpm-workspace.yaml");
    writeFileSync(workspace, "packages:\n  - .\nallowBuilds:\n  '@google/genai': true\n  protobufjs: pending\n", "utf8");
    withPnpmBuildPolicy(workspace, () => {
      const active = parseDocument(readFileSync(workspace, "utf8"));
      if (active.getIn(["allowBuilds", "@google/genai"]) !== true || active.getIn(["allowBuilds", "protobufjs"]) !== false) {
        throw new Error("pnpm build policy activation self-test failed");
      }
    });
    const restored = parseDocument(readFileSync(workspace, "utf8"));
    if (restored.getIn(["allowBuilds", "@google/genai"]) !== true || restored.getIn(["allowBuilds", "protobufjs"]) !== "pending") {
      throw new Error("pnpm build policy self-test failed");
    }
    restored.setIn(["minimumReleaseAgeExclude"], ["other@1.0.0", `${PACKAGE}@1.3.1`]);
    writeYamlDocument(workspace, restored);
    cleanPnpmWorkspace(workspace);
    const cleaned = parseDocument(readFileSync(workspace, "utf8")).getIn(["minimumReleaseAgeExclude"])?.items?.map((entry) => entry.value);
    if (cleaned?.join(",") !== "other@1.0.0") throw new Error("pnpm workspace cleanup self-test failed");
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
    if (!dshEnv()[pathKey].split(delimiter)[0].endsWith(join("node_modules", ".bin"))) {
      throw new Error("bundled pnpm PATH self-test failed");
    }
    // profile 扫描：不能再漏掉 desktop，也不能把没有 package.json 的目录当成 profile。
    const profileHome = join(root, "home");
    if (targetProfiles(profileHome).join(",") !== "web,headless") {
      throw new Error("profile scan fallback self-test failed");
    }
    for (const name of ["desktop", "web"]) {
      mkdirSync(join(profileHome, "profiles", name), { recursive: true });
      writeFileSync(join(profileHome, "profiles", name, "package.json"), "{}\n", "utf8");
    }
    mkdirSync(join(profileHome, "profiles", "empty-dir"), { recursive: true });
    mkdirSync(join(profileHome, "profiles", "headless"), { recursive: true });
    writeFileSync(join(profileHome, "profiles", "headless", "pnpm-workspace.yaml"), "packages:\n  - .\n", "utf8");
    if (targetProfiles(profileHome).join(",") !== "desktop,headless,web") {
      throw new Error(`profile scan self-test failed: ${targetProfiles(profileHome).join(",")}`);
    }
    /*
     * 安装源必须是 github:，不能是 `@scope/name@version`。
     * 这个包没发到 npm（registry 返回 404），用 npm 版本号形式会让 `node cli.js install`
     * 必然失败。这条断言防止以后有人把它改回去。
     */
    if (!PACKAGE_SPEC.startsWith("github:") || PACKAGE_SPEC.includes("@", 1)) {
      throw new Error(`install spec self-test failed: ${PACKAGE_SPEC}`);
    }
    console.log("CLI-SELF-TEST-OK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const command = process.argv[2];
if (command === "install") install();
else if (command === "uninstall") uninstall();
else if (command === "login") await login();
else if (command === "--self-test") selfTest();
else {
  console.log("用法：dsh-workbuddy <install|login|uninstall>");
  process.exitCode = 1;
}
