import { setupComponentTest } from "../../../../../test/setup";

setupComponentTest();

import { describe, expect, it } from "bun:test";
import { fireEvent, waitFor } from "@testing-library/react";
import { createTabCloseFocusHandoff } from "./tab-close-focus-handoff";

function focusFixture() {
  const tablist = document.createElement("div");
  tablist.setAttribute("role", "tablist");
  const source = document.createElement("button");
  const target = document.createElement("button");
  tablist.append(source, target);
  document.body.append(tablist);
  source.focus();
  return { source, tablist, target };
}

function nextChildMutation(root: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(root, { childList: true, subtree: true });
  });
}

describe("createTabCloseFocusHandoff", () => {
  it("waits for the source removal commit before restoring focus", async () => {
    const { source, target } = focusFixture();
    let finishCount = 0;
    const handoff = createTabCloseFocusHandoff(source, {
      onFinish: () => finishCount++,
    });

    handoff.focusAfterSourceRemoval(() => {
      target.focus();
      return document.activeElement === target;
    });

    expect(document.activeElement).toBe(source);
    source.remove();
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(finishCount).toBe(1);
    handoff.cancel();
    fireEvent.keyDown(target, { key: "Tab" });
    expect(finishCount).toBe(1);
  });

  it("lets later pointer and keyboard navigation cancel the handoff", async () => {
    for (const intent of ["pointer", "keyboard"] as const) {
      const { source, tablist, target } = focusFixture();
      let focusAttempts = 0;
      let finishCount = 0;
      const handoff = createTabCloseFocusHandoff(source, {
        onFinish: () => finishCount++,
      });
      handoff.focusAfterSourceRemoval(() => {
        focusAttempts++;
        target.focus();
        return true;
      });

      if (intent === "pointer") fireEvent.pointerDown(target);
      else fireEvent.keyDown(source, { key: "Tab" });
      const mutationDelivered = nextChildMutation(tablist);
      source.remove();
      await mutationDelivered;

      expect(focusAttempts).toBe(0);
      expect(finishCount).toBe(1);
      handoff.cancel();
      fireEvent.keyDown(target, { key: "Tab" });
      expect(finishCount).toBe(1);
      tablist.remove();
    }
  });

  it("does not treat a rejected repeat close activation as new focus intent", async () => {
    const { source, target } = focusFixture();
    const handoff = createTabCloseFocusHandoff(source);
    handoff.focusAfterSourceRemoval(() => {
      target.focus();
      return document.activeElement === target;
    });

    fireEvent.keyDown(source, { key: "Enter" });
    source.remove();
    await waitFor(() => expect(document.activeElement).toBe(target));
  });

  it("preserves a programmatic focus move made before the removal commit", async () => {
    const { source, tablist, target } = focusFixture();
    const handoffTarget = document.createElement("button");
    document.body.append(handoffTarget);
    let focusAttempts = 0;
    let finishCount = 0;
    const handoff = createTabCloseFocusHandoff(source, {
      onFinish: () => finishCount++,
    });
    handoff.focusAfterSourceRemoval(() => {
      focusAttempts++;
      handoffTarget.focus();
      return true;
    });

    target.focus();
    const mutationDelivered = nextChildMutation(tablist);
    source.remove();
    await mutationDelivered;

    expect(document.activeElement).toBe(target);
    expect(focusAttempts).toBe(0);
    expect(finishCount).toBe(1);
  });

  it("allows repeated pointer activation from a close button descendant", async () => {
    const { source, target } = focusFixture();
    const icon = document.createElement("span");
    source.append(icon);
    const handoff = createTabCloseFocusHandoff(source);
    handoff.focusAfterSourceRemoval(() => {
      target.focus();
      return document.activeElement === target;
    });

    fireEvent.pointerDown(icon);
    source.remove();
    await waitFor(() => expect(document.activeElement).toBe(target));
  });
});
