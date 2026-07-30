//! Background self-update: check → download → verify → install, silently.
//!
//! The design (see `apps/native/docs/native-updater-plan.md`): the packaged
//! app polls the rolling `native-updates` GitHub prerelease's `latest.json`,
//! auto-installs anything newer, and publishes the staged version into
//! local-api via [`local_api::UpdateHooks`]. The `/api/config` proxy rewrite
//! then reports the staged version, the webview's existing version card
//! fires, and its button POSTs `/_local/update/restart` — which calls the
//! `request_restart` closure built here (Tauri's `request_restart`, the
//! variant documented to deliver `RunEvent::ExitRequested`, so
//! `shutdown::run_blocking`'s pipeline always runs before the respawn; plain
//! `restart()`/JS `relaunch()` skip those events on the main thread).
//!
//! On macOS the install swaps the `.app` on disk while the running process
//! keeps serving from its own open inode — install-eagerly is safe, and even
//! a plain quit+reopen lands on the new version.
//!
//! The task never runs outside a real shipped build — three independent
//! gates, because `cfg!(debug_assertions)` alone is NOT enough: CI's
//! `tauri-build` job and `boot-smoke.ts` build the RELEASE profile at the
//! committed `0.1.0` placeholder version, which would see prod as "newer"
//! and download ~80 MB over the CI bundle mid-smoke:
//! 1. debug builds compile the spawn out of reach (the plugin itself is only
//!    registered under `cfg(not(debug_assertions))` in `lib.rs`);
//! 2. [`init`] refuses under `selftest::is_enabled()` or at the `0.1.0`
//!    placeholder version;
//! 3. `DECOCMS_DISABLE_AUTO_UPDATE` is honored per cycle (warn-logged every
//!    time — a silently frozen updater must be greppable in diagnostics).
//!
//! All errors are swallowed to tracing: offline, a blocked github.com, or
//! the 404 window while a release is publishing are silent no-ops (the card
//! just doesn't appear). The one exception is a SIGNATURE failure, which
//! gets a distinct error line — it means channel tampering or a botched key
//! rotation, categorically different from flaky networks.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::watch;

/// tauri.conf.json5's committed placeholder — only release-workflow builds
/// (`--config {"version": ...}`) carry a real version.
const PLACEHOLDER_VERSION: &str = "0.1.0";
const KILL_SWITCH_ENV: &str = "DECOCMS_DISABLE_AUTO_UPDATE";
/// Spike/manual-runbook override for [`CHECK_INTERVAL`] (seconds, floored at
/// 15 so a typo can't hot-loop against GitHub). Harmless in the threat
/// model: a local process able to set env already has the kill switch above.
const CHECK_INTERVAL_ENV: &str = "DECOCMS_UPDATE_CHECK_INTERVAL_SECS";
/// Deliberately NOT the 5-minute revalidate cadence: the channel manifest
/// moves at most ~1.2x/day (release-workflow throttle) and card latency is
/// dominated by the dialog's own 5-min × 2-confirmation poll — a 5-minute
/// check would be ~288 no-op manifest fetches a day.
const CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// Manifest fetch timeout; a stalled check must not wedge the loop.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// Whole-download bound. Generous (the artifact is ~80-100 MB and the
/// plugin buffers it in RAM with no resume); a stalled stream without this
/// would block the loop's single future forever.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Built by [`init`] before local-api boots (the hooks ride
/// `StartOptions::update`); [`Updater::spawn`] starts the background task
/// after the server is up. Split so the channel-before-`StartOptions`
/// ordering is enforced by types, not convention.
pub struct Updater {
    hooks: Option<local_api::UpdateHooks>,
    task: Option<TaskParts>,
}

struct TaskParts {
    app: tauri::AppHandle,
    staged_tx: watch::Sender<Option<String>>,
    installing: Arc<AtomicBool>,
}

pub fn init(app: &tauri::AppHandle) -> Updater {
    if !enabled(app) {
        return Updater {
            hooks: None,
            task: None,
        };
    }
    let (staged_tx, staged_rx) = watch::channel(None);
    let installing = Arc::new(AtomicBool::new(false));
    let restart_handle = app.clone();
    let hooks = local_api::UpdateHooks {
        staged_version: staged_rx,
        installing: installing.clone(),
        request_restart: Arc::new(move || restart_handle.request_restart()),
    };
    Updater {
        hooks: Some(hooks),
        task: Some(TaskParts {
            app: app.clone(),
            staged_tx,
            installing,
        }),
    }
}

