import { VtexConfigForm } from "./vtex-config-form.tsx";
import { GoogleAnalyticsConfigForm } from "./google-analytics-config-form.tsx";
import { GoogleSearchConsoleConfigForm } from "./google-search-console-config-form.tsx";
import { GitHubConfigForm } from "./github-config-form.tsx";
import type { CompanionFormComponent } from "./types.ts";

export const COMPANION_CONFIG_FORMS: Record<string, CompanionFormComponent> = {
  vtex: VtexConfigForm,
  "google-analytics": GoogleAnalyticsConfigForm,
  "google-search-console": GoogleSearchConsoleConfigForm,
  github: GitHubConfigForm,
};
