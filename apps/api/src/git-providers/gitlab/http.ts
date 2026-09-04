/**
 * GitLab REST v4 plumbing shared by every GitLab caller: the API base for a
 * host, the headers and timeout one call sends, and the conversion of a
 * refusal into `GitProviderError`.
 *
 * It exists because three clients need the same transport and only one of them
 * (`gitlab/client.ts`) had it — GET-only and module-private, so the content
 * client re-stated it to get POST/PUT/DELETE and the change-request client
 * would have made three copies of the same 404-is-null rule.
 *
 * Nothing here decides which token to send; callers pass one.
 */

import { apiBaseUrlFor } from "@decocms/shared/git-providers";
import { GitProviderError } from "../types";
import { gitlabRetryAfterMs } from "./client";

/** Matches every other GitLab caller: one REST call, not a download. */
const GITLAB_TIMEOUT_MS = 15_000;

/** REST v4 base for a GitLab host — gitlab.com and self-hosted alike. */
export function gitlabApiBaseUrl(host: string): string {
  return apiBaseUrlFor("gitlab", host);
}

/**
 * The human-readable half of a GitLab error body. GitLab is inconsistent:
 * `{"message": "..."}` for most refusals, `{"message": ["..."]}` for merge
 * requests, `{"message": {"base": ["..."]}}` for model validation, and
 * `{"error": "..."}` for OAuth-ish failures. The conflict classifiers match on
 * this text, so flattening every shape is load-bearing, not cosmetic.
 */
export function gitlabErrorMessage(bodyText: string): string {
  const flatten = (value: unknown): string[] => {
    if (typeof value === "string") return value.length > 0 ? [value] : [];
    if (Array.isArray(value)) return value.flatMap(flatten);
    if (value !== null && typeof value === "object") {
      return Object.values(value).flatMap(flatten);
    }
    return [];
  };
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const parts = [
        ...flatten(record.message),
        ...flatten(record.error),
        ...flatten(record.error_description),
      ];
      if (parts.length > 0) return parts.join("; ");
    }
  } catch {
    // Not JSON: an HTML error page or an empty body. Fall through to the text.
  }
  return bodyText.slice(0, 300);
}

/** A `GitProviderError` for a non-2xx response, reading its body for the message. */
export async function gitlabFailure(res: Response): Promise<GitProviderError> {
  const text = await res.text().catch(() => "");
  const detail = text ? gitlabErrorMessage(text) : res.statusText;
  return new GitProviderError({
    provider: "gitlab",
    status: res.status,
    message: `GitLab API ${res.status}: ${detail}`,
    retryAfterMs: res.status === 429 ? gitlabRetryAfterMs(res.headers) : null,
  });
}

export interface GitlabFetchInit {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  accept?: string;
  timeoutMs?: number;
}

/**
 * One authenticated REST call. A network or timeout failure becomes a
 * `GitProviderError` with `status: 0`; every response — including 4xx — is
 * returned, so a caller can give 404 and 409 their endpoint-specific meaning.
 */
export async function gitlabFetch(
  url: string,
  token: string,
  init: GitlabFetchInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: init.accept ?? "application/json",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? GITLAB_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new GitProviderError({
      provider: "gitlab",
      status: 0,
      message: `GitLab request failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    });
  }
}
