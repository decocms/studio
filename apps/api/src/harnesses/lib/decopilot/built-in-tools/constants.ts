export const BROWSERLESS_BASE_URL = "https://chrome.browserless.io";

/** Results above this threshold are offloaded to blob storage. */
export const LARGE_RESULT_TOKEN_THRESHOLD = 32_000;

// Browserless calls have no bound beyond the inner page.goto timeout (30s) —
// if Browserless is unresponsive the outer fetch can hang the harness run
// forever. Give it headroom over the inner timeout instead of leaving it
// unbounded.
export const BROWSERLESS_FETCH_TIMEOUT_MS = 45_000;
