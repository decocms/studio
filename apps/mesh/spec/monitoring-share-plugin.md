# Monitoring Share Plugin

> **Status**: Planning  
> **Created**: 2026-01-28

## Overview

Extend the plugin system to support root-level public routes, then create a Studio plugin (`mesh-plugin-monitoring-share`) that enables sharing read-only, data-scoped monitoring dashboards with external clients via presigned URLs.

### Key Features
- Presigned URLs with embedded tokens (no login required, time-limited)
- Fixed filters that cannot be removed by viewers (e.g., `client.name=car-company-123`)
- Additive filtering - viewers can narrow scope further but cannot widen it
- Optional expiration with max 90-day duration

---

## Phase 1: Extend Plugin System for Public Routes

Currently, client plugins can only register routes under `/$org/$pluginId` (which requires auth). We need to extend the system to support public routes at the root level, similar to how server plugins have `publicRoutes`.

### Changes to Plugin System

**1. Extend `PluginSetupContext`** in `packages/bindings/src/core/plugins.ts`:

```typescript
export interface PluginSetupContext {
  // Existing
  parentRoute: AnyRoute;  // /$org/$pluginId (authenticated)
  routing: { createRoute, lazyRouteComponent };
  registerRootSidebarItem: (params) => void;
  registerPluginRoutes: (routes: AnyRoute[]) => void;
  
  // NEW: For public routes (no auth required)
  rootRoute: AnyRoute;  // Root route for public pages
  registerPublicRoutes: (routes: AnyRoute[]) => void;
}
```

**2. Update main app** in `apps/mesh/src/web/index.tsx`:

```typescript
// NEW: Collect public routes from plugins
const pluginPublicRoutes: AnyRoute[] = [];

sourcePlugins.forEach((plugin: AnyClientPlugin) => {
  if (!plugin.setup) return;

  const context: PluginSetupContext = {
    // Existing...
    parentRoute: pluginLayoutRoute as AnyRoute,
    
    // NEW: Pass rootRoute and callback for public routes
    rootRoute: rootRoute as AnyRoute,
    registerPublicRoutes: (routes) => {
      pluginPublicRoutes.push(...routes);
    },
  };

  plugin.setup(context);
});

// Add public routes to the route tree
const routeTree = rootRoute.addChildren([
  shellRouteTree,
  loginRoute,
  // ... other routes
  ...pluginPublicRoutes,  // NEW: Plugin public routes
]);
```

**3. Migrate user-sandbox** - After this change, the `connectRoute` in `apps/mesh/src/web/routes/connect.tsx` can be moved into the user-sandbox plugin itself, removing the workaround.

---

## Phase 2: Monitoring Share Plugin

### Package Structure

```
packages/mesh-plugin-monitoring-share/
├── package.json
├── shared.ts                    # Plugin ID, types, constants
├── tsconfig.json
├── server/
│   ├── index.ts                 # ServerPlugin export
│   ├── migrations/
│   │   ├── index.ts
│   │   └── 001-monitoring-shares.ts
│   ├── storage/
│   │   ├── index.ts
│   │   └── monitoring-shares.ts
│   ├── routes/
│   │   └── public.ts            # Public data endpoints
│   └── tools/
│       ├── index.ts
│       ├── create.ts
│       ├── list.ts
│       └── delete.ts
└── client/
    ├── index.ts                 # ClientPlugin export
    ├── pages/
    │   └── shared-dashboard.tsx # Public dashboard page
    └── components/
        ├── share-modal.tsx
        └── share-list.tsx
```

### Database Schema

```sql
CREATE TABLE monitoring_shares (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  name TEXT NOT NULL,                    -- "Car Company Dashboard"
  token TEXT UNIQUE NOT NULL,            -- HMAC-signed token
  
  -- Fixed filters (cannot be removed by viewer)
  fixed_property_filters TEXT,           -- JSON: [{"key": "client.name", "operator": "eq", "value": "car-company-123"}]
  fixed_connection_ids TEXT,             -- JSON array of connection IDs
  fixed_virtual_mcp_ids TEXT,            -- JSON array of virtual MCP IDs
  fixed_tool_name TEXT,
  fixed_status TEXT,                     -- "all" | "success" | "errors"
  
  -- Time range options
  time_range_mode TEXT DEFAULT 'relative', -- "relative" | "fixed"
  relative_from TEXT DEFAULT 'now-24h',    -- For relative mode
  relative_to TEXT DEFAULT 'now',
  
  expires_at TIMESTAMP,                  -- Optional, max 90 days from creation
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (organization_id) REFERENCES organization(id),
  FOREIGN KEY (created_by) REFERENCES user(id)
);
```

### Server Plugin

**MCP Tools**:

| Tool | Description |
|------|-------------|
| `MONITORING_SHARE_CREATE` | Create share with fixed filters, returns URL |
| `MONITORING_SHARE_LIST` | List org's shares |
| `MONITORING_SHARE_DELETE` | Revoke a share |

