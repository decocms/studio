import { OBJECT_STORAGE_BINDING } from "@decocms/bindings/object-storage";
import type { StudioContext } from "../../core/studio-context";
import type { BoundObjectStorage } from "../../object-storage/bound-object-storage";

export function requireObjectStorage(ctx: StudioContext): BoundObjectStorage {
  if (!ctx.objectStorage) {
    throw new Error(
      "Object storage is not configured. Ensure S3 credentials are set.",
    );
  }
  return ctx.objectStorage;
}

// Re-export schemas from the canonical OBJECT_STORAGE_BINDING definition
// so tool validation stays in sync with the advertised binding contract.
function getBinding<N extends (typeof OBJECT_STORAGE_BINDING)[number]["name"]>(
  name: N,
) {
  return OBJECT_STORAGE_BINDING.find((b) => b.name === name) as Extract<
    (typeof OBJECT_STORAGE_BINDING)[number],
    { name: N }
  >;
}

const listObjects = getBinding("LIST_OBJECTS");
export const ListObjectsInputSchema = listObjects.inputSchema;
export const ListObjectsOutputSchema = listObjects.outputSchema;

const getObjectMetadata = getBinding("GET_OBJECT_METADATA");
export const GetObjectMetadataInputSchema = getObjectMetadata.inputSchema;
export const GetObjectMetadataOutputSchema = getObjectMetadata.outputSchema;

const getPresignedUrl = getBinding("GET_PRESIGNED_URL");
export const GetPresignedUrlInputSchema = getPresignedUrl.inputSchema;
export const GetPresignedUrlOutputSchema = getPresignedUrl.outputSchema;

const putPresignedUrl = getBinding("PUT_PRESIGNED_URL");
export const PutPresignedUrlInputSchema = putPresignedUrl.inputSchema;
export const PutPresignedUrlOutputSchema = putPresignedUrl.outputSchema;

const deleteObject = getBinding("DELETE_OBJECT");
export const DeleteObjectInputSchema = deleteObject.inputSchema;
export const DeleteObjectOutputSchema = deleteObject.outputSchema;

const deleteObjects = getBinding("DELETE_OBJECTS");
export const DeleteObjectsInputSchema = deleteObjects.inputSchema;
export const DeleteObjectsOutputSchema = deleteObjects.outputSchema;
