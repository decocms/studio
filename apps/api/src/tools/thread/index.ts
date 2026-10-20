/**
 * Thread Management Tools
 *
 * Export all thread-related tools with collection binding compliance.
 */

// Collection-compliant CRUD tools
export { COLLECTION_THREADS_CREATE } from "./create";
export { COLLECTION_THREADS_LIST } from "./list";
export { COLLECTION_THREADS_GET } from "./get";
export { COLLECTION_THREADS_UPDATE } from "./update";
export { COLLECTION_THREADS_DELETE } from "./delete";

// Thread messages tool
export { COLLECTION_THREAD_MESSAGES_LIST } from "./list-messages";

// Admin-org analytics across every tenant's threads
export {
  THREAD_ANALYTICS_ERRORS,
  THREAD_ANALYTICS_LIVE,
  THREAD_ANALYTICS_ORG_LIST,
  THREAD_ANALYTICS_USAGE,
} from "./analytics";
