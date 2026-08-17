/**
 * Web-side re-export of the shared CMS-mode gate.
 *
 * The gate itself lives in `@decocms/shared/cms-mode` so the API reads the same
 * rule (and the same legacy-key fallback) as the UI. Keeping this module means
 * web callers import from one place and the shared package stays the only
 * definition.
 */

export {
  resolveCmsMode,
  resolveCmsModeForBranch,
  type CmsModeGate,
  type CmsModeMetadata,
} from "@decocms/shared/cms-mode";
