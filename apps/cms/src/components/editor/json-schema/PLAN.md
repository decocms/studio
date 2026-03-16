# JSON Schema Form System

## Overview

The JSON Schema form system dynamically generates forms from JSON Schema definitions. This is the core of the CMS editing experience.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Form.tsx                                │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                  FormProvider                        │    │
│  │  (react-hook-form + ajv validation)                 │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                  │
│                           ▼                                  │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              SchemaRenderer                          │    │
│  │  - Resolves $ref                                    │    │
│  │  - Determines widget type                           │    │
│  │  - Handles oneOf/anyOf                              │    │
│  └─────────────────────────────────────────────────────┘    │
│                           │                                  │
│           ┌───────────────┼───────────────┐                 │
│           ▼               ▼               ▼                 │
│     ┌──────────┐   ┌──────────┐   ┌──────────────┐         │
│     │ String   │   │ Object   │   │ Custom       │         │
│     │ Widget   │   │ Template │   │ Widget       │         │
│     └──────────┘   └──────────┘   └──────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### Form.tsx

Main form component that orchestrates everything.

```tsx
interface JSONSchemaFormProps {
  schema: JSONSchema;
  formData: unknown;
  onChange: (data: unknown, errors?: ValidationError[]) => void;
  blockId?: string;
  className?: string;
}

export function JSONSchemaForm({
  schema,
  formData,
  onChange,
  blockId,
  className,
}: JSONSchemaFormProps) {
  const methods = useForm({
    defaultValues: formData,
    resolver: ajvResolver(schema),
    mode: 'onChange',
  });
  
  // Sync form changes with parent
  useEffect(() => {
    const subscription = methods.watch((data) => {
      onChange(data, methods.formState.errors);
    });
    return () => subscription.unsubscribe();
  }, [methods, onChange]);
  
  return (
    <FormProvider {...methods}>
      <SchemaFormContext.Provider value={{ schema, blockId }}>
        <form className={cn('json-schema-form', className)}>
          <SchemaRenderer 
            schema={schema} 
            path="" 
          />
        </form>
      </SchemaFormContext.Provider>
    </FormProvider>
  );
}
```

### SchemaRenderer.tsx

Recursively renders schema nodes.

```tsx
interface SchemaRendererProps {
  schema: JSONSchema;
  path: string;
}

export function SchemaRenderer({ schema, path }: SchemaRendererProps) {
  // Resolve $ref
  const resolvedSchema = useResolvedSchema(schema);
  
  // Handle oneOf/anyOf
  if (resolvedSchema.oneOf || resolvedSchema.anyOf) {
    return <TypeSelector schema={resolvedSchema} path={path} />;
  }
  
  // Get widget for schema type
  const Widget = getWidget(resolvedSchema);
  
  return <Widget schema={resolvedSchema} path={path} />;
}
```

## Widget Resolution

Widgets are resolved based on schema properties:

```typescript
function getWidget(schema: JSONSchema): WidgetComponent {
  // Check for explicit widget
  if (schema.format === 'uri' && schema['x-widget'] === 'image') {
    return MediaUploadWidget;
  }
  
  // Check format
  if (schema.format === 'color') return ColorPickerWidget;
  if (schema.format === 'date') return DatePickerWidget;
  if (schema.format === 'date-time') return DateTimePickerWidget;
  if (schema.format === 'uri') return UrlInputWidget;
  if (schema.format === 'code') return CodeEditorWidget;
  
  // Check type
  switch (schema.type) {
    case 'string':
      if (schema.enum) return SelectWidget;
      if (schema.maxLength > 100) return TextareaWidget;
      return StringWidget;
    case 'number':
    case 'integer':
      return NumberWidget;
    case 'boolean':
      return BooleanWidget;
    case 'array':
      return ArrayWidget;
    case 'object':
      return ObjectWidget;
    default:
      return StringWidget;
  }
}
```

## Widgets Directory

