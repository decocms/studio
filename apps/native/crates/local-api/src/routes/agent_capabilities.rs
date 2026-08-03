//! Native coding-agent availability for the terminal picker.
//!
//! This is a guarded local-app route, not a Studio tool and not a desktop-link
//! capability. It never reaches the hosted API or participates in chat
//! dispatch; it only reports which local CLI can be launched into a PTY.

use axum::Json;
use serde_json::{json, Value};

pub async fn get() -> Json<Value> {
    let cache = harness::detect::ensure_detected().await;
    let capabilities: Vec<&str> = harness::HarnessId::ALL
        .into_iter()
        .filter(|harness| cache.get(*harness))
        .map(harness::HarnessId::wire_id)
        .collect();

    Json(json!({ "capabilities": capabilities }))
}
