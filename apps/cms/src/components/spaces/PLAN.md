# Space Components

## Overview

Spaces are the main content areas of the CMS, each focused on a specific type of content or functionality.

## Space Pattern

Each space follows a consistent pattern:

```
spaces/{spaceName}/
├── index.tsx           # Main export + routing logic
├── {SpaceName}List.tsx # List/grid view
├── {SpaceName}Edit.tsx # Edit view with form + preview
├── use-{spaceName}.ts  # Space-specific hooks
└── types.ts            # Type definitions
```

## Implementation Priority

### P0 - MVP
1. **Pages** - Core page management
2. **Sections** - Reusable UI blocks

### P1 - Core
3. **Loaders** - Data fetching blocks
4. **Actions** - Server actions
5. **Apps** - App installation
6. **Assets** - Media library

### P2 - Advanced
7. **Releases** - Git versioning
8. **Analytics** - Stats dashboard
9. **Logs** - Server logs
10. **Settings** - Configuration
11. **SEO** - Meta/sitemap
12. **Redirects** - URL redirects
13. **Segments** - Audience targeting
14. **Experiments** - A/B testing

## Detailed Plans

See `PLAN.md` in each space subdirectory:
- `spaces/pages/PLAN.md`
- `spaces/sections/PLAN.md`
- `spaces/apps/PLAN.md`
- etc.

## Shared Space Components

### BlockList.tsx
Generic list component for block-based spaces:

```tsx
interface BlockListProps<T> {
  blocks: T[];
  columns: Column<T>[];
  onSelect: (block: T) => void;
  onCreate?: () => void;
  onDelete?: (block: T) => void;
  emptyState?: React.ReactNode;
}
```

### BlockEdit.tsx
Generic edit layout with form + preview:

```tsx
interface BlockEditProps {
  blockId: string;
  blockType: 'pages' | 'sections' | 'loaders' | 'actions';
}
```

## Data Flow

```
┌─────────────────┐     ┌─────────────────┐
│   SpaceList     │────▶│   SpaceEdit     │
│  (React Query)  │     │  (React Query)  │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │    ┌──────────────────┤
         │    │                  │
         ▼    ▼                  ▼
┌─────────────────┐     ┌─────────────────┐
│   cms-sdk       │     │  JSONSchemaForm │
│  blocks.list()  │     │  + Preview      │
│  blocks.get()   │     │                 │
│  blocks.save()  │     │                 │
└─────────────────┘     └─────────────────┘
```

