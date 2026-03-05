/**
 * Shared types for Virtual MCP form components
 */

import { VirtualMCPEntitySchema } from "@/tools/virtual/schema";
import { z } from "zod";
import type { UseFormReturn } from "react-hook-form";

/**
 * Form validation schema for Virtual MCP
 */
export const VirtualMcpFormSchema = VirtualMCPEntitySchema.pick({
  title: true,
  description: true,
  icon: true,
  status: true,
  metadata: true,
  connections: true,
}).extend({
  title: z.string().min(1, "Name is required").max(255),
});

/**
 * Form data type for Virtual MCP
 */
export type VirtualMcpFormData = z.infer<typeof VirtualMcpFormSchema>;

/**
 * Form return type for Virtual MCP
 */
export type VirtualMcpFormReturn = UseFormReturn<VirtualMcpFormData>;
