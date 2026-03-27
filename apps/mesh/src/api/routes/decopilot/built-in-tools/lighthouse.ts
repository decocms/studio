/**
 * Lighthouse Audit Tool
 *
 * Runs a Lighthouse performance audit.
 * Dual-mode:
 * - Remote: Browserless REST API (/performance endpoint)
 * - Local: lighthouse CLI + local Chromium (installed via npm install -g lighthouse)
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import {
  urlInput,
  getBrowserMode,
  getBrowserlessToken,
  getHttpBaseUrl,
  findLocalChromium,
} from "./browserless";

export const InputSchema = z.object({
  url: urlInput.describe("The URL to audit"),
  categories: z
    .array(
      z.enum(["performance", "accessibility", "seo", "best-practices", "pwa"]),
    )
    .default(["performance", "accessibility", "seo", "best-practices"])
    .describe("Lighthouse categories to audit"),
  device: z
    .enum(["desktop", "mobile"])
    .default("mobile")
    .describe("Device emulation for the audit"),
});

export function createLighthouseTool() {
  return tool({
    description:
      "Run a Lighthouse audit on a URL. Returns Core Web Vitals (LCP, CLS, TBT), " +
      "performance score, accessibility score, SEO score, and best-practices score. " +
      "Works with Browserless (remote) or local lighthouse CLI + Chromium.",
    inputSchema: zodSchema(InputSchema),
    execute: async (input: z.infer<typeof InputSchema>) => {
      const mode = getBrowserMode();

      let data: Record<string, unknown>;

      if (mode === "remote") {
        data = await runRemoteLighthouse(input);
      } else {
        data = await runLocalLighthouse(input);
      }

      // Extract scores and key metrics from the Lighthouse response
      const categories = (data?.categories ?? {}) as Record<string, unknown>;
      const audits = (data?.audits ?? {}) as Record<string, unknown>;

      const scores: Record<string, number | null> = {};
      for (const [key, cat] of Object.entries(categories)) {
        scores[key] = (cat as { score?: number })?.score ?? null;
      }

      // Extract Core Web Vitals
      const cwv = {
        lcp: extractAudit(audits, "largest-contentful-paint"),
        cls: extractAudit(audits, "cumulative-layout-shift"),
        tbt: extractAudit(audits, "total-blocking-time"),
        fcp: extractAudit(audits, "first-contentful-paint"),
        si: extractAudit(audits, "speed-index"),
        tti: extractAudit(audits, "interactive"),
      };

      // Extract key diagnostic audits
      const diagnostics = [
        "render-blocking-resources",
        "unused-javascript",
        "unused-css-rules",
        "modern-image-formats",
        "uses-optimized-images",
        "uses-text-compression",
        "uses-responsive-images",
        "efficient-animated-content",
        "dom-size",
        "critical-request-chains",
        "redirects",
        "uses-long-cache-ttl",
        "total-byte-weight",
        "mainthread-work-breakdown",
        "bootup-time",
        "font-display",
        "third-party-summary",
      ]
        .map((id) => extractAudit(audits, id))
        .filter((a) => a !== null);

      return {
        url: input.url,
        device: input.device,
        scores,
        coreWebVitals: cwv,
        diagnostics,
        lighthouseVersion: (data?.lighthouseVersion as string) ?? null,
        mode: mode === "remote" ? "browserless" : "local",
      };
    },
  });
}

/** Remote mode — use Browserless Performance REST API */
async function runRemoteLighthouse(
  input: z.infer<typeof InputSchema>,
): Promise<Record<string, unknown>> {
  const token = getBrowserlessToken();
  const baseUrl = getHttpBaseUrl();
  const endpoint = `${baseUrl}/performance?token=${token}`;

  const body = {
    url: input.url,
    config: {
      extends: "lighthouse:default",
      settings: {
        onlyCategories: input.categories,
        formFactor: input.device,
        screenEmulation:
          input.device === "desktop"
            ? {
                mobile: false,
                width: 1350,
                height: 940,
                deviceScaleFactor: 1,
              }
            : {
                mobile: true,
                width: 412,
                height: 823,
                deviceScaleFactor: 1.75,
              },
        throttling:
          input.device === "desktop"
            ? {
                rttMs: 40,
                throughputKbps: 10240,
                cpuSlowdownMultiplier: 1,
              }
            : undefined,
      },
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Lighthouse API returned ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  return response.json();
}

/** Local mode — run lighthouse CLI with local Chromium */
async function runLocalLighthouse(
  input: z.infer<typeof InputSchema>,
): Promise<Record<string, unknown>> {
  const chromiumPath = findLocalChromium();

  // Check if lighthouse CLI is available
  const { execSync: execSyncLookup } = await import("node:child_process");
  let lighthouseBin: string;
  try {
    lighthouseBin = execSyncLookup("which lighthouse", {
      encoding: "utf-8",
    }).trim();
  } catch {
    throw new Error(
      "lighthouse CLI not found. Install it with: npm install -g lighthouse\n" +
        "Then retry. For full features including Lighthouse, also consider setting BROWSERLESS_TOKEN.",
    );
  }

  if (!chromiumPath) {
    throw new Error(
      "Local Chromium not found. Install with: npx playwright install chromium",
    );
  }

  const categories = input.categories.map((c) => `--only-categories=${c}`);
  const preset =
    input.device === "desktop" ? "--preset=desktop" : "--preset=perf";

  const { execFileSync } = await import("node:child_process");
  const args = [
    input.url,
    "--output=json",
    "--chrome-flags=--headless --no-sandbox --disable-gpu",
    `--chromePath=${chromiumPath}`,
    preset,
    ...categories,
    "--quiet",
  ];

  try {
    const output = execFileSync(lighthouseBin, args, {
      encoding: "utf-8",
      timeout: 120_000,
      maxBuffer: 50 * 1024 * 1024, // 50MB — lighthouse JSON can be large
      env: { ...process.env, CHROME_PATH: chromiumPath },
    });

    return JSON.parse(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Local lighthouse failed: ${message.slice(0, 500)}. ` +
        "Ensure lighthouse and Chromium are installed correctly.",
    );
  }
}

function extractAudit(
  audits: Record<string, unknown>,
  id: string,
): {
  id: string;
  title: string;
  score: number | null;
  displayValue: string | null;
  numericValue: number | null;
} | null {
  const audit = audits[id] as {
    title?: string;
    score?: number;
    displayValue?: string;
    numericValue?: number;
  } | null;
  if (!audit) return null;
  return {
    id,
    title: audit.title ?? id,
    score: audit.score ?? null,
    displayValue: audit.displayValue ?? null,
    numericValue: audit.numericValue ?? null,
  };
}
