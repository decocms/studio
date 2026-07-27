//! `GET /health` — no auth, byte-parity shape with the daemon. Byte-parity
//! target: `daemon/routes/health.ts`, oracle `daemon.e2e.test.ts` ("GET
//! /health works without auth...") and `apps/native/e2e/health.e2e.test.ts`.
//!
//! `orchestrator`/`setup` now reflect the REAL clone -> install -> start
//! pipeline (`crate::setup::SetupOrchestrator`) — corrected from an earlier
//! Phase-1 stub that always reported `{running:false,pending:0}` under the
//! (since-corrected) assumption that local-api has no setup pipeline at all;
//! see `crate::setup`'s module doc. `waitForOrchestratorIdle()` in both
//! `daemon.e2e.helpers.ts` and (for the local-api contract suite)
//! `apps/native/e2e/helpers.ts` polls this endpoint until
//! `orchestrator.running === false && orchestrator.pending === 0`.

use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::state::AppState;

pub async fn health(State(state): State<AppState>) -> Json<Value> {
    let configured = state.config.is_configured();
    let running = state.setup.is_running();
    let pending = state.setup.pending_count();
    Json(json!({
        "ready": true,
        "bootId": state.boot_id.as_ref(),
        "configured": configured,
        "orchestrator": { "running": running, "pending": pending },
        // Legacy shape — daemon-client polls /health and validates this
        // exists. Orchestrator queue empty -> setup is done.
        "setup": { "running": running, "done": !running },
    }))
}
