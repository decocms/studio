//! Background self-update: check → download → verify → stage, silently;
//! the actual INSTALL happens in the exit path ([`apply_pending_update`]).
//!
//! The design (see `apps/native/docs/native-updater-plan.md`): the packaged
//! app polls the rolling `native-updates` GitHub prerelease's `latest.json`,
//! downloads and verifies anything newer, stages the archive under
//! `<app_root>/updates/`, and publishes the staged version into local-api
//! via [`local_api::UpdateHooks`]. The `/api/config` proxy rewrite then
//! reports the staged version, the webview's existing version card fires,
//! and its button POSTs `/_local/update/restart` — which calls the
//! `request_restart` closure built here (Tauri's `request_restart`, the
//! variant documented to deliver `RunEvent::ExitRequested`, so
//! `shutdown::run_blocking`'s pipeline always runs before the respawn).
//!
//! Install is DEFERRED to the exit path deliberately — an earlier design
//! installed eagerly and the live spike caught the consequence: macOS
//! validates a process's code identity against its binary ON DISK, so the
//! moment the bundle was swapped under the running app every Keychain
//! operation failed ("keychain unavailable … UNIX[No such file or
//! directory]") — sign-in broke and rotated-refresh-token saves would fail
//! silently until restart. Applying inside `shutdown.rs`, after local-api
//! has drained, means no Keychain writer can ever observe a swapped bundle,
//! and because BOTH the card's restart and a plain quit funnel through
//! `ExitRequested`, install-on-quit still holds.
//!
//! That ordering is macOS-driven but correct on Linux too, so there is no
//! per-OS install path: `install_appimage` renames the running image aside
//! as a backup and writes the new bytes at `$APPIMAGE`, the kernel keeps
//! the already-mounted image alive for the live process, and the relaunch
//! resolves the binary through `current_binary()` — which returns
//! `env.appimage`, i.e. the path just rewritten. Nothing there needs the
//! swap to be late, and nothing there is harmed by it being late.
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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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
    updates_dir: PathBuf,
}

/// The staged, fully verified update waiting for [`apply_pending_update`].
/// Process-global (not `AppState`) because the apply site is the shutdown
/// path in `src-tauri`, after local-api has already been torn down.
struct PendingUpdate {
    version: String,
    archive: PathBuf,
    update: tauri_plugin_updater::Update,
}

fn pending_slot() -> &'static Mutex<Option<PendingUpdate>> {
    static PENDING: OnceLock<Mutex<Option<PendingUpdate>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(None))
}

pub fn init(app: &tauri::AppHandle, app_root: &Path) -> Updater {
    if !enabled(app) {
        return Updater {
            hooks: None,
            task: None,
        };
    }
    let updates_dir = app_root.join("updates");
    // A staged archive from a crashed previous session is stale by
    // definition (its PendingUpdate handle died with the process); the loop
    // below re-downloads if the channel still offers that version.
    let _ = std::fs::remove_dir_all(&updates_dir);
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
            updates_dir,
        }),
    }
}