impl Updater {
    /// `None` whenever the task will not run — local-api then keeps its
    /// standalone behavior (`/_local/update/restart` answers 409, the
    /// `/api/config` rewrite pins the embedded version).
    pub fn hooks(&self) -> Option<local_api::UpdateHooks> {
        self.hooks.clone()
    }

    pub fn spawn(self) {
        let Some(parts) = self.task else { return };
        // Dropping the JoinHandle detaches the task; the process lifetime is
        // the intended owner, same as upstream::revalidate.
        drop(tauri::async_runtime::spawn(run(parts)));
    }
}

fn enabled(app: &tauri::AppHandle) -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    if crate::selftest::is_enabled() {
        tracing::info!("self-update disabled: selftest mode");
        return false;
    }
    let version = app.package_info().version.to_string();
    if version == PLACEHOLDER_VERSION {
        tracing::info!(
            "self-update disabled: placeholder version {PLACEHOLDER_VERSION} (non-release build)"
        );
        return false;
    }
    true
}

fn kill_switch_active() -> bool {
    std::env::var_os(KILL_SWITCH_ENV).is_some_and(|value| !value.is_empty() && value != "0")
}

/// [`CHECK_INTERVAL`] unless the override env holds a parseable second
/// count; floored, never trusted below 15 s. Pure so the parsing is
/// unit-testable.
fn check_interval(override_secs: Option<&str>) -> Duration {
    override_secs
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|secs| Duration::from_secs(secs.max(15)))
        .unwrap_or(CHECK_INTERVAL)
}

async fn run(parts: TaskParts) {
    let mut interval = tokio::time::interval(check_interval(
        std::env::var(CHECK_INTERVAL_ENV).ok().as_deref(),
    ));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick completes immediately; consuming it here means the
    // first real check runs one full interval after boot — no boot-path
    // contention, mirroring upstream::revalidate's first-tick handling.
    interval.tick().await;
    let mut memo: Option<FailureMemo> = None;
    loop {
        interval.tick().await;
        if kill_switch_active() {
            tracing::warn!("self-update skipped: {KILL_SWITCH_ENV} is set");
            continue;
        }
        cycle(&parts, &mut memo).await;
    }
}

async fn cycle(parts: &TaskParts, memo: &mut Option<FailureMemo>) {
    use tauri_plugin_updater::UpdaterExt;

    let updater = match parts.app.updater_builder().timeout(CHECK_TIMEOUT).build() {
        Ok(updater) => updater,
        Err(error) => {
            tracing::warn!(%error, "self-update: updater construction failed");
            return;
        }
    };
    // check() itself gates on remote > running (built-in semver comparison);
    // this code never re-implements that half.
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return,
        Err(error) => {
            // Offline / blocked endpoint / publish-window 404: silent by
            // design — never surface a red path to the UI from here.
            tracing::debug!(%error, "self-update: check failed (offline or channel unavailable)");
            return;
        }
    };

    let candidate = update.version.clone();
    let staged = parts.staged_tx.borrow().clone();
    match decide(&candidate, staged.as_deref(), memo.as_ref(), Instant::now()) {
        Decision::AlreadyStaged => return,
        Decision::Backoff => {
            tracing::debug!(%candidate, "self-update: in failure backoff, skipping");
            return;
        }
        Decision::Attempt => {}
    }

    tracing::info!(%candidate, "self-update: downloading");
    // `installing` fences the restart route for the whole download+install:
    // restarting mid-swap could re-exec a half-replaced bundle.
    parts.installing.store(true, Ordering::SeqCst);
    let result = download_verify_install(&update, &candidate).await;
    parts.installing.store(false, Ordering::SeqCst);

    match result {
        Ok(()) => {
            *memo = None;
            // Receivers only observe; send failure (no receivers) is fine.
            let _ = parts.staged_tx.send(Some(candidate.clone()));
            tracing::info!(%candidate, "self-update: installed and staged; restart applies it");
        }
        Err(error) => {
            let failure = record_failure(memo.take(), &candidate, Instant::now());
            if error.signature_related {
                // Channel tampering or a botched key rotation — categorically
                // different from a flaky network; keep it loudly greppable.
                tracing::error!(
                    %candidate,
                    error = %error.message,
                    "self-update: SIGNATURE VERIFICATION FAILED"
                );
            } else {
                tracing::warn!(
                    %candidate,
                    attempts = failure.attempts,
                    error = %error.message,
                    "self-update: install attempt failed; backing off"
                );
            }
            *memo = Some(failure);
        }
    }
}

