# Shell Components

## Overview

The shell provides the main application layout, including navigation, topbar, and content areas.

## Components

### CMSLayout.tsx

Main layout component that wraps all CMS routes.

```tsx
interface CMSLayoutProps {
  children: React.ReactNode;
}

export function CMSLayout({ children }: CMSLayoutProps) {
  return (
    <SiteProvider>
      <div className="cms-layout flex h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col">
          <Topbar />
          <main className="flex-1 overflow-auto">
            {children}
          </main>
        </div>
      </div>
    </SiteProvider>
  );
}
```

### Sidebar.tsx

Navigation sidebar with space links.

**Features:**
- Collapsible sections (Content, Advanced, Management)
- Active state indication
- Badge for counts/notifications
- Pin/unpin functionality

**Navigation Items:**
```typescript
const navItems = [
  // Content
  { id: 'pages', label: 'Pages', icon: 'file', href: '/pages' },
  { id: 'sections', label: 'Sections', icon: 'component', href: '/sections' },
  { id: 'assets', label: 'Assets', icon: 'image', href: '/assets' },
  { id: 'releases', label: 'Releases', icon: 'rocket', href: '/releases' },
  
  // Advanced
  { id: 'loaders', label: 'Loaders', icon: 'database', href: '/loaders' },
  { id: 'actions', label: 'Actions', icon: 'zap', href: '/actions' },
  { id: 'apps', label: 'Apps', icon: 'grid', href: '/apps' },
  { id: 'seo', label: 'SEO', icon: 'search', href: '/seo' },
  { id: 'redirects', label: 'Redirects', icon: 'corner-up-right', href: '/redirects' },
  
  // Management
  { id: 'analytics', label: 'Analytics', icon: 'bar-chart', href: '/analytics' },
  { id: 'logs', label: 'Logs', icon: 'terminal', href: '/logs' },
  { id: 'settings', label: 'Settings', icon: 'settings', href: '/settings' },
];
```

### Topbar.tsx

Top navigation bar with context information.

**Features:**
- Breadcrumb navigation (Org > Site > Space > Item)
- Site/env selector dropdown
- Connection status indicator
- User menu (profile, logout)
- Quick actions (publish, preview)

```tsx
export function Topbar() {
  const { site, env } = useSite();
  const { status } = useDaemon();
  
  return (
    <header className="topbar h-12 border-b flex items-center px-4 gap-4">
      <Breadcrumb />
      <div className="flex-1" />
      <ConnectionStatus status={status} />
      <EnvSelector currentEnv={env} />
      <UserMenu />
    </header>
  );
}
```

### SpaceContainer.tsx

Container for space content with consistent padding and scroll behavior.

```tsx
interface SpaceContainerProps {
  title?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function SpaceContainer({ title, actions, children }: SpaceContainerProps) {
  return (
    <div className="space-container p-6">
      {(title || actions) && (
        <div className="flex items-center justify-between mb-6">
          {title && <h1 className="text-2xl font-semibold">{title}</h1>}
          {actions && <div className="flex gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
```

## Porting from admin-cx

Reference files:
- `admin-cx/components/spaces/shell/Index.tsx`
- `admin-cx/components/spaces/shell/SideNav.tsx`
- `admin-cx/components/spaces/siteEditor/Index.tsx`

Key differences:
1. React instead of Preact (hooks are similar)
2. `@deco/ui` components instead of custom UI
3. React Router instead of Fresh routes
4. React Query instead of Preact Signals for state

