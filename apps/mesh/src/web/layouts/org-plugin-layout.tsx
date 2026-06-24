/**
 * Org-level Plugin Layout
 *
 * Mirrors dynamic-plugin-layout.tsx but for org-admin routes (/$org/plugins/$pluginId).
 * Resolves the plugin by $pluginId and renders its LayoutComponent.
 */

import { useParams } from "@tanstack/react-router";
import { Suspense } from "react";
import { Loading01 } from "@untitledui/icons";
import { sourcePlugins } from "../plugins";
import { PluginLayout } from "./plugin-layout";

export default function OrgPluginLayout() {
  const { pluginId } = useParams({
    from: "/shell/$org/plugins/$pluginId",
  });

  const plugin = sourcePlugins.find((p) => p.id === pluginId);

  if (plugin?.renderHeader && plugin?.renderEmptyState && plugin?.bindingName) {
    return (
      <Suspense
        fallback={
          <div className="flex flex-col items-center justify-center h-full w-full">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground mb-4"
            />
            <p className="text-sm text-muted-foreground">Loading plugin...</p>
          </div>
        }
      >
        <PluginLayout
          bindingName={plugin.bindingName}
          renderHeader={plugin.renderHeader}
          renderEmptyState={plugin.renderEmptyState}
        />
      </Suspense>
    );
  }

  const LayoutComponent = plugin?.LayoutComponent;
  if (!LayoutComponent) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">
          Plugin "{pluginId}" not found
        </p>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="flex flex-col items-center justify-center h-full w-full">
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
