/**
 * @decocms/bindings
 *
 * Core type definitions for the bindings system.
 * Bindings define standardized interfaces that integrations (MCPs) can implement.
 */

// Re-export core binder types and utilities
export {
  createBindingChecker,
  bindingClient,
  connectionImplementsBinding,
  type Binder,
  type BindingChecker,
  type ToolBinder,
  type ToolWithSchemas,
  type ConnectionForBinding,
} from "./core/binder";

// Re-export event subscriber binding types (for connections that receive events)
export {
  CloudEventSchema,
  type CloudEvent,
  EventResultSchema,
  type EventResult,
  OnEventsInputSchema,
  type OnEventsInput,
  OnEventsOutputSchema,
  type OnEventsOutput,
  EVENT_SUBSCRIBER_BINDING,
  EventSubscriberBinding,
  type EventSubscriberBindingClient,
} from "./well-known/event-subscriber";

// Re-export trigger binding types (for connections that can emit triggers)
export {
  TriggerParamSchema,
  type TriggerParam,
  TriggerDefinitionSchema,
  type TriggerDefinition,
  TriggerListInputSchema,
  type TriggerListInput,
  TriggerListOutputSchema,
  type TriggerListOutput,
  TriggerConfigureInputSchema,
  type TriggerConfigureInput,
  TriggerConfigureOutputSchema,
  type TriggerConfigureOutput,
  TRIGGER_BINDING,
  TriggerBinding,
  type TriggerBindingClient,
} from "./well-known/trigger";

// Re-export object storage binding types
export {
  OBJECT_STORAGE_BINDING,
  type ObjectStorageBinding,
  type ListObjectsInput,
  type ListObjectsOutput,
  type GetObjectMetadataInput,
  type GetObjectMetadataOutput,
  type GetPresignedUrlInput,
  type GetPresignedUrlOutput,
  type PutPresignedUrlInput,
  type PutPresignedUrlOutput,
  type DeleteObjectInput,
  type DeleteObjectOutput,
  type DeleteObjectsInput,
  type DeleteObjectsOutput,
} from "./well-known/object-storage";

// Re-export brand binding types (for reading org brand context)
export {
  BrandColorsSchema,
  type BrandColors,
  BrandFontsSchema,
  type BrandFonts,
  BrandAssetsSchema,
  type BrandAssets,
  BrandSchema,
  type Brand,
  BrandGetInputSchema,
  type BrandGetInput,
  type BrandGetOutput,
  BrandListInputSchema,
  type BrandListInput,
  BrandListOutputSchema,
  type BrandListOutput,
  BRAND_BINDING,
  BrandBinding,
  type BrandBindingClient,
} from "./well-known/brand";
