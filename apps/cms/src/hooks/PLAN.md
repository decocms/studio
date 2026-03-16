# Hooks

## Overview

Custom React hooks for the CMS application. These provide reusable logic for common operations.

## Directory Structure

```
hooks/
├── use-site.ts           # Site context and metadata
├── use-daemon.ts         # Daemon connection and file operations
├── use-blocks.ts         # Block CRUD operations
├── use-schema.ts         # JSON Schema utilities
├── use-preview.ts        # Preview URL generation
├── use-live-editor.ts    # Iframe communication
└── use-presence.ts       # Real-time collaboration
```

## Core Hooks

### use-site.ts

Access site context and metadata.

```tsx
interface SiteContext {
  site: Site;
  env: Environment;
  meta: MetaInfo | null;
  isLoading: boolean;
}

export function useSite(): SiteContext {
  const context = useContext(SiteContext);
  if (!context) {
    throw new Error('useSite must be used within SiteProvider');
  }
  return context;
}

// Get site info from URL params
export function useSiteParams() {
  const { org, site } = useParams<{ org: string; site: string }>();
  const searchParams = useSearchParams();
  const env = searchParams.get('env') || 'staging';
  
  return { org, site, env };
}
```

### use-daemon.ts

Daemon connection for real-time file operations.

```tsx
interface DaemonContext {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  fs: {
    read: (path: string) => Promise<string>;
    write: (path: string, content: string) => Promise<void>;
    delete: (path: string) => Promise<void>;
    list: (prefix?: string) => Promise<string[]>;
    watch: (path: string) => AsyncIterable<FileEvent>;
  };
}

export function useDaemon(): DaemonContext {
  const context = useContext(DaemonContext);
  if (!context) {
    throw new Error('useDaemon must be used within DaemonProvider');
  }
  return context;
}

// Hook for real-time file watching
export function useFileWatch(path: string) {
  const { fs, status } = useDaemon();
  const queryClient = useQueryClient();
  
  useEffect(() => {
    if (status !== 'connected') return;
    
    const abortController = new AbortController();
    
    (async () => {
      for await (const event of fs.watch(path)) {
        // Invalidate queries when file changes
        queryClient.invalidateQueries(['file', path]);
      }
    })();
    
    return () => abortController.abort();
  }, [path, status]);
}
```

### use-blocks.ts

Block CRUD operations with React Query.

```tsx
// List blocks by type
export function useBlocks(type?: BlockType) {
  const { fs } = useDaemon();
  
  return useQuery({
    queryKey: ['blocks', type],
    queryFn: async () => {
      const files = await fs.list('/.deco/blocks/');
      const blocks = await Promise.all(
        files.map(async (path) => {
          const content = await fs.read(path);
          return { id: pathToBlockId(path), ...JSON.parse(content) };
        })
      );
      
      if (type) {
        return blocks.filter(b => getBlockType(b) === type);
      }
      return blocks;
    },
  });
}

// Get single block
export function useBlock(blockId: string) {
  const { fs } = useDaemon();
  
  return useQuery({
    queryKey: ['block', blockId],
    queryFn: async () => {
      const path = blockIdToPath(blockId);
      const content = await fs.read(path);
      return JSON.parse(content);
    },
    enabled: !!blockId,
  });
}

// Save block mutation
export function useSaveBlock() {
  const { fs } = useDaemon();
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Block }) => {
      const path = blockIdToPath(id);
      await fs.write(path, JSON.stringify(data, null, 2));
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries(['blocks']);
      queryClient.invalidateQueries(['block', id]);
    },
  });
}

// Delete block mutation
export function useDeleteBlock() {
  const { fs } = useDaemon();
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: string) => {
      const path = blockIdToPath(id);
      await fs.delete(path);
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['blocks']);
    },
  });
}
```

### use-schema.ts

JSON Schema utilities.

```tsx
// Get schema for a block type
export function useBlockSchema(resolveType: string) {
  const { meta } = useSite();
  
  return useMemo(() => {
    if (!meta?.manifest.blocks || !resolveType) return null;
    
    // Find schema in manifest blocks
    for (const [blockType, blocks] of Object.entries(meta.manifest.blocks)) {
      if (blocks[resolveType]) {
        return {
          ...meta.schema,
          ...blocks[resolveType],
        };
      }
    }
    
    return null;
  }, [meta, resolveType]);
}

// Resolve $ref in schema
export function useResolvedSchema(schema: JSONSchema) {
  const { meta } = useSite();
  
  return useMemo(() => {
    return resolveRefs(schema, meta?.schema || {});
  }, [schema, meta]);
}
```

### use-preview.ts

Preview URL generation.

```tsx
export function usePreviewUrl(block: Block, options?: PreviewOptions) {
  const { site, meta } = useSite();
  
  return useMemo(() => {
    if (!block?.__resolveType || !site) return '';
    
    const { __resolveType, ...props } = block;
    const url = new URL(`${site.url}/live/previews/${__resolveType}`);
    
    url.searchParams.set('path', options?.path || '/');
    url.searchParams.set('props', encodeProps(props));
    url.searchParams.set('deviceHint', options?.viewport || 'desktop');
    url.searchParams.set('__cb', meta?.etag || Date.now().toString());
    
    return url.toString();
  }, [block, site, meta, options]);
}
```

## Porting from admin-cx

The hooks in admin-cx use Preact Signals. Key differences:

| admin-cx (Signals) | admin/cms (React Query) |
|--------------------|-------------------------|
| `useSignal` | `useState` or React Query |
| `useComputed` | `useMemo` |
| `useSignalEffect` | `useEffect` |
| Signal `.value` access | Direct value from hook |

Most business logic can be directly ported, just changing the reactive primitives.

