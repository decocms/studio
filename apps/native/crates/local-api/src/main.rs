//! `local-api` — the desktop app's Rust HTTP core, binary entrypoint.
//!
//! SHARED FILE (see the native module-ownership contract) — family
//! implementers should never need to touch it.
//!
//! Phase 3 note: the actual boot sequence (env parsing, dir creation,
//! `AppState`/router construction, bind, serve-until-SIGTERM) now lives in
//! `lib.rs::boot_from_env()` — a mechanical extraction so the Tauri shell
//! (`apps/native/src-tauri/`) can embed the exact same server-construction
//! logic in-process (via `lib.rs::start()`) without going through env vars,
//! stdout, or a subprocess at all. This binary's behavior is unchanged:
//! same env contract, same stdout lines, same SIGTERM handling.

#[tokio::main]
async fn main() {
    local_api::boot_from_env().await;
}
