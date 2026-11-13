import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessStreamInputWire } from "@decocms/sandbox/dispatch/schemas";
import {
  shellWords,
  studioCliEnv,
  studioCliErrorText,
  studioCliInstruction,
  studioCliPluginDir,
  studioCliSession,
  studioToolCall,
  studioToolCallFromCodexCommand,
  writeStudioCliSession,
} from "./studio-cli";

function input(mcp: Partial<HarnessStreamInputWire["mcp"]> = {}) {
  return {
    threadId: "thrd_1",
    userMessage: { parts: [] },
    harness: {},
    workspace: { cwd: null },
    models: { thinking: { id: "m", title: "M", credentialId: "c" } },
    mcp: {
      url: "https://tunnel.example.test:8443/api/example-org/mcp/thread/thrd_1",
      headers: { Authorization: "Bearer key_first" },
      expiresAt: 1_900_000_000_999,
      ...mcp,
    },
    studioCli: { org: "example-org" },
    mode: "default",
    temperature: 0,
    toolApprovalLevel: "auto",
    user: { id: "user_1", email: "person@example.test" },
    organizationId: "org_1",
    agent: { id: "agent_1" },
  } as HarnessStreamInputWire;
}

describe("studioCliSession", () => {
  test("is the CLI's session shape for the endpoint's origin", () => {
    expect(studioCliSession(input(), 0)).toEqual({
      target: "https://tunnel.example.test:8443",
      clientId: "studio-sandbox-run",
      user: { sub: "user_1", email: "person@example.test" },
      accessToken: "key_first",
      expiresAt: 1_900_000_000,
      createdAt: "1970-01-01T00:00:00.000Z",
    });
  });

  test("finds the bearer whatever the header's case, and has no refresh token", () => {
    const session = studioCliSession(
      input({ headers: { authorization: "bearer key_lower" } }),
    );
    expect(session.accessToken).toBe("key_lower");
    expect(session).not.toHaveProperty("refreshToken");
  });

  test("user.sub is always a string, which the CLI requires", () => {
    const session = studioCliSession({
      ...input(),
      user: {} as HarnessStreamInputWire["user"],
    });
    expect(session.user).toEqual({ sub: "studio-sandbox-run" });
    expect(typeof studioCliSession(input()).user.sub).toBe("string");
  });

  test("fails closed without naming the credential", () => {
    for (const headers of [
      {},
      { Authorization: "Basic key_basic" },
      { Authorization: "Bearer " },
    ]) {
      expect(() => studioCliSession(input({ headers }))).toThrow(
        "no bearer credential",
      );
    }
    expect(() => studioCliSession(input({ url: "" }))).toThrow("not a URL");
  });
});

