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

// Re-export plugin context types (not the React provider - use @decocms/bindings/plugins for that)
export {
  type PluginContext,
  type PluginContextPartial,
  type PluginConnectionEntity,
  type PluginOrgContext,
  type PluginSession,
  type TypedToolCaller,
} from "./core/plugin-context";

// Re-export registry binding types
export {
  MCPRegistryServerSchema,
  type RegistryAppCollectionEntity,
  REGISTRY_APP_BINDING,
} from "./well-known/registry";

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

// Re-export event bus binding types (for interacting with an event bus)
export {
  EventPublishInputSchema,
  type EventPublishInput,
  EventPublishOutputSchema,
  type EventPublishOutput,
  EventSubscribeInputSchema,
  type EventSubscribeInput,
  EventSubscribeOutputSchema,
  type EventSubscribeOutput,
  EventUnsubscribeInputSchema,
  type EventUnsubscribeInput,
  EventUnsubscribeOutputSchema,
  type EventUnsubscribeOutput,
  EventCancelInputSchema,
  type EventCancelInput,
  EventCancelOutputSchema,
  type EventCancelOutput,
  EventAckInputSchema,
  type EventAckInput,
  EventAckOutputSchema,
  type EventAckOutput,
  SubscriptionItemSchema,
  type SubscriptionItem,
  SubscriptionDetailSchema,
  type SubscriptionDetail,
  EventSyncSubscriptionsInputSchema,
  type EventSyncSubscriptionsInput,
  EventSyncSubscriptionsOutputSchema,
  type EventSyncSubscriptionsOutput,
  EVENT_BUS_BINDING,
  EventBusBinding,
  type EventBusBindingClient,
} from "./well-known/event-bus";

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

// Re-export workflow binding types
export { WORKFLOWS_COLLECTION_BINDING } from "./well-known/workflow";

// Re-export reports binding types
export {
  REPORTS_BINDING,
  type ReportsBinding,
  type ReportStatus,
  type ReportLifecycleStatus,
  type CriterionItem,
  type MetricItem,
  type RankedListRow,
  type ReportSection,
  type ReportSummary,
  type Report,
  type ReportsListInput,
  type ReportsListOutput,
  type ReportsGetInput,
  type ReportsGetOutput,
  type ReportsUpdateStatusInput,
  type ReportsUpdateStatusOutput,
  ReportStatusSchema,
  ReportLifecycleStatusSchema,
  MetricItemSchema,
  ReportSectionSchema,
  ReportSummarySchema,
  ReportSchema,
  type SectionGroup,
  groupSections,
} from "./well-known/reports";

// Re-export Farmrio collection reorder binding types
export {
  FARMRIO_REORDER_BINDING,
  type FarmrioReorderBinding,
  type FarmrioCollectionItem,
  type FarmrioMetricItem,
  type FarmrioCriteriaItem,
  type FarmrioRankedItem,
  type FarmrioSection,
  type FarmrioReportSummary,
  type FarmrioReport,
  type CollectionListInput,
  type CollectionListOutput,
  type CollectionCreateInput,
  type CollectionCreateOutput,
  type CollectionUpdateInput,
  type CollectionUpdateOutput,
  type ReportListInput,
  type ReportListOutput,
  type ReportGetInput,
  type ReportGetOutput,
} from "./well-known/farmrio-reorder";

// Re-export VTEX reorder binding types
export {
  VTEX_COLLECTION_REORDER_BINDING,
  type VtexCollectionReorderBinding,
  VTEX_REORDER_COLLECTION_BINDING,
  type VtexReorderCollectionBinding,
  VtexReorderCollectionInputSchema,
  type VtexReorderCollectionInput,
  VtexReorderCollectionOutputSchema,
  type VtexReorderCollectionOutput,
} from "./well-known/vtex";