```
widgets/
├── primitives/
│   ├── StringWidget.tsx      # Text input
│   ├── NumberWidget.tsx      # Number input
│   ├── BooleanWidget.tsx     # Checkbox/toggle
│   ├── SelectWidget.tsx      # Dropdown select
│   └── TextareaWidget.tsx    # Multi-line text
├── complex/
│   ├── ArrayWidget.tsx       # Array field with add/remove
│   ├── ObjectWidget.tsx      # Nested object
│   └── TypeSelector.tsx      # oneOf/anyOf selector
├── custom/
│   ├── BlockSelector.tsx     # Section/block picker
│   ├── MediaUpload.tsx       # Image/file upload
│   ├── ColorPicker.tsx       # Color input
│   ├── CodeEditor.tsx        # Monaco editor
│   ├── RichText.tsx          # TipTap editor
│   ├── SecretInput.tsx       # Password field
│   ├── MapPicker.tsx         # Location picker
│   ├── DatePicker.tsx        # Date input
│   └── IconSelector.tsx      # Icon picker
└── templates/
    ├── FieldTemplate.tsx     # Wrapper for all fields
    ├── ArrayTemplate.tsx     # Array item layout
    └── ObjectTemplate.tsx    # Object layout
```

## Key Widget Implementations

### BlockSelector.tsx

The most complex widget - allows selecting sections from library.

```tsx
export function BlockSelector({ schema, path }: WidgetProps) {
  const { setValue, watch } = useFormContext();
  const value = watch(path);
  const [isOpen, setIsOpen] = useState(false);
  
  // Get available block types from schema
  const blockTypes = getBlockTypes(schema);
  
  return (
    <>
      <div 
        className="block-selector"
        onClick={() => setIsOpen(true)}
      >
        {value?.__resolveType ? (
          <BlockPreview block={value} />
        ) : (
          <span className="placeholder">Select section...</span>
        )}
      </div>
      
      <BlockSelectorDialog
        open={isOpen}
        onOpenChange={setIsOpen}
        blockTypes={blockTypes}
        onSelect={(block) => {
          setValue(path, block);
          setIsOpen(false);
        }}
      />
    </>
  );
}
```

### ArrayWidget.tsx

Array field with drag-and-drop reordering.

```tsx
export function ArrayWidget({ schema, path }: WidgetProps) {
  const { control } = useFormContext();
  const { fields, append, remove, move } = useFieldArray({
    control,
    name: path,
  });
  
  return (
    <div className="array-widget">
      <DndContext onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id) {
          const oldIndex = fields.findIndex(f => f.id === active.id);
          const newIndex = fields.findIndex(f => f.id === over.id);
          move(oldIndex, newIndex);
        }
      }}>
        <SortableContext items={fields.map(f => f.id)}>
          {fields.map((field, index) => (
            <ArrayItem
              key={field.id}
              index={index}
              path={`${path}.${index}`}
              schema={schema.items}
              onRemove={() => remove(index)}
            />
          ))}
        </SortableContext>
      </DndContext>
      
      <Button 
        variant="outline" 
        onClick={() => append(getDefaultValue(schema.items))}
      >
        Add Item
      </Button>
    </div>
  );
}
```

## Validation

Using AJV for JSON Schema validation:

```typescript
// utils/ajv-resolver.ts
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

export function ajvResolver(schema: JSONSchema) {
  const validate = ajv.compile(schema);
  
  return async (data: unknown) => {
    const valid = validate(data);
    
    if (valid) {
      return { values: data, errors: {} };
    }
    
    const errors = validate.errors?.reduce((acc, error) => {
      const path = error.instancePath.replace(/\//g, '.');
      acc[path] = { message: error.message };
      return acc;
    }, {} as Record<string, { message: string }>);
    
    return { values: {}, errors };
  };
}
```

## Porting from admin-cx

Key files to reference:
- `admin-cx/components/editor/JSONSchema/Form.tsx`
- `admin-cx/components/editor/JSONSchema/widgets/*.tsx`
- `admin-cx/components/editor/JSONSchema/utils.ts`
- `admin-cx/components/editor/JSONSchema/validator.ts`

Main differences:
1. **React Hook Form** instead of custom form state
2. **AJV** instead of RJSF validation
3. **Tailwind/shadcn** instead of custom UI
4. **DnD Kit** instead of custom drag-and-drop

