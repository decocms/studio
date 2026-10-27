import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();

import { describe, expect, mock, test } from "bun:test";
import { render as rtlRender } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";

const { AppInstallPanel } = await import("./app-install-panel");
const { en } = await import("@/i18n/en/index.ts");

const queryClient = new QueryClient();
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper });

const entry = {
  id: "deco-blog",
  app: "blog",
  vendor: "deco",
  title: "Blog",
  description: "Posts and categories",
  category: "Content",
  resolveType: "site/apps/deco/blog.ts",
  blockKey: null,
  installed: false,
  installable: true,
};

const panel = (overrides?: {
  installable?: boolean;
  canInstall?: boolean;
  onInstall?: () => void;
}) =>
  render(
    <AppInstallPanel
      entry={{ ...entry, installable: overrides?.installable ?? true }}
      technology="deno"
      canInstall={overrides?.canInstall ?? true}
      isInstalling={false}
      installError={null}
      onInstall={overrides?.onInstall ?? (() => {})}
    />,
  );

describe("AppInstallPanel", () => {
  test("installs on the button, and only on it", () => {
    const onInstall = mock(() => {});
    const { getByRole } = panel({ onInstall });

    // Opening the panel is not installing: the row that used to BE the
    // install button now only brings the user here.
    expect(onInstall).not.toHaveBeenCalled();

    getByRole("button", {
      name: en["sandbox.appInstallPanel.install"],
    }).click();
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  test("says why instead of offering a button it cannot honour", () => {
    const { getByText, queryByRole } = panel({ canInstall: false });

    expect(getByText(en["sandbox.appInstallPanel.unavailable"])).toBeTruthy();
    expect(
      queryByRole("button", { name: en["sandbox.appInstallPanel.install"] }),
    ).toBeNull();
  });

  test("an app the site already carries has nothing to install", () => {
    const { getByText } = panel({ installable: false });

    expect(
      getByText(en["sandbox.appInstallPanel.notInstallable"]),
    ).toBeTruthy();
  });
});
