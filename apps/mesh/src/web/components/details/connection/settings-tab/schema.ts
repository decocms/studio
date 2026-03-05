import { z } from "zod";

// Environment variable schema
const envVarSchema = z.object({
  key: z.string().min(1, "Key is required"),
  value: z.string(),
});

// UI type - includes "NPX" and "STDIO" which both map to STDIO internally
export const connectionFormSchema = z
  .object({
    title: z.string().min(1, "Name is required"),
    description: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    // UI type for display
    // - NPX: convenience wrapper for npm packages
    // - STDIO: custom command for local servers
    // - HTTP/SSE/Websocket: remote servers
    ui_type: z.enum(["HTTP", "SSE", "Websocket", "NPX", "STDIO"]),
    // For HTTP/SSE/Websocket
    connection_url: z.string().optional(),
    connection_token: z.string().nullable().optional(),
    // For NPX (convenience wrapper)
    npx_package: z.string().optional(),
    // For STDIO (custom command)
    stdio_command: z.string().optional(),
    stdio_args: z.string().optional(), // Space-separated args
    stdio_cwd: z.string().optional(),
    // Shared: Environment variables for both NPX and STDIO
    env_vars: z.array(envVarSchema).optional(),
    // Preserved fields
    configuration_scopes: z.array(z.string()).nullable().optional(),
    configuration_state: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional(),
  })
  .refine(
    (data) => {
      if (data.ui_type === "NPX") {
        return !!data.npx_package?.trim();
      }
      return true;
    },
    { message: "NPM package is required", path: ["npx_package"] },
  )
  .refine(
    (data) => {
      if (data.ui_type === "STDIO") {
        return !!data.stdio_command?.trim();
      }
      return true;
    },
    { message: "Command is required", path: ["stdio_command"] },
  )
  .refine(
    (data) => {
      if (
        data.ui_type === "HTTP" ||
        data.ui_type === "SSE" ||
        data.ui_type === "Websocket"
      ) {
        return !!data.connection_url?.trim();
      }
      return true;
    },
    { message: "URL is required", path: ["connection_url"] },
  );

export type ConnectionFormData = z.infer<typeof connectionFormSchema>;
export type EnvVar = z.infer<typeof envVarSchema>;
