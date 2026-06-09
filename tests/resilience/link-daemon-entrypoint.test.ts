import { describe, expect, test } from "bun:test";
import { buildDaemonSession } from "./link-daemon-entrypoint";

describe("buildDaemonSession", () => {
  test("puts the API key in accessToken and the cluster URL in target", () => {
    const session = buildDaemonSession({
      apiKey: "key-abc",
      clusterUrl: "http://toxiproxy:3010",
      nowIso: "2026-06-03T00:00:00.000Z",
    });
    expect(session.accessToken).toBe("key-abc");
    expect(session.target).toBe("http://toxiproxy:3010");
    expect(session.clientId).toBe("resilience-link-daemon");
    expect(session.user.sub).toBe("resilience-link-daemon");
    expect(session.createdAt).toBe("2026-06-03T00:00:00.000Z");
  });

  test("throws when the API key is empty", () => {
    expect(() =>
      buildDaemonSession({
        apiKey: "",
        clusterUrl: "http://toxiproxy:3010",
        nowIso: "2026-06-03T00:00:00.000Z",
      }),
    ).toThrow(/DAEMON_API_KEY/);
  });
});
