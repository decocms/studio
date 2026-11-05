/**
 * Runs with `input.studioCli` reach Studio through the `decocms` CLI instead of
 * a mounted `studio` MCP server. This file owns the three things both harnesses
 * share for that: the CLI session file built from the run's minted key, the
 * prompt that tells the model about it, and recognizing a shell command that is
 * one plain tool call so the chat can render it as that tool.
 */

import { existsSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";

/** The CLI's `Session` (apps/api/src/cli/lib/session.ts), restated: this package installs standalone. */
export interface StudioCliSession {
  target: string;
  clientId: string;
  user: { sub: string; email?: string };
  accessToken: string;
  expiresAt: number;
  createdAt: string;
}

const STUDIO_CLI_HOME_ENV = "DECOCMS_HOME";

/**
 * The harness environment for a CLI run. `DATA_DIR` goes: the CLI reads it
 * before `DECOCMS_HOME` and would miss the run's session.
 */
export function studioCliEnv(
  base: Record<string, string | undefined>,
  home: string,
): Record<string, string | undefined> {
  const { DATA_DIR: _dataDir, ...rest } = base;
  return { ...rest, [STUDIO_CLI_HOME_ENV]: home };
}

/** The image's `decocms-studio` skill plugin, or `null` when this image has none. */
export function studioCliPluginDir(): string | null {
  const dir = process.env.DECOCMS_STUDIO_PLUGIN_DIR;
  return dir && existsSync(dir) ? dir : null;
}

/** The run key as a CLI session for the origin that minted it. Throws, naming no value, when the key is unusable. */
export function studioCliSession(
  input: HarnessStreamInputWire,
  now = Date.now(),
): StudioCliSession {
  let target: string;
  try {
    target = new URL(input.mcp.url).origin;
  } catch {
    throw new Error("studio CLI: the run's Studio endpoint is not a URL");
  }
  const authorization = Object.entries(input.mcp.headers).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token) throw new Error("studio CLI: the run has no bearer credential");
  return {
    target,
    clientId: "studio-sandbox-run",
    // The CLI treats a session whose `user.sub` is not a string as missing.
    user: {
      sub:
        typeof input.user?.id === "string" && input.user.id
          ? input.user.id
          : "studio-sandbox-run",
      ...(typeof input.user?.email === "string"
        ? { email: input.user.email }
        : {}),
    },
    accessToken: token,
    expiresAt: Math.floor(input.mcp.expiresAt / 1000),
    createdAt: new Date(now).toISOString(),
  };
}

/** The CLI's file name for a target: `session.<host>.json`. */
function studioCliSessionPath(home: string, target: string): string {
  const host = new URL(target).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  return join(home, `session.${host || "default"}.json`);
}

/**
 * (Re)writes the session into `home`, atomically and owner-only. Called every
 * turn: a kept session would otherwise go on using the first turn's key.
 */
export async function writeStudioCliSession(
  home: string,
  input: HarnessStreamInputWire,
): Promise<string> {
  const session = studioCliSession(input);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const path = studioCliSessionPath(home, session.target);
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(session), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  return path;
}

let processHome: Promise<string> | undefined;

/** One private dir per runner process, so a kept session's shells keep finding it. Removed on exit. */
export function processStudioCliHome(): Promise<string> {
  processHome ??= mkdtemp(join(tmpdir(), "studio-cli-")).then((home) => {
    process.once("exit", () => rmSync(home, { recursive: true, force: true }));
    return home;
  });
  return processHome;
}

export function studioCliInstruction(org: string): string {
  return (
    "Studio (this organization's chats, task board, agents, connections and " +
    "tools) is reached with the `decocms` CLI; follow the decocms-studio skill. " +
    `The organization slug is \`${org}\`. The CLI session for this run is ` +
    "already provided: never run `decocms auth login` and do not pass " +
    "`--target`. Call one tool per command, with its arguments as inline JSON: " +
    `\`decocms tools call <NAME> --org ${org} -d '{...}'\`.`
  );
}

const UNQUOTED = /[A-Za-z0-9_\-.,:=@%+/]/;

/**
 * Splits a POSIX shell command into words, or `null` when the shell would do
 * anything but run one simple command with literal arguments: operators,
 * redirects, expansions, globs, comments, line continuations.
 */
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  while (i < command.length) {
    const char = command[i]!;
    if (char === " " || char === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      i++;
      continue;
    }
    inWord = true;
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      word += command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (char === '"') {
      i++;
      for (;;) {
        const inner = command[i];
        if (inner === undefined) return null;
        i++;
        if (inner === '"') break;
        if (inner === "$" || inner === "`") return null;
        if (inner === "\\") {
          const next = command[i];
          if (next === undefined || next === "\n") return null;
          if ('$`"\\'.includes(next)) {
            word += next;
            i++;
            continue;
          }
        }
        word += inner;
      }
      continue;
    }
    if (char === "\\") {
      const next = command[i + 1];
      if (next === undefined || next === "\n") return null;
      word += next;
      i += 2;
      continue;
    }
    if (!UNQUOTED.test(char)) return null;
    word += char;
    i++;
  }
  if (inWord) words.push(word);
  return words;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `decocms tools call <NAME> --org <slug> [-d '<json object>']` as the tool
 * call it is, or `null` for anything else — including arguments read from a
 * file or stdin, which the chat could not show.
 */
function studioToolCallFromWords(
  words: string[],
): { name: string; input: Record<string, unknown> } | null {
  const [bin, group, verb, ...rest] = words;
  if (bin !== "decocms" || group !== "tools" || verb !== "call") return null;
  let name: string | undefined;
  let org: string | undefined;
  let data: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    // Inline `=` only on long flags: the CLI reads `-d=x` as the value `=x`.
    const flag = /^(?:(--org|--data)(?:=(.*))?|(-d))$/s.exec(word);
    if (flag) {
      const value = flag[2] ?? rest[++i];
      if (value === undefined) return null;
      if (flag[1] === "--org") {
        if (org !== undefined) return null;
        org = value;
      } else {
        if (data !== undefined) return null;
        data = value;
      }
      continue;
    }
    if (word.startsWith("-") || name !== undefined) return null;
    name = word;
  }
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name) || !org) return null;
  if (data === undefined) return { name, input: {} };
  if (data.startsWith("@")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? { name, input: parsed } : null;
}

/** A Claude Code Bash command as a Studio tool call, or `null`. */
export function studioToolCall(
  command: unknown,
): { name: string; input: Record<string, unknown> } | null {
  if (typeof command !== "string") return null;
  const words = shellWords(command);
  return words ? studioToolCallFromWords(words) : null;
}

/**
 * A Codex command execution as a Studio tool call, or `null`. Codex reports
 * the argv it ran shell-joined, so a model's command arrives wrapped as
 * `bash -lc '<command>'`.
 */
export function studioToolCallFromCodexCommand(
  command: unknown,
): { name: string; input: Record<string, unknown> } | null {
  if (typeof command !== "string") return null;
  const words = shellWords(command);
  if (!words) return null;
  const [shell, flag, script, ...extra] = words;
  if (
    shell &&
    /(^|\/)(ba|z|da)?sh$/.test(shell) &&
    (flag === "-c" || flag === "-lc") &&
    extra.length === 0
  ) {
    return studioToolCall(script);
  }
  return studioToolCallFromWords(words);
}

/** The tool's JSON result, which is what the chat's tool renderers read. */
export function studioCliOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}

/** A failed call's output, without the shell's own exit-code line. */
export function studioCliErrorText(output: string): string {
  return output.replace(/^Exit code \d+\n?/, "").trim() || output;
}
