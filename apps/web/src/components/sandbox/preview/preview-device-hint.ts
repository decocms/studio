import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  isSecurePreviewUrl,
  resolvePreviewServerUrl,
} from "@decocms/shared/deco-site-production-url";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { KEYS } from "@/lib/query-keys";

/**
 * Preview-server device hint: a preview server that renders something other
 * than a responsive website (e.g. a mobile app on the web) publishes
 * `GET /.well-known/deco-preview.json` so the canvas opens on the right device.
 * A regular deco site has no such file (404) and keeps today's desktop default.
 */
const WELL_KNOWN_PATH = "/.well-known/deco-preview.json";
const MAX_HINT_BYTES = 4096;
const HINT_TIMEOUT_MS = 3000;

const ViewportSideSchema = z.number().int().min(200).max(4000);

const PreviewDeviceHintSchema = z.object({
  kind: z.string().min(1).max(64),
  device: z.enum(["mobile", "desktop"]),
  viewport: z
    .object({ width: ViewportSideSchema, height: ViewportSideSchema })
    .optional(),
});

export type PreviewDeviceHint = z.infer<typeof PreviewDeviceHintSchema>;
type PreviewDevice = PreviewDeviceHint["device"];

/**
 * Which server the hint is read from: the one the canvas actually renders.
 * Local mode's tunnel replaces the preview server there, so it wins.
 */
export function previewDeviceHintBase(input: {
  localPreviewUrl: string | null | undefined;
  previewServerUrl: string | null | undefined;
}): string | null {
  return input.localPreviewUrl || input.previewServerUrl || null;
}

/** The hint URL for a preview server, or null when Studio must not ask it. */
export function previewDeviceHintUrl(
  previewServerUrl: string | null | undefined,
): string | null {
  if (!previewServerUrl || !isSecurePreviewUrl(previewServerUrl)) return null;
  return new URL(WELL_KNOWN_PATH, previewServerUrl).href;
}

/**
 * Validate a hint response. Anything unexpected — another origin answering,
 * an oversized or malformed body — is no hint at all, never an error.
 */
export function parsePreviewDeviceHint(input: {
  requestUrl: string;
  responseUrl: string;
  body: string;
}): PreviewDeviceHint | null {
  try {
    if (new URL(input.responseUrl).origin !== new URL(input.requestUrl).origin)
      return null;
  } catch {
    return null;
  }
  if (input.body.length > MAX_HINT_BYTES) return null;
  try {
    const parsed = PreviewDeviceHintSchema.safeParse(JSON.parse(input.body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function fetchPreviewDeviceHint(
  url: string,
): Promise<PreviewDeviceHint | null> {
  const res = await fetch(url, {
    mode: "cors",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(HINT_TIMEOUT_MS),
  }).catch(() => null);
  if (!res?.ok) return null;
  // Skip reading a body that announces itself oversized; parse re-checks.
  if (Number(res.headers.get("content-length")) > MAX_HINT_BYTES) return null;
  const body = await res.text().catch(() => null);
  if (body === null) return null;
  return parsePreviewDeviceHint({
    requestUrl: url,
    responseUrl: res.url,
    body,
  });
}

/** One read per preview-server origin; `null` skips the request entirely. */
export function usePreviewDeviceHint(
  previewServerUrl: string | null | undefined,
): PreviewDeviceHint | null {
  const url = previewDeviceHintUrl(previewServerUrl);
  const { data } = useQuery({
    queryKey: KEYS.previewDeviceHint(url ?? ""),
    queryFn: () => fetchPreviewDeviceHint(url!),
    enabled: !!url,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  return url ? (data ?? null) : null;
}

/** Explicit project setting > preview-server hint > desktop. */
export function resolveDefaultPreviewDevice(input: {
  explicit: PreviewDevice | null | undefined;
  hint: PreviewDeviceHint | null;
}): PreviewDevice {
  return input.explicit ?? input.hint?.device ?? "desktop";
}

/** Toolbar badge naming what the preview server says it renders. */
export function previewDeviceHintBadgeKey(
  hint: PreviewDeviceHint | null,
): TranslationKey | null {
  if (hint?.kind === "eitri-app") return "sandbox.preview.deviceHintEitriApp";
  if (hint?.device === "mobile") return "sandbox.preview.deviceHintMobile";
  return null;
}

/**
 * Whether the project's editor surface renders an app rather than a site, so
 * labels say "App Editor". Same server and cached query the canvas reads.
 */
export function useProjectRendersApp(
  project:
    | {
        id: string;
        metadata?: Parameters<typeof resolvePreviewServerUrl>[0];
      }
    | null
    | undefined,
): boolean {
  const { url: localPreviewUrl } = useLocalPreviewUrl(project?.id);
  const previewServerUrl = project
    ? resolvePreviewServerUrl(project.metadata)
    : null;
  const hint = usePreviewDeviceHint(
    previewDeviceHintBase({ localPreviewUrl, previewServerUrl }),
  );
  return hint?.kind === "eitri-app";
}
