/**
 * Declare Plugin
 *
 * Provides an embedded declare-cc dashboard for project planning.
 * When `.planning/` exists, embeds the declare dashboard in an iframe.
 * Otherwise shows a setup screen to initialize declare-cc.
 *
 * Uses LayoutComponent to manage its own connection resolution
 * (shares the local-dev connection via plugin config).
 */

import type {
  ClientPlugin,
  PluginSetupContext,
} from "@decocms/bindings/plugins";
import { Flag06 } from "@untitledui/icons";
import { lazy } from "react";
import { DECLARE_BINDING } from "./lib/binding";

const DeclareLayout = lazy(() => import("./components/declare-layout"));

/**
 * Declare Plugin Definition
 */
export const declarePlugin: ClientPlugin<typeof DECLARE_BINDING> = {
  id: "declare",
  description: "Plan your project with declarations and milestones",
  binding: DECLARE_BINDING,
  LayoutComponent: DeclareLayout,
  setup: (context: PluginSetupContext) => {
    context.registerRootSidebarItem({
      icon: <Flag06 size={16} />,
      label: "Declare",
    });
  },
};