describe("writeStudioCliSession", () => {
  test("writes an owner-only file the CLI finds by host, and rewrites it each turn", async () => {
    const parent = await mkdtemp(join(tmpdir(), "studio-cli-test-"));
    const home = join(parent, "home");
    try {
      const path = await writeStudioCliSession(home, input());
      expect(path).toBe(join(home, "session.tunnel.example.test_8443.json"));
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        accessToken: "key_first",
      });

      await writeStudioCliSession(
        home,
        input({
          headers: { Authorization: "Bearer key_second" },
          expiresAt: 1_900_003_600_000,
        }),
      );
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        accessToken: "key_second",
        expiresAt: 1_900_003_600,
      });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      // One session, no temp files left behind for `readSession` to trip on.
      expect(await readdir(home)).toEqual([
        "session.tunnel.example.test_8443.json",
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("studioCliInstruction", () => {
  test("names the org and forbids logging in", () => {
    const text = studioCliInstruction("example-org");
    expect(text).toContain("`example-org`");
    expect(text).toContain("decocms-studio skill");
    expect(text).toContain("never run `decocms auth login`");
  });
});

describe("shellWords", () => {
  test("joins quoted segments into one word", () => {
    expect(shellWords(`a 'b c'"d"e\\ f ''`)).toEqual(["a", "b cde f", ""]);
    expect(shellWords(`x "a\\"b\\\\c\\n"`)).toEqual(["x", 'a"b\\c\\n']);
  });

  test("refuses anything the shell would do more with", () => {
    for (const command of [
      "a | b",
      "a && b",
      "a || b",
      "a; b",
      "a > out",
      "a < in",
      "a & ",
      "$(a)",
      "`a`",
      'a "$HOME"',
      "a $HOME",
      "a *",
      "a {b,c}",
      "~/a",
      "a # comment",
      "a\nb",
      "a \\\nb",
      "a 'unterminated",
      'a "unterminated',
    ]) {
      expect(shellWords(command)).toBe(null);
    }
  });
});

describe("studioToolCall", () => {
  test("maps one plain call with literal JSON", () => {
    expect(
      studioToolCall(
        `decocms tools call web_search --org example-org -d '{"query":"a | b && c"}'`,
      ),
    ).toEqual({ name: "web_search", input: { query: "a | b && c" } });
    expect(
      studioToolCall(
        `decocms tools call --org=example-org TASK_BOARD_ITEM_CREATE --data='{"title":"x"}'`,
      ),
    ).toEqual({ name: "TASK_BOARD_ITEM_CREATE", input: { title: "x" } });
    expect(
      studioToolCall(
        `decocms tools call TASK_BOARD_ITEM_CREATE --org example-org --data "{\\"title\\":\\"it's\\"}"`,
      ),
    ).toEqual({ name: "TASK_BOARD_ITEM_CREATE", input: { title: "it's" } });
  });

  test("no -d is the empty input the CLI sends", () => {
    expect(
      studioToolCall("decocms tools call ORGANIZATION_LIST --org example-org"),
    ).toEqual({ name: "ORGANIZATION_LIST", input: {} });
  });

  test("anything else stays a shell command", () => {
    for (const command of [
      `decocms tools call web_search --org o -d '{"q":1}' | jq .`,
      `decocms tools call web_search --org o && echo done`,
      `decocms tools call web_search --org o -d '{"q":1}'; ls`,
      `decocms tools call web_search --org o > out.json`,
      `decocms tools call web_search --org o -d "$(cat args.json)"`,
      `decocms tools call web_search --org o -d @args.json`,
      `decocms tools call web_search --org o -d @-`,
      `decocms tools call web_search --org o -d '{not json}'`,
      `decocms tools call web_search --org o -d '[1,2]'`,
      `decocms tools call web_search --org o -d='{}'`,
      `decocms tools call web_search -d '{}'`,
      `decocms tools call web_search --org o --org p`,
      `decocms tools call web_search --org o --target https://x.test`,
      `decocms tools call a b --org o`,
      `decocms tools call --org o`,
      `decocms tools list --org o`,
      `bunx decocms tools call web_search --org o`,
      `FOO=1 decocms tools call web_search --org o`,
      `decocms tools call 'web search' --org o`,
      `decocms tools call web_search --org`,
    ]) {
      expect(studioToolCall(command)).toBe(null);
    }
    expect(studioToolCall(undefined)).toBe(null);
  });
});

describe("studioToolCallFromCodexCommand", () => {
  test("unwraps the shell-joined `bash -lc` Codex reports", () => {
    expect(
      studioToolCallFromCodexCommand(
        `/bin/bash -lc 'decocms tools call web_search --org o -d '"'"'{"query":"x"}'"'"''`,
      ),
    ).toEqual({ name: "web_search", input: { query: "x" } });
    expect(
      studioToolCallFromCodexCommand("decocms tools call web_search --org o"),
    ).toEqual({ name: "web_search", input: {} });
  });

  test("a compound script inside the wrapper stays a shell command", () => {
    expect(
      studioToolCallFromCodexCommand(
        `bash -lc 'decocms tools call web_search --org o | jq .'`,
      ),
    ).toBe(null);
    expect(
      studioToolCallFromCodexCommand(
        `bash -lc 'decocms tools call web_search --org o' extra`,
      ),
    ).toBe(null);
  });
});

describe("studioCliErrorText", () => {
  test("drops the shell's exit-code line", () => {
    expect(
      studioCliErrorText(
        'Exit code 1\nHTTP 404 Not Found\n{"error":"Unknown tool: x"}',
      ),
    ).toBe('HTTP 404 Not Found\n{"error":"Unknown tool: x"}');
  });
});

describe("studioCliEnv", () => {
  test("sets the session dir and drops DATA_DIR, which the CLI reads first", () => {
    expect(
      studioCliEnv({ PATH: "/bin", DATA_DIR: "/data" }, "/tmp/studio-cli-x"),
    ).toEqual({ PATH: "/bin", DECOCMS_HOME: "/tmp/studio-cli-x" });
  });
});

describe("studioCliPluginDir", () => {
  test("is the image's plugin dir only when it exists", async () => {
    const prev = process.env.DECOCMS_STUDIO_PLUGIN_DIR;
    const dir = await mkdtemp(join(tmpdir(), "studio-plugin-"));
    try {
      delete process.env.DECOCMS_STUDIO_PLUGIN_DIR;
      expect(studioCliPluginDir()).toBe(null);
      process.env.DECOCMS_STUDIO_PLUGIN_DIR = join(dir, "missing");
      expect(studioCliPluginDir()).toBe(null);
      await mkdir(join(dir, "plugin"));
      process.env.DECOCMS_STUDIO_PLUGIN_DIR = join(dir, "plugin");
      expect(studioCliPluginDir()).toBe(join(dir, "plugin"));
    } finally {
      if (prev === undefined) delete process.env.DECOCMS_STUDIO_PLUGIN_DIR;
      else process.env.DECOCMS_STUDIO_PLUGIN_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