struct InstallError {
    message: String,
    signature_related: bool,
}

impl InstallError {
    fn new(message: String) -> Self {
        let signature_related = message.to_ascii_lowercase().contains("signature");
        Self {
            message,
            signature_related,
        }
    }
}

async fn download_verify_install(
    update: &tauri_plugin_updater::Update,
    expected_version: &str,
) -> Result<(), InstallError> {
    let bytes = tokio::time::timeout(DOWNLOAD_TIMEOUT, update.download(|_, _| {}, || {}))
        .await
        .map_err(|_| InstallError::new("download timed out".to_string()))?
        .map_err(|error| InstallError::new(format!("download failed: {error}")))?;

    // Version-pairing check (v1 downgrade defense): the minisign signature
    // covers the archive bytes but NOT the manifest's `version` field, and
    // the manifest lives on a mutable release asset writable by every
    // workflow token with contents:write. Without this, a lying manifest
    // could pair a high `version` with an old validly-signed artifact and
    // silently roll the fleet back. The bundle's own Info.plist version IS
    // signature-covered, so requiring it to match closes the pairing attack.
    let embedded = bundle_short_version(&bytes)
        .map_err(|error| InstallError::new(format!("bundle inspection failed: {error}")))?;
    if embedded != expected_version {
        return Err(InstallError::new(format!(
            "version-pairing mismatch: manifest claims {expected_version} but the signed bundle is {embedded} — refusing to install"
        )));
    }

    // install() is synchronous gunzip+untar+swap I/O — off the runtime
    // worker, same rationale as setup.rs's TLS spawn_blocking.
    let update = update.clone();
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|join| InstallError::new(format!("install task failed: {join}")))?
        .map_err(|error| InstallError::new(format!("install failed: {error}")))?;
    Ok(())
}

/// `CFBundleShortVersionString` of the top-level `.app` inside the updater
/// tar.gz (`<name>.app/Contents/Info.plist` — exactly depth 3, so a nested
/// framework's plist can never shadow the bundle's own).
fn bundle_short_version(targz: &[u8]) -> Result<String, String> {
    let decoder = flate2::read::GzDecoder::new(targz);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("unreadable archive: {error}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|error| format!("unreadable archive entry: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("unreadable entry path: {error}"))?;
        let components: Vec<String> = path
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let is_bundle_plist = components.len() == 3
            && components[0].ends_with(".app")
            && components[1] == "Contents"
            && components[2] == "Info.plist";
        if !is_bundle_plist {
            continue;
        }
        let mut plist_bytes = Vec::new();
        entry
            .read_to_end(&mut plist_bytes)
            .map_err(|error| format!("unreadable Info.plist: {error}"))?;
        let value = plist::Value::from_reader(std::io::Cursor::new(plist_bytes))
            .map_err(|error| format!("unparseable Info.plist: {error}"))?;
        return value
            .as_dictionary()
            .and_then(|dict| dict.get("CFBundleShortVersionString"))
            .and_then(|v| v.as_string())
            .map(str::to_string)
            .ok_or_else(|| "Info.plist has no CFBundleShortVersionString".to_string());
    }
    Err("no <name>.app/Contents/Info.plist in archive".to_string())
}

// ---------------------------------------------------------------------------
// Pure decision logic — always compiled (release-only cfg would silently
// compile these tests out of `cargo test --workspace`, which runs the dev
// profile), only the spawn side above is gated by `enabled()`.

#[derive(Debug, PartialEq, Eq)]
enum Decision {
    Attempt,
    AlreadyStaged,
    Backoff,
}

/// One remembered failing version. Without this memo a persistently failing
/// install (TCC block, full disk, bad signature) would re-download the full
/// artifact EVERY tick, forever — the memo turns that into exponential
/// backoff, reset the moment a different version appears on the channel.
struct FailureMemo {
    version: String,
    attempts: u32,
    next_retry_at: Instant,
}

