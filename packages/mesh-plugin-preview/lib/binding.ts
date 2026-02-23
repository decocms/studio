/**
 * Preview Binding
 *
 * Defines the minimal tool interface required for the preview plugin.
 * Connections must provide read_file, write_file, and bash tools.
 * This is used to filter the connection selector in project settings.
 */

import { z } from "zod";
import type { Binder } from "@decocms/bindings";

export const PREVIEW_BINDING = [
  {
    name: "read_file" as const,
    inputSchema: z.object({
      path: z.string(),
    }),
  },
  {
    name: "write_file" as const,
    inputSchema: z.object({
      path: z.string(),
      content: z.string(),
    }),
  },
  {
    name: "bash" as const,
    inputSchema: z.object({
      cmd: z.string(),
    }),
  },
] as const satisfies Binder;

export type PreviewBinding = typeof PREVIEW_BINDING;
