import { describe, it, expect } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import type { LinkStatus } from "../../links/tunnel-status-probe";
import { LINK_CURRENT_GET } from "./get-current";

const USER_ID = "user_1";

function makeCtx(
  probe?: (userId: string) => Promise<LinkStatus>,
): StudioContext {
  return {
    auth: { user: { id: USER_ID, email: "t@e.com", name: "T", role: "user" } },
    access: {
      granted: () => true,
      check: async () => {},
      grant: () => {},
      setToolName: () => {},
    },
    linkStatusProbe: probe,
  } as unknown as StudioContext;
}

describe("LINK_CURRENT_GET", () => {
  it("offline when no probe is wired", async () => {
    const result = await LINK_CURRENT_GET.handler({}, makeCtx(undefined));
    expect(result).toEqual({ online: false, capabilities: [] });
  });

  it("offline when probe reports offline", async () => {
    const ctx = makeCtx(async () => ({ online: false, capabilities: [] }));
    expect(await LINK_CURRENT_GET.handler({}, ctx)).toEqual({
      online: false,
      capabilities: [],
    });
  });

  it("online maps probe fields", async () => {
    const ctx = makeCtx(async () => ({
      online: true,
      hostname: "laptop",
      cliVersion: "1.2.3",
      capabilities: ["claude-code"],
    }));
    const result = await LINK_CURRENT_GET.handler({}, ctx);
    expect(result.online).toBe(true);
    expect(result.hostname).toBe("laptop");
    expect(result.cliVersion).toBe("1.2.3");
    expect(result.capabilities).toEqual(["claude-code"]);
  });

  it("throws when called without auth", async () => {
    const ctx = {
      auth: {},
      access: { check: async () => {} },
    } as unknown as StudioContext;
    await expect(LINK_CURRENT_GET.handler({}, ctx)).rejects.toThrow(
      "Authentication required",
    );
  });
});
