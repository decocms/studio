import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { initPwaInstallCapture, usePwaInstall } from "./pwa-install";

function dispatchBeforeInstallPrompt(outcome: "accepted" | "dismissed") {
  const event = Object.assign(
    new Event("beforeinstallprompt", { cancelable: true }),
    {
      prompt: async () => {},
      userChoice: Promise.resolve({ outcome, platform: "web" }),
    },
  );
  window.dispatchEvent(event);
}

describe("usePwaInstall", () => {
  it("drops a dismissed prompt so a second click doesn't silently no-op", async () => {
    initPwaInstallCapture();
    const { result } = renderHook(() => usePwaInstall());

    await act(async () => {
      dispatchBeforeInstallPrompt("dismissed");
    });
    expect(result.current.canPrompt).toBe(true);

    await act(async () => {
      const outcome = await result.current.promptInstall();
      expect(outcome).toBe("dismissed");
    });

    expect(result.current.canPrompt).toBe(false);
  });
});
