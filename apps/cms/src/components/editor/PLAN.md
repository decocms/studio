# Editor Components

## Overview

The editor system consists of two main parts:
1. **JSON Schema Form** - Dynamic form generation from JSON Schema
2. **Preview** - Live iframe preview of the block being edited

## Components

### BlockEditor.tsx

Main editor component combining form and preview.

```tsx
interface BlockEditorProps {
  blockId: string;
  block: Block;
  schema: JSONSchema;
  showPreview?: boolean;
  previewPath?: string;
  onSave?: (block: Block) => void;
}

export function BlockEditor({
  blockId,
  block,
  schema,
  showPreview = true,
  previewPath,
  onSave,
}: BlockEditorProps) {
  const [formData, setFormData] = useState(block);
  
  const handleChange = (data: Block) => {
    setFormData(data);
    onSave?.(data);
  };
  
  return (
    <ResizablePanelGroup direction="horizontal">
      <ResizablePanel defaultSize={50} minSize={30}>
        <ScrollArea className="h-full">
          <JSONSchemaForm
            schema={schema}
            formData={formData}
            onChange={handleChange}
            blockId={blockId}
          />
        </ScrollArea>
      </ResizablePanel>
      
      {showPreview && (
        <>
          <ResizableHandle />
          <ResizablePanel defaultSize={50} minSize={30}>
            <Preview
              block={formData}
              blockId={blockId}
              previewPath={previewPath}
            />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
```

## Directory Structure

```
editor/
├── BlockEditor.tsx       # Main editor layout
├── json-schema/          # Form system
│   ├── Form.tsx          # Main form component
│   ├── widgets/          # Input widgets
│   ├── templates/        # Field/array/object templates
│   └── utils/            # Schema utilities
└── preview/              # Preview system
    ├── Preview.tsx       # Main preview component
    ├── Addressbar.tsx    # URL bar with viewport
    └── ViewportSelector.tsx
```

## Implementation Priority

### P0 - Required for MVP
1. `BlockEditor.tsx` - Layout component
2. `json-schema/Form.tsx` - Basic form rendering
3. `json-schema/widgets/StringField.tsx`
4. `json-schema/widgets/NumberField.tsx`
5. `json-schema/widgets/BooleanField.tsx`
6. `json-schema/widgets/ArrayField.tsx`
7. `json-schema/widgets/ObjectField.tsx`
8. `json-schema/widgets/SelectField.tsx`
9. `preview/Preview.tsx`
10. `preview/Addressbar.tsx`

### P1 - Core Widgets
11. `widgets/BlockSelector.tsx` - Select sections/blocks
12. `widgets/MediaUpload.tsx` - Image/file upload
13. `widgets/ColorPicker.tsx`
14. `widgets/RichText.tsx`

### P2 - Advanced Widgets
15. `widgets/CodeEditor.tsx` - Monaco editor
16. `widgets/SecretInput.tsx`
17. `widgets/MapPicker.tsx`
18. `widgets/DatePicker.tsx`
19. `widgets/IconSelector.tsx`
20. `widgets/DynamicOptions.tsx`

## Porting Strategy

The JSON Schema form is a critical component. Strategy:

1. **Start Fresh** - Use `react-hook-form` + `ajv` instead of RJSF
2. **Port Widgets** - Convert Preact widgets to React one by one
3. **Maintain Compatibility** - Same schema format as admin-cx
4. **Improve UX** - Take opportunity to improve upon original

See detailed plans:
- `json-schema/PLAN.md`
- `preview/PLAN.md`

