# DecoCMS - Content Management System

> Port of admin-cx (admin.deco.cx) to the new React/Vite stack

## Overview

This app provides the **Content Management System** for deco sites, complementing the **Context Management System** (mesh/MCP). It enables visual editing of pages, sections, loaders, actions, and other blocks that power deco-based websites.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      apps/cms                               │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Shell     │  │   Spaces    │  │    Editor           │  │
│  │  (Layout)   │  │  (Views)    │  │  (Form + Preview)   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│                         │                    │              │
│                         ▼                    ▼              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              packages/cms-sdk                       │    │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────────┐  │    │
│  │  │ Daemon  │ │ Blocks  │ │ Schema  │ │  Preview  │  │    │
│  │  │ Client  │ │  CRUD   │ │ Fetcher │ │   URLs    │  │    │
│  │  └─────────┘ └─────────┘ └─────────┘ └───────────┘  │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │    deco site runtime    │
              │  /.deco/blocks/*.json   │
              │      /live/_meta        │
              │    /live/previews/*     │
              └─────────────────────────┘
```

## Key Dependencies

- **@deco/ui** - Shared UI components (buttons, inputs, tables, etc.)
- **@deco/sdk** - Auth, API client, React Query hooks
- **packages/cms-sdk** - NEW: CMS-specific SDK (daemon, blocks, schema)
- **react-router** - Client-side routing
- **react-hook-form** - Form state management
- **ajv** - JSON Schema validation

## Features to Port from admin-cx

### P0 - MVP (Must Have)
- [ ] Pages list and editor
- [ ] Sections list and editor
- [ ] JSON Schema form with core widgets
- [ ] Preview iframe with viewport controls
- [ ] Real-time daemon sync
- [ ] Block CRUD operations

### P1 - Core Features
- [ ] Loaders list and editor
- [ ] Actions list and editor
- [ ] Apps management (install/uninstall)
- [ ] Assets upload and management
- [ ] Releases and git operations
- [ ] Analytics integration (Plausible)
- [ ] Logs viewer (HyperDX)
- [ ] SEO settings
- [ ] Redirects management

### P2 - Advanced Features
- [ ] Themes editor
- [ ] Segments and experiments
- [ ] Blog management
- [ ] Records (Drizzle Studio)

## Implementation Phases

### Phase 1: Foundation (Week 1-2)
1. Create packages/cms-sdk with daemon client
2. Setup apps/cms with basic routing
3. Implement site connection flow

### Phase 2: Core Editor (Week 2-3)
1. Port JSON Schema form system
2. Implement preview iframe
3. Create block editor component

### Phase 3: Spaces (Week 4-6)
1. Pages space
2. Sections space
3. Loaders/Actions spaces
4. Apps space
5. Assets space

### Phase 4: Operations (Week 6-7)
1. Releases and git operations
2. Settings (domains, team)
3. Navigation between mesh and cms

### Phase 5: Analytics & Observability (Week 8)
1. Analytics integration
2. Logs viewer
3. Error monitoring

## File Structure

See individual `PLAN.md` files in each subdirectory for detailed implementation plans.

## Running Locally

```bash
# From repo root
npm run dev:cms

# Or directly
cd apps/cms && npm run dev
```

## Environment Variables

```env
VITE_API_URL=http://localhost:3000
VITE_SITE_DOMAIN=.deco.site
```

