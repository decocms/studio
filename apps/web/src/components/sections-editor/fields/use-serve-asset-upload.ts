import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { useContentBackend } from "../use-content-backend";
import type { SandboxConfig } from "./field-props";

/**
 * Uploads to a connected `deco serve`, when it takes them (`describe.assets`):
 * `PUT <server>/assets/<name>` with its token, answered with the path the
 * field stores (`/assets/<name>`). `null` otherwise — on GitHub uploads keep
 * going to Studio's file storage.
 */
export function useServeAssetUpload(
  sandbox: SandboxConfig | null | undefined,
): ((file: File) => Promise<string>) | null {
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
  const origin = new URL(connection.endpoint).origin;
  return async (file) => {
    const res = await fetch(
      `${origin}/assets/${encodeURIComponent(file.name)}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${connection.token}`,
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
