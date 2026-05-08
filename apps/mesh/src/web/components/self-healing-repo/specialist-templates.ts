import brokenLinkFinderInstructions from "./prompts/broken-link-finder.md?raw";
import seoAuditorInstructions from "./prompts/seo-auditor.md?raw";
import performanceWatchdogInstructions from "./prompts/performance-watchdog.md?raw";

const DAILY_9AM_UTC = "0 9 * * *";

export interface SpecialistTemplate {
  id: string;
  title: string;
  description: string;
  icon: string;
  instructions: string;
  siteDiagnosticsTools: string[];
  cron: string;
  /** GitHub label the orchestrator uses to filter open issues for this specialist. */
  issueLabel: string;
  /** Body of the SUBTASK prompt for the specialist (input the specialist parses). */
  buildSubtaskInput: (args: { siteRootUrl: string }) => string;
}

export const SPECIALIST_TEMPLATES: SpecialistTemplate[] = [
  {
    id: "seo-auditor",
    title: "SEO Auditor",
    description: "Monitors websites for SEO improvements.",
    icon: "icon://FileSearch02?color=purple",
    instructions: seoAuditorInstructions,
    siteDiagnosticsTools: [
      "audit_seo",
      "fetch_page",
      "crawl_site",
      "render_page",
    ],
    cron: DAILY_9AM_UTC,
    issueLabel: "agent:seo",
    buildSubtaskInput: ({ siteRootUrl }) => `urls:\n  - ${siteRootUrl}\n`,
  },
  {
    id: "performance-watchdog",
    title: "Performance Watchdog",
    description: "Monitors websites for Core Web Vitals problems.",
    icon: "icon://Speedometer03?color=emerald",
    instructions: performanceWatchdogInstructions,
    siteDiagnosticsTools: ["fetch_page", "pagespeed_insights", "crawl_site"],
    cron: DAILY_9AM_UTC,
    issueLabel: "agent:perf",
    buildSubtaskInput: ({ siteRootUrl }) => `site_root_url: ${siteRootUrl}\n`,
  },
  {
    id: "broken-link-finder",
    title: "Broken Link Finder",
    description: "Monitors websites for broken links.",
    icon: "icon://LinkBroken01?color=rose",
    instructions: brokenLinkFinderInstructions,
    siteDiagnosticsTools: ["collect_site_links", "check_urls"],
    cron: DAILY_9AM_UTC,
    issueLabel: "agent:links",
    buildSubtaskInput: ({ siteRootUrl }) => `site_root_url: ${siteRootUrl}\n`,
  },
];

export interface ComingSoonSpecialist {
  id: string;
  title: string;
  description: string;
  icon: string;
}

export const COMING_SOON_SPECIALISTS: ComingSoonSpecialist[] = [
  {
    id: "log-monitor",
    title: "Log Monitor",
    description:
      "Monitors websites for errors and warnings on the server. Outputs GitHub issues.",
    icon: "icon://MessageAlertCircle?color=amber",
  },
];
