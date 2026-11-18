import {
  COPILOT_INTEGRATION_ID,
  GITHUB_COPILOT_BASE_URL,
} from "../../harnesses/claude-code-env";

/** Long enough for a slow GitHub, short enough that linking never hangs. */
const VERIFY_TIMEOUT_MS = 8_000;
/** GitHub's reason is one short line; anything longer is not worth showing. */
const REASON_MAX_CHARS = 200;

/**
 * Proves a token can call Copilot the way a run will, before it is stored or
 * shared. Copilot answers the models list with the same auth check as
 * `/v1/messages` (same base URL and integration header as the run's env), and
 * the list has no side effect. A token without the "Copilot Requests"
 * permission is refused here instead of failing every run that uses it.
 *
 * Fails closed: if Copilot cannot be reached the token is not accepted.
 */
export async function verifyCopilotToken(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(`${GITHUB_COPILOT_BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Copilot-Integration-Id": COPILOT_INTEGRATION_ID,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    throw new Error(
      "Couldn't reach GitHub Copilot to verify the token. Try again in a moment.",
    );
  }
  if (res.ok) {
    await res.body?.cancel();
    return;
  }
  const reason = await readReason(res, token);
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "GitHub Copilot rejected this token" +
        (reason ? ` (${reason})` : "") +
        ". Create a fine-grained token with the Copilot Requests permission " +
        "on an account that has a Copilot seat, then link it again.",
    );
  }
  throw new Error(
    `Couldn't verify the token with GitHub Copilot (HTTP ${res.status}). Try again in a moment.`,
  );
}

/** GitHub's own explanation, first line only, with the token scrubbed out. */
async function readReason(res: Response, token: string): Promise<string> {
  const body = await res.text().catch(() => "");
  const line = (body.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.split(token).join("[token]").slice(0, REASON_MAX_CHARS);
}

/** Swapped by tests; the tools call through it so none of them hit GitHub. */
export const copilotTokenVerifier = { verify: verifyCopilotToken };
