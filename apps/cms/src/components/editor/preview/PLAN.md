# Preview System

## Overview

The preview system provides a live iframe preview of the block being edited. It communicates with the deco runtime to render blocks in real-time.

## Components

### Preview.tsx

Main preview component with iframe and controls.

```tsx
interface PreviewProps {
  block: Block;
  blockId?: string;
  previewPath?: string;
  className?: string;
}

export function Preview({
  block,
  blockId,
  previewPath = '/',
  className,
}: PreviewProps) {
  const { site } = useSite();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [isLoading, setIsLoading] = useState(true);
  
  // Build preview URL
  const previewUrl = usePreviewUrl(site, block, {
    path: previewPath,
    viewport,
  });
  
  // Handle iframe communication
  useLiveEditorEvents({
    iframeRef,
    onEditProp: (paths) => {
      // Scroll to field in form
      const fieldId = paths.join('_');
      document.getElementById(fieldId)?.scrollIntoView({ behavior: 'smooth' });
    },
  });
  
  return (
    <div className={cn('preview', className)}>
      <Addressbar
        url={previewUrl}
        viewport={viewport}
        onViewportChange={setViewport}
        isLoading={isLoading}
      />
      
      <div className="preview-container">
        <iframe
          ref={iframeRef}
          src={previewUrl}
          className={cn(
            'preview-frame',
            VIEWPORT_SIZES[viewport],
          )}
          onLoad={() => setIsLoading(false)}
        />
      </div>
    </div>
  );
}
```

### Addressbar.tsx

URL bar with viewport controls and external link.

```tsx
interface AddressbarProps {
  url: string;
  viewport: Viewport;
  onViewportChange: (viewport: Viewport) => void;
  isLoading?: boolean;
}

export function Addressbar({
  url,
  viewport,
  onViewportChange,
  isLoading,
}: AddressbarProps) {
  const displayUrl = useMemo(() => {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  }, [url]);
  
  return (
    <div className="addressbar flex items-center gap-2 p-2 border-b">
      {/* Viewport selector */}
      <ViewportSelector value={viewport} onChange={onViewportChange} />
      
      {/* URL display */}
      <div className="flex-1 flex items-center gap-2 px-3 py-1.5 bg-muted rounded">
        {isLoading && <Spinner size="sm" />}
        <span className="text-sm text-muted-foreground truncate">
          {displayUrl}
        </span>
      </div>
      
      {/* External link */}
      <Button variant="ghost" size="icon" asChild>
        <a href={url} target="_blank" rel="noopener">
          <ExternalLink className="h-4 w-4" />
        </a>
      </Button>
    </div>
  );
}
```

### ViewportSelector.tsx

Toggle between mobile, tablet, and desktop viewports.

```tsx
const VIEWPORTS = {
  mobile: { width: 412, height: 823, icon: Smartphone },
  tablet: { width: 1024, height: 1366, icon: Tablet },
  desktop: { width: 1280, height: 800, icon: Monitor },
} as const;

export function ViewportSelector({ value, onChange }: ViewportSelectorProps) {
  return (
    <ToggleGroup type="single" value={value} onValueChange={onChange}>
      {Object.entries(VIEWPORTS).map(([key, { icon: Icon }]) => (
        <ToggleGroupItem key={key} value={key}>
          <Icon className="h-4 w-4" />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
```

## Preview URL Generation

```typescript
// hooks/use-preview-url.ts
export function usePreviewUrl(
  site: Site,
  block: Block,
  options: PreviewOptions
): string {
  return useMemo(() => {
    const { __resolveType, ...props } = block;
    
    if (!__resolveType) return '';
    
    const url = new URL(`${site.url}/live/previews/${__resolveType}`);
    
    // Add path parameter
    url.searchParams.set('path', options.path);
    url.searchParams.set('pathTemplate', options.path);
    
    // Add encoded props
    url.searchParams.set('props', encodeProps(JSON.stringify(props)));
    
    // Add viewport hint
    url.searchParams.set('deviceHint', options.viewport);
    
    // Disable async rendering
    url.searchParams.set('__decoFBT', '0');
    url.searchParams.set('__d', '');
    
    // Add cache buster
    url.searchParams.set('__cb', site.etag || Date.now().toString());
    
    return url.toString();
  }, [site, block, options]);
}

function encodeProps(props: string): string {
  return btoa(encodeURIComponent(props));
}
```

## Iframe Communication

The preview iframe and editor communicate via postMessage:

```typescript
// hooks/use-live-editor-events.ts
interface LiveEditorEventsOptions {
  iframeRef: RefObject<HTMLIFrameElement>;
  onEditProp?: (paths: string[]) => void;
  onSelectSection?: (data: { index: number }) => void;
}

export function useLiveEditorEvents({
  iframeRef,
  onEditProp,
  onSelectSection,
}: LiveEditorEventsOptions) {
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Verify origin
      if (!event.origin.includes('.deco.site')) return;
      
      const { type, args } = event.data;
      
      switch (type) {
        case 'editor::edit':
          onEditProp?.(args.paths);
          break;
        case 'editor::select-section':
          onSelectSection?.(args);
          break;
      }
    };
    
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onEditProp, onSelectSection]);
  
  // Send mode to iframe
  const sendMode = useCallback((mode: 'view' | 'edit') => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'editor::mode', args: { mode } },
      '*'
    );
  }, [iframeRef]);
  
  return { sendMode };
}
```

## Message Types

Messages sent FROM iframe (site) TO editor:
- `editor::edit` - User clicked to edit a field
- `editor::select-section` - User clicked to select a section
- `editor::ready` - Iframe finished loading

Messages sent FROM editor TO iframe:
- `editor::mode` - Set edit/view mode
- `editor::highlight` - Highlight a specific element
- `editor::scroll-to` - Scroll to a specific section

## Porting from admin-cx

Key files to reference:
- `admin-cx/components/spaces/siteEditor/extensions/CMS/views/Preview.tsx`
- `admin-cx/components/pages/View.tsx`
- `admin-cx/components/pages/block-edit/BlockEditorPreview.tsx`
- `admin-cx/components/pages/block-edit/inlineEditor.ts`
- `admin-cx/components/pages/block-edit/state.tsx`

The preview system is largely the same - it uses the same deco runtime endpoints (`/live/previews/*`). Main changes:
1. React refs instead of Preact refs
2. CSS modules/Tailwind instead of inline styles
3. Zustand/React Query instead of Signals for state

