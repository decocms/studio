//! Pure WebDAV/1 protocol translation — request path parsing, `href`
//! construction, the PROPFIND multistatus XML shape, `Range` parsing and
//! HTTP-date formatting. No I/O, no upstream, no axum state, so every rule
//! rclone actually depends on is unit-testable in isolation.
//!
//! Port of the non-I/O half of `packages/sandbox/daemon/org-fs/webdav.ts`
//! (`xmlEscape`, `pathFromUrl`, `basename`, `isMacJunk`, `hrefFor`,
//! `propResponse`, `multistatus`, `parseRange`), with one deliberate
//! addition: the TS daemon ran ONE server per mounted volume at the origin
//! root, so its hrefs started at `/`. Here every volume is served under a
//! shared prefix (`/_sandbox/orgfs/<org>/<volume>`), and rclone's webdav
//! backend computes an entry's remote name by slicing its endpoint path off
//! the front of `href` (`backend/webdav/webdav.go`'s `listAll`). So hrefs
//! MUST carry that prefix or every listing resolves to the wrong name.

use std::time::{SystemTime, UNIX_EPOCH};

/// Advertised in `Allow` and `OPTIONS` — exactly what rclone's webdav
/// backend (`--webdav-vendor other`, no locking) exercises.
pub const DAV_METHODS: &str = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, PROPPATCH";

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// One entry in a volume. Mirrors `org-fs/api.ts::OrgFsNode`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgFsNode {
    /// Normalized in-volume path, no leading/trailing slash. `""` is the root.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Epoch seconds; rendered as `getlastmodified`.
    pub updated_at_secs: i64,
}

/// A request resolved against the mount: which org/volume it addresses, the
/// in-volume path, and the URL prefix every `href` in the response must carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestTarget {
    pub org: String,
    pub volume: String,
    /// Decoded, normalized in-volume path (`""` = volume root).
    pub path: String,
    /// e.g. `/_sandbox/orgfs/acme/home` — no trailing slash.
    pub mount_prefix: String,
}

/// Why a request path could not be resolved to a volume entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetError {
    /// Fewer than `<org>/<volume>` segments — not addressable.
    NotAVolume,
    /// A `.` or `..` segment. `OrgFs` normalizes these upstream anyway;
    /// refusing here keeps the local surface from having an opinion at all.
    Traversal,
}

pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

fn decode(segment: &str) -> String {
    urlencoding::decode(segment)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| segment.to_string())
}

/// Resolve `<org>/<volume>/<in-volume path>` from the router-relative path,
/// deriving the href prefix from the original (pre-`nest()`) path so this
/// module never hardcodes where it is mounted.
pub fn parse_target(
    original_path: &str,
    relative_path: &str,
) -> Result<RequestTarget, TargetError> {
    let rel: Vec<&str> = relative_path.split('/').filter(|s| !s.is_empty()).collect();
    if rel.len() < 2 {
        return Err(TargetError::NotAVolume);
    }
    let rest = &rel[2..];
    let mut segments = Vec::with_capacity(rest.len());
    for raw in rest {
        let decoded = decode(raw);
        if decoded == "." || decoded == ".." {
            return Err(TargetError::Traversal);
        }
        segments.push(decoded);
    }

    let original: Vec<&str> = original_path.split('/').filter(|s| !s.is_empty()).collect();
    let prefix_len = original.len().saturating_sub(rest.len());
    let mount_prefix = format!("/{}", original[..prefix_len].join("/"));

    Ok(RequestTarget {
        org: decode(rel[0]),
        volume: decode(rel[1]),
        path: segments.join("/"),
        mount_prefix,
    })
}

