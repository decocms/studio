//! CLI availability detection — GROW-ONLY cache mirroring
//! `apps/api/src/link-daemon/capabilities.ts`'s semantics EXACTLY:
//! `mergeProbedCapabilities` there never un-advertises a capability once
//! seen ("a transient probe failure (CLI busy, SDK hiccup) must never
//! un-advertise a capability mid-run — dispatch routing would start
//! bouncing threads that are actively streaming"). This module ports that
//! same invariant to Rust: once a harness flips to `true`, no later probe
//! — however it fails — can flip it back.
//!
//! "Detected" means the CLI is installed AND has a confirmed logged-in
//! session — FAIL-CLOSED: an installed-but-not-logged-in CLI is not usable,
//! so it does NOT count as detected. `probe()` requires BOTH a successful
//! `--version` probe (installed) AND a passing auth probe (logged in):
//!   - claude via `<bin> auth status --json`'s `"loggedIn":true` (mirrors
//!     `capabilities.ts::detectClaudeCode`'s account-email check, adapted
//!     since this crate drives the CLI's own surface rather than the
//!     `@anthropic-ai/claude-agent-sdk`),
//!   - codex via `<bin> login status`'s "Logged in" text — which the codex
//!     CLI prints to STDERR with an empty stdout, so the auth probe merges
//!     stdout+stderr before parsing (see `run_probe_capture`).
//!
//! A failed/unrecognized/unparseable auth check keeps `detected` at
//! `false` (logged as a diagnostic). The grow-only cache invariant above
//! still holds: once a confirmed-logged-in probe flips a harness to
//! `true`, no later probe flips it back — but a CLI never reaches `true`
//! in the first place until login is confirmed.
//!
//! Because detection is now auth-gated, the SHARED CONTRACT surface
//! `apps/native/e2e/fixtures/stub-harness.mjs` answers the auth probe as
//! logged-in too (claude: `{"loggedIn":true}` on stdout for `auth status
//! --json`; codex: "Logged in using ChatGPT" on stderr for `login status`)
//! in ADDITION to `--version`, so the differential/parity tests still see
//! it as detected. Both probes are independently swappable via
//! [`resolve::resolve_argv`] (the SHARED CONTRACT env overrides).

use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::RwLock;

use crate::resolve::{self, HarnessId};

/// Wall-clock cap on a single probe subprocess (version OR auth check).
/// Generous for a binary that's actually installed and responsive, bounded
/// so a hung/misbehaving binary on someone's PATH can't wedge detection.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the background task re-probes while at least one harness is
/// still undetected. Matches the order of magnitude of
/// `capabilities.ts::startCapabilityReprobe`'s default (60s).
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Detection {
    pub claude_code: bool,
    pub codex: bool,
}

impl Detection {
    pub fn get(self, harness: HarnessId) -> bool {
        match harness {
            HarnessId::ClaudeCode => self.claude_code,
            HarnessId::Codex => self.codex,
        }
    }

    fn set(&mut self, harness: HarnessId, value: bool) {
        match harness {
            HarnessId::ClaudeCode => self.claude_code = value,
            HarnessId::Codex => self.codex = value,
        }
    }

    fn all_detected(self) -> bool {
        self.claude_code && self.codex
    }

    /// Grow-only merge: `self ||= probed`, per-field. Never flips a `true`
    /// back to `false`. Returns whether anything NEW became detected.
    fn merge(&mut self, probed: Detection) -> bool {
        let mut grew = false;
        for harness in HarnessId::ALL {
            if !self.get(harness) && probed.get(harness) {
                self.set(harness, true);
                grew = true;
            }
        }
        grew
    }
}

static CACHE: OnceLock<RwLock<Detection>> = OnceLock::new();
static REFRESH_STARTED: OnceLock<()> = OnceLock::new();

fn cache_lock() -> &'static RwLock<Detection> {
    CACHE.get_or_init(|| RwLock::new(Detection::default()))
}

/// Read the cache without probing. `Detection::default()` (nothing
/// detected) if nothing has probed yet.
pub async fn cached() -> Detection {
    *cache_lock().read().await
}

/// Ensures the cache has been populated at least once, paying for a
/// bounded probe pass on the FIRST call (cold start) and starting the
/// background re-probe loop as a side effect. Every call after the first
/// reads the warm cache instantly — a request never blocks on a probe it
/// didn't cause. Concurrent cold-start callers all pay for their own probe
/// (idempotent — the grow-only merge makes redundant probing harmless,
/// just slightly wasteful), same tradeoff the Phase 1 `routes/models.rs`
/// bootstrap already made.
pub async fn ensure_detected() -> Detection {
    let current = cached().await;
    if current.all_detected() {
        start_background_reprobe();
        return current;
    }
    let probed = probe_missing(current).await;
    let merged = {
        let mut guard = cache_lock().write().await;
        guard.merge(probed);
        *guard
    };
    start_background_reprobe();
    merged
}

