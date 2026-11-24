import { describe, expect, it } from "bun:test";
import { StoreViewSchema, parseToolResult } from "./diagnosis-schema.ts";
import {
  DiagnosisEngineError,
  diagnosisStatusState,
  engineConnectionOf,
  retryEngineRead,
  storeViewEnabled,
  storeViewRefetchInterval,
  unwrapEngineResult,
} from "./diagnosis-state.ts";
import { storeViewFixture } from "./fixtures.ts";

const noRetry = () => {};

describe("diagnosisStatusState", () => {
  it("a failed status read is an error with retry, not unconfigured", () => {
    let retried = 0;
    const state = diagnosisStatusState(
      { data: undefined, error: new Error("network down"), isPending: false },
      () => {
        retried += 1;
      },
    );
    expect(state.state).toBe("error");
    if (state.state !== "error") throw new Error("expected error");
    expect(state.error).toBe("network down");
    state.retry();
    expect(retried).toBe(1);
    expect(engineConnectionOf(state)).toBeNull();
  });

  it("engine queries stay disabled until the status says configured", () => {
    const loading = diagnosisStatusState(
      { data: undefined, error: null, isPending: true },
      noRetry,
    );
    expect(loading).toEqual({ state: "loading" });
    expect(engineConnectionOf(loading)).toBeNull();

    for (const reason of [
      "flag_off",
      "service_unset",
      "not_connected",
    ] as const) {
      const state = diagnosisStatusState(
        {
          data: { configured: false, connection_id: null, reason },
          error: null,
          isPending: false,
        },
        noRetry,
      );
      expect(state).toEqual({ state: "unconfigured", reason });
      expect(engineConnectionOf(state)).toBeNull();
    }

    const configured = diagnosisStatusState(
      {
        data: { configured: true, connection_id: "org_1_plan-diagnosis" },
        error: null,
        isPending: false,
      },
      noRetry,
    );
    expect(configured).toEqual({
      state: "configured",
      connectionId: "org_1_plan-diagnosis",
    });
    expect(engineConnectionOf(configured)).toBe("org_1_plan-diagnosis");
  });

  it("a failed refetch keeps the last good status", () => {
    const state = diagnosisStatusState(
      {
        data: { configured: true, connection_id: "org_1_plan-diagnosis" },
        error: new Error("blip"),
        isPending: false,
      },
      noRetry,
    );
    expect(state.state).toBe("configured");
  });

  it("an unconfigured answer without a reason or a configured one without an id is not connected", () => {
    for (const data of [
      { configured: false, connection_id: null },
      { configured: true, connection_id: null },
    ]) {
      expect(
        diagnosisStatusState({ data, error: null, isPending: false }, noRetry),
      ).toEqual({ state: "unconfigured", reason: "not_connected" });
    }
  });
});

describe("unwrapEngineResult", () => {
  it("returns the value and throws the engine's message otherwise", () => {
    expect(unwrapEngineResult({ ok: true, value: 1 })).toBe(1);
    const refused = parseToolResult(StoreViewSchema, {
      status: "error",
      error: "configure o domínio da loja",
      needs_domain: true,
    });
    try {
      unwrapEngineResult(refused);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DiagnosisEngineError);
      expect((error as DiagnosisEngineError).message).toBe(
        "configure o domínio da loja",
      );
      expect((error as DiagnosisEngineError).needsDomain).toBe(true);
    }
    const notFound = (() => {
      try {
        unwrapEngineResult({ ok: false, error: "oportunidade não encontrada" });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(notFound).toBeInstanceOf(DiagnosisEngineError);
    expect((notFound as DiagnosisEngineError).needsDomain).toBe(false);
  });
});

describe("retryEngineRead", () => {
  it("retries a transport failure once and never an engine answer", () => {
    expect(retryEngineRead(0, new TypeError("fetch failed"))).toBe(true);
    expect(retryEngineRead(1, new TypeError("fetch failed"))).toBe(false);
    expect(retryEngineRead(0, new DiagnosisEngineError("não encontrada"))).toBe(
      false,
    );
  });
});

describe("storeViewEnabled", () => {
  it("reads once the engine is configured and the goals have loaded", () => {
    expect(storeViewEnabled("conn_1", { pending: false })).toBe(true);
  });

  it("stays off while the goals load or without an engine connection", () => {
    expect(storeViewEnabled("conn_1", { pending: true })).toBe(false);
    expect(storeViewEnabled(null, { pending: false })).toBe(false);
  });
});

describe("storeViewRefetchInterval", () => {
  const view = StoreViewSchema.parse(storeViewFixture);

  it("polls every 5s while the last good view is running", () => {
    expect(storeViewRefetchInterval({ ...view, running: true })).toBe(5000);
  });

  it("keeps polling after a failed poll, since the last good view stays", () => {
    // React Query keeps `state.data` from the last success when a poll throws.
    const lastGood = { ...view, running: true };
    expect(storeViewRefetchInterval(lastGood)).toBe(5000);
  });

  it("stops when the view is not running or there is no view", () => {
    expect(storeViewRefetchInterval(view)).toBe(false);
    expect(storeViewRefetchInterval(undefined)).toBe(false);
  });
});
