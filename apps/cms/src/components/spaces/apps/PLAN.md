# Apps Space

## Overview

The Apps space allows users to install, configure, and manage deco apps. Apps extend site functionality by providing sections, loaders, actions, and integrations.

## App Categories

1. **Commerce** - VTEX, Shopify, Wake, VNDA, etc.
2. **CMS** - Blog, Records, etc.
3. **Analytics** - Plausible, PostHog, etc.
4. **AI** - OpenAI, Anthropic, etc.
5. **Integrations** - Slack, Discord, etc.
6. **Utils** - Website, Assets, etc.

## Components

### AppsList.tsx

Grid view of available and installed apps.

**Features:**
- Tabs: Installed | Available
- Category filter
- Search by name
- App cards with:
  - Icon
  - Name
  - Description
  - Install/Configure button
  - Status badge (installed, update available)

```tsx
export function AppsList() {
  const { data: installed } = useInstalledApps();
  const { data: available } = useAvailableApps();
  const [tab, setTab] = useState<'installed' | 'available'>('installed');
  
  return (
    <SpaceContainer title="Apps">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="installed">
            Installed ({installed?.length || 0})
          </TabsTrigger>
          <TabsTrigger value="available">Available</TabsTrigger>
        </TabsList>
        
        <TabsContent value="installed">
          <AppsGrid 
            apps={installed} 
            onConfigure={(app) => navigate(`/apps/${app.id}`)}
          />
        </TabsContent>
        
        <TabsContent value="available">
          <AppsGrid 
            apps={available}
            onInstall={(app) => installApp(app)}
          />
        </TabsContent>
      </Tabs>
    </SpaceContainer>
  );
}
```

### AppConfig.tsx

Configuration form for an installed app.

**Features:**
- App header with icon and description
- JSON Schema form for app props
- Documentation link
- Uninstall button

```tsx
export function AppConfig({ appId }: { appId: string }) {
  const { data: app } = useApp(appId);
  const { data: schema } = useAppSchema(app?.__resolveType);
  const saveApp = useSaveApp();
  
  return (
    <div className="app-config">
      <AppHeader app={app} />
      
      <JSONSchemaForm
        schema={schema}
        formData={app}
        onChange={(data) => saveApp.mutate({ id: appId, data })}
      />
      
      <div className="mt-8 pt-8 border-t">
        <Button 
          variant="destructive" 
          onClick={() => uninstallApp(appId)}
        >
          Uninstall App
        </Button>
      </div>
    </div>
  );
}
```

### InstallAppDialog.tsx

Modal for installing a new app.

**Steps:**
1. App selection (if not pre-selected)
2. Required configuration
3. Confirmation
4. Installation (creates block in /.deco/blocks/)

## App Installation Flow

```typescript
async function installApp(locator: AppLocator) {
  const { vendor, app } = locator;
  
  if (vendor === 'decohub') {
    // Legacy decohub apps
    await blocks.save(app, {
      __resolveType: `decohub/apps/${app}.ts`,
    });
  } else {
    // New apps via API
    await api.sites.apps.install({
      locator,
      env: currentEnv,
      site: siteName,
    });
  }
}
```

## Hooks

### use-apps.ts

```tsx
// List installed apps
export function useInstalledApps() {
  const { blocks } = useDaemon();
  return useQuery({
    queryKey: ['apps', 'installed'],
    queryFn: () => blocks.list({ type: 'apps' }),
  });
}

// List available apps from decohub
export function useAvailableApps() {
  return useQuery({
    queryKey: ['apps', 'available'],
    queryFn: async () => {
      // Fetch from decohub or apps registry
      const response = await fetch('https://apps.deco.cx/api/apps');
      return response.json();
    },
  });
}

// Get app schema
export function useAppSchema(resolveType: string) {
  const { meta } = useSite();
  return useMemo(() => {
    return meta?.manifest.blocks.apps?.[resolveType];
  }, [meta, resolveType]);
}
```

## Porting from admin-cx

Reference files:
- `admin-cx/components/spaces/siteEditor/extensions/CMS/views/Apps.tsx`
- `admin-cx/loaders/apps/list.ts`
- `admin-cx/actions/sites/apps/install.ts`

