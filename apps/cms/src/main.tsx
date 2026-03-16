/**
 * Deco CMS - Content Management System
 *
 * Entry point for the CMS application.
 * Provides editing capabilities for deco sites (pages, sections, loaders, actions, etc.)
 */

import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, Outlet } from "react-router";
import { DecoQueryClientProvider } from "@deco/sdk";
import { Spinner } from "@deco/ui/components/spinner.tsx";

// Styles
import "@deco/ui/styles/global.css";
// TODO: Add local styles
// import "./styles.css";

// Lazy load route components
const SiteLayout = React.lazy(() => import("./routes/site-layout.tsx"));
const SiteHome = React.lazy(() => import("./routes/home.tsx"));
const PagesList = React.lazy(() => import("./routes/pages/index.tsx"));
const PagesEdit = React.lazy(() => import("./routes/pages/[pageId].tsx"));
const SectionsList = React.lazy(() => import("./routes/sections/index.tsx"));
const SectionsEdit = React.lazy(
  () => import("./routes/sections/[sectionId].tsx")
);
const LoadersList = React.lazy(() => import("./routes/loaders/index.tsx"));
const ActionsList = React.lazy(() => import("./routes/actions/index.tsx"));
const AppsList = React.lazy(() => import("./routes/apps/index.tsx"));
const AssetsList = React.lazy(() => import("./routes/assets/index.tsx"));
const ReleasesList = React.lazy(() => import("./routes/releases/index.tsx"));
const AnalyticsDashboard = React.lazy(
  () => import("./routes/analytics/index.tsx")
);
const LogsViewer = React.lazy(() => import("./routes/logs/index.tsx"));
const SettingsOverview = React.lazy(
  () => import("./routes/settings/index.tsx")
);

import React from "react";

// Loading fallback
function LoadingFallback() {
  return (
    <div className="h-screen w-screen flex items-center justify-center">
      <Spinner />
    </div>
  );
}

// Error boundary fallback
function ErrorFallback({ error }: { error: Error }) {
  return (
    <div className="h-screen w-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-red-500 mb-4">
          Something went wrong
        </h1>
        <p className="text-muted-foreground mb-4">{error.message}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-primary text-primary-foreground rounded"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

// Router configuration
const router = createBrowserRouter([
  {
    path: "/:org/:site",
    element: (
      <Suspense fallback={<LoadingFallback />}>
        <SiteLayout />
      </Suspense>
    ),
    errorElement: <ErrorFallback error={new Error("Route error")} />,
    children: [
      {
        index: true,
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <SiteHome />
          </Suspense>
        ),
      },
      // Pages
      {
        path: "pages",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <PagesList />
          </Suspense>
        ),
      },
      {
        path: "pages/:pageId",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <PagesEdit />
          </Suspense>
        ),
      },
      // Sections
      {
        path: "sections",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <SectionsList />
          </Suspense>
        ),
      },
      {
        path: "sections/:sectionId",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <SectionsEdit />
          </Suspense>
        ),
      },
      // Loaders
      {
        path: "loaders",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <LoadersList />
          </Suspense>
        ),
      },
      // Actions
      {
        path: "actions",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <ActionsList />
          </Suspense>
        ),
      },
      // Apps
      {
        path: "apps",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <AppsList />
          </Suspense>
        ),
      },
      // Assets
      {
        path: "assets",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <AssetsList />
          </Suspense>
        ),
      },
      // Releases
      {
        path: "releases",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <ReleasesList />
          </Suspense>
        ),
      },
      // Analytics
      {
        path: "analytics",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <AnalyticsDashboard />
          </Suspense>
        ),
      },
      // Logs
      {
        path: "logs",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <LogsViewer />
          </Suspense>
        ),
      },
      // Settings
      {
        path: "settings",
        element: (
          <Suspense fallback={<LoadingFallback />}>
            <SettingsOverview />
          </Suspense>
        ),
      },
    ],
  },
]);

// Render app
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DecoQueryClientProvider>
      <RouterProvider router={router} />
    </DecoQueryClientProvider>
  </StrictMode>
);