pub fn basename(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// macOS metadata noise: AppleDouble xattr sidecars (`._*`) and Finder's
/// `.DS_Store`. Written through the mount on every mac file operation —
/// without this they'd sync into the org volume for every other consumer to
/// see. PUTs are accepted-and-dropped rather than rejected: a failing
/// AppleDouble write breaks the whole Finder copy (rclone #7503).
pub fn is_mac_junk(path: &str) -> bool {
    let name = basename(path);
    name.starts_with("._") || name == ".DS_Store"
}

/// WebDAV href for a node: mount prefix, per-segment encoded in-volume path,
/// trailing slash for collections.
pub fn href_for(mount_prefix: &str, path: &str, is_dir: bool) -> String {
    let mut href = String::from(mount_prefix);
    if !path.is_empty() {
        for segment in path.split('/') {
            href.push('/');
            href.push_str(&urlencoding::encode(segment));
        }
    }
    if is_dir && !href.ends_with('/') {
        href.push('/');
    }
    href
}

pub fn prop_response(mount_prefix: &str, node: &OrgFsNode) -> String {
    let type_and_len = if node.is_dir {
        "<D:resourcetype><D:collection/></D:resourcetype>".to_string()
    } else {
        format!(
            "<D:resourcetype/><D:getcontentlength>{}</D:getcontentlength>",
            node.size
        )
    };
    format!(
        "<D:response><D:href>{href}</D:href>\
         <D:propstat><D:prop>\
         <D:displayname>{name}</D:displayname>\
         <D:getlastmodified>{lastmod}</D:getlastmodified>\
         {type_and_len}\
         </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
        href = xml_escape(&href_for(mount_prefix, &node.path, node.is_dir)),
        name = xml_escape(basename(&node.path)),
        lastmod = http_date(node.updated_at_secs),
    )
}

/// The empty-prop 200 PROPPATCH acknowledgement — rclone may PROPPATCH
/// mtimes; accepting as a no-op keeps it from erroring the transfer.
pub fn proppatch_response(mount_prefix: &str, path: &str) -> String {
    format!(
        "<D:response><D:href>{href}</D:href>\
         <D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status>\
         </D:propstat></D:response>",
        href = xml_escape(&href_for(mount_prefix, path, false)),
    )
}

pub fn multistatus(bodies: &[String]) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
         <D:multistatus xmlns:D=\"DAV:\">{}</D:multistatus>",
        bodies.concat()
    )
}

/// Parse a single `bytes=a-b` range against a known length.
/// `None` = absent, malformed, or not satisfiable.
pub fn parse_range(header: Option<&str>, size: u64) -> Option<(u64, u64)> {
    let raw = header?.trim();
    let spec = raw.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    if b.contains('-') || b.contains(',') {
        return None;
    }
    let (start, end) = if a.is_empty() {
        // suffix: last N bytes
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        (size.saturating_sub(n), size.checked_sub(1)?)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() {
            size.checked_sub(1)?
        } else {
            b.parse::<u64>().ok()?.min(size.checked_sub(1)?)
        };
        (start, end)
    };
    if start > end || start >= size {
        return None;
    }
    Some((start, end))
}

