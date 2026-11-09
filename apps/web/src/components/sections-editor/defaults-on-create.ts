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

/**
 * On while the outermost form edits its stored block as it is
 * (`defaultsOnCreateOnly`). The form fills no defaults in, so what is created
 * inside it (an item, a branch, a value the block didn't have) gets its own.
 * Every other form, the blog's included, leaves it off.
 */
export const CreateOnlyContext = createContext(false);

/** Fills in what a field is creating, when its form is create-only. */
export function useSeedNew(meta: LiveMeta | undefined) {
  const createOnly = useContext(CreateOnlyContext);
  return <T>(schema: SchemaProperty | null | undefined, value: T): T =>
    createOnly ? withDefaultsForNew(schema, value, meta) : value;
}
