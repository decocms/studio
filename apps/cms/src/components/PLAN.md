# Components Structure

## Overview

Components are organized by function:

```
components/
├── shell/          # App shell and navigation
├── spaces/         # Main content areas (pages, sections, etc.)
├── editor/         # Block editing (form + preview)
└── common/         # Shared/reusable components
```

## Component Guidelines

### 1. Use @deco/ui Components
Always prefer `@deco/ui` components over creating new ones:
- `Button`, `Input`, `Select` from `@deco/ui/components`
- `ResourceTable` for data lists
- `Dialog`, `Sheet` for modals
- `Tabs`, `Accordion` for organization

### 2. Colocation
Keep related files together:
```
components/spaces/pages/
├── index.tsx           # Main export
├── PagesList.tsx       # List component
├── PageEditor.tsx      # Editor component
├── use-pages.ts        # Page-specific hooks
└── types.ts            # Type definitions
```

### 3. Props Pattern
Use explicit prop interfaces:
```tsx
interface PageEditorProps {
  pageId: string;
  onSave?: (page: Page) => void;
  onCancel?: () => void;
}

export function PageEditor({ pageId, onSave, onCancel }: PageEditorProps) {
  // ...
}
```

## Key Components to Implement

### Shell Components
- `CMSLayout` - Main app shell with sidebar + topbar
- `Sidebar` - Navigation between spaces
- `Topbar` - Breadcrumbs, site selector, user menu
- `SpaceContainer` - Container for space content

### Space Components
- `PagesSpace` - Pages list and management
- `SectionsSpace` - Sections list and management
- `LoadersSpace` - Loaders list
- `ActionsSpace` - Actions list
- `AppsSpace` - App installation
- `AssetsSpace` - Asset library
- `ReleasesSpace` - Git releases
- `SettingsSpace` - Site configuration

### Editor Components
- `BlockEditor` - Combined form + preview layout
- `JSONSchemaForm` - Form rendered from JSON Schema
- `Preview` - iframe preview with controls
- `Addressbar` - URL input with viewport switcher

### Common Components
- `BlockCard` - Card displaying block info
- `BlockSelector` - Modal for selecting blocks
- `AssetPicker` - Modal for selecting/uploading assets
- `ColorPicker` - Color input with picker
- `CodeEditor` - Monaco-based code editor