/// `Www, DD Mon YYYY HH:MM:SS GMT` — the only format `http.TimeFormat`
/// (and therefore rclone's `getlastmodified` parse) accepts.
pub fn http_date(epoch_secs: i64) -> String {
    let days = epoch_secs.div_euclid(86_400);
    let secs = epoch_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    // 1970-01-01 was a Thursday (index 4 in WEEKDAYS).
    let weekday = (days + 4).rem_euclid(7) as usize;
    format!(
        "{wd}, {day:02} {mon} {year:04} {h:02}:{m:02}:{s:02} GMT",
        wd = WEEKDAYS[weekday],
        mon = MONTHS[(month - 1) as usize],
        h = secs / 3600,
        m = (secs % 3600) / 60,
        s = secs % 60,
    )
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff][Z|±HH:MM]` → epoch seconds. Anything else is
/// `None`, and the caller substitutes "now" (matching the TS
/// `new Date(node.updatedAt || Date.now())` fallback).
pub fn iso_to_epoch_secs(iso: &str) -> Option<i64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| iso.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut secs = civil_to_days(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;

    let tail = &iso[19..];
    let offset_at = tail.rfind(['+', '-']);
    if let Some(i) = offset_at {
        let offset = &tail[i..];
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let digits: String = offset[1..].chars().filter(char::is_ascii_digit).collect();
        if digits.len() >= 4 {
            let hours: i64 = digits[0..2].parse().ok()?;
            let minutes: i64 = digits[2..4].parse().ok()?;
            secs -= sign * (hours * 3600 + minutes * 60);
        }
    }
    Some(secs)
}

/// Howard Hinnant's `civil_from_days` — days since the Unix epoch to
/// `(year, month, day)`, proleptic Gregorian, no leap seconds.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The inverse of [`civil_from_days`].
fn civil_to_days(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Resolve a `Destination` header to an in-volume path within the SAME
/// mount. `Err` carries the status to return: 502 for a cross-server or
/// cross-volume destination (RFC 4918 §9.9.2), which this layer cannot
/// perform as a single upstream `move`.
pub fn parse_destination(
    destination: &str,
    mount_prefix: &str,
    host: Option<&str>,
) -> Result<String, u16> {
    let raw = destination.trim();
    let path = match raw
        .strip_prefix("http://")
        .or_else(|| raw.strip_prefix("https://"))
    {
        Some(rest) => {
            let (authority, path) = match rest.find('/') {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, "/"),
            };
            if let Some(expected) = host {
                if !authority.eq_ignore_ascii_case(expected) {
                    return Err(502);
                }
            }
            path
        }
        None => raw,
    };
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let rest = path.strip_prefix(mount_prefix).ok_or(502u16)?;
    if !(rest.is_empty() || rest.starts_with('/')) {
        return Err(502);
    }
    let mut segments = Vec::new();
    for raw in rest.split('/').filter(|s| !s.is_empty()) {
        let decoded = decode(raw);
        if decoded == "." || decoded == ".." {
            return Err(400);
        }
        segments.push(decoded);
    }
    Ok(segments.join("/"))
}

/// Volumes the desktop must never write to. `public-<set>` volumes are
/// generated by the org's public-set sync (`file-storage/public-sets.ts`);
/// a write through a mount would be silently clobbered by the next sync.
/// Enforced HERE rather than trusting rclone's `--read-only` mount flag.
pub fn is_read_only_volume(volume: &str) -> bool {
    volume == "public" || volume.starts_with("public-")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(path: &str, is_dir: bool, size: u64) -> OrgFsNode {
        OrgFsNode {
            path: path.to_string(),
            is_dir,
            size,
            updated_at_secs: 1_700_000_000,
        }
    }

    #[test]
    fn xml_escape_covers_the_four_entities() {
        assert_eq!(
            xml_escape("a&b<c>d\"e"),
            "a&amp;b&lt;c&gt;d&quot;e".to_string()
        );
    }

    #[test]
    fn parse_target_splits_org_volume_and_path() {
        let t = parse_target(
            "/_sandbox/orgfs/acme/home/docs/a.md",
            "/acme/home/docs/a.md",
        )
        .unwrap();
        assert_eq!(t.org, "acme");
        assert_eq!(t.volume, "home");
        assert_eq!(t.path, "docs/a.md");
        assert_eq!(t.mount_prefix, "/_sandbox/orgfs/acme/home");
    }

    #[test]
    fn parse_target_handles_the_volume_root_with_and_without_a_trailing_slash() {
        for (original, relative) in [
            ("/_sandbox/orgfs/acme/home", "/acme/home"),
            ("/_sandbox/orgfs/acme/home/", "/acme/home/"),
        ] {
            let t = parse_target(original, relative).unwrap();
            assert_eq!(t.path, "");
            assert_eq!(t.mount_prefix, "/_sandbox/orgfs/acme/home");
        }
    }

    #[test]
    fn parse_target_decodes_percent_encoded_segments() {
        let t = parse_target(
            "/_sandbox/orgfs/acme/home/my%20docs/a%2Bb.md",
            "/acme/home/my%20docs/a%2Bb.md",
        )
        .unwrap();
        assert_eq!(t.path, "my docs/a+b.md");
    }

    #[test]
    fn parse_target_rejects_a_bare_org_and_traversal_segments() {
        assert_eq!(
            parse_target("/_sandbox/orgfs/acme", "/acme"),
            Err(TargetError::NotAVolume)
        );
        assert_eq!(
            parse_target("/_sandbox/orgfs/acme/home/../x", "/acme/home/../x"),
            Err(TargetError::Traversal)
        );
        assert_eq!(
            parse_target("/_sandbox/orgfs/acme/home/%2e%2e/x", "/acme/home/%2e%2e/x"),
            Err(TargetError::Traversal)
        );
    }

    #[test]
    fn href_carries_the_mount_prefix_and_encodes_each_segment() {
        assert_eq!(
            href_for("/_sandbox/orgfs/acme/home", "my docs/a.md", false),
            "/_sandbox/orgfs/acme/home/my%20docs/a.md"
        );
        assert_eq!(
            href_for("/_sandbox/orgfs/acme/home", "my docs", true),
            "/_sandbox/orgfs/acme/home/my%20docs/"
        );
        // The volume root is a collection: prefix plus exactly one slash.
        assert_eq!(
            href_for("/_sandbox/orgfs/acme/home", "", true),
            "/_sandbox/orgfs/acme/home/"
        );
    }

    #[test]
    fn prop_response_shape_matches_the_ts_daemon() {
        let dir = prop_response("/p/v", &node("docs", true, 0));
        assert!(dir.contains("<D:href>/p/v/docs/</D:href>"));
        assert!(dir.contains("<D:resourcetype><D:collection/></D:resourcetype>"));
        assert!(!dir.contains("getcontentlength"));
        assert!(dir.contains("<D:displayname>docs</D:displayname>"));

        let file = prop_response("/p/v", &node("docs/a.md", false, 42));
        assert!(file.contains("<D:href>/p/v/docs/a.md</D:href>"));
        assert!(file.contains("<D:resourcetype/><D:getcontentlength>42</D:getcontentlength>"));
        assert!(file.contains("<D:status>HTTP/1.1 200 OK</D:status>"));
    }

    #[test]
    fn multistatus_wraps_bodies_in_the_dav_envelope() {
        let xml = multistatus(&["<D:response/>".to_string()]);
        assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?>"));
        assert!(xml.contains("<D:multistatus xmlns:D=\"DAV:\"><D:response/></D:multistatus>"));
    }

    #[test]
    fn parse_range_handles_open_closed_and_suffix_forms() {
        assert_eq!(parse_range(Some("bytes=0-9"), 100), Some((0, 9)));
        assert_eq!(parse_range(Some("bytes=10-"), 100), Some((10, 99)));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Some((90, 99)));
        // end past EOF clamps
        assert_eq!(parse_range(Some("bytes=90-999"), 100), Some((90, 99)));
    }

    #[test]
    fn parse_range_rejects_unsatisfiable_and_malformed_specs() {
        assert_eq!(parse_range(None, 100), None);
        assert_eq!(parse_range(Some("items=0-9"), 100), None);
        assert_eq!(parse_range(Some("bytes=0-9,20-29"), 100), None);
        assert_eq!(parse_range(Some("bytes=100-200"), 100), None);
        assert_eq!(parse_range(Some("bytes=9-0"), 100), None);
        assert_eq!(parse_range(Some("bytes=-0"), 100), None);
        assert_eq!(parse_range(Some("bytes=0-9"), 0), None);
    }

    #[test]
    fn http_date_renders_rfc_1123_gmt() {
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(784_111_777), "Sun, 06 Nov 1994 08:49:37 GMT");
        assert_eq!(http_date(1_700_000_000), "Tue, 14 Nov 2023 22:13:20 GMT");
    }

    #[test]
    fn iso_round_trips_through_http_date() {
        assert_eq!(
            iso_to_epoch_secs("2023-11-14T22:13:20.000Z"),
            Some(1_700_000_000)
        );
        assert_eq!(iso_to_epoch_secs("1970-01-01T00:00:00Z"), Some(0));
        // Offsets are normalized to UTC.
        assert_eq!(
            iso_to_epoch_secs("2023-11-14T23:13:20+01:00"),
            Some(1_700_000_000)
        );
        assert_eq!(iso_to_epoch_secs(""), None);
        assert_eq!(iso_to_epoch_secs("not a date at all"), None);
    }

    #[test]
    fn destination_resolves_absolute_urls_and_bare_paths() {
        let prefix = "/_sandbox/orgfs/acme/home";
        assert_eq!(
            parse_destination(
                "http://127.0.0.1:4000/_sandbox/orgfs/acme/home/b%20.md",
                prefix,
                Some("127.0.0.1:4000")
            ),
            Ok("b .md".to_string())
        );
        assert_eq!(
            parse_destination("/_sandbox/orgfs/acme/home/docs/b.md", prefix, None),
            Ok("docs/b.md".to_string())
        );
        // Destination == the volume root.
        assert_eq!(
            parse_destination("/_sandbox/orgfs/acme/home/", prefix, None),
            Ok(String::new())
        );
    }

    #[test]
    fn destination_outside_this_mount_is_a_bad_gateway() {
        let prefix = "/_sandbox/orgfs/acme/home";
        // Different host.
        assert_eq!(
            parse_destination(
                "http://evil.example/_sandbox/orgfs/acme/home/b.md",
                prefix,
                Some("127.0.0.1:4000")
            ),
            Err(502)
        );
        // Different volume.
        assert_eq!(
            parse_destination("/_sandbox/orgfs/acme/outputs/b.md", prefix, None),
            Err(502)
        );
        // Prefix match must land on a segment boundary.
        assert_eq!(
            parse_destination("/_sandbox/orgfs/acme/homework/b.md", prefix, None),
            Err(502)
        );
        assert_eq!(
            parse_destination("/_sandbox/orgfs/acme/home/../x", prefix, None),
            Err(400)
        );
    }

    #[test]
    fn mac_junk_is_recognized_by_basename_only() {
        assert!(is_mac_junk("._a.md"));
        assert!(is_mac_junk("docs/._a.md"));
        assert!(is_mac_junk(".DS_Store"));
        assert!(is_mac_junk("docs/.DS_Store"));
        assert!(!is_mac_junk("docs/a.md"));
        assert!(!is_mac_junk("._weird/a.md"));
    }

    #[test]
    fn public_volumes_are_read_only() {
        assert!(is_read_only_volume("public"));
        assert!(is_read_only_volume("public-skills"));
        assert!(!is_read_only_volume("home"));
        assert!(!is_read_only_volume("uploads"));
        assert!(!is_read_only_volume("outputs"));
        assert!(!is_read_only_volume("publications"));
    }
}
