import { setupComponentTest } from "../../../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { handleFileDrop } from "./uploader";

function fakeView(posAtCoords: () => { pos: number } | null) {
  return {
    posAtCoords,
    state: { selection: { to: 0 } },
  };
}

function fakeDropEvent(files: File[]): DragEvent {
  const event = new DragEvent("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files },
  });
  return event;
}

describe("handleFileDrop", () => {
  it("does not prevent default when the drop position can't be resolved, so the window fallback can still handle it", () => {
    const view = fakeView(() => null);
    const event = fakeDropEvent([new File(["x"], "x.txt")]);

    const handled = handleFileDrop(view, event, false, () => Promise.resolve());

    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it("prevents default and processes the file when the drop position resolves", async () => {
    const view = fakeView(() => ({ pos: 3 }));
    const event = fakeDropEvent([new File(["x"], "x.txt")]);
    let processedAt: number | undefined;

    const handled = handleFileDrop(view, event, false, (_file, position) => {
      processedAt = position;
      return Promise.resolve();
    });

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(processedAt).toBe(3);
  });
});
