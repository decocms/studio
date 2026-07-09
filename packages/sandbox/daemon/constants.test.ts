import { describe, expect, test } from "bun:test";
import { buildDevEnv, isSyntheticBranch, pmRunCommand } from "./constants";

describe("isSyntheticBranch", () => {
  test("matches the ephemeral sentinel", () => {
    expect(isSyntheticBranch("ephemeral")).toBe(true);
  });

  test("matches any thread: prefixed branch", () => {
    expect(isSyntheticBranch("thread:abc123")).toBe(true);
  });

  test("rejects real git branches", () => {
    expect(isSyntheticBranch("main")).toBe(false);
    expect(isSyntheticBranch("feat/thread-stuff")).toBe(false);
  });
});

describe("buildDevEnv", () => {
  test("always sets HOST and HOSTNAME to 0.0.0.0", () => {
    const env = buildDevEnv({});
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.HOSTNAME).toBe("0.0.0.0");
  });

  test("derives PORT from config.application.port when not overridden", () => {
    const env = buildDevEnv({ application: { port: 4000 } });
    expect(env.PORT).toBe("4000");
  });

  test("an explicit PORT override wins over config.application.port", () => {
    const env = buildDevEnv({ application: { port: 4000 } }, { PORT: "5000" });
    expect(env.PORT).toBe("5000");
  });

  test("omits PORT when no config port is set and no override given", () => {
    const env = buildDevEnv({});
    expect(env.PORT).toBeUndefined();
  });

  test("overrides can also stomp HOST/HOSTNAME", () => {
    const env = buildDevEnv({}, { HOST: "127.0.0.1" });
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.HOSTNAME).toBe("0.0.0.0");
  });
});

describe("pmRunCommand", () => {
  test("builds a cd + run-prefix command and matching label", () => {
    const { cmd, label } = pmRunCommand("", "/app/repo", "npm run", "dev");
    expect(cmd).toBe("cd /app/repo && npm run dev");
    expect(label).toBe("$ cd /app/repo && npm run dev");
  });

  test("prepends the runtime prefix verbatim", () => {
    const { cmd } = pmRunCommand(
      "NODE_ENV=production ",
      "/app/repo",
      "pnpm run",
      "build",
    );
    expect(cmd).toBe("NODE_ENV=production cd /app/repo && pnpm run build");
  });
});
