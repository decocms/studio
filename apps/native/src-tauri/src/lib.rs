//! Studio desktop shell — Tauri v2 app embedding the `local-api` Rust core
//! in-process (see the desktop migration contract's "in-process
//! axum, no sidecar" decision). The CSP and dynamic-port behavior is exercised
//! by the self-test module and `apps/native/scripts/boot-smoke.ts`.

mod auth;
mod commands;
mod control_origin;
mod csp;
mod selftest;
mod setup;
mod shutdown;
mod state;
mod ui_assets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // MCP bridge for AI-assistant-driven dev tooling (@hypothesi/tauri-mcp-server).
    // Debug builds only — never shipped in the packaged app.
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
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
            tauri::async_runtime::block_on(setup::run(&handle))?;
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
