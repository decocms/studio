/**
 * Org Layout
 *
 * Wraps all org-level routes. The shell-level ProjectContextProvider
 * already provides the complete org context (including enabledPlugins).
 */

import { Outlet } from "@tanstack/react-router";

export default function OrgLayout() {
  return <Outlet />;
}
