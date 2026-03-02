/**
 * Collection Reorder Ranking Plugin
 *
 * Provides a UI for viewing and applying collection reorder ranking reports.
 * Uses FARMRIO_REORDER_BINDING which matches the farmrio-db-reorder MCP schema.
 */

import { FARMRIO_REORDER_BINDING } from "@decocms/bindings";
import type {
  ClientPlugin,
  PluginSetupContext,
} from "@decocms/bindings/plugins";
import { BarChart01 } from "@untitledui/icons";
import { lazy } from "react";

const RankingLayout = lazy(() => import("./components/ranking-layout"));

/**
 * Collection Reorder Ranking Plugin Definition
 */
export const collectionReorderRankingPlugin: ClientPlugin<
  typeof FARMRIO_REORDER_BINDING
> = {
  id: "collection-reorder-ranking",
  description: "View collection reorder ranking reports",
  binding: FARMRIO_REORDER_BINDING,
  LayoutComponent: RankingLayout,
  setup: (context: PluginSetupContext) => {
    context.registerSidebarGroup({
      id: "commerce",
      label: "Commerce",
      items: [
        {
          icon: <BarChart01 size={16} />,
          label: "Collection Ranking",
        },
      ],
    });
  },
};
