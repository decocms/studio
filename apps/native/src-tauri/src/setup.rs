//! Native boot sequence: start one stable loopback control origin, serve the
//! bundled UI and APIs from it, then open the main webview. Development keeps
//! Vite/HMR as the browser-facing origin and proxies API paths to Rust.

use std::sync::Arc;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::state::LocalApiState;
use crate::{control_origin, selftest};

const AUTH_STATUS_CHANGED_EVENT: &str = "auth-status-changed";

#[derive(Debug, thiserror::Error)]
pub enum SetupError {
    #[error("failed to resolve the app-data directory: {0}")]
    AppDataDir(#[source] tauri::Error),
    #[error("invalid self-test app-data directory: {0}")]
    SelftestAppDataDir(String),
    #[error("failed to create app-data directory {path:?}: {source}")]
    CreateAppDataDir {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to start local-api: {0}")]
    LocalApi(#[from] local_api::StartError),
    #[error("failed to load bundled UI assets: {0}")]
    UiAssets(String),
    #[error("failed to prepare local HTTPS: {0}")]
    LocalTls(#[from] crate::local_tls::TlsError),
    #[error("invalid control URL: {0}")]
    ControlUrl(String),
    #[error("failed to build the main window: {0}")]
    Window(#[source] tauri::Error),
}

/// Cryptographically random 32-byte hex token, generated fresh per launch
/// — mirrors `local_api`'s own `generate_token()` (kept as a small
/// independent duplicate rather than exposing that private helper: the
/// shell always knows its own token up front, unlike the standalone
/// binary which may inherit one from the env — see `StartOptions`'s doc
/// comment in `crates/local-api/src/lib.rs`).
fn generate_launch_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_allowed_webview_navigation(
    url: &tauri::Url,
    control_origin: &str,
    preview_port: u16,
) -> bool {
    url.as_str() == "about:blank"
        || url.origin().ascii_serialization() == control_origin
        || is_sandbox_preview_url(url, preview_port)
}

/// Whether `url` is a sandbox preview.
///
/// Mirrors `preview_url`'s gate: under a single-label control host every
/// sandbox shares ONE preview origin, and only under a real registrable domain
/// does each get its own `<handle>.<host>`. Accepts whichever form the
/// configured host implies, and nothing else.
fn is_sandbox_preview_url(url: &tauri::Url, preview_port: u16) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if url.scheme() != control_origin::CONTROL_SCHEME
        || url.port_or_known_default() != Some(preview_port)
    {
        return false;
    }
    let control = control_origin::CONTROL_HOST;
    if !control.contains('.') {
        // Single-origin mode: the preview is the control host on its own port.
        return host == control;
    }
    // Per-handle mode: exactly one label under the control host. The wildcard
    // DNS record covers one level, and a deeper name is not something this app
    // ever mints.
    host.strip_suffix(&format!(".{control}"))
        .is_some_and(|label| !label.is_empty() && !label.contains('.'))
}

fn new_window_policy() -> tauri::webview::NewWindowResponse<tauri::Wry> {
    tauri::webview::NewWindowResponse::Deny
}

fn spawn_auth_status_bridge(app: tauri::AppHandle, session: upstream::UpstreamSession) {
    let mut status_rx = session.subscribe();
    tauri::async_runtime::spawn(async move {
        while status_rx.changed().await.is_ok() {
            let payload = crate::auth::AuthStatusWire::from(status_rx.borrow().clone());
            if let Err(error) = app.emit(AUTH_STATUS_CHANGED_EVENT, payload) {
                tracing::warn!(%error, "failed to emit upstream auth status change");
            }
        }
    });
}

/// Tauri's normal window/app exit path emits `ExitRequested`, but a dev-loop
/// rebuild may terminate the process with an OS signal instead. Route SIGTERM
/// and SIGINT back through `AppHandle::exit` so `shutdown::run_blocking` still
/// cancels local harness process groups and drains the embedded local API.
#[cfg(unix)]
fn install_signal_shutdown(app: tauri::AppHandle) {
    use tokio::signal::unix::{signal, SignalKind};

    // `signal(...)` installs Tokio's process-wide handlers synchronously.
    // Do that before spawning the waiter: merely spawning an async block that
    // installs them later leaves a scheduling window where startup recovery is
    // already running under the platform's default SIGTERM disposition.
    let mut terminate = match signal(SignalKind::terminate()) {
        Ok(signal) => Some(signal),
        Err(error) => {
            tracing::warn!(%error, "could not install native SIGTERM handler");
            None
        }
    };
    let mut interrupt = match signal(SignalKind::interrupt()) {
        Ok(signal) => Some(signal),
        Err(error) => {
            tracing::warn!(%error, "could not install native SIGINT handler");
            None
        }
    };

    tauri::async_runtime::spawn(async move {
        let mut graceful_requested = false;
        while let Some(signal_name) = next_shutdown_signal(&mut terminate, &mut interrupt).await {
            match shutdown_signal_action(&mut graceful_requested) {
                ShutdownSignalAction::RequestGracefulExit => {
                    tracing::info!(signal = signal_name, "native shutdown signal received");
                    app.exit(0);
                }
                ShutdownSignalAction::ForceExit => {
                    // Tokio permanently replaces the platform's default signal
                    // disposition even after a `Signal` stream is dropped. Keep
                    // both listeners alive after the first request and make a
                    // second signal the operator's reliable escape hatch from a
                    // wedged shutdown hook.
                    tracing::error!(
                        signal = signal_name,
                        "second native shutdown signal received; forcing exit"
                    );
                    std::process::exit(1);
                }
            }
        }
    });
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShutdownSignalAction {
    RequestGracefulExit,
    ForceExit,
}

#[cfg(unix)]
fn shutdown_signal_action(graceful_requested: &mut bool) -> ShutdownSignalAction {
    if std::mem::replace(graceful_requested, true) {
        ShutdownSignalAction::ForceExit
    } else {
        ShutdownSignalAction::RequestGracefulExit
    }
}

#[cfg(unix)]
async fn next_shutdown_signal(
    terminate: &mut Option<tokio::signal::unix::Signal>,
    interrupt: &mut Option<tokio::signal::unix::Signal>,
) -> Option<&'static str> {
    enum Received {
        Terminate(Option<()>),
        Interrupt(Option<()>),
    }

    loop {
        let received = match (terminate.as_mut(), interrupt.as_mut()) {
            (Some(terminate), Some(interrupt)) => tokio::select! {
                value = terminate.recv() => Received::Terminate(value),
                value = interrupt.recv() => Received::Interrupt(value),
            },
            (Some(terminate), None) => Received::Terminate(terminate.recv().await),
            (None, Some(interrupt)) => Received::Interrupt(interrupt.recv().await),
            (None, None) => return None,
        };
        match received {
            Received::Terminate(Some(())) => return Some("SIGTERM"),
            Received::Interrupt(Some(())) => return Some("SIGINT"),
            Received::Terminate(None) => *terminate = None,
            Received::Interrupt(None) => *interrupt = None,
        }
    }
}

pub async fn run(app: &tauri::AppHandle) -> Result<(), SetupError> {
    // Install OS signal ownership before local-api startup/recovery begins.
    // A dev-loop SIGTERM can arrive while `local_api::start` is reopening the
    // durable queue; registering only after that await left the platform's
    // default disposition active and skipped every graceful cleanup fence.
    #[cfg(unix)]
    install_signal_shutdown(app.clone());

    let selftest_mode = selftest::is_enabled();
    let app_root = if selftest_mode {
        selftest::app_data_dir().map_err(SetupError::SelftestAppDataDir)?
    } else {
        app.path().app_data_dir().map_err(SetupError::AppDataDir)?
    };
    std::fs::create_dir_all(&app_root).map_err(|source| SetupError::CreateAppDataDir {
        path: app_root.clone(),
        source,
    })?;

    // Local HTTPS. The webview's origin has to be BOTH a real domain (so each
    // sandbox preview gets its own cookie jar) and a secure context (so Web
    // Crypto exists), and only TLS gives both — see `local_tls`'s module doc.
    // The CA is minted per machine and reused; the leaf is fresh each launch.
    // Trusting the root prompts the user once, in the USER trust domain, so it
    // needs their own password rather than an administrator.
    let tls = crate::local_tls::ensure(&app_root)?;
    crate::local_tls::ensure_trusted(&tls.ca_cert)?;
    tracing::info!(ca = %tls.ca_cert.display(), "local TLS material ready and trusted");

    let control = control_origin::current(selftest_mode);
    let browser_origin = control.resolve();
    let bundled_ui = if selftest_mode || !tauri::is_dev() {
        Some(Arc::new(
            crate::ui_assets::TauriUiAssets::new(app, selftest_mode)
                .map_err(SetupError::UiAssets)?,
        ) as Arc<dyn local_api::UiAssetProvider>)
    } else {
        None
    };
    let mut embedded =
        local_api::EmbeddedOptions::new(control.expected_host(), browser_origin.clone());
    embedded.ui_assets = bundled_ui;
    embedded.preview_cookie_selftest = selftest_mode;
    let handle = local_api::start_embedded(
        local_api::StartOptions {
            // Serve the leaf minted above: the webview's origin must be a
            // secure context for Web Crypto, and a real domain for per-sandbox
            // cookie jars.
            tls: Some(local_api::TlsFiles {
                cert: tls.leaf_cert.clone(),
                key: tls.leaf_key.clone(),
            }),
            token: generate_launch_token(),
            boot_id: uuid::Uuid::new_v4().to_string(),
            app_root,
            port: control.listener_port,
            mode: local_api::ApiMode::Strict,
        },
        embedded,
    )
    .await?;
    let port = handle.port();
    let preview_port = handle.preview_port();
    tracing::info!(
        port,
        preview_port,
        browser_origin,
        "native control server started in-process"
    );
    app.manage(LocalApiState::new(handle));

    // Keep server-side revocation and refresh-token expiry reflected in the
    // native shell even when no proxy request or account-menu action happens.
    // Dropping a Tokio JoinHandle detaches (rather than cancels) its task; the
    // process lifetime is the desired owner for this periodic loop.
    let upstream_session = upstream::global();
    spawn_auth_status_bridge(app.clone(), upstream_session.clone());
    drop(upstream::revalidate::spawn(
        upstream_session,
        upstream::revalidate::DEFAULT_INTERVAL,
    ));

    let webview_url = WebviewUrl::External(
        browser_origin
            .parse::<tauri::Url>()
            .map_err(|error| SetupError::ControlUrl(error.to_string()))?,
    );
    let navigation_control_origin = browser_origin.clone();
    let mut builder = WebviewWindowBuilder::new(app, "main", webview_url)
        .title("Studio")
        .inner_size(1080.0, 720.0)
        // Wry reports child-frame navigations here too, so rejected URLs must
        // not cause side effects. Only explicit UI actions open the browser.
        .on_navigation(move |url| {
            is_allowed_webview_navigation(url, &navigation_control_origin, preview_port)
        })
        .on_new_window(move |_url, _features| new_window_policy());
    if selftest_mode {
        // "Hidden or visible" per the brief — hidden keeps an automated
        // `boot-smoke.ts` run from popping a window on the CI/dev machine.
        // DESKTOP_SELFTEST_VISIBLE=1 keeps the window visible: macOS App
        // Nap throttles timers AND network-response delivery for hidden
        // windows, which can wedge the self-test's fetches indefinitely
        // (observed live 2026-07-19: requests reached local-api, responses
        // never reached the hidden page). CI/boot-smoke stays hidden by
        // default; flip this on when the self-test inexplicably stalls.
        if std::env::var("DESKTOP_SELFTEST_VISIBLE").as_deref() != Ok("1") {
            builder = builder.visible(false);
        }
        // Boot-error captor: runs before any page script, so module-eval
        // failures the selftest bundle would otherwise miss (it is eval'd
        // only after page load) land in `window.__BOOT_ERRORS` for the
        // bundle's diagnostic probe to report. Selftest-only — never ships
        // in a normal launch.
        //
        // `securitypolicyviolation` is included alongside `error`/
        // `unhandledrejection`: a blocked resource (e.g. an `img-src`
        // violation) does NOT fire `window.onerror` — it's a dedicated DOM
        // event — so without this listener a CSP regression would silently
        // NOT show up in `__BOOT_ERRORS` at all, defeating the "read the
        // CSP failures pragmatically" check this was added for (see
        // `csp.rs`'s module doc).
        builder = builder.initialization_script(
            "window.__BOOT_ERRORS = [];\n\
             window.addEventListener('error', (e) => {\n\
               window.__BOOT_ERRORS.push('error: ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || 0));\n\
             }, true);\n\
             window.addEventListener('unhandledrejection', (e) => {\n\
               window.__BOOT_ERRORS.push('unhandledrejection: ' + String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));\n\
             });\n\
             window.addEventListener('securitypolicyviolation', (e) => {\n\
               window.__BOOT_ERRORS.push('securitypolicyviolation: ' + (e.violatedDirective || '') + ' blocked ' + (e.blockedURI || '') + ' on ' + (e.documentURI || ''));\n\
             });",
        );
    }
    if selftest_mode {
        builder = builder.on_page_load(move |window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                tracing::info!("self-test: page loaded, evaluating bundle");
                if let Err(err) = window.eval(selftest::BUNDLE_JS) {
                    tracing::error!(error = %err, "self-test: failed to eval bundle");
                }
            }
        });
    }
    builder.build().map_err(SetupError::Window)?;

    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn first_shutdown_signal_is_graceful_and_second_is_forced() {
        let mut graceful_requested = false;
        assert_eq!(
            shutdown_signal_action(&mut graceful_requested),
            ShutdownSignalAction::RequestGracefulExit
        );
        assert_eq!(
            shutdown_signal_action(&mut graceful_requested),
            ShutdownSignalAction::ForceExit
        );
        assert_eq!(
            shutdown_signal_action(&mut graceful_requested),
            ShutdownSignalAction::ForceExit
        );
    }

    #[test]
    fn webview_navigation_is_limited_to_control_and_preview_origins() {
        let control = "https://local.studio.decocms.com:43120";
        let preview_port = 61_234;
        for allowed in [
            "https://local.studio.decocms.com:43120/fila",
            "https://h1-abc.local.studio.decocms.com:61234/products",
            "about:blank",
        ] {
            assert!(
                is_allowed_webview_navigation(&allowed.parse().unwrap(), control, preview_port),
                "{allowed} should be allowed"
            );
        }
        for blocked in [
            "https://studio.decocms.com/fila",
            "https://13105467.fls.doubleclick.net/activityi;src=13105467",
            "https://ct.pinterest.com/ct.html",
            "http://127.0.0.1:61234/steal-cookie",
            "https://h1.local.studio.decocms.com:61235/",
            // Sub-labels are NOT the preview while the control host is a
            // single label — they are separate sites with no cookie storage.
            "https://local.studio.decocms.com:61234/",
            "https://a.b.local.studio.decocms.com:61234/",
            "http://h1.local.studio.decocms.com:61234/",
            "http://preview.localhost:61234/",
            "http://evil.localhost:61234/",
        ] {
            assert!(
                !is_allowed_webview_navigation(&blocked.parse().unwrap(), control, preview_port),
                "{blocked} should be blocked"
            );
        }
    }

    #[test]
    fn webview_new_windows_are_always_denied() {
        assert!(matches!(
            new_window_policy(),
            tauri::webview::NewWindowResponse::Deny
        ));
    }
}
