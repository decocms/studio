# Routes

## Overview

Route components using React Router. Each route maps to a space or specific view in the CMS.

## Route Structure

```
routes/
├── index.tsx             # Router configuration
├── site-layout.tsx       # Layout with providers
├── home.tsx              # Site dashboard
├── pages/
│   ├── index.tsx         # Pages list
│   └── [pageId].tsx      # Page editor
├── sections/
│   ├── index.tsx         # Sections list
│   └── [sectionId].tsx   # Section editor
├── loaders/
│   └── index.tsx         # Loaders list
├── actions/
│   └── index.tsx         # Actions list
├── apps/
│   ├── index.tsx         # Apps list
│   └── [appId].tsx       # App config
├── assets/
│   └── index.tsx         # Asset library
├── releases/
│   └── index.tsx         # Release management
├── analytics/
│   └── index.tsx         # Analytics dashboard
├── logs/
│   └── index.tsx         # Log viewer
└── settings/
    ├── index.tsx         # Settings overview
    ├── domains.tsx       # Domain management
    └── team.tsx          # Team settings
```

## Router Configuration

```tsx
// routes/index.tsx
import { createBrowserRouter, RouteObject } from 'react-router';

const routes: RouteObject[] = [
  {
    path: '/:org/:site',
    element: <SiteLayout />,
    children: [
      { index: true, element: <SiteHome /> },
      
      // Pages
      { path: 'pages', element: <PagesList /> },
      { path: 'pages/new', element: <PagesNew /> },
      { path: 'pages/:pageId', element: <PagesEdit /> },
      
      // Sections
      { path: 'sections', element: <SectionsList /> },
      { path: 'sections/new', element: <SectionsNew /> },
      { path: 'sections/:sectionId', element: <SectionsEdit /> },
      
      // Loaders & Actions
      { path: 'loaders', element: <LoadersList /> },
      { path: 'loaders/:loaderId', element: <LoadersEdit /> },
      { path: 'actions', element: <ActionsList /> },
      { path: 'actions/:actionId', element: <ActionsEdit /> },
      
      // Apps
      { path: 'apps', element: <AppsList /> },
      { path: 'apps/:appId', element: <AppsConfig /> },
      
      // Assets
      { path: 'assets', element: <AssetsList /> },
      
      // Releases
      { path: 'releases', element: <ReleasesList /> },
      { path: 'releases/:releaseId', element: <ReleasesDetail /> },
      
      // Analytics & Logs
      { path: 'analytics', element: <AnalyticsDashboard /> },
      { path: 'logs', element: <LogsViewer /> },
      
      // Settings
      { path: 'settings', element: <SettingsOverview /> },
      { path: 'settings/domains', element: <SettingsDomains /> },
      { path: 'settings/team', element: <SettingsTeam /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
```

## Site Layout

```tsx
// routes/site-layout.tsx
export function SiteLayout() {
  return (
    <CMSProviders>
      <CMSLayout>
        <Suspense fallback={<SpaceLoading />}>
          <Outlet />
        </Suspense>
      </CMSLayout>
    </CMSProviders>
  );
}
```

## Page Route Example

```tsx
// routes/pages/[pageId].tsx
export function PagesEdit() {
  const { pageId } = useParams<{ pageId: string }>();
  const { data: page, isLoading } = usePage(pageId!);
  const { data: schema } = useBlockSchema('website/pages/Page.tsx');
  const savePage = useSaveBlock();
  const navigate = useNavigate();
  
  if (isLoading) {
    return <EditorLoading />;
  }
  
  if (!page) {
    return <NotFound message="Page not found" />;
  }
  
  return (
    <BlockEditor
      blockId={pageId!}
      block={page}
      schema={schema!}
      showPreview
      previewPath={page.path}
      onSave={(data) => savePage.mutate({ id: pageId!, data })}
      onBack={() => navigate('/pages')}
    />
  );
}
```

## URL Patterns

| Pattern | Description | Example |
|---------|-------------|---------|
| `/:org/:site` | Site home | `/deco/storefront` |
| `/:org/:site/pages` | Pages list | `/deco/storefront/pages` |
| `/:org/:site/pages/:pageId` | Edit page | `/deco/storefront/pages/pages-home-abc123` |
| `/:org/:site/sections` | Sections list | `/deco/storefront/sections` |
| `/:org/:site/apps` | Apps list | `/deco/storefront/apps` |

## Query Parameters

- `?env=staging` - Environment selection (default: staging)
- `?viewport=mobile` - Preview viewport (pages/sections)

## Navigation Hooks

```tsx
// Custom hook for CMS navigation
export function useCMSNavigate() {
  const navigate = useNavigate();
  const { org, site } = useParams();
  
  return {
    toHome: () => navigate(`/${org}/${site}`),
    toPages: () => navigate(`/${org}/${site}/pages`),
    toPage: (pageId: string) => navigate(`/${org}/${site}/pages/${pageId}`),
    toSections: () => navigate(`/${org}/${site}/sections`),
    toSection: (sectionId: string) => navigate(`/${org}/${site}/sections/${sectionId}`),
    toApps: () => navigate(`/${org}/${site}/apps`),
    toSettings: () => navigate(`/${org}/${site}/settings`),
  };
}
```

