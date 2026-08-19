//! Linux (WebKitGTK) trust for this app's own local leaf certificate.
//!
//! macOS installs the per-machine root into the login keychain once and every
//! consumer — webview included — follows. An AppImage has no install hook to
//! add a system anchor from, and asking a user to run `update-ca-trust` as root
//! for a certificate that only secures loopback is hostile. So on Linux nothing
//! is installed into the OS at all: the webview is handed a per-HOST exception
//! for the exact leaf this launch minted, registered in-process before its
//! first navigation (`setup.rs` stages the window at `about:blank` for exactly
//! this reason). Spawned CLIs get their own answer — see
//! `local_tls::ensure_child_ca_bundle`.
//!
//! ## The exception set only ever grows
//!
//! `webkit_web_context_allow_tls_certificate_for_host` has no inverse:
//! WebKitGTK exposes no per-host revoke and no way to enumerate what is
//! already allowed. The set is therefore append-only for the lifetime of the
//! process. Two things bound it: one entry per sandbox preview handle seen
//! during this run (plus the control host), and process exit — the leaf is
//! re-minted on every launch, so nothing registered here can outlive the
//! certificate it was registered for. [`ACCUMULATION_WARN_THRESHOLD`] logs if
//! a run ever exceeds a plausible number of sandboxes, which would mean the
//! dedup below stopped working rather than that a user opened that many.
//!
//! ## Why previews must be registered proactively
//!
//! The exception API takes an exact host — no wildcard — and the
//! `load-failed-with-tls-errors` recovery signal fires only for main-frame
//! loads. A sandbox preview is an iframe, so it has no second chance: its host
//! has to be allowed before the URL reaches the page. That is what
//! [`allow_preview_host`] and `local-api`'s `preview_host_observer` exist for.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use tauri::Manager;
use webkit2gtk::gio;
use webkit2gtk::gio::prelude::TlsCertificateExt;
use webkit2gtk::{WebContextExt, WebViewExt};

/// The label `setup::run` builds the shell's one window under.
const MAIN_WINDOW_LABEL: &str = "main";

/// A run with more allowed hosts than this is a bug in the dedup, not a user
/// with that many sandboxes open.
const ACCUMULATION_WARN_THRESHOLD: usize = 64;

/// This launch's leaf, so [`allow_preview_host`] can re-read it on the GTK
/// thread without the caller having to carry the path around. Set by
/// [`install`]; a preview seen before that is dropped, which is correct — no
/// window exists to load it in yet either.
static LEAF_CERT: OnceLock<PathBuf> = OnceLock::new();

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

#[derive(Default)]
struct State {
    /// Every host whose exception has been installed successfully.
    granted: HashSet<String>,
    /// Every caller waiting for the first registration attempt for a host.
    /// This deduplicates concurrent URL requests without acknowledging any of
    /// them before the GTK callback has completed.
    waiting: HashMap<String, Vec<tokio::sync::oneshot::Sender<Result<(), String>>>>,
    /// Preview hosts observed before the webview existed. Drained by
    /// [`install`] under this same lock, so a host can never be queued into a
    /// list nobody will read again.
    pending: Vec<String>,
    webview_ready: bool,
}

fn state() -> MutexGuard<'static, State> {
    STATE
        .get_or_init(|| Mutex::new(State::default()))
        .lock()
        // A panic while holding this lock leaves the set intact; refusing to
        // trust anything afterwards would strand the webview for good.
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Trust the control origin in `window`'s webview, then navigate it to
/// `control_url`.
///
/// The returned receiver resolves once the GTK main thread has run the
/// registration. A closed channel means the dispatch never reached the
/// webview, which is as fatal as a failed registration — the window would sit
/// on `about:blank` forever.
pub fn install(
    window: &tauri::WebviewWindow,
    leaf_cert: PathBuf,
    control_host: String,
    control_url: String,
) -> tokio::sync::oneshot::Receiver<Result<(), String>> {
    let _ = LEAF_CERT.set(leaf_cert.clone());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dispatch = window.with_webview(move |platform| {
        let outcome =
            register_control_origin(&platform.inner(), &leaf_cert, &control_host, &control_url);
        let _ = tx.send(outcome);
    });
    if let Err(error) = dispatch {
        tracing::error!(%error, "could not reach the webview to trust the local certificate");
    }
    rx
}

/// Trust one sandbox preview host, dispatching to the GTK main thread.
///
/// Called from `local-api`'s request path (any thread) via the
/// `preview_host_observer` hook, once per preview URL handed out.
pub fn allow_preview_host(
    app: &tauri::AppHandle,
    host: &str,
) -> tokio::sync::oneshot::Receiver<Result<(), String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let host = host.to_string();
    {
        let mut state = state();
        if state.granted.contains(&host) {
            let _ = tx.send(Ok(()));
            return rx;
        }
        if let Some(waiters) = state.waiting.get_mut(&host) {
            waiters.push(tx);
            return rx;
        }
        state.waiting.insert(host.clone(), vec![tx]);
        let host_count = state.granted.len() + state.waiting.len();
        if host_count > ACCUMULATION_WARN_THRESHOLD {
            tracing::warn!(
                hosts = host_count,
                "webview TLS exceptions keep accumulating; WebKitGTK cannot revoke one, \
                 so they clear only when the app restarts"
            );
        }
        if !state.webview_ready {
            state.pending.push(host);
            return rx;
        }
    }
    dispatch_preview_host(app, host);
    rx
}

