//! Tiny, dependency-free UNIX-time helpers shared by [`crate::login`] and
//! [`crate::bridge`] — both mint a [`crate::tokens::StoredSession`] and need
//! the exact same `created_at`/expiry-math primitives. Extracted here
//! (rather than duplicated) the moment a SECOND call site needed them —
//! see this repo's "leave no dead code" / DRY guidance.

/// Current UNIX time in whole seconds. Never panics (falls back to `0` on a
/// pre-1970 system clock, which only matters on a badly misconfigured
/// machine and is informational-only here — nothing security-sensitive
/// hinges on this fallback).
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// A minimal, dependency-free RFC3339 (UTC, second precision) formatter —
/// avoids pulling in `chrono`/`time` for one timestamp field that's
/// informational only (mirrors `session.ts`'s `createdAt`, never parsed
/// back for expiry math, which uses `expires_at` instead).
pub fn now_rfc3339() -> String {
    let secs = now_unix();
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (h, m, s) = (
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
    );
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Howard Hinnant's `civil_from_days` algorithm (public domain) — converts
/// a day count since the Unix epoch into a proleptic-Gregorian
/// (year, month, day). Small, well-known, dependency-free.
#[expect(
    clippy::arithmetic_side_effects,
    clippy::as_conversions,
    reason = "Hinnant's kernel verbatim: `z` comes from `now_unix()/86_400`, so \
              every intermediate is proven in range, and `doe`/`yoe`/`doy`/`mp` \
              are bounded by construction. Rewriting the ops as `checked_*` \
              would obscure the published algorithm without adding a reachable \
              check. Mirrors `local_api::time_util::civil_from_days`, which \
              carries the round-trip test."
)]
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_rfc3339_produces_a_parseable_shape() {
        let s = now_rfc3339();
        assert_eq!(s.len(), 20);
        assert!(s.ends_with('Z'));
        assert_eq!(s.as_bytes()[4], b'-');
        assert_eq!(s.as_bytes()[10], b'T');
    }

    #[test]
    fn now_unix_is_a_plausible_recent_timestamp() {
        // Sanity bound, not a real clock test: anything after 2020-01-01 and
        // before a comfortably-far future date.
        let t = now_unix();
        assert!(t > 1_577_836_800, "expected a post-2020 timestamp");
        assert!(t < 4_102_444_800, "expected a pre-2100 timestamp");
    }
}
