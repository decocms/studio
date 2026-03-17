/**
 * Filesystem Schemas
 *
 * Re-exports schemas from @decocms/bindings for use in MCP tools.
 * The bindings package is the source of truth for these schemas.
 */

export {
  FsReadInputSchema,
  type FsReadInput,
  FsReadOutputSchema,
  type FsReadOutput,
  FsWriteInputSchema,
  type FsWriteInput,
  FsWriteOutputSchema,
  type FsWriteOutput,
  FsListInputSchema,
  type FsListInput,
  FsListOutputSchema,
  type FsListOutput,
  FsDeleteInputSchema,
  type FsDeleteInput,
  FsDeleteOutputSchema,
  type FsDeleteOutput,
  FsMetadataInputSchema,
  type FsMetadataInput,
  FsMetadataOutputSchema,
  type FsMetadataOutput,
} from "@decocms/bindings";