fn dispatch_preview_host(app: &tauri::AppHandle, host: String) {
    let Some(leaf_cert) = LEAF_CERT.get().cloned() else {
        complete_preview_host(
            &host,
            Err("the local leaf certificate is not initialized".to_string()),
        );
        return;
    };
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        complete_preview_host(&host, Err("the main webview does not exist".to_string()));
        return;
    };
    let callback_host = host.clone();
    let dispatch = window.with_webview(move |platform| {
        let outcome = allow_host(&platform.inner(), &leaf_cert, &callback_host);
        if let Err(error) = &outcome {
            tracing::warn!(%error, host = %callback_host, "could not trust a sandbox preview host");
        }
        complete_preview_host(&callback_host, outcome);
    });
    if let Err(error) = dispatch {
        tracing::warn!(%error, "could not reach the webview to trust a sandbox preview host");
        complete_preview_host(
            &host,
            Err(format!(
                "could not reach the webview to trust the preview host: {error}"
            )),
        );
    }
}

fn complete_preview_host(host: &str, outcome: Result<(), String>) {
    let waiters = {
        let mut state = state();
        let waiters = state.waiting.remove(host).unwrap_or_default();
        if outcome.is_ok() {
            state.granted.insert(host.to_string());
        }
        waiters
    };
    for waiter in waiters {
        let _ = waiter.send(outcome.clone());
    }
}

/// Runs on the GTK main thread, inside `with_webview`.
fn register_control_origin(
    webview: &webkit2gtk::WebView,
    leaf_cert: &Path,
    control_host: &str,
    control_url: &str,
) -> Result<(), String> {
    let leaf = load_leaf(leaf_cert)?;
    let context = webview
        .context()
        .ok_or_else(|| "the webview reported no WebKit context".to_string())?;
    context.allow_tls_certificate_for_host(&leaf, control_host);

    // Belt and braces for main-frame loads only (subframes never raise this
    // signal). It re-registers exactly the certificate we already trust, for a
    // host we would have registered anyway, so it can only ever recover from a
    // host this process failed to anticipate — never widen trust. wry itself
    // exposes no TLS API and never connects this signal, so there is no
    // competing handler.
    let expected = leaf.clone();
    let control_host = control_host.to_string();
    webview.connect_load_failed_with_tls_errors(move |view, failing_uri, certificate, _errors| {
        let Some(failing_host) = host_of(failing_uri) else {
            return false;
        };
        if !is_control_host_or_subdomain(&failing_host, &control_host) {
            return false;
        }
        if !certificate.is_same(&expected) {
            return false;
        }
        let Some(context) = view.context() else {
            return false;
        };
        context.allow_tls_certificate_for_host(certificate, &failing_host);
        view.reload();
        true
    });

    // Under the same lock that queues them, so a preview observed while this
    // runs either lands in `pending` (and is drained here) or dispatches on
    // its own against a webview that now exists.
    let pending = {
        let mut state = state();
        state.webview_ready = true;
        std::mem::take(&mut state.pending)
    };
    for host in pending {
        context.allow_tls_certificate_for_host(&leaf, &host);
        complete_preview_host(&host, Ok(()));
    }

    // Only now: every exception this launch knows about is registered, so the
    // first real navigation cannot race them.
    webview.load_uri(control_url);
    Ok(())
}

/// Runs on the GTK main thread, inside `with_webview`.
fn allow_host(webview: &webkit2gtk::WebView, leaf_cert: &Path, host: &str) -> Result<(), String> {
    let leaf = load_leaf(leaf_cert)?;
    let context = webview
        .context()
        .ok_or_else(|| "the webview reported no WebKit context".to_string())?;
    context.allow_tls_certificate_for_host(&leaf, host);
    Ok(())
}

fn load_leaf(path: &Path) -> Result<gio::TlsCertificate, String> {
    gio::TlsCertificate::from_file(path).map_err(|error| {
        format!(
            "could not read the local leaf certificate {}: {error}",
            path.display()
        )
    })
}

fn host_of(uri: &str) -> Option<String> {
    tauri::Url::parse(uri).ok()?.host_str().map(str::to_string)
}

/// The control host itself, or exactly ONE label under it — the only shapes
/// this app ever mints (`local-api`'s `preview_url_for`). A deeper name is
/// somebody else's.
fn is_control_host_or_subdomain(host: &str, control_host: &str) -> bool {
    if host == control_host {
        return true;
    }
    host.strip_suffix(control_host)
        .and_then(|label| label.strip_suffix('.'))
        .is_some_and(|label| !label.is_empty() && !label.contains('.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovers_only_the_control_host_and_its_direct_preview_labels() {
        let control = "local.studio.decocms.com";
        for allowed in [
            "local.studio.decocms.com",
            "h1-abc.local.studio.decocms.com",
        ] {
            assert!(
                is_control_host_or_subdomain(allowed, control),
                "{allowed} should be recoverable"
            );
        }
        for blocked in [
            "studio.decocms.com",
            "decocms.com",
            "a.b.local.studio.decocms.com",
            ".local.studio.decocms.com",
            "xlocal.studio.decocms.com",
            "local.studio.decocms.com.evil.test",
            "",
        ] {
            assert!(
                !is_control_host_or_subdomain(blocked, control),
                "{blocked} should not be recoverable"
            );
        }
    }

    #[test]
    fn reads_the_host_out_of_a_failing_uri() {
        assert_eq!(
            host_of("https://h1.local.studio.decocms.com:61234/products").as_deref(),
            Some("h1.local.studio.decocms.com")
        );
        assert_eq!(host_of("about:blank"), None);
        assert_eq!(host_of("not a url"), None);
    }
}
