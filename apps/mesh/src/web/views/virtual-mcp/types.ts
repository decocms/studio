/**
 * Shared types for Virtual MCP form components
 */

import { VirtualMCPEntitySchema } from "@/tools/virtual/schema";
import { z } from "zod";
import type { UseFormReturn } from "react-hook-form";

/**
 * Form validation schema for Virtual MCP
 *
 * `slots` is picked from VirtualMCPEntitySchema but overridden to `optional()`
 * here because the entity schema uses `.default([])` which splits `z.input`
 * (slots?: …) from `z.output` (slots: …). react-hook-form's `useForm<T>` +
 * `zodResolver` requires identical input/output types — so we keep slots
 * optional throughout the form layer and default in the submit handler.
 */
export const VirtualMcpFormSchema = VirtualMCPEntitySchema.pick({
  status: true,
  title: true,
  description: true,
  icon: true,
  metadata: true,
  connections: true,
  slots: true,
}).extend({
  slots: VirtualMCPEntitySchema.shape.slots.optional(),
});

/**
 * Form data type for Virtual MCP
 */
export type VirtualMcpFormData = z.infer<typeof VirtualMcpFormSchema>;

/**
 * Form return type for Virtual MCP
 */
export type VirtualMcpFormReturn = UseFormReturn<VirtualMcpFormData>;