**Public Routes** (no auth):
- `GET /api/monitoring-share/:token` - Get share config
- `GET /api/monitoring-share/:token/logs` - Fetch filtered logs (merges fixed + viewer filters)

### Client Plugin

**Setup** - Registers public route using the new `registerPublicRoutes`:

```typescript
setup: (ctx) => {
  ctx.registerPublicRoutes([
    ctx.routing.createRoute({
      getParentRoute: () => ctx.rootRoute,
      path: "/share/monitoring/$token",
      component: lazyRouteComponent(() => import("./pages/shared-dashboard.tsx")),
    }),
  ]);
}
```

**Shared Dashboard Page**:
- Minimal layout (no sidebar, no auth required)
- Fetches share config by token
- Shows fixed filters as locked badges
- Allows additive filtering only
- Displays monitoring logs

**Share Modal** - Triggered from monitoring page:
- Name input
- Pre-filled with current filters
- Checkboxes to lock each filter
- Expiration picker (max 90 days)
- Copy URL button

---

## Data Flow

```
┌─────────────┐    Click Share    ┌─────────────────┐
│  Org Admin  │ ───────────────▶  │ Monitoring Page │
└─────────────┘                   └────────┬────────┘
                                           │
                                           ▼
                               ┌───────────────────────┐
                               │ MONITORING_SHARE_CREATE│
                               └───────────┬───────────┘
                                           │
                                           ▼
                                    ┌────────────┐
                                    │  Database  │
                                    └──────┬─────┘
                                           │
                                           ▼
                               ┌───────────────────────┐
                               │   Return Share URL    │
                               └───────────────────────┘
                                           │
                                           ▼
┌─────────────────┐   Visit URL   ┌─────────────────────┐
│ External Viewer │ ────────────▶ │ /share/monitoring/  │
└─────────────────┘               │      :token         │
                                  └──────────┬──────────┘
                                             │
                                             ▼
                               ┌─────────────────────────┐
                               │ GET /api/monitoring-    │
                               │     share/:token        │
                               └───────────┬─────────────┘
                                           │
                                           ▼
                               ┌─────────────────────────┐
                               │ Validate token, return  │
                               │ config + filtered logs  │
                               └─────────────────────────┘
```

---

## Security Model

1. **Token Generation**: HMAC-signed tokens using `ENCRYPTION_KEY`
2. **Expiration**: Server-side enforcement, max 90 days
3. **Org Isolation**: Tokens scoped to organization, cannot access other orgs' data
4. **Fixed Filters**: Applied server-side before any query - cannot be bypassed
5. **Read-only**: No write operations exposed through public endpoints
6. **Additive Only**: Viewer filters can only narrow, never widen scope

---

## Implementation Checklist

### Phase 1: Plugin System
- [ ] Add `rootRoute` and `registerPublicRoutes` to `PluginSetupContext` interface
- [ ] Update `apps/mesh/src/web/index.tsx` to pass rootRoute and collect public routes
- [ ] Move connect route into user-sandbox plugin using new API
- [ ] Remove/deprecate `apps/mesh/src/web/routes/connect.tsx` workaround

### Phase 2: Plugin Package
- [ ] Create package structure for `mesh-plugin-monitoring-share`
- [ ] Define shared types, plugin ID, and constants
- [ ] Create database migration for `monitoring_shares` table
- [ ] Implement `MonitoringSharesStorage` class
- [ ] Create MCP tools (CREATE, LIST, DELETE)
- [ ] Implement public routes for token validation and data fetching
- [ ] Export ServerPlugin with tools, routes, migrations, storage

### Phase 3: Client Plugin
- [ ] Create ClientPlugin with public route registration
- [ ] Build public shared dashboard page with locked filters
- [ ] Create share creation modal component
- [ ] Add Share button to monitoring page header
- [ ] Register client and server plugins in main app

---

## Files to Create/Modify

### Phase 1 (Plugin System)
| File | Change |
|------|--------|
| `packages/bindings/src/core/plugins.ts` | Add `rootRoute` and `registerPublicRoutes` to context |
| `apps/mesh/src/web/index.tsx` | Pass new context props, collect and mount public routes |
| `packages/@decocms/sandbox/client/index.ts` | Migrate connect route registration |
| `apps/mesh/src/web/routes/connect.tsx` | Remove (or keep as fallback) |

### Phase 2 & 3 (Plugin)
| File | Action |
|------|--------|
| `packages/mesh-plugin-monitoring-share/*` | Create entire plugin package |
| `apps/mesh/src/web/plugins.ts` | Register client plugin |
| `apps/mesh/src/api/plugins.ts` | Register server plugin |
| `apps/mesh/src/web/routes/orgs/monitoring.tsx` | Add Share button |
