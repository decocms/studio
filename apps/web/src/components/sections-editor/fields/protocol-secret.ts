import {
  isWellFormedCiphertext,
  SECRET_BLOCK_TYPE,
} from "@decocms/shared/secret-ciphertext";
import type { StoredSecretState } from "./secret-field";

/** What a next-major `Secret` field holds now. */
export function protocolSecretState(value: unknown): StoredSecretState {
  if (value === undefined || value === null || value === "") return "none";
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).__resolveType === SECRET_BLOCK_TYPE &&
    isWellFormedCiphertext((value as Record<string, unknown>).ciphertext)
  ) {
    return "encrypted";
  }
  return "plaintext";
}
