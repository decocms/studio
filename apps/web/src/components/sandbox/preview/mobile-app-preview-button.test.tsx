import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@decocms/ui/components/tooltip.tsx";
import type { MobileAppConfig } from "@decocms/shared/mobile-app";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { MobileAppPreviewButton } from "./mobile-app-preview-button";

const POINTER = "delivery.decocms.com/sites/nb/drafts/s1/index.json@e3";

function show(config: MobileAppConfig, draftPointer: string | null = POINTER) {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <MobileAppPreviewButton
          virtualMcpId="p1"
          config={config}
          draftPointer={draftPointer}
          path="/lancamento-983"
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  const body = within(document.body);
  return {
    view,
    trigger: () => body.getByTestId("mobile-app-qr-trigger"),
    open: () => {
      fireEvent.click(body.getByTestId("mobile-app-qr-trigger"));
      return within(body.getByTestId("mobile-app-qr"));
    },
  };
}

beforeEach(() => localStorage.clear());

describe("MobileAppPreviewButton", () => {
  test("highlighted until opened once, per project", () => {
    const first = show({ protocol: "newbalance" });
    expect(
      first.trigger().querySelector("[class*='animate-ping']"),
    ).not.toBeNull();
    first.open();
    expect(localStorage.getItem(LOCALSTORAGE_KEYS.mobileAppQrSeen("p1"))).toBe(
      "true",
    );
    first.view.unmount();

    const again = show({ protocol: "newbalance" });
    expect(again.trigger().querySelector("[class*='animate-ping']")).toBeNull();
    again.view.unmount();
  });

  test("shows the app link to copy and a QR code of the bridge page", () => {
    const { open, view } = show({
      protocol: "newbalance",
      iosInstallUrl: "https://testflight.apple.com/join/B9wsWdMp",
    });
    const panel = open();
    expect(
      panel.getByText(
        "newbalance-dev://account/StudioPreview/s1/%2Flancamento-983",
      ),
    ).toBeTruthy();
    expect(panel.getByText(/Scan with the camera/)).toBeTruthy();
    expect(panel.getByRole("img")).toBeTruthy();
    view.unmount();
  });

  test("without a draft yet, or a protocol, it says so", () => {
    const waiting = show({ protocol: "newbalance" }, null);
    expect(waiting.open().getByText(/QR code shows up/)).toBeTruthy();
    waiting.view.unmount();

    const unset = show({ protocol: "" });
    expect(unset.open().getByText(/Eitri protocol/)).toBeTruthy();
    unset.view.unmount();
  });
});
