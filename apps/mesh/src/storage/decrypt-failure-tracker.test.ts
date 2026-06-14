import { afterEach, describe, expect, it } from "bun:test";
import { CONNECTION_DECRYPT_DISABLE_THRESHOLD } from "../core/constants";
import {
  isDecryptDisabled,
  markDecryptDisabled,
  recordDecryptFailure,
  recordDecryptSuccess,
  resetAll,
} from "./decrypt-failure-tracker";

describe("decrypt-failure-tracker", () => {
  afterEach(() => resetAll());

  it("crosses the threshold only after N consecutive failures", () => {
    const id = "conn_a";
    for (let i = 1; i < CONNECTION_DECRYPT_DISABLE_THRESHOLD; i++) {
      const r = recordDecryptFailure(id);
      expect(r.consecutiveFailures).toBe(i);
      expect(r.thresholdCrossed).toBe(false);
    }
    const crossing = recordDecryptFailure(id);
    expect(crossing.consecutiveFailures).toBe(
      CONNECTION_DECRYPT_DISABLE_THRESHOLD,
    );
    expect(crossing.thresholdCrossed).toBe(true);
  });

  it("success clears the failure window", () => {
    const id = "conn_b";
    recordDecryptFailure(id);
    recordDecryptFailure(id);
    recordDecryptSuccess(id);
    expect(recordDecryptFailure(id).consecutiveFailures).toBe(1);
  });

  it("marks and reports disabled state without re-enabling on success", () => {
    const id = "conn_c";
    expect(isDecryptDisabled(id)).toBe(false);
    markDecryptDisabled(id);
    expect(isDecryptDisabled(id)).toBe(true);
    // success clears the entry; a disabled connection is re-flagged on the next
    // failure but is never auto-re-enabled by the tracker (non-self-healing).
    recordDecryptSuccess(id);
    expect(isDecryptDisabled(id)).toBe(false);
  });

  it("tracks connections independently", () => {
    recordDecryptFailure("conn_x");
    const y = recordDecryptFailure("conn_y");
    expect(y.consecutiveFailures).toBe(1);
  });
});
