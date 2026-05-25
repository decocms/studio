/**
 * Hooks that wrap the FILE_OBJECTS_LIST and FILE_PRESIGN_UPLOAD MCP tools.
 * Used by the picker dialog (and any future caller that wants to upload to
 * a configured bucket from the browser).
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

export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  publicUrl: string;
  contentType: string;
  expiresInSeconds: number;
}

export function useFilePickerUpload() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useMutation({
    mutationFn: async (input: {
      configId: string;
      file: File;
    }): Promise<PresignedUpload> => {
      const contentType = input.file.type || "application/octet-stream";
      const presignResult = await client.callTool({
        name: "FILE_PRESIGN_UPLOAD",
        arguments: {
          configId: input.configId,
          filename: input.file.name,
          contentType,
          size: input.file.size,
        },
      });
      const presigned = unwrapToolResult<PresignedUpload>(presignResult);

      const putResponse = await fetch(presigned.uploadUrl, {
        method: "PUT",
        // S3 requires the Content-Type that was signed; if these mismatch,
        // S3 returns 403 SignatureDoesNotMatch.
        headers: { "Content-Type": presigned.contentType },
        body: input.file,
      });
      if (!putResponse.ok) {
        const body = await putResponse.text().catch(() => "");
        throw new Error(
          `Upload failed (${putResponse.status}): ${body.slice(0, 200) || putResponse.statusText}`,
        );
      }
      return presigned;
    },
  });
}
