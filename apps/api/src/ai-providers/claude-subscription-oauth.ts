/**
 * "Log in with your Claude subscription" — Claude Code's own OAuth PKCE flow.
 *
 * The result is a short-lived OAuth access token, not an API key, which is what
 * the sandbox-hosted `claude-code` harness wants (`CLAUDE_CODE_OAUTH_TOKEN`).
 * It therefore lives outside the `ai-providers` registry — none of the
 * registry's surfaces (list models, count tokens, key preview) apply.
 *
 * The redirect URI is Anthropic's own page, which we cannot receive a callback
 * on, so the flow is the copy/paste one: the user authorizes, Anthropic shows
 * them a `code#state` string, and they paste it back into Studio. `state` still
 * round-trips, so the PKCE verifier is bound to the user who started the flow.
 *
 * ⚠️ The client id is ANTHROPIC'S — the one their own client uses, not one
 * Studio registered — which is why it is configurable (`CLAUDE_SUBSCRIPTION_
 * CLIENT_ID`) rather than compiled in. Two consequences, both unverified
 * against a live login:
 *
 *  - `user:inference` is the scope that makes inference bill the person's
 *    plan. `org:create_api_key` — which the CLI historically also requested —
 *    is deliberately NOT requested here: it mints an API key, which is the
 *    billing outcome this feature exists to avoid.
 *  - For an account that has BOTH a claude.ai subscription AND a Console
 *    organization, this client is reported to resolve to the Console org, so
 *    the run bills API credit instead of the plan
 *    (anthropics/claude-code#39445). Nothing here can detect that, so treat
 *    "linked" as "linked", not as proof of who pays.
 */

import { getSettings } from "../settings";

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPE = "user:profile user:inference";
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

const clientId = () => getSettings().claudeSubscriptionClientId;

export function claudeSubscriptionAuthorizeUrl(params: {
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  return url.toString();
}

/**
 * Anthropic hands the user a single `code#state` string. Splitting it here
 * keeps the tool honest about which half is the state it must verify — pasting
 * the whole blob is what people actually do.
 */
export function splitPastedCode(pasted: string): {
  code: string;
  state?: string;
} {
  const [code, state] = pasted.trim().split("#");
  return state ? { code: code!, state } : { code: code! };
}

export interface ClaudeSubscriptionToken {
  accessToken: string;
  expiresAt: Date;
}

export async function exchangeClaudeSubscriptionCode(params: {
  code: string;
  state: string;
  codeVerifier: string;
}): Promise<ClaudeSubscriptionToken> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: params.code,
      state: params.state,
      client_id: clientId(),
      redirect_uri: REDIRECT_URI,
      code_verifier: params.codeVerifier,
    }),
  });
  if (!res.ok) {
    // The body can echo the code back; only the status is safe to surface.
    throw new Error(
      `Claude subscription login failed (${res.status}). The code may have ` +
        `expired — start the login again.`,
    );
  }
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("Claude subscription login returned no access token");
  }
  // Capped at 24h, and 24h when Anthropic sends no `expires_in`: we hold no
  // refresh token, so a stored credential is never kept longer than a day —
  // after that the user re-links.
  const ttlMs = Math.min(
    (json.expires_in ?? MAX_TTL_MS / 1000) * 1000,
    MAX_TTL_MS,
  );
  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + ttlMs),
  };
}
