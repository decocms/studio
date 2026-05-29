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
import { setOAuthRedirectOrigin } from "@decocms/mesh-sdk";
import { usePreferences } from "@/web/hooks/use-preferences";

async function fetchPublicConfig(): Promise<PublicConfig> {
  performance.mark("mesh:config-fetch:start");
  try {
    const response = await fetch("/api/config");
    if (!response.ok) {
      throw new Error("Failed to load public configuration");
    }
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || "Failed to load public configuration");
    }
    return data.config;
  } finally {
    performance.mark("mesh:config-fetch:end");
    performance.measure(
      "mesh:config-fetch",
      "mesh:config-fetch:start",
      "mesh:config-fetch:end",
    );
  }
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

  const [preferences] = usePreferences();

  // Set OAuth redirect origin for proxy environments (e.g. tokyo.localhost → localhost:3000)
  if (publicConfig.internalUrl) {
    setOAuthRedirectOrigin(publicConfig.internalUrl);
  }

  // Inject theme variables synchronously before paint to avoid FOUC
  // useLayoutEffect is correct here (not useEffect) for DOM mutations that affect visual appearance
  useLayoutEffect(() => {
    injectThemeVariables(publicConfig.theme);
  }, [publicConfig.theme]);

  // Apply dark/light class based on user preference
  useLayoutEffect(() => {
    const root = document.documentElement;

    // Keep <meta name="theme-color"> in sync with the resolved theme so the
    // PWA title-bar (Window Controls Overlay) matches the app chrome. We
    // read --sidebar from documentElement (which may be oklch) and round-trip
    // through canvas's fillStyle setter — the setter normalises any valid CSS
    // color to canonical hex/rgb format, which is exactly what the meta tag
    // accepts. Runs *after* the dark class toggle so the var resolves to the
    // right value for the active theme.
    const applyMeta = () => {
      const meta = document.querySelector<HTMLMetaElement>(
        'meta[name="theme-color"]',
      );
      if (!meta) return;
      const raw = getComputedStyle(root).getPropertyValue("--sidebar").trim();
      if (!raw) return;
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) return;
      // Canvas rejects invalid values silently (keeps the prior fillStyle), so
      // seed with a sentinel we can detect. CSS.supports("color", x) is too
      // lax — it accepts CSS-wide keywords (inherit, unset, …) that fillStyle
      // does not parse, which would leave the meta tag stuck on the sentinel.
      ctx.fillStyle = "#010203";
      const sentinel = ctx.fillStyle as string;
      ctx.fillStyle = raw;
      const normalised = ctx.fillStyle as string;
      if (normalised === sentinel) return;
      meta.content = normalised;
    };

    if (preferences.theme === "dark") {
      root.classList.add("dark");
      applyMeta();
      return;
    }

    if (preferences.theme === "light") {
      root.classList.remove("dark");
      applyMeta();
      return;
    }

    // System mode: follow OS preference and listen for changes
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (dark: boolean) => {
      root.classList.toggle("dark", dark);
      applyMeta();
    };

    apply(mq.matches);

    const handler = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preferences.theme]);

  return <>{children}</>;
}
