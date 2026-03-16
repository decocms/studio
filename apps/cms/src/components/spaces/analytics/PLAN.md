# Analytics Space

## Overview

The Analytics space provides site analytics data, primarily through embedded Plausible or other analytics providers.

## Analytics Providers

1. **Plausible** (Primary) - Privacy-focused analytics
2. **Cloudflare Analytics** - CDN-level metrics
3. **OneDollarStats** - Budget analytics option
4. **Custom** - HyperDX for logs and traces

## Components

### AnalyticsDashboard.tsx

Main analytics view with provider tabs.

```tsx
export function AnalyticsDashboard() {
  const { site } = useSite();
  const { data: analyticsConfig } = useAnalyticsConfig();
  const [provider, setProvider] = useState<AnalyticsProvider>('plausible');
  
  return (
    <SpaceContainer title="Analytics">
      <Tabs value={provider} onValueChange={setProvider}>
        <TabsList>
          <TabsTrigger value="plausible">Plausible</TabsTrigger>
          <TabsTrigger value="cloudflare">CDN</TabsTrigger>
        </TabsList>
        
        <TabsContent value="plausible" className="mt-4">
          <PlausibleEmbed 
            domain={analyticsConfig?.plausible?.domain || site.name}
          />
        </TabsContent>
        
        <TabsContent value="cloudflare" className="mt-4">
          <CloudflareAnalytics site={site.name} />
        </TabsContent>
      </Tabs>
    </SpaceContainer>
  );
}
```

### PlausibleEmbed.tsx

Embedded Plausible dashboard.

```tsx
interface PlausibleEmbedProps {
  domain: string;
}

export function PlausibleEmbed({ domain }: PlausibleEmbedProps) {
  const [timeRange, setTimeRange] = useState('30d');
  
  // Build embed URL
  const embedUrl = useMemo(() => {
    const url = new URL(`https://plausible.io/share/${domain}`);
    url.searchParams.set('auth', 'embed');
    url.searchParams.set('embed', 'true');
    url.searchParams.set('theme', 'system');
    url.searchParams.set('period', timeRange);
    return url.toString();
  }, [domain, timeRange]);
  
  return (
    <div className="plausible-embed">
      <div className="flex justify-end mb-4">
        <Select value={timeRange} onValueChange={setTimeRange}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="day">Today</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="month">This Month</SelectItem>
            <SelectItem value="6mo">Last 6 months</SelectItem>
            <SelectItem value="12mo">Last 12 months</SelectItem>
          </SelectContent>
        </Select>
      </div>
      
      <iframe
        src={embedUrl}
        className="w-full h-[600px] border-0 rounded-lg"
        loading="lazy"
        title="Analytics"
      />
    </div>
  );
}
```

### CloudflareAnalytics.tsx

Cloudflare CDN analytics with charts.

```tsx
export function CloudflareAnalytics({ site }: { site: string }) {
  const { data: analytics, isLoading } = useCloudflareAnalytics(site);
  
  if (isLoading) return <AnalyticsSkeleton />;
  
  return (
    <div className="grid grid-cols-2 gap-4">
      {/* Requests over time */}
      <Card>
        <CardHeader>
          <CardTitle>Requests</CardTitle>
        </CardHeader>
        <CardContent>
          <LineChart data={analytics?.requests} />
        </CardContent>
      </Card>
      
      {/* Bandwidth */}
      <Card>
        <CardHeader>
          <CardTitle>Bandwidth</CardTitle>
        </CardHeader>
        <CardContent>
          <LineChart data={analytics?.bandwidth} />
        </CardContent>
      </Card>
      
      {/* Cache ratio */}
      <Card>
        <CardHeader>
          <CardTitle>Cache Hit Ratio</CardTitle>
        </CardHeader>
        <CardContent>
          <DonutChart 
            data={[
              { name: 'Cached', value: analytics?.cacheRatio },
              { name: 'Uncached', value: 100 - analytics?.cacheRatio },
            ]} 
          />
        </CardContent>
      </Card>
      
      {/* Response times */}
      <Card>
        <CardHeader>
          <CardTitle>Response Time (p95)</CardTitle>
        </CardHeader>
        <CardContent>
          <LineChart data={analytics?.latencies} />
        </CardContent>
      </Card>
    </div>
  );
}
```

## Hooks

### use-analytics.ts

```tsx
// Get analytics configuration
export function useAnalyticsConfig() {
  const { site } = useSite();
  return useQuery({
    queryKey: ['analytics-config', site.name],
    queryFn: () => api.sites.analytics.getConfig({ site: site.name }),
  });
}

// Get Cloudflare analytics
export function useCloudflareAnalytics(site: string, period = '24h') {
  return useQuery({
    queryKey: ['cloudflare-analytics', site, period],
    queryFn: () => api.cloudflare.analytics({ site, period }),
    refetchInterval: 60000, // Refresh every minute
  });
}

// Get Plausible data (if using API instead of embed)
export function usePlausibleData(domain: string, period = '30d') {
  return useQuery({
    queryKey: ['plausible', domain, period],
    queryFn: () => api.plausible.aggregate({ domain, period }),
  });
}
```

## Porting from admin-cx

Reference files:
- `admin-cx/components/spaces/siteEditor/extensions/Deco/views/Analytics.tsx`
- `admin-cx/components/analytics/AnalyticsFrame.tsx`
- `admin-cx/islands/PlausibleAdminIsland.tsx`
- `admin-cx/loaders/cloudflare/*.ts`
- `admin-cx/loaders/plausible/*.ts`

