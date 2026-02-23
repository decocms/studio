/**
 * Preview Plugin
 *
 * Provides a dev server preview iframe in the mesh UI.
 * Auto-detects the dev command/port from package.json and starts
 * the dev server via bash, showing output in an iframe.
 *
 * Uses LayoutComponent to manage its own connection resolution
 * (shares the local-dev connection via plugin config).
 */

import type {
  ClientPlugin,
  PluginSetupContext,
} from "@decocms/bindings/plugins";
import { Monitor01 } from "@untitledui/icons";
import { lazy } from "react";
import { PREVIEW_BINDING } from "./lib/binding";

const PreviewLayout = lazy(() => import("./components/preview-layout"));

/**
 * Preview Plugin Definition
 */
export const previewPlugin: ClientPlugin<typeof PREVIEW_BINDING> = {
  id: "preview",
  description: "Preview your dev server in the browser",
  binding: PREVIEW_BINDING,
  LayoutComponent: PreviewLayout,
  setup: (context: PluginSetupContext) => {
    context.registerSidebarGroup({
      id: "preview",
      label: "Preview",
      items: [
        {
          icon: <Monitor01 size={16} />,
          label: "Dev Server",
        },
      ],
      defaultExpanded: true,
    });
  },
};
