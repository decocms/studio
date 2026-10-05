import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { useT } from "@/i18n/use-t.ts";
import { servePreviewUrl } from "../content-backend";
import { useContentBackend } from "../use-content-backend";
import type { SandboxConfig } from "./field-props";

/**
 * Uploads to a connected `deco serve`, when it takes them (`describe.assets`):
 * `PUT <server>/assets/<name>`, answered with the path the
 * field stores (`/assets/<name>`). `null` otherwise — on GitHub uploads keep
 * going to Studio's file storage.
 */
export function useServeAssetUpload(
  sandbox: SandboxConfig | null | undefined,
): ((file: File) => Promise<string>) | null {
  const t = useT();
  const backend = useContentBackend(sandbox?.virtualMcpId, sandbox?.branch);
  const { connection } = useDecoServeConnection(sandbox?.virtualMcpId);
  if (
    backend.kind !== "protocol" ||
    backend.source !== "local" ||
    !backend.describe.assets ||
    !connection
  ) {
    return null;
  }
  const { maxBytes } = backend.describe.assets;
  const origin = new URL(connection.endpoint).origin;
  return async (file) => {
    if (file.size > maxBytes) {
      throw new Error(
        t("sectionsEditor.fileField.tooLarge", {
          max: `${Math.floor(maxBytes / (1024 * 1024))} MB`,
        }),
      );
    }
    const res = await fetch(
      `${origin}/assets/${encodeURIComponent(file.name)}`,
      {
        method: "PUT",
        headers: {
          "content-type": file.type || "application/octet-stream",
        },
        body: file,
      },
    );
    const body = (await res.json().catch(() => null)) as {
      path?: unknown;
      error?: { message?: unknown };
    } | null;
    if (!res.ok || typeof body?.path !== "string") {
      const message = body?.error?.message;
      throw new Error(
        typeof message === "string" ? message : `Upload failed (${res.status})`,
      );
    }
    return body.path;
  };
}

/**
 * Where a stored path such as `/assets/logo.png` loads from: on a connected
 * `deco serve`, the site's own dev app, not Studio's origin.
 */
export function useServeAssetSrc(
  sandbox: SandboxConfig | null | undefined,
  path: string,
): string {
  const backend = useContentBackend(sandbox?.virtualMcpId, sandbox?.branch);
  const preview = servePreviewUrl(backend);
  return preview && path.startsWith("/") && !path.startsWith("//")
    ? new URL(path, preview).href
    : path;
}
