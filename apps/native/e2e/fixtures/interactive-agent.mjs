#!/usr/bin/env node
// @ts-nocheck -- deterministic Node/Bun process fixture, no build step.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
if (provider !== "claude-code" && provider !== "codex") {
  fail("--stub-provider must be claude-code or codex");
}
const providerArgs = process.argv.slice(providerFlag + 2);

// Availability and direct-start compatibility probes invoke the exact same
// argv prefix as the interactive child. Answer them before requiring the
// launch-only log environment so the fixture exercises the production gate.
if (providerArgs.includes("--version")) {
  if (provider === "claude-code") {
    const version = process.env.STUDIO_TERMINAL_E2E_CLAUDE_VERSION || "2.1.218";
    process.stdout.write(`${version} (Claude Code)\n`);
  } else {
    const version = process.env.STUDIO_TERMINAL_E2E_CODEX_VERSION || "0.144.5";
    process.stdout.write(`codex-cli ${version}\n`);
  }
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

const sessionId = `studio-e2e-${provider}-session`;

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

let managedLaunch;

function loadHookConfig() {
  if (provider === "claude-code") {
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
    managedLaunch = { ...promptContract, mcpServerNames: ["cms"] };
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  }

  const codexHome = process.env.CODEX_HOME;
  if (!codexHome || !providerArgs.includes("--dangerously-bypass-hook-trust")) {
    fail("Codex launch is missing its managed home or hook trust flag");
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
    !config.includes(`url = ${JSON.stringify(process.env.DECOCMS_MCP_URL)}`) ||
    !config.includes('Authorization = "DECOCMS_MCP_AUTHORIZATION"') ||
    config.includes("Cookie =") ||
    config.includes("Origin =")
  ) {
    fail("Codex launch must expose exactly the managed cms MCP config");
  }
  managedLaunch = { ...promptContract, mcpServerNames: ["cms"] };
  return JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
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

const resumeId =
  provider === "claude-code"
    ? argValue("--resume")
    : (() => {
        const resumeIndex = providerArgs.indexOf("resume");
        return resumeIndex === -1 ? undefined : providerArgs[resumeIndex + 1];
      })();

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
  })}\n`,
  { encoding: "utf8", mode: 0o600 },
);

emitHook("SessionStart");
process.stdout.write(`STUB_READY:${provider}:${sessionId}\r\n`);

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

let input = "";
let handling = Promise.resolve();

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
    handling = handling.then(() => {
      emitHook("UserPromptSubmit", { prompt });
      process.stdout.write(`STUB_REPLY:${provider}:${prompt}\r\n`);
      emitHook("Stop");
      process.stdout.write(`STUB_COMPLETED:${provider}\r\n`);
    });
  }
}

process.stdin.on("data", (chunk) => {
  input += chunk;
  drainPrompts();
});
