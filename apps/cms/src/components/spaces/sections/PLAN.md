# Sections Space

## Overview

The Sections space allows users to create and manage reusable UI sections. Sections are the building blocks of pages and can be shared across multiple pages.

## Types of Sections

1. **Saved Sections** - Custom instances stored in `/.deco/blocks/`
2. **Template Sections** - Available section types from the manifest (e.g., `website/sections/Hero.tsx`)

## Components

### SectionsList.tsx

Grid/list view showing all saved sections.

**Features:**
- Grid view with preview thumbnails
- Filter by section type
- Search by name
- Quick actions: Edit, Duplicate, Delete
- Create new section (from template)

**Implementation:**
```tsx
export function SectionsList() {
  const { data: sections, isLoading } = useSections();
  const { data: templates } = useSectionTemplates();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  
  return (
    <SpaceContainer 
      title="Sections"
      actions={
        <>
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
          <CreateSectionButton templates={templates} />
        </>
      }
    >
      {viewMode === 'grid' ? (
        <SectionsGrid sections={sections} loading={isLoading} />
      ) : (
        <SectionsTable sections={sections} loading={isLoading} />
      )}
    </SpaceContainer>
  );
}
```

### SectionsEdit.tsx

Section editor with form + preview.

**Features:**
- Same split view as pages
- Preview shows section in isolation
- Section-specific fields based on schema
- "Used in" indicator showing which pages use this section

```tsx
export function SectionsEdit({ sectionId }: { sectionId: string }) {
  const { data: section } = useSection(sectionId);
  const { data: schema } = useBlockSchema(section?.__resolveType);
  const { data: usedIn } = useSectionUsage(sectionId);
  
  return (
    <div className="sections-edit">
      <BlockEditor
        blockId={sectionId}
        block={section}
        schema={schema}
        showPreview
      />
      {usedIn?.length > 0 && (
        <UsedInBadge pages={usedIn} />
      )}
    </div>
  );
}
```

### CreateSectionDialog.tsx

Modal for creating new sections from templates.

**Features:**
- Template selector with categories
- Preview of selected template
- Name input
- Initial configuration (optional)

## Section Preview

Sections are previewed by wrapping them in a minimal page:

```typescript
function getSectionPreviewUrl(site: string, section: Block) {
  const pageWrapper = {
    path: '/',
    sections: [section],
    __resolveType: 'website/pages/Page.tsx',
  };
  
  const url = new URL(`${site}/live/previews/website/pages/Page.tsx`);
  url.searchParams.set('props', encodeProps(pageWrapper));
  return url.toString();
}
```

## Hooks

### use-sections.ts

```tsx
// List all saved sections
export function useSections() {
  const { blocks } = useDaemon();
  return useQuery({
    queryKey: ['sections'],
    queryFn: () => blocks.list({ type: 'sections' }),
  });
}

// Get available section templates from manifest
export function useSectionTemplates() {
  const { meta } = useSite();
  return useQuery({
    queryKey: ['section-templates'],
    queryFn: () => {
      const sections = meta?.manifest.blocks.sections || {};
      return Object.keys(sections).map(resolveType => ({
        resolveType,
        schema: sections[resolveType],
      }));
    },
    enabled: !!meta,
  });
}

// Find pages that use a section
export function useSectionUsage(sectionId: string) {
  const { data: pages } = usePages();
  return useMemo(() => {
    return pages?.filter(page => 
      page.sections?.some(s => s.__resolveType === sectionId)
    );
  }, [pages, sectionId]);
}
```

## Porting from admin-cx

Reference files:
- `admin-cx/components/library/BlockSelector.tsx`
- `admin-cx/components/spaces/siteEditor/extensions/CMS/views/List.tsx`
- `admin-cx/components/editor/JSONSchema/widgets/SelectBlock/SelectSectionBlock.tsx`

