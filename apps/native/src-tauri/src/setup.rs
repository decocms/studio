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
    #[error("{host} does not resolve to this machine: {detail}")]
    ControlDns { host: String, detail: String },
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
    let origin = control_origin::current(crate::selftest::is_enabled());
    if url.scheme() != origin.scheme() || url.port_or_known_default() != Some(preview_port) {
        return false;
    }
    let control = origin.host();
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
    let control = control_origin::current(selftest_mode);
    // The control origin is a PUBLIC name that must resolve to loopback, and
    // resolvers with DNS-rebinding protection (dnsmasq's stop-dns-rebind,
    // pfSense, many corporate/VPN resolvers) strip exactly that answer. On
    // such a network the user is online, everything else works, and the
    // webview simply cannot load — so check up front and fail with a message
    // that names the actual problem instead of showing a dead window.
    if control.secure {
        preflight_control_dns(control.host()).await?;
    }
    // Selftest runs headless on CI, where no keychain can be unlocked — it
    // stays on plain `localhost`, which is a secure context for free.
    let tls = if control.secure {
        // On a blocking thread: minting keys is CPU work, the file IO is
        // sync, and `security add-trusted-cert` blocks on a password or
        // Touch-ID prompt on first run. None of that belongs on a runtime
        // worker (and, before setup moved off the main thread, this exact
        // call froze the UI thread while the prompt was up).
        let tls_root = app_root.clone();
        let tls = tauri::async_runtime::spawn_blocking(move || {
            let tls = crate::local_tls::ensure(&tls_root)?;
            crate::local_tls::ensure_trusted(&tls.ca_cert)?;
            Ok::<_, crate::local_tls::TlsError>(tls)
        })
        .await
        .map_err(|join| {
            SetupError::LocalTls(crate::local_tls::TlsError::Trust(join.to_string()))
        })??;
        tracing::info!(ca = %tls.ca_cert.display(), "local TLS material ready and trusted");
        Some(tls)
    } else {
        None
    };
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
    embedded.listener_host = Some(control.listener_host());
    embedded.ui_assets = bundled_ui;
    embedded.preview_cookie_selftest = selftest_mode;
    let handle = local_api::start_embedded(
        local_api::StartOptions {
            // Serve the leaf minted above: the webview's origin must be a
            // secure context for Web Crypto, and a real domain for per-sandbox
            // cookie jars.
            tls: tls.as_ref().map(|tls| local_api::TlsFiles {
                cert: tls.leaf_cert.clone(),
                key: tls.leaf_key.clone(),
                ca: tls.ca_cert.clone(),
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
    let window = builder.build().map_err(SetupError::Window)?;
    // The `devtools` cargo feature (workspace Cargo.toml) makes the webview
    // inspectable even in release builds. Auto-opening rides the same switch
    // as native-side logging: a packaged run under `RUST_LOG=…` is a
    // debugging session, so one env var yields both Rust logs and the web
    // inspector. A normal Finder launch (no RUST_LOG) never pops it.
    if std::env::var("RUST_LOG").is_ok_and(|level| !level.is_empty()) {
        window.open_devtools();
    }

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

/// Resolve the control host and require a loopback answer.
///
/// Failure modes this catches, in order of likelihood: DNS-rebinding
/// protection stripping the loopback A record (the record IS public and IS
/// `127.0.0.1` — that is the canonical rebind signature), a VPN/corporate
/// split-horizon resolver that never reaches the public zone, and plain
/// offline. Each would otherwise present as a webview that never loads.
async fn preflight_control_dns(host: &str) -> Result<(), SetupError> {
    let lookup = tokio::net::lookup_host((host, 443)).await;
    let addrs: Vec<std::net::SocketAddr> = match lookup {
        Ok(addrs) => addrs.collect(),
        Err(error) => {
            return Err(SetupError::ControlDns {
                host: host.to_string(),
                detail: format!(
                    "DNS lookup failed ({error}). If you are online, your DNS resolver \
                     (or VPN) is likely blocking public names that resolve to 127.0.0.1 \
                     — a DNS-rebinding protection. Allowlist this domain in the resolver, \
                     or add it to /etc/hosts pointing at 127.0.0.1."
                ),
            });
        }
    };
    if addrs.iter().any(|addr| addr.ip().is_loopback()) {
        return Ok(());
    }
    Err(SetupError::ControlDns {
        host: host.to_string(),
        detail: format!(
            "the name resolved, but not to 127.0.0.1 (got {:?}). A DNS filter or \
             captive portal is rewriting the answer; allowlist the domain or add a \
             127.0.0.1 entry for it in /etc/hosts.",
            addrs.iter().map(|addr| addr.ip()).collect::<Vec<_>>()
        ),
    })
}

/// Render a boot failure the user can actually read.
///
/// Setup runs off the main thread, so a failure no longer aborts the process
/// — but without this, it would strand a running app with no window at all.
/// A minimal data-URL page needs no listener, no assets and no CSP, which
/// matters because the failing step may be exactly the one that provides
/// those.
pub fn show_boot_failure(app: &tauri::AppHandle, error: &SetupError) {
    let detail = html_escape(&error.to_string());
    let hint = match error {
        SetupError::ControlDns { .. } => {
            "The app's local address could not be resolved. This is usually a DNS \
             filter or VPN blocking loopback answers — see the detail below."
        }
        SetupError::LocalTls(_) => {
            "The app could not set up its local HTTPS certificate. If a trust prompt \
             was cancelled, reopen the app and accept it — the certificate only \
             secures traffic that never leaves this machine."
        }
        SetupError::LocalApi(_) => {
            "The app's local server could not start. If another copy of the app is \
             already running, use that one — only a single instance can hold the port."
        }
        _ => "The app could not finish starting.",
    };
    let page = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Studio could not start</title>\
         <body style=\"font-family:-apple-system,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#1c1c1e\">\
         <h1 style=\"font-size:1.3rem\">Studio could not start</h1>\
         <p>{hint}</p>\
         <pre style=\"white-space:pre-wrap;background:#f2f2f7;padding:1rem;border-radius:8px;font-size:0.8rem\">{detail}</pre>\
         <p style=\"color:#6e6e73;font-size:0.85rem\">Quit and reopen the app to try again.</p>"
    );
    let url = format!(
        "data:text/html;charset=utf-8,{}",
        urlencoding::encode(&page)
    );
    let Ok(url) = url.parse::<tauri::Url>() else {
        return;
    };
    if let Err(window_error) =
        WebviewWindowBuilder::new(app, "boot-error", WebviewUrl::External(url))
            .title("Studio")
            .inner_size(560.0, 480.0)
            .build()
    {
        // No window is possible at all — exiting beats a silent zombie.
        tracing::error!(%window_error, "could not present the boot failure window");
        app.exit(1);
    }
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
