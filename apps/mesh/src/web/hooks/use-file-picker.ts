/**
 * File picker hooks: list objects (via FILE_OBJECTS_LIST MCP tool) and
 * upload through the org-scoped proxy endpoint. Uploads do not use the
 * browser→S3 presigned PUT path because that would require CORS on every
 * customer bucket; instead we POST multipart to mesh and let it stream
 * to S3 server-side.
 */

import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useMutation, useQuery } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import { unwrapToolResult } from "../lib/unwrap-tool-result";

export interface PickerObject {
  key: string;
  size: number;
  lastModified: string | null;
  publicUrl: string;
}

export interface ListObjectsResponse {
  items: PickerObject[];
  nextCursor: string | null;
}

export function useFilePickerObjects(params: {
  configId: string | null;
  enabled?: boolean;
}) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.filePickerObjects(org.id, params.configId),
    enabled: params.enabled !== false && !!params.configId,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await client.callTool({
        name: "FILE_OBJECTS_LIST",
        arguments: { configId: params.configId },
      });
      return unwrapToolResult<ListObjectsResponse>(result);
    },
  });
}

export interface UploadResult {
  key: string;
  publicUrl: string;
  contentType: string;
  size: number;
}

/**
 * Upload a file to a configured bucket via the mesh proxy endpoint. We
 * don't presign + PUT directly from the browser because that requires
 * per-bucket CORS configuration on every customer bucket (S3, GCS, R2),
 * which is too much friction for a CMS. The proxy streams through mesh
 * once and avoids the cross-origin problem entirely.
 *
 * The file is sent as the raw POST body (NOT multipart) so the server
 * can stream it straight to S3 via `@aws-sdk/lib-storage` without ever
 * buffering the full payload — necessary for the 100 MB cap.
 */
export function useFilePickerUpload() {
  const { org } = useProjectContext();

  return useMutation({
    mutationFn: async (input: {
      configId: string;
      file: File;
    }): Promise<UploadResult> => {
      const contentType = input.file.type || "application/octet-stream";

      const response = await fetch(
        `/api/${encodeURIComponent(org.slug)}/file-configs/${encodeURIComponent(input.configId)}/upload?filename=${encodeURIComponent(input.file.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: input.file,
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let message = `${response.status} ${response.statusText}`;
        try {
          const parsed = JSON.parse(text) as { message?: string };
          if (parsed.message) message = parsed.message;
        } catch {
          if (text) message = text.slice(0, 200);
        }
        throw new Error(`Upload failed: ${message}`);
      }

      return (await response.json()) as UploadResult;
    },
  });
}
