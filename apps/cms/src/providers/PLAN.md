# Providers

## Overview

React context providers that make site and daemon functionality available throughout the app.

## Directory Structure

```
providers/
├── site-provider.tsx     # Site metadata and connection
├── daemon-provider.tsx   # Real-time file system
└── index.tsx             # Combined providers
```

## SiteProvider

Provides site context including metadata, environment, and connection info.

```tsx
// site-provider.tsx
interface SiteContextValue {
  site: {
    name: string;
    url: string;
    domains: string[];
  };
  env: {
    name: string;
    platform: 'deco' | 'tunnel' | 'keda';
    head?: string;
  };
  meta: MetaInfo | null;
  isLoading: boolean;
  error: Error | null;
  refetchMeta: () => void;
}

const SiteContext = createContext<SiteContextValue | null>(null);

export function SiteProvider({ children }: { children: React.ReactNode }) {
  const { org, site, env } = useSiteParams();
  
  // Fetch site info
  const { data: siteInfo, isLoading: siteLoading } = useQuery({
    queryKey: ['site', org, site],
    queryFn: () => api.sites.get({ org, site }),
  });
  
  // Fetch environment
  const { data: envInfo, isLoading: envLoading } = useQuery({
    queryKey: ['env', org, site, env],
    queryFn: () => api.environments.get({ org, site, env }),
    enabled: !!siteInfo,
  });
  
  // Fetch metadata from site
  const { 
    data: meta, 
    isLoading: metaLoading,
    refetch: refetchMeta,
  } = useQuery({
    queryKey: ['meta', envInfo?.url],
    queryFn: async () => {
      const response = await fetch(`${envInfo!.url}/live/_meta`);
      return response.json();
    },
    enabled: !!envInfo?.url,
    refetchInterval: 30000, // Refetch every 30s
  });
  
  const value = useMemo(() => ({
    site: siteInfo,
    env: envInfo,
    meta,
    isLoading: siteLoading || envLoading || metaLoading,
    error: null,
    refetchMeta,
  }), [siteInfo, envInfo, meta, siteLoading, envLoading, metaLoading]);
  
  if (!siteInfo || !envInfo) {
    return <SiteLoadingScreen />;
  }
  
  return (
    <SiteContext.Provider value={value}>
      {children}
    </SiteContext.Provider>
  );
}
```

## DaemonProvider

Manages the daemon WebSocket connection for real-time file operations.

```tsx
// daemon-provider.tsx
interface DaemonContextValue {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  fs: FileSystem;
  reconnect: () => void;
}

const DaemonContext = createContext<DaemonContextValue | null>(null);

export function DaemonProvider({ children }: { children: React.ReactNode }) {
  const { site, env } = useSite();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<DaemonContextValue['status']>('connecting');
  const clientRef = useRef<DaemonClient | null>(null);
  
  // Initialize daemon connection
  useEffect(() => {
    if (!site?.url || !env?.name) return;
    
    const client = new DaemonClient(site.url, env.name);
    clientRef.current = client;
    
    const connect = async () => {
      setStatus('connecting');
      
      try {
        // Start watching
        for await (const event of client.watch()) {
          setStatus('connected');
          
          if (event.type === 'fs-sync') {
            // Invalidate query for changed file
            const blockId = pathToBlockId(event.path);
            if (blockId) {
              queryClient.invalidateQueries(['block', blockId]);
              queryClient.invalidateQueries(['blocks']);
            }
          }
          
          if (event.type === 'meta-info') {
            // Update meta info
            queryClient.setQueryData(['meta', site.url], event.data);
          }
        }
      } catch (error) {
        console.error('Daemon connection error:', error);
        setStatus('error');
        
        // Retry after delay
        setTimeout(connect, 5000);
      }
    };
    
    connect();
    
    return () => {
      client.disconnect();
    };
  }, [site?.url, env?.name]);
  
  const fs = useMemo(() => ({
    read: (path: string) => clientRef.current!.readFile(path),
    write: (path: string, content: string) => clientRef.current!.writeFile(path, content),
    delete: (path: string) => clientRef.current!.deleteFile(path),
    list: (prefix?: string) => clientRef.current!.listFiles(prefix),
  }), []);
  
  const reconnect = useCallback(() => {
    clientRef.current?.reconnect();
  }, []);
  
  return (
    <DaemonContext.Provider value={{ status, fs, reconnect }}>
      {children}
    </DaemonContext.Provider>
  );
}
```

## Combined Provider

Wraps all CMS-specific providers.

```tsx
// index.tsx
export function CMSProviders({ children }: { children: React.ReactNode }) {
  return (
    <SiteProvider>
      <DaemonProvider>
        {children}
      </DaemonProvider>
    </SiteProvider>
  );
}
```

## Usage in Routes

```tsx
// routes/site-layout.tsx
export function SiteLayout() {
  return (
    <CMSProviders>
      <CMSLayout>
        <Outlet />
      </CMSLayout>
    </CMSProviders>
  );
}
```

## Porting from admin-cx

Reference files:
- `admin-cx/components/spaces/siteEditor/sdk.ts` - Main SDK with all providers
- `admin-cx/components/spaces/siteEditor/fs.tsx` - File system utilities
- `admin-cx/components/AdminProvider.tsx` - Auth and site context

The admin-cx SDK creates a complex interconnected system with Signals. For React:
1. Split into separate providers (Site, Daemon)
2. Use React Query for data fetching
3. Use regular React state for connection status
4. Keep the same daemon protocol and API calls

