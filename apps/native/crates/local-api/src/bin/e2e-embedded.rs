//! Feature-gated embedded server runner for black-box desktop E2E tests.
//!
//! `local-api`'s normal standalone binary is deliberately bearer-only. Coding
//! agents instead use the Tauri embedding's exact Host + Origin + HttpOnly
//! control-cookie contract so their locally injected MCP endpoint can carry a
//! scoped credential. This runner exposes that production embedding seam on
//! loopback for tests without adding an environment switch to the shipped
//! binary or weakening standalone authentication.

use std::path::PathBuf;

use local_api::{ApiMode, EmbeddedOptions, StartOptions};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let token = required_env("LOCAL_API_TOKEN");
    let boot_id = required_env("LOCAL_API_BOOT_ID");
    let app_root = PathBuf::from(required_env("LOCAL_API_WORKDIR"));
    let port = required_env("LOCAL_API_PORT")
        .parse::<u16>()
        .unwrap_or_else(|error| fail(&format!("invalid LOCAL_API_PORT: {error}")));
    if port == 0 {
        fail("LOCAL_API_PORT must be nonzero so the embedded Host fence is known before bind");
    }
    // This runner tests the terminal contract, not macOS NFS. Keeping the
    // bundled rclone idle makes the disposable cwd deterministic and avoids
    // leaving a kernel mount behind when a failing E2E force-kills us. The
    // reader for this variable is compiled only with this runner's feature.
    std::env::set_var("LOCAL_API_E2E_DISABLE_ORG_MOUNTS", "1");

    let authority = format!("127.0.0.1:{port}");
    let embedded = EmbeddedOptions::new(authority.clone(), format!("http://{authority}"));
    let handle = local_api::start_embedded(
        StartOptions {
            token,
            boot_id: boot_id.clone(),
            app_root,
            port,
            mode: ApiMode::Strict,
            tls: None,
            update: None,
        },
        embedded,
    )
    .await
    .unwrap_or_else(|error| fail(&error.to_string()));

    println!("LOCAL_API_PORT={}", handle.port());
    println!("LOCAL_API_PREVIEW_PORT={}", handle.preview_port());
    tracing::info!(
        port = handle.port(),
        preview_port = handle.preview_port(),
        %boot_id,
        "embedded e2e local-api listening"
    );

    wait_for_termination().await;
    handle.shutdown().await;
}

fn required_env(name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fail(&format!("missing required env: {name}")))
}

fn fail(message: &str) -> ! {
    eprintln!("[local-api-e2e-embedded] {message}");
    std::process::exit(1)
}

async fn wait_for_termination() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        let mut terminate = signal(SignalKind::terminate())
            .unwrap_or_else(|error| fail(&format!("could not install SIGTERM handler: {error}")));
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result {
                    fail(&format!("could not install Ctrl-C handler: {error}"));
                }
            }
            _ = terminate.recv() => {}
        }
    }

    #[cfg(not(unix))]
    if let Err(error) = tokio::signal::ctrl_c().await {
        fail(&format!("could not install Ctrl-C handler: {error}"));
    }
}
