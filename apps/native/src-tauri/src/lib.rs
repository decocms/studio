//! Studio desktop shell — Tauri v2 app embedding the `local-api` Rust core
//! in-process (see the desktop migration contract's "in-process
//! axum, no sidecar" decision). The CSP and dynamic-port behavior is exercised
//! by the self-test module and `apps/native/scripts/boot-smoke.ts`.

mod auth;
mod commands;
mod control_origin;
mod csp;
mod env_path;
mod local_tls;
mod selftest;
mod setup;
mod shutdown;
mod state;
mod ui_assets;
mod updater;
/// Linux has no OS-level trust step for the local certificate — the webview
/// gets a per-host exception instead. Nothing else needs this module.
#[cfg(target_os = "linux")]
mod webview_trust;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Must run before `setup::run` boots local-api: every child spawn (agent
    // detection, `bun install`, the script runner, ripgrep) inherits this
    // process's environment, and a Finder/Dock launch starts with launchd's
    // minimal PATH. See `env_path` for the repair strategy and its bounds.
    env_path::repair();

    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // MCP bridge for AI-assistant-driven dev tooling (@hypothesi/tauri-mcp-server).
    // Debug builds only — never shipped in the packaged app.
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }

    // Self-update — release builds only, the exact mirror of the debug-only
    // mcp-bridge above. The cfg-gate is load-bearing, not belt-and-braces: a
    // debug binary with the plugin registered and the committed
    // plugins.updater config WOULD self-update from the production channel
    // if anything called check(). The background task has further runtime
    // gates — see `updater`'s module doc.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .invoke_handler(tauri::generate_handler![
            commands::local_api_info,
            commands::auth_status,
            commands::auth_login,
            commands::auth_logout,
            commands::auth_complete_session,
            commands::selftest_report,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Selftest keeps the synchronous path: `boot-smoke.ts` treats
            // "setup returned" as "everything is up", and CI depends on that
            // ordering. Real launches run setup OFF the main thread — the
            // first-run `security add-trusted-cert` call blocks on a
            // password/Touch-ID prompt, and under `block_on` that froze the
            // main thread before any window existed. A failure now renders an
            // error window naming the failing step instead of aborting the
            // process with nothing on screen.
            if selftest::is_enabled() {
                tauri::async_runtime::block_on(setup::run(&handle))?;
            } else {
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = setup::run(&handle).await {
                        tracing::error!(%error, "desktop setup failed");
                        setup::show_boot_failure(&handle, &error);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            shutdown::run_blocking(app_handle);
        }
    });
}