/// Starts the periodic re-probe loop exactly once per process. A no-op
/// once every harness is detected (matches `capabilities.ts`'s "probing
/// stops being useful once every CLI capability is present" comment) —
/// each tick still fires, but `probe_missing` skips a harness already
/// `true`, so a fully-detected process settles into a near-free timer.
fn start_background_reprobe() {
    if REFRESH_STARTED.set(()).is_err() {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(REFRESH_INTERVAL).await;
            let current = cached().await;
            if current.all_detected() {
                continue;
            }
            let probed = probe_missing(current).await;
            let mut guard = cache_lock().write().await;
            guard.merge(probed);
        }
    });
}

/// Probes only the harnesses NOT already `true` in `current` — matches
/// `capabilities.ts::missingCliCapabilities` gating re-probes to what's
/// actually missing, so a confirmed-detected CLI never pays for another
/// probe subprocess.
async fn probe_missing(current: Detection) -> Detection {
    let (claude_code, codex) = tokio::join!(
        async {
            if current.claude_code {
                true
            } else {
                probe(HarnessId::ClaudeCode).await
            }
        },
        async {
            if current.codex {
                true
            } else {
                probe(HarnessId::Codex).await
            }
        },
    );
    Detection { claude_code, codex }
}

async fn probe(harness: HarnessId) -> bool {
    // Fail-CLOSED: detected == installed AND logged in. Short-circuit the
    // auth probe when `--version` already failed (nothing to be logged in
    // to).
    if !version_ok(harness).await {
        return false;
    }
    if !auth_ok(harness).await {
        tracing::debug!(
            harness = harness.wire_id(),
            "CLI answered --version but its auth-status probe did not confirm a logged-in session \
             (not logged in, or the auth surface is unrecognized/unsupported) — NOT counted as \
             detected (fail-closed: an installed-but-not-logged-in CLI is not usable)"
        );
        return false;
    }
    true
}

async fn version_ok(harness: HarnessId) -> bool {
    let Ok(argv) = resolve::resolve_argv(harness) else {
        return false;
    };
    run_probe_capture(&argv, &["--version"], PROBE_TIMEOUT)
        .await
        .is_some()
}

async fn auth_ok(harness: HarnessId) -> bool {
    let Ok(argv) = resolve::resolve_argv(harness) else {
        return false;
    };
    match harness {
        HarnessId::ClaudeCode => {
            let Some(captured) =
                run_probe_capture(&argv, &["auth", "status", "--json"], PROBE_TIMEOUT).await
            else {
                return false;
            };
            claude_auth_status_indicates_logged_in(&captured)
        }
        HarnessId::Codex => {
            let Some(captured) =
                run_probe_capture(&argv, &["login", "status"], PROBE_TIMEOUT).await
            else {
                return false;
            };
            codex_login_status_indicates_logged_in(&captured)
        }
    }
}

