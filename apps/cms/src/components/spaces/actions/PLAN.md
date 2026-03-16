# Actions Space

## Overview

The Actions space manages server actions - functions that handle user interactions like form submissions, cart operations, and other mutations.

## What are Actions?

Actions are TypeScript functions that:
- Run on the server when triggered by user interaction
- Handle mutations (create, update, delete operations)
- Can return data or redirect
- Are called via POST requests

## Components

### ActionsList.tsx

List view showing all saved action instances.

```tsx
export function ActionsList() {
  const { data: actions, isLoading } = useActions();
  const { data: templates } = useActionTemplates();
  
  return (
    <SpaceContainer 
      title="Actions"
      actions={<CreateActionButton templates={templates} />}
    >
      <ResourceTable
        data={actions}
        loading={isLoading}
        columns={[
          { key: 'id', label: 'Name', sortable: true },
          { key: '__resolveType', label: 'Type', render: (a) => formatActionType(a.__resolveType) },
          { key: 'updatedAt', label: 'Updated', render: (a) => formatTimeAgo(a.updatedAt) },
        ]}
        onRowClick={(action) => navigate(action.id)}
        searchPlaceholder="Search actions..."
      />
    </SpaceContainer>
  );
}
```

### ActionsEdit.tsx

Action configuration editor with test panel.

```tsx
export function ActionsEdit({ actionId }: { actionId: string }) {
  const { data: action } = useAction(actionId);
  const { data: schema } = useBlockSchema(action?.__resolveType);
  const saveAction = useSaveBlock();
  
  return (
    <div className="actions-edit grid grid-cols-2 gap-4">
      {/* Form */}
      <div className="border rounded-lg overflow-auto">
        <div className="p-4 border-b">
          <h2 className="font-semibold">Configuration</h2>
        </div>
        <JSONSchemaForm
          schema={schema}
          formData={action}
          onChange={(data) => saveAction.mutate({ id: actionId, data })}
          className="p-4"
        />
      </div>
      
      {/* Test Panel */}
      <div className="border rounded-lg overflow-auto">
        <div className="p-4 border-b">
          <h2 className="font-semibold">Test Action</h2>
        </div>
        <ActionTestPanel actionId={actionId} action={action} />
      </div>
    </div>
  );
}
```

### ActionTestPanel.tsx

Panel for testing/invoking an action.

```tsx
interface ActionTestPanelProps {
  actionId: string;
  action: Block;
}

export function ActionTestPanel({ actionId, action }: ActionTestPanelProps) {
  const { site } = useSite();
  const [payload, setPayload] = useState('{}');
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  const testAction = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const requestPayload = {
        ...action,
        ...JSON.parse(payload),
      };
      
      const response = await fetch(`${site.url}/live/invoke/${action.__resolveType}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
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
      <div>
        <Label>Request Payload (JSON)</Label>
        <Textarea 
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={5}
          className="font-mono text-sm"
          placeholder='{"key": "value"}'
        />
      </div>
      
      <Button onClick={testAction} disabled={isLoading}>
        {isLoading ? <Spinner className="mr-2" /> : <Zap className="h-4 w-4 mr-2" />}
        Test Action
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

### use-actions.ts

```tsx
// List all saved actions
export function useActions() {
  const { blocks } = useDaemon();
  return useQuery({
    queryKey: ['actions'],
    queryFn: () => blocks.list({ type: 'actions' }),
  });
}

// Get action templates from manifest
export function useActionTemplates() {
  const { meta } = useSite();
  return useMemo(() => {
    const actions = meta?.manifest.blocks.actions || {};
    return Object.keys(actions)
      .filter(key => !key.startsWith('deco-sites'))
      .map(resolveType => ({
        resolveType,
        name: resolveType.split('/').pop()?.replace('.ts', ''),
        schema: actions[resolveType],
      }));
  }, [meta]);
}

// Invoke action for testing
export function useInvokeAction() {
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

## Common Action Types

From apps in decohub:
- `vtex/actions/cart/addItems.ts` - Add to cart
- `vtex/actions/cart/updateItem.ts` - Update cart item
- `shopify/actions/cart/addItem.ts` - Shopify add to cart
- `website/actions/newsletter/subscribe.ts` - Newsletter signup
- `website/actions/sendEmail.ts` - Send email

## Porting from admin-cx

Reference files:
- `admin-cx/components/spaces/siteEditor/extensions/CMS/views/List.tsx`
- `admin-cx/components/library/BlockSelector.tsx`

