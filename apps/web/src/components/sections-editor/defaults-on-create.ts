import { createContext, useContext } from "react";
import { useVirtualMCP } from "@/sdk/hooks/use-virtual-mcp";
import type { LiveMeta, SchemaProperty } from "./resolve-schema";
import { withDefaultsForNew } from "./schema-defaults";

/**
 * Whether the project writes `@default`s only into new blocks (CMS settings;
 * off unless turned on). Suspends until the project is read, so such a project
 * never writes while its setting is loading.
 */
export function useDefaultsOnCreateOnly(
  projectId: string | null | undefined,
): boolean {
  const virtualMcp = useVirtualMCP(projectId);
  return virtualMcp?.metadata?.defaultsOnCreateOnly === true;
}

/** The project a form follows when it has no `sandbox` (the SEO forms). */
export const DefaultsProjectContext = createContext<string | null>(null);

/**
 * On while the outermost form edits the stored block of a project that writes
 * defaults only into new blocks. The form no longer fills defaults in, so what
 * a field creates inside it (an item, a branch) gets its own. Forms that never
 * fill defaults (the blog's) leave it off.
 */
export const CreateOnlyContext = createContext(false);

/** Fills in what a field is creating, when its form is create-only. */
export function useSeedNew(meta: LiveMeta | undefined) {
  const createOnly = useContext(CreateOnlyContext);
  return <T>(schema: SchemaProperty | null | undefined, value: T): T =>
    createOnly ? withDefaultsForNew(schema, value, meta) : value;
}
