const REF_COOKIE = "studio_signup_ref";
const SRC_COOKIE = "studio_signup_src";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
// Untrusted query params echoed into a cookie sent on every request — bound them.
const MAX_VALUE_LENGTH = 128;

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${MAX_AGE_SECONDS}; samesite=lax`;
}

/**
 * Persists the WhatsApp Concierge `ref`/`src` query params (if present) into
 * first-party cookies so they survive the rest of the signup funnel — page
 * navigations, email verification, and OAuth round-trips all drop query
 * params but keep cookies. First touch wins: never overwrites an existing
 * cookie from an earlier visit.
 */
export function captureSignupAttribution(search: {
  ref?: string;
  src?: string;
}) {
  if (
    search.ref &&
    search.ref.length <= MAX_VALUE_LENGTH &&
    !getCookie(REF_COOKIE)
  ) {
    setCookie(REF_COOKIE, search.ref);
  }
  if (
    search.src &&
    search.src.length <= MAX_VALUE_LENGTH &&
    !getCookie(SRC_COOKIE)
  ) {
    setCookie(SRC_COOKIE, search.src);
  }
}
