/**
 * Dynamic Plugin Layout
 *
 * Routes to the appropriate plugin layout based on the $pluginId param.
 * Uses the plugin's renderHeader/renderEmptyState if defined, otherwise falls back to Outlet.
 */

import { Outlet, useParams } from "@tanstack/react-router";
import { Suspense } from "react";
import { Loading01 } from "@untitledui/icons";
import { sourcePlugins } from "../plugins";
import { PluginLayout } from "./plugin-layout";

export default function DynamicPluginLayout() {
  const { pluginId } = useParams({
    from: "/shell/$org/projects/$virtualMcpId/$pluginId",
  });

  // Find the plugin by ID
  const plugin = sourcePlugins.find((p) => p.id === pluginId);

  // If plugin has render props and a binding, use PluginLayout with those
  if (plugin?.renderHeader && plugin?.renderEmptyState && plugin?.binding) {
    return (
      <Suspense
        fallback={
          <div className="flex flex-col items-center justify-center h-full">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground mb-4"
            />
            <p className="text-sm text-muted-foreground">Loading plugin...</p>
          </div>
        }
      >
        <PluginLayout
          binding={plugin.binding}
          renderHeader={plugin.renderHeader}
          renderEmptyState={plugin.renderEmptyState}
        />
      </Suspense>
    );
  }

  // Fallback: legacy LayoutComponent or just Outlet
  const LayoutComponent = plugin?.LayoutComponent;
  if (!LayoutComponent) {
    return <Outlet />;
  }

  return (
    <Suspense
      fallback={
        <div className="flex flex-col items-center justify-center h-full">
          <Loading01
            size={32}
            className="animate-spin text-muted-foreground mb-4"
          />
          <p className="text-sm text-muted-foreground">Loading plugin...</p>
        </div>
      }
    >
      <LayoutComponent />
    </Suspense>
  );
}