fn decide(
    candidate: &str,
    staged: Option<&str>,
    memo: Option<&FailureMemo>,
    now: Instant,
) -> Decision {
    // Plain equality, not semver ordering: a channel ROLLFORWARD after a
    // botched release must be able to replace an already-staged version in
    // either direction; check() already guarantees candidate > running.
    if staged == Some(candidate) {
        return Decision::AlreadyStaged;
    }
    if let Some(memo) = memo {
        if memo.version == candidate && now < memo.next_retry_at {
            return Decision::Backoff;
        }
    }
    Decision::Attempt
}

fn record_failure(memo: Option<FailureMemo>, version: &str, now: Instant) -> FailureMemo {
    let attempts = match &memo {
        Some(memo) if memo.version == version => memo.attempts + 1,
        _ => 1,
    };
    FailureMemo {
        version: version.to_string(),
        attempts,
        next_retry_at: now + backoff_after(attempts),
    }
}

/// 1h, 2h, 4h, 8h, 16h, 24h cap.
fn backoff_after(attempts: u32) -> Duration {
    let hours = 1u64 << attempts.saturating_sub(1).min(5);
    Duration::from_secs(hours.min(24) * 3600)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: Duration = Duration::from_secs(3600);

    #[test]
    fn check_interval_override_parses_and_floors() {
        assert_eq!(check_interval(None), CHECK_INTERVAL);
        assert_eq!(check_interval(Some("nonsense")), CHECK_INTERVAL);
        assert_eq!(check_interval(Some("")), CHECK_INTERVAL);
        assert_eq!(check_interval(Some("120")), Duration::from_secs(120));
        // Floored: a typo can't hot-loop against the channel.
        assert_eq!(check_interval(Some("1")), Duration::from_secs(15));
    }

    #[test]
    fn backoff_doubles_and_caps_at_a_day() {
        assert_eq!(backoff_after(1), HOUR);
        assert_eq!(backoff_after(2), 2 * HOUR);
        assert_eq!(backoff_after(5), 16 * HOUR);
        assert_eq!(backoff_after(6), 24 * HOUR);
        assert_eq!(backoff_after(60), 24 * HOUR);
    }

    #[test]
    fn decide_skips_staged_backs_off_failures_and_resets_on_new_versions() {
        let now = Instant::now();
        assert_eq!(
            decide("2.0.0", Some("2.0.0"), None, now),
            Decision::AlreadyStaged
        );
        // A different staged version (even a NEWER one — channel rollforward)
        // is attempted; ordering is check()'s job.
        assert_eq!(decide("2.0.0", Some("3.0.0"), None, now), Decision::Attempt);

        let memo = record_failure(None, "2.0.0", now);
        assert_eq!(memo.attempts, 1);
        assert_eq!(decide("2.0.0", None, Some(&memo), now), Decision::Backoff);
        // Backoff elapsed → retry.
        assert_eq!(
            decide("2.0.0", None, Some(&memo), now + 2 * HOUR),
            Decision::Attempt
        );
        // A NEW version is never held back by an old version's memo.
        assert_eq!(decide("2.1.0", None, Some(&memo), now), Decision::Attempt);

        // Repeated failures of the same version escalate; a different
        // version resets the counter.
        let memo = record_failure(Some(memo), "2.0.0", now);
        assert_eq!(memo.attempts, 2);
        let memo = record_failure(Some(memo), "2.1.0", now);
        assert_eq!(memo.attempts, 1);
    }

    #[test]
    fn bundle_short_version_reads_the_top_level_app_plist_only() {
        let plist_xml = |version: &str| {
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key><string>{version}</string>
</dict></plist>"#
            )
        };
        let mut builder = tar::Builder::new(Vec::new());
        let mut add = |path: &str, contents: &str| {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, path, contents.as_bytes())
                .unwrap();
        };
        // A nested framework plist that must NOT win, plus the real one.
        add(
            "deco.app/Contents/Frameworks/X.framework/Info.plist",
            &plist_xml("9.9.9"),
        );
        add("deco.app/Contents/Info.plist", &plist_xml("4.151.0"));
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, &tar_bytes).unwrap();
        let targz = encoder.finish().unwrap();

        assert_eq!(bundle_short_version(&targz).unwrap(), "4.151.0");
        assert!(bundle_short_version(b"not a tarball").is_err());
    }
}
