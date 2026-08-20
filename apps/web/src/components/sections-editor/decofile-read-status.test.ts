import { describe, expect, it } from "bun:test";
import {
  classifyCommittedReadStatus,
  decofileErrorStatus,
} from "./decofile-read-status";

describe("classifyCommittedReadStatus", () => {
  it("reads a daemon 400 as proof the file is absent", () => {
    expect(classifyCommittedReadStatus(400)).toBe("absent");
  });

  it("reads a 404 as an unprovisioned sandbox, not an absent file", () => {
    expect(classifyCommittedReadStatus(404)).toBe("unavailable");
  });

  it("passes 2xx through and surfaces the rest as errors", () => {
    expect(classifyCommittedReadStatus(200)).toBe("ok");
    expect(classifyCommittedReadStatus(204)).toBe("ok");
    expect(classifyCommittedReadStatus(500)).toBe("error");
    expect(classifyCommittedReadStatus(502)).toBe("error");
  });
});

describe("decofileErrorStatus", () => {
  it("tags 404 when the dev server answered a non-decofile 200", () => {
    expect(decofileErrorStatus({ liveOk: true, committedAbsent: false })).toBe(
      404,
    );
  });

  it("tags 404 when the checkout has no decofile artifacts — dev server down", () => {
    expect(decofileErrorStatus({ liveOk: false, committedAbsent: true })).toBe(
      404,
    );
    expect(
      decofileErrorStatus({
        liveOk: false,
        liveStatus: 502,
        committedAbsent: true,
      }),
    ).toBe(404);
  });

  it("keeps a transient failure transient when absence is unproven", () => {
    expect(
      decofileErrorStatus({
        liveOk: false,
        liveStatus: 503,
        committedAbsent: false,
      }),
    ).toBe(503);
    expect(decofileErrorStatus({ liveOk: false, committedAbsent: false })).toBe(
      502,
    );
  });

  it("passes a real dev-server 404 through unchanged", () => {
    expect(
      decofileErrorStatus({
        liveOk: false,
        liveStatus: 404,
        committedAbsent: false,
      }),
    ).toBe(404);
  });
});
