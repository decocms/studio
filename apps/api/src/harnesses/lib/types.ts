// Domain/wire types moved to @decocms/shared/harness/types so apps/web and
// packages/sandbox consume them without depending on this package. Re-exported
// here so the API and harness internals keep their import paths (they follow
// when decopilot/ folds into apps/api).
export * from "@decocms/shared/harness/types";

export { createSecretModelSource } from "./sources";
export type {
  DecopilotMcpSource,
  DecopilotModelSource,
  DecopilotModelSources,
  DecopilotObjectStorageSource,
  DecopilotHttpMcpSource,
  DecopilotSecretModelSource,
  DecopilotSecretModelSources,
  McpClientLike,
  OpenMcpSourceOptions,
  OpenedMcpSource,
} from "./sources";
