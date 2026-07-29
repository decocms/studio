//! Bakes the web bundle's version into the binary as `STUDIO_WEB_VERSION`.
//!
//! The webview compares `GET /api/config`'s `config.version` against its own
//! build-time `__STUDIO_VERSION__` and nags "A new version is ready" when they
//! drift (`apps/web/src/components/version-check-dialog.tsx`). Vite injects
//! that constant from `apps/api/package.json` (see `apps/web/vite.config.ts`'s
//! `define`), and the desktop bundles that same Vite output — so reading the
//! very same file here is what makes the two agree, and lets
//! `routes/upstream.rs` answer the poll with the version actually running
//! inside this app instead of whatever the upstream deployment happens to be
//! serving.
//!
//! Parsed by hand rather than with `serde_json` to keep this crate free of
//! build-dependencies; the field is a plain string in a generated file.

use std::path::Path;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    // apps/native/crates/local-api -> apps/api/package.json
    let package_json = Path::new(&manifest_dir).join("../../../api/package.json");

    println!("cargo:rerun-if-changed={}", package_json.display());

    let version = std::fs::read_to_string(&package_json)
        .ok()
        .and_then(|contents| parse_version(&contents));

    // Fail open: an unreadable/renamed manifest must not break the build. The
    // proxy treats an empty value as "don't rewrite" and passes upstream's
    // version through unchanged (today's behavior).
    println!(
        "cargo:rustc-env=STUDIO_WEB_VERSION={}",
        version.unwrap_or_default()
    );
}

/// Pulls the top-level `"version": "…"` string out of a package.json.
fn parse_version(contents: &str) -> Option<String> {
    let start = contents.find("\"version\"")?;
    let rest = &contents[start + "\"version\"".len()..];
    let colon = rest.find(':')?;
    let after_colon = &rest[colon + 1..];
    let open = after_colon.find('"')?;
    let value = &after_colon[open + 1..];
    let close = value.find('"')?;
    Some(value[..close].to_string())
}
