import { CHANNEL_BINDING } from "./channels.ts";

// Import new Resources 2.0 bindings function
import { LANGUAGE_MODEL_BINDING } from "@decocms/bindings/llm";

// Export types and utilities from binder
export {
  bindingClient,
  ChannelBinding,
  impl,
  type Binder,
  type BinderImplementation,
  type MCPBindingClient,
  type ToolLike,
} from "./binder.ts";

// Export all channel types and schemas
export * from "./channels.ts";

// Export binding utilities
export * from "./utils.ts";

export const WellKnownBindings = {
  Channel: CHANNEL_BINDING,
  LanguageModel: LANGUAGE_MODEL_BINDING,
  // Note: Resources is not included here since it's a generic function
  // Use createResourceBindings(dataSchema) directly for Resources 2.0
} as const;

export type WellKnownBindingsName = keyof typeof WellKnownBindings;
