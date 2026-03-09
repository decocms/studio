# Pages Space

## Overview

The Pages space allows users to create, edit, and manage website pages. Pages are composed of sections and define the URL structure of the site.

## Components

### PagesList.tsx

List view showing all pages with their paths and metadata.

**Features:**
- Table view with columns: Name, Path, Sections count, Last updated
- Search/filter by name or path
- Sort by name, path, or date
- Quick actions: Edit, Duplicate, Delete
- Create new page button

**Implementation:**
```tsx
export function PagesList() {
  const { data: pages, isLoading } = usePages();
  const navigate = useNavigate();
  
  const columns = [
    { key: 'name', label: 'Name', sortable: true },
    { key: 'path', label: 'Path', sortable: true },
    { key: 'sectionsCount', label: 'Sections', render: (p) => p.sections?.length || 0 },
    { key: 'updatedAt', label: 'Updated', render: (p) => formatTimeAgo(p.updatedAt) },
  ];
  
  return (
    <SpaceContainer 
      title="Pages"
      actions={<Button onClick={() => navigate('new')}>Create Page</Button>}
    >
      <ResourceTable
        data={pages}
        columns={columns}
        loading={isLoading}
        onRowClick={(page) => navigate(page.id)}
        searchPlaceholder="Search pages..."
      />
    </SpaceContainer>
  );
}
```

### PagesEdit.tsx

Page editor with form on left, preview on right.

**Features:**
- Split view: Form (left) + Preview (right)
- Resizable panels
- Form fields:
  - Name (text input)
  - Path (path input with validation)
  - Sections (array of section selectors)
  - SEO settings (collapsible)
- Preview:
  - Live iframe preview
  - Viewport selector (mobile/tablet/desktop)
  - Addressbar with URL
- Auto-save on change
- Publish button

**Implementation:**
```tsx
export function PagesEdit({ pageId }: { pageId: string }) {
  const { data: page, isLoading } = usePage(pageId);
  const { data: schema } = useBlockSchema('website/pages/Page.tsx');
  const savePage = useSavePage();
  
  if (isLoading) return <Spinner />;
  
  return (
    <BlockEditor
      blockId={pageId}
      block={page}
      schema={schema}
      onSave={(data) => savePage.mutate({ id: pageId, data })}
      showPreview
      previewPath={page?.path}
    />
  );
}
```

## Hooks

### use-pages.ts

```tsx
// List all pages
export function usePages() {
  const { blocks } = useDaemon();
  return useQuery({
    queryKey: ['pages'],
    queryFn: () => blocks.list({ type: 'pages' }),
  });
}

// Get single page
export function usePage(pageId: string) {
  const { blocks } = useDaemon();
  return useQuery({
    queryKey: ['pages', pageId],
    queryFn: () => blocks.get(pageId),
    enabled: !!pageId,
  });
}

// Save page
export function useSavePage() {
  const { blocks } = useDaemon();
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, data }) => blocks.save(id, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries(['pages']);
      queryClient.invalidateQueries(['pages', id]);
    },
  });
}
```

## Page Block Schema

Pages use the `website/pages/Page.tsx` schema:

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "title": "Page Name"
    },
    "path": {
      "type": "string",
      "title": "URL Path",
      "pattern": "^/.*"
    },
    "sections": {
      "type": "array",
      "title": "Sections",
      "items": {
        "$ref": "#/definitions/Section"
      }
    },
    "seo": {
      "$ref": "#/definitions/SEO"
    }
  },
  "required": ["name", "path", "sections"]
}
```

## Porting from admin-cx

Reference files:
- `admin-cx/components/library/Pages.tsx`
- `admin-cx/components/spaces/siteEditor/extensions/CMS/views/List.tsx`
- `admin-cx/components/spaces/siteEditor/extensions/CMS/views/Edit.tsx`

