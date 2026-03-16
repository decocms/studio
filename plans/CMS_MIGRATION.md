# DecoCMS Migration Plan

> Comprehensive plan for porting admin.deco.cx to the new React/Vite stack

## Summary

This document outlines the migration of the Content Management System from the legacy Deno/Fresh stack (admin-cx) to the new React/Vite stack, creating a sibling to the existing Context Management System (mesh).

## What We're Building

**DUAL CMS Architecture:**
1. **Context CMS** (mesh) - Edit MCP connections, tools, AI agents
2. **Content CMS** (NEW) - Edit sites, pages, sections, loaders, actions

Both systems share:
- Authentication (`@deco/sdk` better-auth)
- UI Components (`@deco/ui`)
- Infrastructure (Cloudflare Workers, Supabase)

## Implementation Structure

### New Packages

```
admin/
├── apps/
│   └── cms/                    # NEW: Content CMS web app
│       ├── PLAN.md             # Top-level app plan
│       └── src/
│           ├── components/
│           │   ├── shell/      # Layout components
│           │   ├── spaces/     # Space views (pages, sections, etc.)
│           │   └── editor/     # Form + Preview
│           ├── hooks/
│           ├── providers/
│           └── routes/
│
└── packages/
    └── cms-sdk/                # NEW: CMS-specific SDK
        ├── PLAN.md
        └── src/
            ├── daemon/         # WebSocket daemon client
            ├── blocks/         # Block CRUD utilities
            ├── schema/         # JSON Schema fetching
            └── preview/        # Preview URL generation
```

### Detailed Plans

Each directory contains a `PLAN.md` with:
- Purpose and overview
- Component specifications
- Implementation details
- Code examples
- Reference to admin-cx files for porting

## Feature Mapping

| admin-cx Feature | New Location | Priority |
|-----------------|--------------|----------|
| Pages | `apps/cms/src/components/spaces/pages/` | P0 |
| Sections | `apps/cms/src/components/spaces/sections/` | P0 |
| JSON Schema Form | `apps/cms/src/components/editor/json-schema/` | P0 |
| Preview | `apps/cms/src/components/editor/preview/` | P0 |
| Loaders | `apps/cms/src/components/spaces/loaders/` | P1 |
| Actions | `apps/cms/src/components/spaces/actions/` | P1 |
| Apps | `apps/cms/src/components/spaces/apps/` | P1 |
| Assets | `apps/cms/src/components/spaces/assets/` | P1 |
| Releases | `apps/cms/src/components/spaces/releases/` | P2 |
| Analytics | `apps/cms/src/components/spaces/analytics/` | P2 |
| Settings | `apps/cms/src/components/spaces/settings/` | P2 |

## Technology Stack Comparison

| Aspect | admin-cx (Old) | apps/cms (New) |
|--------|----------------|----------------|
| Runtime | Deno | Node/Bun |
| Framework | Fresh + Preact | Vite + React |
| Routing | Fresh file routes | React Router |
| State | Preact Signals | React Query + useState |
| Forms | RJSF custom | react-hook-form + AJV |
| Styling | Tailwind + DaisyUI | Tailwind + shadcn/ui |
| UI Components | Custom | @deco/ui |

## Implementation Phases

### Phase 1: Foundation (Week 1-2)
- [ ] Create `packages/cms-sdk` with daemon client
- [ ] Setup `apps/cms` with Vite + React Router
- [ ] Implement site connection flow
- [ ] Basic shell layout (sidebar, topbar)

### Phase 2: Core Editor (Week 2-3)
- [ ] Port JSON Schema form system
- [ ] Implement core widgets (string, number, boolean, array, object)
- [ ] Implement preview iframe with viewport controls
- [ ] Bidirectional iframe communication

### Phase 3: Essential Spaces (Week 4-5)
- [ ] Pages space (list + edit)
- [ ] Sections space (list + edit)
- [ ] Block selector widget

