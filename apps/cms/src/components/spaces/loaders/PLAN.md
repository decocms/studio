# Loaders Space

## Overview

The Loaders space manages data loaders - server-side functions that fetch and transform data for use in sections and pages.

## What are Loaders?

Loaders are TypeScript functions that:
- Run on the server at request time
- Fetch data from APIs, databases, or other sources
- Transform and return data for use in UI components
- Can be cached and have dependencies

## Components

### LoadersList.tsx

List view showing all saved loader instances.

```tsx
export function LoadersList() {
  const { data: loaders, isLoading } = useLoaders();
  const { data: templates } = useLoaderTemplates();
  
  return (
    <SpaceContainer 
      title="Loaders"
      actions={<CreateLoaderButton templates={templates} />}
    >
      <ResourceTable
        data={loaders}
        loading={isLoading}
        columns={[
          { key: 'id', label: 'Name', sortable: true },
          { key: '__resolveType', label: 'Type', render: (l) => formatLoaderType(l.__resolveType) },
          { key: 'usedIn', label: 'Used In', render: (l) => <UsageCount blockId={l.id} /> },
          { key: 'updatedAt', label: 'Updated', render: (l) => formatTimeAgo(l.updatedAt) },
        ]}
        onRowClick={(loader) => navigate(loader.id)}
        searchPlaceholder="Search loaders..."
      />
    </SpaceContainer>
  );
}
```

### LoadersEdit.tsx

Loader configuration editor.

```tsx
export function LoadersEdit({ loaderId }: { loaderId: string }) {
  const { data: loader } = useLoader(loaderId);
  const { data: schema } = useBlockSchema(loader?.__resolveType);
  const saveLoader = useSaveBlock();
  
  // Loaders typically don't have visual preview
  // Instead, show test/invoke panel
  return (
    <div className="loaders-edit grid grid-cols-2 gap-4">
      {/* Form */}
      <div className="border rounded-lg overflow-auto">
        <div className="p-4 border-b">
          <h2 className="font-semibold">Configuration</h2>
        </div>
        <JSONSchemaForm
          schema={schema}
          formData={loader}
          onChange={(data) => saveLoader.mutate({ id: loaderId, data })}
          className="p-4"
        />
      </div>
      
      {/* Test Panel */}
      <div className="border rounded-lg overflow-auto">
        <div className="p-4 border-b">
          <h2 className="font-semibold">Test Loader</h2>
        </div>
        <LoaderTestPanel loaderId={loaderId} loader={loader} />
      </div>
    </div>
  );
}
```

### LoaderTestPanel.tsx

Panel for testing/invoking a loader.

```tsx
interface LoaderTestPanelProps {
  loaderId: string;
  loader: Block;
}

export function LoaderTestPanel({ loaderId, loader }: LoaderTestPanelProps) {
  const { site } = useSite();
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  const testLoader = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`${site.url}/live/invoke/${loader.__resolveType}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loader),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      setResult(data);
    } catch (err) {
      setError(err as Error);
    } finally {
      setIsLoading(false);
    }
  };
  
  return (
    <div className="p-4 space-y-4">
      <Button onClick={testLoader} disabled={isLoading}>
        {isLoading ? <Spinner className="mr-2" /> : <Play className="h-4 w-4 mr-2" />}
        Test Loader
      </Button>
      
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      
      {result && (
        <div className="border rounded p-4 bg-muted">
          <div className="text-sm font-medium mb-2">Result:</div>
          <pre className="text-xs overflow-auto max-h-96">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
```

## Hooks

### use-loaders.ts

```tsx
// List all saved loaders
export function useLoaders() {
  const { blocks } = useDaemon();
  return useQuery({
    queryKey: ['loaders'],
    queryFn: () => blocks.list({ type: 'loaders' }),
  });
}

// Get loader templates from manifest
export function useLoaderTemplates() {
  const { meta } = useSite();
  return useMemo(() => {
    const loaders = meta?.manifest.blocks.loaders || {};
    return Object.keys(loaders)
      .filter(key => !key.startsWith('deco-sites')) // Filter site-specific
      .map(resolveType => ({
        resolveType,
        name: resolveType.split('/').pop()?.replace('.ts', ''),
        schema: loaders[resolveType],
      }));
  }, [meta]);
}

// Invoke loader for testing
export function useInvokeLoader() {
  const { site } = useSite();
  
  return useMutation({
    mutationFn: async ({ resolveType, props }: { resolveType: string; props: unknown }) => {
      const response = await fetch(`${site.url}/live/invoke/${resolveType}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(props),
      });
      return response.json();
    },
  });
}
```

## Common Loader Types

From apps in decohub:
- `website/loaders/image.ts` - Image optimization
- `vtex/loaders/product/productList.ts` - VTEX product lists
- `vtex/loaders/cart.ts` - Shopping cart
- `shopify/loaders/ProductList.ts` - Shopify products
- `blog/loaders/posts.ts` - Blog posts

## Porting from admin-cx

Reference files:
- `admin-cx/components/spaces/siteEditor/extensions/CMS/views/List.tsx`
- `admin-cx/components/library/BlockSelector.tsx`

