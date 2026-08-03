#[expect(
    clippy::expect_used,
    reason = "build script: a failed Tauri build-context generation SHOULD fail the \
              build rather than produce a broken bundle."
)]
fn main() {
    const COMMANDS: &[&str] = &[
        "local_api_info",
        "auth_status",
        "auth_login",
        "auth_logout",
        "auth_complete_session",
        "selftest_report",
    ];

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Tauri application metadata");
}
