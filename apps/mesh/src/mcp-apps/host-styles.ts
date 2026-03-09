import type {
  McpUiHostStyles,
  McpUiStyleVariableKey,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps";

/**
 * Maps host CSS variables (from packages/ui/src/styles/global.css) to
 * ext-apps spec keys (McpUiStyleVariableKey).
 */
export const HOST_TO_SPEC_VAR_MAP: Array<[string, McpUiStyleVariableKey]> = [
  // Background colors
  ["--background", "--color-background-primary"],
  ["--muted", "--color-background-secondary"],
  ["--accent", "--color-background-tertiary"],
  ["--destructive", "--color-background-danger"],
  ["--success", "--color-background-success"],
  ["--warning", "--color-background-warning"],

  // Text colors
  ["--foreground", "--color-text-primary"],
  ["--muted-foreground", "--color-text-secondary"],
  ["--accent-foreground", "--color-text-tertiary"],
  ["--destructive-foreground", "--color-text-danger"],
  ["--success-foreground", "--color-text-success"],
  ["--warning-foreground", "--color-text-warning"],

  // Border colors
  ["--border", "--color-border-primary"],
  ["--input", "--color-border-secondary"],

  // Ring
  ["--ring", "--color-ring-primary"],

  // Fonts
  ["--font-sans", "--font-sans"],
  ["--font-mono", "--font-mono"],

  // Font weights (from @theme inline in global.css)
  ["--font-weight-normal", "--font-weight-normal"],
  ["--font-weight-medium", "--font-weight-medium"],
  ["--font-weight-semibold", "--font-weight-semibold"],
  ["--font-weight-bold", "--font-weight-bold"],

  // Border radius (base value only — calc()-based variants are excluded)
  ["--radius", "--border-radius-md"],

  // Border width
  ["--default-border-width", "--border-width-regular"],

  // Shadows
  ["--shadow-sm", "--shadow-sm"],
  ["--shadow-md", "--shadow-md"],
  ["--shadow-lg", "--shadow-lg"],
];

/**
 * Reads the host's computed CSS variable values and returns them mapped
 * to the ext-apps spec keys.
 */
export function readHostStyles(): McpUiHostStyles {
  if (typeof document === "undefined") return {};

  const computed = getComputedStyle(document.documentElement);
  const variables: Partial<Record<McpUiStyleVariableKey, string>> = {};

  for (const [hostVar, specKey] of HOST_TO_SPEC_VAR_MAP) {
    const value = computed.getPropertyValue(hostVar).trim();
    if (value) {
      variables[specKey] = value;
    }
  }

  return { variables: variables as McpUiStyles };
}
