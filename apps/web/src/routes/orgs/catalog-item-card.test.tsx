import { setupComponentTest } from "../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { describe, expect, it, mock } from "bun:test";
import { fireEvent, render as renderBare } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CatalogItemCard } from "./catalog-item-card";
import type { RegistryItem } from "@/components/store/types";

// useT() reads its language preference through TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const render = (ui: Parameters<typeof renderBare>[0]) =>
  renderBare(ui, { wrapper });

const item: RegistryItem = {
  id: "provider/app",
  title: "App",
  server: { name: "app" },
};

describe("CatalogItemCard", () => {
  it("is not exposed as a button when the viewer can't connect or navigate", () => {
    const { container } = render(
      <CatalogItemCard
        item={item}
        canManage={false}
        allConnections={[]}
        connectedAppNames={new Set()}
        connectingItemId={null}
        onNavigateConnected={mock()}
        onConnect={mock()}
      />,
    );
    expect(container.querySelector('[role="button"]')).toBeNull();
  });

  it("is clickable to connect when the viewer can manage connections", () => {
    const onConnect = mock();
    const { container } = render(
      <CatalogItemCard
        item={item}
        canManage
        allConnections={[]}
        connectedAppNames={new Set()}
        connectingItemId={null}
        onNavigateConnected={mock()}
        onConnect={onConnect}
      />,
    );
    const card = container.querySelector('[role="button"]');
    expect(card).not.toBeNull();
    fireEvent.keyDown(card as Element, { key: "Enter" });
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});
