import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { useT } from "@/i18n/use-t.ts";
import { buildSandboxUrl } from "@/sdk/sandbox-url";
import { servePreviewUrl } from "../content-backend";
import { useContentBackend } from "../use-content-backend";
import type { SandboxConfig } from "./field-props";

/**
 * Uploads to a connected `deco serve`, when it takes them (`describe.assets`):
 * `PUT <server>/assets/<name>`, answered with the path the
 * field stores (`/assets/<name>`). A sandbox's daemon takes them the same way,
 * through Studio's sandbox proxy, into its working tree. `null` otherwise —
 * on GitHub uploads keep going to Studio's file storage.
 */
export function useServeAssetUpload(
  sandbox: SandboxConfig | null | undefined,
): ((file: File) => Promise<string>) | null {
  const t = useT();
  const backend = useContentBackend(sandbox?.virtualMcpId, sandbox?.branch);
  const { connection } = useDecoServeConnection(sandbox?.virtualMcpId);
  if (
    backend.kind !== "protocol" ||
    !backend.describe.assets ||
    !sandbox ||
    (backend.source === "local" ? !connection : backend.source !== "sandbox")
  ) {
    return null;
  }
  const { maxBytes } = backend.describe.assets;
  const uploadUrl = (name: string) =>
    backend.source === "sandbox"
      ? buildSandboxUrl(sandbox, `assets/${encodeURIComponent(name)}`)
      : `${new URL(connection!.endpoint).origin}/assets/${encodeURIComponent(name)}`;
  return async (file) => {
    if (file.size > maxBytes) {
      throw new Error(
        t("sectionsEditor.fileField.tooLarge", {
          max: `${Math.floor(maxBytes / (1024 * 1024))} MB`,
        }),
      );
    }
    if (backend.describe.readOnly) {
      throw new Error(t("decoServe.upload.readOnly", { name: file.name }));
    }
    let res: Response;
    try {
      res = await fetch(uploadUrl(file.name), {
        method: "PUT",
        headers: {
          "content-type": file.type || "application/octet-stream",
        },
        body: file,
      });
    } catch {
      throw new Error(t("decoServe.upload.serverGone", { name: file.name }));
    }
    const body = (await res.json().catch(() => null)) as {
      path?: unknown;
      error?: { message?: unknown };
    } | null;
    if (!res.ok || typeof body?.path !== "string") {
      const message = body?.error?.message;
      throw new Error(
        t("decoServe.upload.failed", {
          name: file.name,
          detail: typeof message === "string" ? message : `HTTP ${res.status}`,
        }),
      );
    }
    return body.path;
  };
}

/**
 * Where a stored path such as `/assets/logo.png` loads from: on a connected
 * `deco serve`, the site's own dev app, not Studio's origin; in a sandbox,
 * its dev server.
 */
export function useServeAssetSrc(
  sandbox: SandboxConfig | null | undefined,
  path: string,
): string {
  const backend = useContentBackend(sandbox?.virtualMcpId, sandbox?.branch);
  const preview =
    backend.kind === "protocol" && backend.source === "sandbox"
      ? (sandbox?.previewUrl ?? null)
      : servePreviewUrl(backend);
  return preview && path.startsWith("/") && !path.startsWith("//")
    ? new URL(path, preview).href
    : path;
}
