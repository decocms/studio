//! `DESKTOP_SELFTEST=1` runtime validation mode. See
//! `selftest/bundle.js`'s header comment for what's actually validated
//! against the built app. Driven end-to-end by
//! `apps/native/scripts/boot-smoke.ts`.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

const APP_DATA_DIR_ENV: &str = "DESKTOP_SELFTEST_APP_DATA_DIR";
const APP_DATA_DIR_NAME: &str = "app-data";
const BOOT_SMOKE_DIR_PREFIX: &str = "desktop-boot-smoke-";

/// The self-test JS bundle, embedded at compile time. `eval()`'d into the
/// shell's window by `setup.rs` once the page finishes loading, only when
/// [`is_enabled`] is true.
pub const BUNDLE_JS: &str = include_str!("../selftest/bundle.js");

/// `DESKTOP_SELFTEST=1` gates the entire flow: window visibility (hidden
/// under self-test — see `setup.rs`), the exact localhost preview CSP
/// widening, and whether the bundle is ever eval'd at all. Checked once
/// per process (env vars don't change mid-run).
pub fn is_enabled() -> bool {
    std::env::var("DESKTOP_SELFTEST").as_deref() == Ok("1")
}

/// Resolves the required, smoke-owned app-data root. Self-test mode never
/// falls back to Tauri's production `com.decocms.studio` directory: a missing
/// or unsafe override fails boot before local-api can open its SQLite store.
pub fn app_data_dir() -> Result<PathBuf, String> {
    let configured = std::env::var_os(APP_DATA_DIR_ENV)
        .ok_or_else(|| format!("{APP_DATA_DIR_ENV} must be set when DESKTOP_SELFTEST=1"))?;
    let configured = PathBuf::from(configured);
    if !configured.is_absolute() {
        return Err(format!("{APP_DATA_DIR_ENV} must be absolute"));
    }
    if configured.file_name().and_then(|name| name.to_str()) != Some(APP_DATA_DIR_NAME) {
        return Err(format!(
            "{APP_DATA_DIR_ENV} must end in /{APP_DATA_DIR_NAME}"
        ));
    }
    let parent = configured
        .parent()
        .ok_or_else(|| format!("{APP_DATA_DIR_ENV} has no parent directory"))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("failed to resolve {APP_DATA_DIR_ENV}'s parent: {error}"))?;
    let canonical_temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|error| format!("failed to resolve the system temporary directory: {error}"))?;
    let resolved = canonical_parent.join(APP_DATA_DIR_NAME);
    validate_app_data_dir(&resolved, &canonical_temp)?;
    Ok(resolved)
}

fn validate_app_data_dir(path: &Path, temp_root: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("{APP_DATA_DIR_ENV} must be absolute"));
    }
    if path.file_name().and_then(|name| name.to_str()) != Some(APP_DATA_DIR_NAME) {
        return Err(format!(
            "{APP_DATA_DIR_ENV} must end in /{APP_DATA_DIR_NAME}"
        ));
    }
    let smoke_root = path
        .parent()
        .ok_or_else(|| format!("{APP_DATA_DIR_ENV} has no parent directory"))?;
    if smoke_root.parent() != Some(temp_root) {
        return Err(format!(
            "{APP_DATA_DIR_ENV} must be a direct child of a boot-smoke directory under the system temporary directory"
        ));
    }
    let smoke_name = smoke_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !smoke_name.starts_with(BOOT_SMOKE_DIR_PREFIX)
        || smoke_name.len() == BOOT_SMOKE_DIR_PREFIX.len()
    {
        return Err(format!(
            "{APP_DATA_DIR_ENV}'s parent must start with {BOOT_SMOKE_DIR_PREFIX} and include a unique suffix"
        ));
    }
    Ok(())
}

/// `DESKTOP_SELFTEST_OUT` — required when [`is_enabled`] is true (enforced
/// by `commands::selftest_report`, not here, so a misconfigured self-test
/// run fails loudly via the JS bundle's own `finish()` catch rather than a
/// silent boot-time exit that leaves `boot-smoke.ts` waiting on a file that
/// will never appear).
pub fn out_path() -> Result<String, String> {
    std::env::var("DESKTOP_SELFTEST_OUT")
        .map_err(|_| "DESKTOP_SELFTEST_OUT must be set when DESKTOP_SELFTEST=1".to_string())
}

/// Writes the JSON report to [`out_path`] and exits the app — 0 if
/// `report.allPass` is `true`, 1 otherwise (including if the report itself
/// is malformed, fail closed). Called from `commands::selftest_report`;
/// broken out into its own function so the exit-code decision has a single
/// well-named home. `app.exit(code)` (not `std::process::exit`) so the
/// normal `RunEvent::ExitRequested` shutdown path (`shutdown.rs`) still
/// runs — the self-test flow must exercise the SAME graceful-shutdown code
/// path a real window close does, not a shortcut around it.
pub fn report_and_exit(app: &AppHandle, report: serde_json::Value) -> Result<(), String> {
    let path = out_path()?;
    let all_pass = report
        .get("allPass")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let bytes = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("failed to write {path}: {e}"))?;
    tracing::info!(all_pass, path = %path, "self-test report written");
    app.exit(if all_pass { 0 } else { 1 });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_js_is_non_empty_and_mentions_selftest_report() {
        assert!(BUNDLE_JS.contains("selftest_report"));
    }

    #[test]
    fn accepts_only_the_boot_smoke_app_data_shape() {
        let temp = std::env::temp_dir();
        let app_data = temp
            .join("desktop-boot-smoke-a1B2c3")
            .join(APP_DATA_DIR_NAME);
        assert!(
            validate_app_data_dir(&app_data, &temp).is_ok(),
            "{} should be accepted",
            app_data.display()
        );
    }

    #[test]
    fn rejects_production_nested_and_non_unique_app_data_paths() {
        let temp = std::env::temp_dir();
        for path in [
            PathBuf::from("relative/com.decocms.studio"),
            temp.join("other")
                .join("desktop-boot-smoke-a1B2c3")
                .join(APP_DATA_DIR_NAME),
            temp.join(BOOT_SMOKE_DIR_PREFIX).join(APP_DATA_DIR_NAME),
            temp.join("desktop-boot-smoke-a1B2c3").join("not-app-data"),
        ] {
            assert!(
                validate_app_data_dir(&path, &temp).is_err(),
                "{} should be rejected",
                path.display()
            );
        }
    }
}
