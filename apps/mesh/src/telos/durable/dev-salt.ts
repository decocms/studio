// Dev-only reset seam. A failed pursuit/capability run claims its OAOO workflow
// id (or a debounce key), so re-triggering the same org resumes the dead record
// instead of starting fresh — in prod that's the point (exactly-once), but in dev
// it forces a code edit (bumping a capability `version`) just to retry.
//
// Setting TELOS_DEV_SALT to any new value salts every telos workflow id + key, so
// a fresh value = a clean slate, no code change. Ignored in production (NODE_ENV
// === "production") so prod ids stay stable and exactly-once holds.
export function telosSalt(): string {
  if (process.env.NODE_ENV === "production") return "";
  const salt = process.env.TELOS_DEV_SALT;
  return salt ? `:${salt}` : "";
}