/// Install the staged update, if any. Called from `shutdown::run_blocking`
/// AFTER local-api has drained — the bundle swap happens when no Keychain
/// writer is left to observe it, and since both the card's restart and a
/// plain quit funnel through `ExitRequested`, this is also what makes
/// install-on-quit true. Failures log and fall through: the process exits
/// on the old version and the next boot re-downloads.
pub fn apply_pending_update() {
    let pending = pending_slot().lock().ok().and_then(|mut slot| slot.take());
    let Some(pending) = pending else { return };
    tracing::info!(version = %pending.version, "self-update: applying staged update before exit");
    let bytes = match std::fs::read(&pending.archive) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::error!(%error, "self-update: staged archive unreadable; exiting without applying");
            return;
        }
    };
    // install() re-verifies the minisign signature over these exact bytes,
    // so a staged file tampered with between stage and apply fails closed.
    match pending.update.install(bytes) {
        Ok(()) => {
            let _ = std::fs::remove_file(&pending.archive);
            tracing::info!(version = %pending.version, "self-update: applied; relaunch runs the new version");
        }
        Err(error) => {
            tracing::error!(%error, "self-update: apply failed; exiting on the current version");
        }
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
    // Linux: the plugin swaps the file $APPIMAGE points at, in place. Run from a
    // raw binary (dev checkout, extracted AppDir, future deb/rpm) it would
    // overwrite current_exe() itself — never spawn there. The plugin has no such
    // guard: tauri-plugin-updater 2.10.1 wires executable_path from env.appimage
    // and install_appimage rewrites it with no "not an AppImage" error.
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_none() {
        tracing::info!("self-update disabled: not running from an AppImage");
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
    // `installing` fences the restart route for the whole download+stage:
    // a restart mid-restage would race the pending-archive swap.
    parts.installing.store(true, Ordering::SeqCst);
    let result = download_verify_stage(&update, &candidate, &parts.updates_dir).await;
    parts.installing.store(false, Ordering::SeqCst);

    match result {
        Ok(archive) => {
            *memo = None;
            if let Ok(mut slot) = pending_slot().lock() {
                *slot = Some(PendingUpdate {
                    version: candidate.clone(),
                    archive,
                    update: update.clone(),
                });
            }
            // Receivers only observe; send failure (no receivers) is fine.
            let _ = parts.staged_tx.send(Some(candidate.clone()));
            tracing::info!(%candidate, "self-update: verified and staged; applies on restart or quit");
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

async fn download_verify_stage(
    update: &tauri_plugin_updater::Update,
    expected_version: &str,
    updates_dir: &Path,
) -> Result<PathBuf, InstallError> {
    let bytes = tokio::time::timeout(DOWNLOAD_TIMEOUT, update.download(|_, _| {}, || {}))
        .await
        .map_err(|_| InstallError::new("download timed out".to_string()))?
        .map_err(|error| InstallError::new(format!("download failed: {error}")))?;

    // Version-pairing check (v1 downgrade defense): the minisign signature
    // covers the archive bytes but NOT the manifest's `version` field, and
    // the manifest lives on a mutable release asset writable by every
    // workflow token with contents:write. Without this, a lying manifest
    // could pair a high `version` with an old validly-signed artifact and
    // silently roll the fleet back.
    //
    // Every platform's archive carries its own version marker INSIDE the
    // signed bytes, so requiring it to match closes the pairing attack the
    // same way on each:
    //   macOS — `CFBundleShortVersionString` in the `.app`'s Info.plist;
    //   Linux — the tar member NAME `deco_<version>_amd64.AppImage`, which
    //     exists only because the Linux release leg builds with
    //     `createUpdaterArtifacts: "v1Compatible"` (the tarball then holds
    //     exactly one member, and tar stores names in the signed bytes).
    // Both extractors are always compiled (see the note above them); only
    // this dispatch is per-OS.
    #[cfg(target_os = "linux")]
    let embedded = appimage_member_version(&bytes);
    #[cfg(not(target_os = "linux"))]
    let embedded = bundle_short_version(&bytes);
    let embedded = embedded
        .map_err(|error| InstallError::new(format!("bundle inspection failed: {error}")))?;
    if embedded != expected_version {
        return Err(InstallError::new(format!(
            "version-pairing mismatch: manifest claims {expected_version} but the signed bundle is {embedded} — refusing to stage"
        )));
    }

    // Stage to disk instead of installing NOW: swapping the bundle under the
    // running process breaks macOS Keychain access; on Linux the swap is
    // survivable but the exit path is still where it belongs, so one ordering
    // serves both (see the module doc). Sync fs on a blocking thread —
    // ~80-100 MB write.
    let dir = updates_dir.to_path_buf();
    let version = expected_version.to_string();
    tauri::async_runtime::spawn_blocking(move || stage_archive(&dir, &version, &bytes))
        .await
        .map_err(|join| InstallError::new(format!("stage task failed: {join}")))?
        .map_err(|error| InstallError::new(format!("staging failed: {error}")))
}

/// Purely cosmetic: nothing ever parses this name — [`stage_archive`] hands
/// the exact `PathBuf` to the apply path and clears the directory wholesale
/// — but a support bundle listing `<app_root>/updates/` should name the
/// platform's real artifact rather than a macOS bundle archive.
#[cfg(target_os = "linux")]
const PENDING_ARCHIVE_SUFFIX: &str = "AppImage.tar.gz";
#[cfg(not(target_os = "linux"))]
const PENDING_ARCHIVE_SUFFIX: &str = "app.tar.gz";

/// Clear-then-write: at most ONE pending archive ever exists, so a
/// superseding version can never leave the old one behind and the apply
/// path never has to disambiguate.
fn stage_archive(dir: &Path, version: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("pending-{version}.{PENDING_ARCHIVE_SUFFIX}"));
    std::fs::write(&path, bytes)?;
    Ok(path)
}

// Both version-marker extractors below are compiled on EVERY OS — only the
// call site in `download_verify_stage` is cfg-dispatched — so macOS CI runs
// the Linux parser's tests and vice versa. flate2/tar/plist are portable, so
// the only cost is the `dead_code` allow on whichever one this target does
// not call.

/// `CFBundleShortVersionString` of the top-level `.app` inside the updater
/// tar.gz (`<name>.app/Contents/Info.plist` — exactly depth 3, so a nested
/// framework's plist can never shadow the bundle's own).
#[cfg_attr(target_os = "linux", allow(dead_code))]
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

/// The `<version>` of the sole top-level `*.AppImage` member of a
/// `v1Compatible` updater tarball — the Linux twin of
/// [`bundle_short_version`]. Usable as a pairing marker only because tar
/// stores member NAMES in the bytes minisign signs; depth 1 is pinned for
/// the same reason the macOS side pins depth 3, so no nested member can
/// stand in for the real one. The `<product>_<version>_<arch>` shape is
/// tauri-bundler's, frozen by the pinned CLI version (a bump must
/// re-verify it — see the pin comment in `.github/workflows/release-native.yaml`).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn appimage_member_version(targz: &[u8]) -> Result<String, String> {
    let decoder = flate2::read::GzDecoder::new(targz);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("unreadable archive: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("unreadable archive entry: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("unreadable entry path: {error}"))?;
        let components: Vec<String> = path
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let [name] = components.as_slice() else {
            continue;
        };
        let Some(stem) = name.strip_suffix(".AppImage") else {
            continue;
        };
        // Fail closed rather than skip on: an unexpected shape on the one
        // member we ship means the bundler moved under us, not that some
        // other member is the right one.
        let segments: Vec<&str> = stem.split('_').collect();
        let [_product, version, _arch] = segments.as_slice() else {
            return Err(format!(
                "unexpected AppImage member name {name}, want <product>_<version>_<arch>.AppImage"
            ));
        };
        if version.is_empty() {
            return Err(format!("AppImage member name {name} has an empty version"));
        }
        return Ok((*version).to_string());
    }
    Err("no top-level *.AppImage member in archive".to_string())
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
    fn stage_archive_is_clear_then_write() {
        let dir = tempfile::tempdir().unwrap();
        let updates = dir.path().join("updates");
        let first = stage_archive(&updates, "9.0.1", b"first").unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"first");
        // A superseding stage removes the previous archive entirely.
        let second = stage_archive(&updates, "9.0.2", b"second").unwrap();
        assert!(!first.exists());
        assert_eq!(std::fs::read(&second).unwrap(), b"second");
        assert_eq!(std::fs::read_dir(&updates).unwrap().count(), 1);
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

    /// A gzipped tar holding one empty file per path — the AppImage marker
    /// lives entirely in the member NAME, so contents are irrelevant.
    fn targz_of(paths: &[&str]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for path in paths {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, path, std::io::empty())
                .unwrap();
        }
        let tar_bytes = builder.into_inner().unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, &tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn appimage_member_version_reads_the_v1_compatible_member_name() {
        let targz = targz_of(&["deco_4.151.0_amd64.AppImage"]);
        assert_eq!(appimage_member_version(&targz).unwrap(), "4.151.0");
    }

    #[test]
    fn appimage_member_version_rejects_anything_but_the_bundler_shape() {
        // Depth 2: a nested member must never stand in for the real one.
        assert!(
            appimage_member_version(&targz_of(&["nested/deco_4.151.0_amd64.AppImage"])).is_err()
        );
        // Not exactly <product>_<version>_<arch>.
        assert!(appimage_member_version(&targz_of(&["deco_4.151.0.AppImage"])).is_err());
        assert!(appimage_member_version(&targz_of(&["deco_4.151.0_amd64_x.AppImage"])).is_err());
        assert!(appimage_member_version(&targz_of(&["deco.AppImage"])).is_err());
        assert!(appimage_member_version(&targz_of(&["deco__amd64.AppImage"])).is_err());
        // No AppImage member at all (e.g. a macOS artifact served by a
        // manifest whose platform keys were crossed).
        assert!(appimage_member_version(&targz_of(&["deco.app/Contents/Info.plist"])).is_err());
        // Not gzip.
        assert!(appimage_member_version(b"not a tarball").is_err());
    }
}