### Phase 4: Content Spaces (Week 5-6)
- [ ] Loaders space
- [ ] Actions space
- [ ] Apps space
- [ ] Assets space

### Phase 5: Operations (Week 6-7)
- [ ] Releases (git status, commit, history)
- [ ] Settings (domains, team)
- [ ] Integration with mesh navigation

### Phase 6: Analytics & Polish (Week 8)
- [ ] Analytics (Plausible embed)
- [ ] Logs viewer
- [ ] Error handling and edge cases
- [ ] Performance optimization

## Key Design Decisions

### 1. Separate App vs Integrated
**Decision:** Separate `apps/cms` app
**Rationale:** 
- Clean separation of concerns
- Independent deployment
- Easier testing
- Can be integrated later via module federation

### 2. Daemon vs Deconfig
**Decision:** Keep daemon for now
**Rationale:**
- Full backward compatibility with existing sites
- Deconfig support can be added later
- Sites don't need migration

### 3. Form Library
**Decision:** react-hook-form + AJV
**Rationale:**
- Better React integration than RJSF
- More control over rendering
- Same validation via AJV
- Smaller bundle size

### 4. Shared SDK
**Decision:** Create `@deco/cms-sdk`
**Rationale:**
- Reusable across apps
- Easier testing
- Clear API boundaries
- Version management

## File Index

All `PLAN.md` files in the implementation:

### App Level
- `apps/cms/PLAN.md` - Main app overview

### Source Structure
- `apps/cms/src/PLAN.md` - Source organization

### Components
- `apps/cms/src/components/PLAN.md` - Component overview
- `apps/cms/src/components/shell/PLAN.md` - Shell/layout
- `apps/cms/src/components/editor/PLAN.md` - Editor overview
- `apps/cms/src/components/editor/json-schema/PLAN.md` - Form system
- `apps/cms/src/components/editor/preview/PLAN.md` - Preview system

### Spaces
- `apps/cms/src/components/spaces/PLAN.md` - Spaces overview
- `apps/cms/src/components/spaces/pages/PLAN.md` - Pages
- `apps/cms/src/components/spaces/sections/PLAN.md` - Sections
- `apps/cms/src/components/spaces/loaders/PLAN.md` - Loaders
- `apps/cms/src/components/spaces/actions/PLAN.md` - Actions
- `apps/cms/src/components/spaces/apps/PLAN.md` - Apps
- `apps/cms/src/components/spaces/assets/PLAN.md` - Assets
- `apps/cms/src/components/spaces/releases/PLAN.md` - Releases
- `apps/cms/src/components/spaces/analytics/PLAN.md` - Analytics
- `apps/cms/src/components/spaces/settings/PLAN.md` - Settings

### Hooks & Providers
- `apps/cms/src/hooks/PLAN.md` - Custom hooks
- `apps/cms/src/providers/PLAN.md` - Context providers
- `apps/cms/src/routes/PLAN.md` - Routing

### SDK Package
- `packages/cms-sdk/PLAN.md` - SDK overview

## Success Criteria

- [ ] Feature parity with admin-cx for P0/P1 features
- [ ] Existing sites work without migration
- [ ] < 2s initial load time
- [ ] < 100ms form render time
- [ ] < 500ms preview refresh after edit
- [ ] All JSON Schema widgets ported
- [ ] Real-time daemon sync working
- [ ] Release/git operations functional

## Getting Started

1. Review this document and the linked PLAN.md files
2. Start with `packages/cms-sdk` implementation
3. Setup `apps/cms` with basic routing
4. Implement core editor (form + preview)
5. Build out spaces one by one

## Questions?

Key files in admin-cx to reference:
- `admin-cx/components/spaces/siteEditor/sdk.ts` - Main SDK
- `admin-cx/components/editor/JSONSchema/` - Form system
- `admin-cx/components/spaces/siteEditor/extensions/` - All views
- `admin-cx/loaders/` - Data fetching
- `admin-cx/actions/` - Mutations

