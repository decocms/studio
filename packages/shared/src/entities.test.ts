import { describe, expect, it } from "bun:test";
import { canWriteToThread } from "./entities.ts";

const GUI = "user_gui";
const ANA = "user_ana";

describe("canWriteToThread", () => {
  it("lets the owner write to their own chat", () => {
    expect(canWriteToThread({ created_by: GUI, userId: GUI })).toBe(true);
  });

  it("keeps a teammate's personal chat read-only", () => {
    expect(canWriteToThread({ created_by: GUI, userId: ANA })).toBe(false);
    expect(
      canWriteToThread({ created_by: GUI, metadata: {}, userId: ANA }),
    ).toBe(false);
    expect(
      canWriteToThread({
        created_by: GUI,
        metadata: { shared: false },
        userId: ANA,
      }),
    ).toBe(false);
  });

  it("lets any member post in a shared room", () => {
    expect(
      canWriteToThread({
        created_by: GUI,
        metadata: { shared: true },
        userId: ANA,
      }),
    ).toBe(true);
  });

  it("denies a write when the actor is unknown", () => {
    expect(
      canWriteToThread({
        created_by: GUI,
        metadata: { shared: true },
        userId: null,
      }),
    ).toBe(false);
    expect(canWriteToThread({ created_by: GUI, userId: undefined })).toBe(
      false,
    );
  });

  it("stays writable when the owner is unknown (legacy/optimistic rows)", () => {
    expect(canWriteToThread({ created_by: null, userId: ANA })).toBe(true);
    expect(canWriteToThread({ userId: ANA })).toBe(true);
  });

  it("ignores a non-boolean `shared` rather than trusting it", () => {
    expect(
      canWriteToThread({
        created_by: GUI,
        metadata: { shared: "yes" as unknown as boolean },
        userId: ANA,
      }),
    ).toBe(false);
  });
});
