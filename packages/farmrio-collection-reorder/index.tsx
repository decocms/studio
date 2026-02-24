/**
 * Collection Reorder Ranking Plugin
 *
 * Provides a UI for viewing collection reorder ranking reports.
 * Uses the same REPORTS_BINDING as the reports plugin — shows all reports
 * with a specialized layout for ranking visualization.
 */

import { REPORTS_BINDING } from "@decocms/bindings";
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
  typeof REPORTS_BINDING
> = {
  id: "collection-reorder-ranking",
  description: "View collection reorder ranking reports",
  binding: REPORTS_BINDING,
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
