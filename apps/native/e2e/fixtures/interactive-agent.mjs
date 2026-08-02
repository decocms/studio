#!/usr/bin/env node
// @ts-nocheck -- deterministic Node/Bun process fixture, no build step.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NATIVE_GUARDRAIL =
  "You are operating inside Studio Native as an interactive coding agent.";
const VIRTUAL_MCP_INSTRUCTIONS =
  "Reply through the deterministic terminal fixture.";

function fail(message) {
  process.stderr.write(`studio terminal e2e fixture: ${message}\n`);
  process.exit(2);
}

const providerFlag = process.argv.indexOf("--stub-provider");
const provider = process.argv[providerFlag + 1];
if (
  provider !== "claude-code" &&
  provider !== "codex" &&
  provider !== "opencode"
) {
  fail("--stub-provider must be claude-code, codex, or opencode");
}
const providerArgs = process.argv.slice(providerFlag + 2);

// Availability and direct-start compatibility probes invoke the exact same
// argv prefix as the interactive child. Answer them before requiring the
// launch-only log environment so the fixture exercises the production gate.
if (providerArgs.includes("--version")) {
  if (provider === "claude-code") {
    const version = process.env.STUDIO_TERMINAL_E2E_CLAUDE_VERSION || "2.1.218";
    process.stdout.write(`${version} (Claude Code)\n`);
  } else if (provider === "codex") {
    const version = process.env.STUDIO_TERMINAL_E2E_CODEX_VERSION || "0.144.5";
    process.stdout.write(`codex-cli ${version}\n`);
  } else {
    process.stdout.write("1.18.10\n");
  }
  process.exit(0);
}
if (
  provider === "opencode" &&
  JSON.stringify(providerArgs) ===
    JSON.stringify(["--pure", "db", "SELECT 1", "--format", "json"])
) {
  process.stdout.write('[{"1":1}]\n');
  process.exit(0);
}
if (
  provider === "claude-code" &&
  providerArgs[0] === "auth" &&
  providerArgs[1] === "status"
) {
  process.stdout.write('{"loggedIn":true}\n');
  process.exit(0);
}
if (
  provider === "codex" &&
  providerArgs[0] === "login" &&
  providerArgs[1] === "status"
) {
  process.stderr.write("Logged in using ChatGPT\n");
  process.exit(0);
}

const launchLog = process.env.STUDIO_TERMINAL_E2E_LOG;
if (!launchLog) fail("STUDIO_TERMINAL_E2E_LOG is required");

const isTitleInvocation =
  (provider === "claude-code" && providerArgs.includes("-p")) ||
  (provider === "codex" && providerArgs.includes("exec"));
