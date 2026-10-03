import {
  ContentProtocolError,
  ErrorCode,
} from "@decocms/shared/blocks-protocol";

/** Why a `deco serve` request failed: a bad token (the server restarted) or no server. */
export function decoServeErrorReason(
  error: unknown,
): "unauthorized" | "unreachable" {
  return error instanceof ContentProtocolError &&
    error.code === ErrorCode.Unauthorized
    ? "unauthorized"
    : "unreachable";
}
