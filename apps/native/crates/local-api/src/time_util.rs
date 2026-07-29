//! Calendar math and epoch clocks shared across families.
//!
//! Two wire contracts hang off this arithmetic — the threads DB's RFC 3339
//! `created_at`/`updated_at` strings and the WebDAV layer's HTTP dates — and
//! each used to carry its own transcription of the same Howard Hinnant
//! `civil_from_days` algorithm. Two transcriptions of one algorithm is a
//! drift channel in code where an off-by-one is a wrong DATE, so the
//! algorithm lives here once and each consumer formats on top.
//!
//! `crate::tasks::now_ms` stays where it is — it is the task registry's
//! canonical millisecond clock with many established importers — and this
//! module holds its seconds sibling for the sites that need epoch seconds.

use std::time::{SystemTime, UNIX_EPOCH};

/// Epoch seconds, `0` when the clock reads before 1970 (never on a working
/// system; failing closed beats panicking in a request path).
///
/// The millisecond sibling is [`crate::tasks::now_ms`].
pub(crate) fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Howard Hinnant's `civil_from_days` — days since the Unix epoch to
/// `(year, month, day)`, proleptic Gregorian, no leap seconds. The same
/// algorithm libc++'s `<chrono>` uses, valid across the whole `SystemTime`
/// range.
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// The inverse of [`civil_from_days`] — `(year, month, day)` to days since
/// the Unix epoch.
pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two directions must invert each other across the whole range the
    /// formats care about — one transcription slip here is a wrong date on
    /// the wire.
    #[test]
    fn civil_and_days_invert_each_other() {
        for days in [-719_468, -1, 0, 1, 19_000, 20_500, 2_932_896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m as i64, d as i64), days, "{days}");
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2026-07-29 is day 20663.
        assert_eq!(civil_from_days(20_663), (2026, 7, 29));
        assert_eq!(days_from_civil(2026, 7, 29), 20_663);
    }
}
