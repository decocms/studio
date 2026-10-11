import { setupComponentTest } from "../../test/setup";
setupComponentTest();

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "bun:test";
import {
  APP_GONE_AFTER_FAILURES,
  type AppProbe,
  nextAppProbeDelay,
  nextAppReachable,
  useLocalAppReachable,
} from "./use-local-app-reachable";

const APP = "http://localhost:3000/";

/** A probe answering from a script, then repeating its last answer. */
function scripted(answers: boolean[]): AppProbe & { calls: number } {
  const probe = (async () => {
    const answer = answers[Math.min(probe.calls, answers.length - 1)]!;
    probe.calls++;
    return answer;
  }) as unknown as AppProbe & { calls: number };
  probe.calls = 0;
  return probe;
}

describe("nextAppReachable / nextAppProbeDelay", () => {
  it("an app that never answered is waiting; any answer is up", () => {
    expect(nextAppReachable(null, false, 1)).toBe(false);
    expect(nextAppReachable(null, true, 0)).toBe(true);
    expect(nextAppReachable(false, true, 0)).toBe(true);
  });

  it("an app that answered rides out one failed probe, then is gone", () => {
    expect(nextAppReachable(true, false, 1)).toBe(true);
    expect(nextAppReachable(true, false, APP_GONE_AFTER_FAILURES)).toBe(false);
  });

  it("checks fast while down (backoff to 5 s), slowly while up", () => {
    expect(nextAppProbeDelay(false, 1)).toBe(1_000);
    expect(nextAppProbeDelay(false, 2)).toBe(2_000);
    expect(nextAppProbeDelay(false, 10)).toBe(5_000);
    expect(nextAppProbeDelay(true, 0)).toBe(10_000);
    // Up but the last probe failed: confirm quickly.
    expect(nextAppProbeDelay(true, 1)).toBe(1_000);
  });
});

describe("useLocalAppReachable", () => {
  it("no URL: nothing to probe", () => {
    const probe = scripted([true]);
    const { result } = renderHook(() => useLocalAppReachable(null, probe));
    expect(result.current).toBeNull();
    expect(probe.calls).toBe(0);
  });

  it("waits while the app isn't listening, then reports it up on its own", async () => {
    const probe = scripted([false, true]);
    const { result } = renderHook(() => useLocalAppReachable(APP, probe));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(false));
    await waitFor(() => expect(result.current).toBe(true), { timeout: 3_000 });
  });

  it("a new URL starts over (not the old answer)", async () => {
    const probe = scripted([true]);
    const { result, rerender } = renderHook(
      ({ url }) => useLocalAppReachable(url, probe),
      { initialProps: { url: APP } },
    );
    await waitFor(() => expect(result.current).toBe(true));
    rerender({ url: "http://localhost:3001/" });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(true));
  });
});
