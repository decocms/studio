import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  isSecurePreviewUrl,
  resolvePreviewServerUrl,
} from "@decocms/shared/deco-site-production-url";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { KEYS } from "@/lib/query-keys";

/**
 * Preview-server hint: a preview server that renders a mobile app on the web
 * publishes `GET /.well-known/deco-preview.json` with `kind: "eitri-app"`.
 * That one signal opens the canvas on mobile, repaints edits in place, labels
 * the surface "App Editor" and shows "View on phone". A regular deco site has
 * no such file (404) and keeps today's behavior.
 */
const WELL_KNOWN_PATH = "/.well-known/deco-preview.json";
const MAX_HINT_BYTES = 4096;
const HINT_TIMEOUT_MS = 3000;
const HINT_POLL_MS = 3000;

const EITRI_PLAY_RE =
  /^eitri:\/\/workspace\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const EITRI_LOGIN_RE = /^https:\/\/console\.eitri\.tech\/[^\s"<>]*$/;

const PreviewDeviceHintSchema = z.object({
  kind: z.string().min(1).max(64),
  /**
   * Dev only: the `eitri app start` workspace this preview server follows.
   * "View on phone" shows it as the single QR for Eitri Play. Anything but
   * `eitri://workspace/<uuid>` is dropped, never shown.
   */
  eitriPlay: z.string().regex(EITRI_PLAY_RE).optional().catch(undefined),
  /**
   * Dev only: the Eitri Console link `eitri login` printed, while the CLI next
   * to the preview server waits for the developer to sign in. Only
   * `https://console.eitri.tech/...` is kept.
   */
  eitriLogin: z
    .string()
    .regex(EITRI_LOGIN_RE)
    .max(512)
    .optional()
    .catch(undefined),
});

export type PreviewDeviceHint = z.infer<typeof PreviewDeviceHintSchema>;

/**
 * Which server the hint is read from: the one the canvas actually renders.
 * Local mode's tunnel replaces the preview server there, so it wins.
 */
export function previewDeviceHintBase(input: {
  localPreviewUrl: string | null | undefined;
  /** The sandbox dev server the canvas renders, when the project runs one. */
  sandboxPreviewUrl?: string | null | undefined;
  previewServerUrl: string | null | undefined;
}): string | null {
  return (
    input.localPreviewUrl ||
    input.sandboxPreviewUrl ||
    input.previewServerUrl ||
    null
  );
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
  /** Re-read every few seconds (e.g. while "View on phone" waits for the QR). */
  poll = false,
  /** Remember the answer for this project, so labels outside the canvas agree. */
  rememberForProjectId?: string | null,
): PreviewDeviceHint | null {
  const url = previewDeviceHintUrl(previewServerUrl);
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: KEYS.previewDeviceHint(url ?? ""),
    queryFn: async () => {
      const hint = await fetchPreviewDeviceHint(url!);
      if (rememberForProjectId) {
        const key = rendersAppStorageKey(rememberForProjectId);
        const isApp = hintRendersApp(hint);
        try {
          localStorage.setItem(key, JSON.stringify(isApp));
        } catch {
          // storage unavailable: the label just follows the hint
        }
        queryClient.setQueryData(["localStorage", key], isApp);
      }
      return hint;
    },
    enabled: !!url,
    staleTime: poll ? 0 : 10 * 60 * 1000,
    refetchInterval: poll ? HINT_POLL_MS : false,
    retry: false,
  });
  return url ? (data ?? null) : null;
}

/** The one app signal. */
export const hintRendersApp = (hint: PreviewDeviceHint | null): boolean =>
  hint?.kind === "eitri-app";

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
  // The sandbox URL is only known inside the canvas; it remembers the answer
  // here so the sidebar and header agree even before (or without) a canvas.
  const [rememberedApp] = useLocalStorage<boolean>(
    rendersAppStorageKey(project?.id),
    false,
  );
  return hintRendersApp(hint) || (!!project?.id && rememberedApp);
}

export const rendersAppStorageKey = (projectId: string | null | undefined) =>
  `deco:project-renders-app:${projectId ?? ""}`;