if (isTitleInvocation) {
  const titlePrompt = readFileSync(0, "utf8");
  if (!titlePrompt.includes("Session:")) {
    fail("title prompt was not delivered over stdin");
  }
  if (providerArgs.some((argument) => argument.includes("Session:"))) {
    fail("title prompt leaked into process arguments");
  }
  if (provider === "claude-code") {
    for (const flag of [
      "--safe-mode",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--strict-mcp-config",
    ]) {
      if (!providerArgs.includes(flag)) {
        fail(`Claude title invocation is missing ${flag}`);
      }
    }
    if (providerArgs.includes("--mcp-config")) {
      fail("Claude title invocation must not load an MCP server");
    }
  } else {
    const execIndex = providerArgs.indexOf("exec");
    const globalArgs = providerArgs.slice(0, execIndex).join(" ");
    if (
      execIndex === -1 ||
      globalArgs !== "--disable apps --disable plugins --disable hooks" ||
      !providerArgs.includes("--ignore-user-config") ||
      !providerArgs.includes("--ignore-rules") ||
      !providerArgs.includes("--ephemeral") ||
      providerArgs.at(-1) !== "-" ||
      !process.env.CODEX_HOME
    ) {
      fail("Codex title invocation escaped its managed isolation boundary");
    }
  }
  appendFileSync(
    launchLog,
    `${JSON.stringify({
      kind: "title",
      provider,
      promptViaStdin: true,
      integrationsDisabled: true,
      managedCodexHome:
        provider === "codex" ? Boolean(process.env.CODEX_HOME) : null,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const title = JSON.stringify({ title: `Stub ${provider} chat` });
  if (provider === "claude-code") {
    process.stdout.write(`${JSON.stringify({ result: title })}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: title },
      })}\n`,
    );
  }
  process.exit(0);
}

function argValue(name) {
  const index = providerArgs.indexOf(name);
  return index === -1 ? undefined : providerArgs[index + 1];
}

function validateSystemPrompt(systemPrompt) {
  if (!systemPrompt.includes(NATIVE_GUARDRAIL)) {
    fail("managed system prompt is missing Studio Native guardrails");
  }
  if (!systemPrompt.includes(VIRTUAL_MCP_INSTRUCTIONS)) {
    fail("managed system prompt is missing virtual MCP instructions");
  }
  return {
    nativeGuardrails: true,
    virtualMcpInstructions: true,
  };
}

function workspaceTrustTarget(selectedProvider) {
  const cwd = realpathSync(process.cwd());
  const result = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--git-common-dir"],
    {
      encoding: "utf8",
    },
  );
  const commonDirRaw = result.status === 0 ? result.stdout.trim() : "";
  if (!commonDirRaw) return cwd;
  const commonDir = realpathSync(
    isAbsolute(commonDirRaw) ? commonDirRaw : resolve(cwd, commonDirRaw),
  );
  if (basename(commonDir) === ".git") return realpathSync(dirname(commonDir));
  return selectedProvider === "claude-code"
    ? commonDir
    : realpathSync(dirname(commonDir));
}

let managedLaunch;

function loadHookConfig() {
  if (provider === "claude-code") {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    if (!claudeConfigDir) {
      fail("Claude launch is missing its isolated config directory");
    }
    const claudeState = JSON.parse(
      readFileSync(join(claudeConfigDir, ".claude.json"), "utf8"),
    );
    const trustTarget = workspaceTrustTarget(provider);
    if (
      claudeState.studioE2eSentinel?.preserve !== true ||
      JSON.stringify(claudeState.projects?.["/studio-e2e/unrelated"]) !==
        JSON.stringify({ allowedTools: ["Read"], custom: "keep" }) ||
      claudeState.projects?.[trustTarget]?.hasTrustDialogAccepted !== true ||
      claudeState.projects?.[dirname(trustTarget)]?.hasTrustDialogAccepted ===
        true
    ) {
      fail("Claude workspace trust was not merged at the exact launch target");
    }
    const settingsPath = argValue("--settings");
    if (!settingsPath || !providerArgs.includes("--strict-mcp-config")) {
      fail("Claude launch is missing managed settings or strict MCP config");
    }
    const promptPath = argValue("--append-system-prompt-file");
    if (!promptPath) fail("Claude launch is missing its managed system prompt");
    const promptContract = validateSystemPrompt(
      readFileSync(promptPath, "utf8"),
    );
    const mcpConfigRaw = argValue("--mcp-config");
    if (!mcpConfigRaw) fail("Claude launch is missing its managed MCP config");
    const mcpConfig = JSON.parse(mcpConfigRaw);
    if (
      Object.keys(mcpConfig).join(",") !== "mcpServers" ||
      Object.keys(mcpConfig.mcpServers ?? {}).join(",") !== "cms"
    ) {
      fail("Claude launch must expose exactly the managed cms MCP server");
    }
    const cms = mcpConfig.mcpServers.cms;
    if (
      cms?.type !== "http" ||
      cms?.url !== "${DECOCMS_MCP_URL}" ||
      Object.keys(cms?.headers ?? {}).join(",") !== "Authorization" ||
      cms.headers.Authorization !== "${DECOCMS_MCP_AUTHORIZATION}"
    ) {
      fail("Claude cms MCP config is not the managed credential template");
    }
    managedLaunch = {
      ...promptContract,
      mcpServerNames: ["cms"],
      workspaceTrustSuppressed: true,
    };
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  }

  if (provider === "codex") {
    const codexHome = process.env.CODEX_HOME;
    if (
      !codexHome ||
      !providerArgs.includes("--dangerously-bypass-hook-trust")
    ) {
      fail("Codex launch is missing its managed home or hook trust flag");
    }
    const trustIndexes = providerArgs.flatMap((argument, index) =>
      argument === "-c" ? [index] : [],
    );
    const trustTarget = workspaceTrustTarget(provider);
    const expectedTrustOverride = `projects={ ${JSON.stringify(trustTarget)} = { trust_level = "trusted" } }`;
    const resumeIndex = providerArgs.indexOf("resume");
    if (
      trustIndexes.length !== 1 ||
      providerArgs[trustIndexes[0] + 1] !== expectedTrustOverride ||
      (resumeIndex !== -1 && trustIndexes[0] > resumeIndex) ||
      providerArgs.includes("--dangerously-bypass-approvals-and-sandbox")
    ) {
      fail("Codex workspace trust is not an exact launch-only override");
    }
    const profile = argValue("--profile");
    if (!profile) fail("Codex launch is missing its managed profile");
    const config = readFileSync(
      join(codexHome, `${profile}.config.toml`),
      "utf8",
    );
    const developerInstructions = config
      .split("\n")
      .find((line) => line.startsWith("developer_instructions = "))
      ?.slice("developer_instructions = ".length);
    if (!developerInstructions) {
      fail("Codex managed profile is missing developer instructions");
    }
    const promptContract = validateSystemPrompt(
      JSON.parse(developerInstructions),
    );
    const mcpSections = config
      .split("\n")
      .filter((line) => line.startsWith("[mcp_servers."));
    if (
      mcpSections.join(",") !==
        "[mcp_servers.cms],[mcp_servers.cms.env_http_headers]" ||
      !config.includes("hooks = true") ||
      !config.includes(
        `url = ${JSON.stringify(process.env.DECOCMS_MCP_URL)}`,
      ) ||
      !config.includes('Authorization = "DECOCMS_MCP_AUTHORIZATION"') ||
      config.includes("Cookie =") ||
      config.includes("Origin =") ||
      config.includes("trust_level") ||
      config.includes("[projects.")
    ) {
      fail("Codex launch must expose exactly the managed cms MCP config");
    }
    managedLaunch = {
      ...promptContract,
      mcpServerNames: ["cms"],
      workspaceTrustSuppressed: true,
    };
    return JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
  }

  const rawConfig = process.env.OPENCODE_CONFIG_CONTENT;
  if (!rawConfig) fail("OpenCode launch is missing OPENCODE_CONFIG_CONTENT");
  const authorization = process.env.DECOCMS_MCP_AUTHORIZATION;
  if (
    authorization &&
    (rawConfig.includes(authorization) ||
      providerArgs.some((argument) => argument.includes(authorization)))
  ) {
    fail("OpenCode scoped bearer escaped its environment boundary");
  }

  const config = JSON.parse(rawConfig);
  const managedAgentName = argValue("--agent");
  if (
    typeof managedAgentName !== "string" ||
    !managedAgentName.startsWith("studio-native-") ||
    Object.keys(config.agent ?? {}).join(",") !== managedAgentName ||
    config.agent[managedAgentName]?.mode !== "primary" ||
    config.agent[managedAgentName]?.disable !== false ||
    providerArgs.filter((argument) => argument === "--agent").length !== 1
  ) {
    fail("OpenCode launch is missing its launch-unique managed primary agent");
  }
  if (providerArgs.includes("--model")) {
    fail("OpenCode launch must leave provider/model selection to its TUI");
  }
  const promptContract = validateSystemPrompt(
    config.agent[managedAgentName].prompt,
  );

  const pluginUrl = config.plugin?.[0];
  if (
    config.plugin?.length !== 1 ||
    typeof pluginUrl !== "string" ||
    !pluginUrl.startsWith("file:")
  ) {
    fail("OpenCode launch is missing its managed lifecycle plugin URL");
  }
  let pluginPath;
  try {
    pluginPath = fileURLToPath(pluginUrl);
  } catch {
    fail("OpenCode lifecycle plugin URL is invalid");
  }
  if (!existsSync(pluginPath)) {
    fail("OpenCode lifecycle plugin file does not exist");
  }

  if (
    Object.keys(config.mcp ?? {}).join(",") !== "cms" ||
    config.mcp.cms?.type !== "remote" ||
    config.mcp.cms.url !== "{env:DECOCMS_MCP_URL}" ||
    Object.keys(config.mcp.cms.headers ?? {}).join(",") !== "Authorization" ||
    config.mcp.cms.headers.Authorization !==
      "{env:DECOCMS_MCP_AUTHORIZATION}" ||
    config.mcp.cms.oauth !== false
  ) {
    fail("OpenCode launch must expose exactly the managed cms MCP config");
  }

  const resumedSession = process.env.STUDIO_OPENCODE_SESSION_ID;
  const sessionFlags = providerArgs.filter(
    (argument) => argument === "--session",
  );
  if (resumedSession) {
    if (
      sessionFlags.length !== 1 ||
      argValue("--session") !== resumedSession ||
      providerArgs.includes("resume")
    ) {
      fail("OpenCode resume must use exactly --session <id>");
    }
  } else if (sessionFlags.length !== 0) {
    fail("fresh OpenCode launch must not contain --session");
  }

  managedLaunch = {
    ...promptContract,
    mcpServerNames: ["cms"],
    workspaceTrustSuppressed: null,
  };
  return null;
}

const hookConfig = loadHookConfig();
if (provider === "codex") {
  const events = Object.keys(hookConfig?.hooks ?? {}).sort();
  if (
    Object.keys(hookConfig ?? {}).join(",") !== "hooks" ||
    events.join(",") !==
      [
        "PermissionRequest",
        "PostToolUse",
        "PreToolUse",
        "SessionStart",
        "Stop",
        "SubagentStart",
        "SubagentStop",
        "UserPromptSubmit",
      ].join(",")
  ) {
    fail("Codex hooks.json does not match the supported event schema");
  }
}

async function validateScopedMcpAccess() {
  const mcpUrl = process.env.DECOCMS_MCP_URL;
  const authorization = process.env.DECOCMS_MCP_AUTHORIZATION;
  if (!mcpUrl || !authorization?.startsWith("Bearer ")) {
    fail("managed MCP endpoint or scoped authorization is missing");
  }
  if (process.env.DECOCMS_MCP_COOKIE || process.env.DECOCMS_MCP_ORIGIN) {
    fail("legacy whole-API MCP credentials reached the provider child");
  }

  const selected = new URL(mcpUrl);
  const another = new URL(mcpUrl);
  another.pathname = another.pathname.replace(/\/[^/]+$/, "/not-selected");
  const privateRoute = new URL("/_auth/status", mcpUrl);
  const invoke = (target) =>
    fetch(target, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5_000),
    });
  try {
    const [selectedResponse, anotherResponse, privateResponse] =
      await Promise.all([
        invoke(selected),
        invoke(another),
        invoke(privateRoute),
      ]);
    if (selectedResponse.status !== 200) {
      fail("scoped MCP authorization did not reach its selected endpoint");
    }
    if (anotherResponse.status !== 401 || privateResponse.status !== 401) {
      fail("scoped MCP authorization escaped its exact endpoint");
    }
    return true;
  } catch {
    fail("scoped MCP authorization probe failed");
  }
}

managedLaunch.scopedMcpAuthorization = await validateScopedMcpAccess();

function hookCommand(eventName) {
  const command = hookConfig?.hooks?.[eventName]?.[0]?.hooks?.[0]?.command;
  if (typeof command !== "string" || command.length === 0) {
    fail(`managed hook config is missing ${eventName}`);
  }
  return command;
}

function emitHook(eventName, extra = {}) {
  const result = spawnSync("/bin/sh", ["-c", hookCommand(eventName)], {
    env: process.env,
    input: JSON.stringify({
      hook_event_name: eventName,
      session_id: sessionId,
      ...extra,
    }),
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    fail(`${eventName} hook command failed`);
  }
}

async function emitOpenCodeEvent(eventName, properties, turn = null) {
  const hookUrl = process.env.STUDIO_AGENT_HOOK_URL;
  const hookToken = process.env.STUDIO_AGENT_HOOK_TOKEN;
  if (!hookUrl || !hookToken) {
    fail("OpenCode launch is missing its authenticated lifecycle hook");
  }
  let response;
  try {
    response = await fetch(hookUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hookToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "opencode",
        rootSessionID: sessionId,
        ...(turn ? { turn } : {}),
        event: { type: eventName, properties },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    fail(`${eventName} OpenCode hook request failed`);
  }
  if (response.status !== 204) {
    fail(`${eventName} OpenCode hook returned ${response.status}`);
  }
}

const resumeId =
  provider === "claude-code"
    ? argValue("--resume")
    : provider === "codex"
      ? (() => {
          const resumeIndex = providerArgs.indexOf("resume");
          return resumeIndex === -1 ? undefined : providerArgs[resumeIndex + 1];
        })()
      : argValue("--session");

function isClaudeRecoveryFixture() {
  const targetBranch =
    process.env.STUDIO_TERMINAL_E2E_CLAUDE_MISSING_RESUME_BRANCH;
  const sentinel =
    process.env.STUDIO_TERMINAL_E2E_CLAUDE_MISSING_RESUME_SENTINEL;
  if (provider !== "claude-code" || !targetBranch || !sentinel) {
    return false;
  }

  const branch = spawnSync(
    "git",
    ["-C", process.cwd(), "branch", "--show-current"],
    { encoding: "utf8" },
  );
  if (branch.status !== 0) {
    fail("could not resolve the Claude recovery fixture branch");
  }
  return branch.stdout.trim() === targetBranch;
}

const claudeRecoveryFixture = isClaudeRecoveryFixture();

function claimMissingClaudeResume() {
  const sentinel =
    process.env.STUDIO_TERMINAL_E2E_CLAUDE_MISSING_RESUME_SENTINEL;
  if (!claudeRecoveryFixture || !resumeId || !sentinel) return false;

  try {
    closeSync(openSync(sentinel, "wx", 0o600));
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    fail(`could not claim the Claude missing-resume fixture: ${String(error)}`);
  }
}

const simulatedMissingResume = claimMissingClaudeResume();
const sessionId =
  resumeId ??
  (claudeRecoveryFixture &&
  existsSync(process.env.STUDIO_TERMINAL_E2E_CLAUDE_MISSING_RESUME_SENTINEL)
    ? "studio-e2e-claude-code-recovered-session"
    : `studio-e2e-${provider}-session`);

appendFileSync(
  launchLog,
  `${JSON.stringify({
    kind: "interactive",
    provider,
    args: providerArgs,
    resumeId: resumeId ?? null,
    managedLaunch,
    cwd: process.cwd(),
    pid: process.pid,
    ...(simulatedMissingResume ? { simulatedMissingResume: true } : {}),
  })}\n`,
  { encoding: "utf8", mode: 0o600 },
);

if (simulatedMissingResume) {
  // Claude can still deliver SessionEnd for an explicit resume id that has no
  // transcript. It must not make that missing conversation resumable again.
  emitHook("SessionEnd", { session_id: resumeId });
  process.stderr.write(
    `\u001b7\u001b[r\u001b8\u001b(B\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?1004h\u001b[?2031h\u001b[<u\u001b[>1u\u001b[>4;2m\u001b[>0q\u001b[c\u001b[>4m\u001b[<u\u001b[?1004l\u001b[?2031l\u001b[?2004l\u001b[?2026hNo\u001b[4Gconversation\u001b[17Gfound\u001b[23Gwith\u001b[28Gsession\u001b[36GID:\u001b[40G${resumeId}\r\r\n\u001b[?2026l`,
  );
  process.exit(1);
}

if (provider === "opencode") {
  await emitOpenCodeEvent("session.created", {
    info: { id: sessionId, title: "New session - terminal fixture" },
  });
  await emitOpenCodeEvent("session.updated", {
    info: { id: sessionId, title: "New session - terminal fixture" },
  });
  const childSessionId = `${sessionId}-child`;
  await emitOpenCodeEvent("session.updated", {
    info: {
      id: childSessionId,
      parentID: sessionId,
      title: "Child session must not rename the chat",
    },
  });
  await emitOpenCodeEvent("session.idle", {
    sessionID: childSessionId,
    info: { id: childSessionId, parentID: sessionId },
  });
} else {
  emitHook("SessionStart");
}
process.stdout.write(`STUB_READY:${provider}:${sessionId}\r\n`);

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

let input = "";
let handling = Promise.resolve();
let opencodeTurnID = 0;

function drainPrompts() {
  const startMarker = "\u001b[200~";
  const endMarker = "\u001b[201~";
  while (true) {
    const start = input.indexOf(startMarker);
    if (start === -1) return;
    const end = input.indexOf(endMarker, start + startMarker.length);
    if (end === -1) return;
    const prompt = input.slice(start + startMarker.length, end);
    input = input.slice(end + endMarker.length).replace(/^[\r\n]+/, "");
    handling = handling.then(async () => {
      if (provider === "opencode") {
        const turnID = ++opencodeTurnID;
        await emitOpenCodeEvent(
          "session.status",
          {
            sessionID: sessionId,
            status: { type: "busy" },
          },
          { id: turnID, phase: "busy" },
        );
        await emitOpenCodeEvent(
          "permission.asked",
          {
            sessionID: sessionId,
          },
          { id: turnID, phase: "active" },
        );
        await emitOpenCodeEvent(
          "permission.replied",
          {
            sessionID: sessionId,
          },
          { id: turnID, phase: "active" },
        );
        await emitOpenCodeEvent(
          "question.asked",
          {
            sessionID: sessionId,
          },
          { id: turnID, phase: "active" },
        );
        await emitOpenCodeEvent(
          "question.replied",
          {
            sessionID: sessionId,
          },
          { id: turnID, phase: "active" },
        );
        process.stdout.write(`STUB_REPLY:${provider}:${prompt}\r\n`);
        await emitOpenCodeEvent("session.updated", {
          info: { id: sessionId, title: "Stub opencode chat" },
        });
        await emitOpenCodeEvent(
          "session.idle",
          { sessionID: sessionId },
          { id: turnID, phase: "terminal" },
        );
      } else {
        emitHook("UserPromptSubmit", { prompt });
        process.stdout.write(`STUB_REPLY:${provider}:${prompt}\r\n`);
        emitHook("Stop");
      }
      process.stdout.write(`STUB_COMPLETED:${provider}\r\n`);
    });
  }
}

process.stdin.on("data", (chunk) => {
  input += chunk;
  drainPrompts();
});
