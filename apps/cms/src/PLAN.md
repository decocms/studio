# apps/cms/src - Source Structure

## Directory Layout

```
src/
├── main.tsx              # App entry point
├── routes/               # Route components
├── components/           # React components
│   ├── shell/           # Layout components
│   ├── spaces/          # Space views (pages, sections, etc.)
│   ├── editor/          # Form and preview
│   └── common/          # Shared components
├── hooks/               # React hooks
├── providers/           # Context providers
├── stores/              # Zustand stores (if needed)
└── utils/               # Utility functions
```

## Entry Point (main.tsx)

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { DecoQueryClientProvider } from "@deco/sdk";
import { router } from "./routes";

import "@deco/ui/styles/global.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DecoQueryClientProvider>
      <RouterProvider router={router} />
    </DecoQueryClientProvider>
  </StrictMode>
);
```

## Routing Structure

The CMS will be accessible at `/:org/:project/cms/*` or as a standalone app.

Routes:
- `/:org/:site` - Site dashboard
- `/:org/:site/pages` - Pages list
- `/:org/:site/pages/:pageId` - Page editor
- `/:org/:site/sections` - Sections list
- `/:org/:site/sections/:sectionId` - Section editor
- `/:org/:site/loaders` - Loaders list
- `/:org/:site/actions` - Actions list
- `/:org/:site/apps` - Apps management
- `/:org/:site/assets` - Asset library
- `/:org/:site/releases` - Release management
- `/:org/:site/analytics` - Analytics dashboard
- `/:org/:site/logs` - Logs viewer
- `/:org/:site/settings` - Site settings

## Key Patterns

### 1. Site Context Provider
All routes under `/:org/:site` will be wrapped with `SiteProvider` that:
- Establishes daemon connection
- Fetches site metadata (`/live/_meta`)
- Provides block access via React Query

### 2. Space Pattern
Each "space" (pages, sections, etc.) follows the same pattern:
- List view with table/grid
- Detail/edit view with form + preview
- Uses shared `BlockEditor` component

### 3. Real-time Updates
The daemon connection provides real-time file system updates:
- File changes trigger query invalidation
- Optimistic updates for better UX
- Conflict resolution for concurrent edits