/// Parses `claude auth status --json`'s output. Pure (no subprocess) so it
/// is unit-tested directly against captured output rather than requiring
/// a real login/logout cycle in CI. `text` is the MERGED stdout+stderr the
/// probe captured, so rather than parsing the whole capture (which fails
/// the moment any stderr noise precedes/follows the JSON), extract the
/// JSON object — first `{` through last `}` — and parse `loggedIn` from
/// that substring. A clean stdout-only JSON still parses (the whole string
/// is the object).
fn claude_auth_status_indicates_logged_in(text: &str) -> bool {
    let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) else {
        return false;
    };
    if end < start {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(&text[start..=end])
        .ok()
        .and_then(|v| v.get("loggedIn").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

/// Parses `codex login status`'s plain-text output ("Logged in using
/// ChatGPT" / "Logged in using an API key - ..." vs "Not logged in" — the
/// codex CLI has no `--json` flag for this subcommand, and prints this line
/// to STDERR). Pure for the same reason as the claude parser above. `text`
/// is the MERGED stdout+stderr, so check whether ANY line/segment is
/// "Logged in" (capital L) — true for "Logged in using ChatGPT" even when
/// it arrives via stderr after (empty) stdout, false for "Not logged in".
fn codex_login_status_indicates_logged_in(text: &str) -> bool {
    text.lines()
        .any(|line| line.trim_start().starts_with("Logged in"))
}

/// Spawn `<argv> <args>` with stdin closed (never let a probe hang reading
/// stdin — see `run.rs`'s module doc for why every harness spawn does
/// this), capture stdout AND stderr merged (stdout first, then stderr),
/// bounded by `timeout`. The auth probe needs the merge because codex
/// `login status` prints "Logged in ..." to stderr with an empty stdout;
/// merging is harmless for the `--version` probe (which only checks
/// success). `None` on spawn failure, non-success exit, or timeout;
/// non-UTF8-safe-decode issues are tolerated via lossy conversion, and the
/// child is best-effort killed on timeout so it doesn't leak as a zombie.
async fn run_probe_capture(argv: &[String], args: &[&str], timeout: Duration) -> Option<String> {
    let (program, rest) = argv.split_first()?;
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(rest);
    cmd.args(args);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            // ENOENT here is how a broken PATH (e.g. a GUI launch before the
            // shell's repair) manifests — never swallow it invisibly.
            tracing::debug!(%program, %error, "agent probe spawn failed");
            return None;
        }
    };
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;

    let read_and_wait = async {
        use tokio::io::AsyncReadExt;
        let mut out = Vec::new();
        let mut err = Vec::new();
        // Drain BOTH pipes CONCURRENTLY: a child that fills its stderr
        // pipe buffer while we're blocked reading stdout to EOF (or the
        // reverse) would deadlock if we drained them sequentially.
        let _ = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        let status = child.wait().await;
        (out, err, status)
    };

    match tokio::time::timeout(timeout, read_and_wait).await {
        Ok((mut out, err, Ok(status))) if status.success() => {
            out.extend_from_slice(&err);
            Some(String::from_utf8_lossy(&out).into_owned())
        }
        Ok(_) => None,
        Err(_) => {
            // Timed out — best-effort reap so we don't leak a zombie. The
            // owning `Command`/`Child` was moved into `read_and_wait`'s
            // future, which was dropped by the timeout; nothing left to
            // kill from here on most platforms (drop already sends
            // SIGKILL for a tokio::process::Child with kill_on_drop, the
            // default). Nothing further to do.
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_merge_is_grow_only() {
        let mut current = Detection {
            claude_code: true,
            codex: false,
        };
        let probed_a_failure = Detection {
            claude_code: false,
            codex: false,
        };
        let grew = current.merge(probed_a_failure);
        assert!(!grew);
        assert!(
            current.claude_code,
            "a transient probe failure must never un-list a previously-detected CLI"
        );
    }

    #[test]
    fn detection_merge_reports_growth_when_something_new_is_detected() {
        let mut current = Detection::default();
        let probed = Detection {
            claude_code: true,
            codex: false,
        };
        let grew = current.merge(probed);
        assert!(grew);
        assert!(current.claude_code);
        assert!(!current.codex);
    }

    #[test]
    fn detection_merge_of_fully_detected_is_a_no_op() {
        let mut current = Detection {
            claude_code: true,
            codex: true,
        };
        let grew = current.merge(Detection {
            claude_code: true,
            codex: true,
        });
        assert!(!grew);
        assert!(current.all_detected());
    }

    #[test]
    fn claude_auth_status_parses_logged_in_true() {
        let sample = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.com"}"#;
        assert!(claude_auth_status_indicates_logged_in(sample));
    }

    #[test]
    fn claude_auth_status_parses_logged_in_false() {
        let sample = r#"{"loggedIn":false}"#;
        assert!(!claude_auth_status_indicates_logged_in(sample));
    }

    #[test]
    fn claude_auth_status_treats_garbage_as_not_logged_in() {
        assert!(!claude_auth_status_indicates_logged_in("not json at all"));
        assert!(!claude_auth_status_indicates_logged_in(""));
    }

    #[test]
    fn claude_auth_status_parses_json_embedded_in_merged_stderr_noise() {
        // Merged stdout+stderr: a stderr warning line before the JSON must
        // not break parsing (the whole-capture `from_str` would have).
        let merged = "warning: config deprecated\n{\"loggedIn\":true,\"email\":\"a@b.com\"}\n";
        assert!(claude_auth_status_indicates_logged_in(merged));
        let merged_false = "some noise\n{\"loggedIn\":false}\ntrailing noise\n";
        assert!(!claude_auth_status_indicates_logged_in(merged_false));
    }

    #[test]
    fn codex_login_status_recognizes_logged_in_variants() {
        assert!(codex_login_status_indicates_logged_in(
            "Logged in using ChatGPT"
        ));
        assert!(codex_login_status_indicates_logged_in(
            "Logged in using an API key - sk-...\n"
        ));
        assert!(codex_login_status_indicates_logged_in(
            "  Logged in using ChatGPT"
        ));
    }

    #[test]
    fn codex_login_status_recognizes_logged_in_delivered_via_stderr() {
        // codex prints "Logged in ..." to STDERR with an empty stdout; the
        // probe merges stdout (empty) + stderr, so the parser sees the line
        // after a leading empty-stdout segment (and possibly other stderr
        // lines). This is the regression this whole change fixes.
        let merged = "\nLogged in using ChatGPT\n";
        assert!(codex_login_status_indicates_logged_in(merged));
        let merged_with_noise = "codex-cli 1.2.3\nLogged in using ChatGPT\n";
        assert!(codex_login_status_indicates_logged_in(merged_with_noise));
    }

    #[test]
    fn codex_login_status_recognizes_not_logged_in() {
        assert!(!codex_login_status_indicates_logged_in("Not logged in"));
        assert!(!codex_login_status_indicates_logged_in(""));
    }
}
