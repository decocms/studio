# Assets Space

## Overview

The Assets space provides a media library for managing images, videos, documents, and other files used in the site.

## Features

- **Upload** - Drag & drop, paste, or click to upload
- **Browse** - Grid/list view with thumbnails
- **Search** - By filename, type, or metadata
- **Organize** - Folders (optional), tags
- **Use** - Copy URL, insert into content
- **Edit** - Rename, replace, crop images

## Components

### AssetsList.tsx

Main asset browser with grid view.

```tsx
export function AssetsList() {
  const { data: assets, isLoading } = useAssets();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  
  return (
    <SpaceContainer 
      title="Assets"
      actions={
        <>
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
          <UploadButton />
        </>
      }
    >
      <UploadDropzone onUpload={handleUpload}>
        {viewMode === 'grid' ? (
          <AssetsGrid 
            assets={assets} 
            selected={selectedAssets}
            onSelect={setSelectedAssets}
            onPreview={(asset) => setPreviewAsset(asset)}
          />
        ) : (
          <AssetsTable 
            assets={assets}
            selected={selectedAssets}
            onSelect={setSelectedAssets}
          />
        )}
      </UploadDropzone>
      
      {selectedAssets.length > 0 && (
        <SelectionToolbar 
          count={selectedAssets.length}
          onDelete={() => deleteAssets(selectedAssets)}
          onDownload={() => downloadAssets(selectedAssets)}
        />
      )}
    </SpaceContainer>
  );
}
```

### AssetUploader.tsx

Upload component with drag & drop.

**Features:**
- Drag & drop zone
- Multiple file selection
- Upload progress
- Image compression (optional)
- Duplicate detection

```tsx
export function AssetUploader({ onUpload }: AssetUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  
  const handleDrop = async (files: File[]) => {
    for (const file of files) {
      const upload = { id: uuid(), file, progress: 0 };
      setUploads(prev => [...prev, upload]);
      
      try {
        const asset = await uploadAsset(file, (progress) => {
          setUploads(prev => prev.map(u => 
            u.id === upload.id ? { ...u, progress } : u
          ));
        });
        onUpload?.(asset);
      } catch (error) {
        // Handle error
      }
    }
  };
  
  return (
    <div 
      className={cn('upload-zone', isDragging && 'dragging')}
      onDragOver={handleDragOver}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {uploads.map(upload => (
        <UploadProgress key={upload.id} upload={upload} />
      ))}
    </div>
  );
}
```

### AssetPreview.tsx

Modal/panel for viewing and editing assets.

**Features:**
- Full-size preview
- Metadata display (size, dimensions, format)
- Copy URL button
- Rename
- Delete
- Image cropping (via ImageCrop component)

### AssetPicker.tsx

Modal for selecting assets from library (used in forms).

```tsx
interface AssetPickerProps {
  value?: string;
  onChange: (url: string) => void;
  accept?: string; // MIME types
}

export function AssetPicker({ value, onChange, accept }: AssetPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  
  return (
    <>
      <div className="asset-picker-trigger" onClick={() => setIsOpen(true)}>
        {value ? (
          <img src={value} alt="" className="thumbnail" />
        ) : (
          <span>Select asset...</span>
        )}
      </div>
      
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-4xl">
          <AssetsList 
            selectionMode="single"
            accept={accept}
            onSelect={(asset) => {
              onChange(asset.url);
              setIsOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
```

## Asset Storage

Assets are typically stored in:
1. **Deco Assets** - Managed asset storage (recommended)
2. **External URLs** - Direct links to external resources
3. **GitHub** - Static files in repo (legacy)

```typescript
async function uploadAsset(file: File): Promise<Asset> {
  const formData = new FormData();
  formData.append('file', file);
  
  const response = await fetch(`/api/sites/${site}/assets`, {
    method: 'POST',
    body: formData,
  });
  
  return response.json();
}
```

## Hooks

### use-assets.ts

```tsx
export function useAssets(options?: { type?: string }) {
  return useQuery({
    queryKey: ['assets', options],
    queryFn: () => api.sites.assets.list({ 
      site: siteName,
      ...options 
    }),
  });
}

export function useUploadAsset() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (file: File) => uploadAsset(file),
    onSuccess: () => {
      queryClient.invalidateQueries(['assets']);
    },
  });
}
```

## Porting from admin-cx

Reference files:
- `admin-cx/components/spaces/siteEditor/extensions/CMS/views/Assets.tsx`
- `admin-cx/components/ui/UploadAsset.tsx`
- `admin-cx/components/ui/ImageCrop.tsx`
- `admin-cx/loaders/sites/assets.ts`

