/**
 * Theme Provider
 *
 * Fetches theme configuration from the public config endpoint and injects
 * CSS variables into the document root for light and dark mode overrides.
 */

import { useSuspenseQuery } from "@tanstack/react-query";
import { useLayoutEffect, type ReactNode } from "react";
import type { PublicConfig } from "@/api/routes/public-config";
import { KEYS } from "@/web/lib/query-keys";

async function fetchPublicConfig(): Promise<PublicConfig> {
  const response = await fetch("/api/config");
  if (!response.ok) {
    throw new Error("Failed to load public configuration");
  }
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || "Failed to load public configuration");
  }
  return data.config;
}

/**
 * Injects CSS variables into the document based on theme configuration.
 * Light mode variables go into :root, dark mode into .dark class.
 */
function injectThemeVariables(theme: PublicConfig["theme"]) {
  if (!theme) return;

  // Remove any previously injected theme style
  const existingStyle = document.getElementById("mesh-theme-overrides");
  if (existingStyle) {
    existingStyle.remove();
  }

  const cssRules: string[] = [];

  // Light mode overrides (applied to :root)
  if (theme.light && Object.keys(theme.light).length > 0) {
    const lightVars = Object.entries(theme.light)
      .map(([key, value]) => `  ${key}: ${value};`)
      .join("\n");
    cssRules.push(`:root {\n${lightVars}\n}`);
  }

  // Dark mode overrides (applied to .dark class)
  if (theme.dark && Object.keys(theme.dark).length > 0) {
    const darkVars = Object.entries(theme.dark)
      .map(([key, value]) => `  ${key}: ${value};`)
      .join("\n");
    cssRules.push(`.dark {\n${darkVars}\n}`);
  }

  // Only inject if we have rules
  if (cssRules.length > 0) {
    const style = document.createElement("style");
    style.id = "mesh-theme-overrides";
    style.textContent = cssRules.join("\n\n");
    document.head.appendChild(style);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { data: publicConfig } = useSuspenseQuery({
    queryKey: KEYS.publicConfig(),
    queryFn: fetchPublicConfig,
    staleTime: Infinity,
  });

  // Inject theme variables synchronously before paint to avoid FOUC
  // useLayoutEffect is correct here (not useEffect) for DOM mutations that affect visual appearance
  useLayoutEffect(() => {
    injectThemeVariables(publicConfig.theme);
  }, [publicConfig.theme]);

  return <>{children}</>;
}
