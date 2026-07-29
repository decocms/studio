//! `GET /models` — new. Detects which harness CLIs (`claude`, `codex`) are
//! installed/reachable/logged-in and returns the static tier catalog for
//! each. Full shape: `the native local-API contract
//! #models--tiers-endpoint`, oracle `apps/native/e2e/models.e2e.test.ts`.
//!
//! **Now-superseded** for the real production shell (see
//! `routes/intercept/link_current.rs`'s doc comment, which cross-references
//! this note): the shipped frontend (`apps/web/src`) never calls this
//! route at runtime — grep finds only a doc-comment/test reference in
//! `transport-rules.ts` — it gets harness availability exclusively via
//! `POST /api/:org/tools/LINK_CURRENT_GET` (`useCurrentLink()`), served by
//! `routes/intercept/link_current.rs` from the SAME `harness::detect` cache
//! this file reads. See
//! the native desktop-runtime audit finding #7.
//! KEPT, not deleted: exercised by this crate's own e2e oracle
//! (`models.e2e.test.ts`) and useful standalone as a selftest/e2e
//! harness-detection auth probe — reading through the same cache
//! `LINK_CURRENT_GET` uses means a probe against this route and the shipped
//! path can never disagree about which CLIs are usable.
//!
//! Phase 2: detection AND the tier catalog both come from `crates/harness`
//! (`harness::detect`, `harness::tiers`) — the CANONICAL copies, shared
//! with `routes/dispatch.rs`'s own "is this harness runnable" gate, so
//! `/models` and dispatch's `unknown_harness` gate can never disagree
//! about which CLIs are usable. `harness::detect`'s cache is process-wide
//! (not per-request), so this handler is a thin read-through: warm the
//! cache on first call (bounded — see `harness::detect::ensure_detected`'s
//! doc comment), read it on every call after.
//!
//! - `harnesses` always has exactly 2 entries, stable order
//!   (`claude-code` then `codex`), even when neither is detected — NEVER
//!   an empty array (`harness::HarnessId::ALL`'s order is pinned by its
//!   own doc comment + unit test).
//! - "Detected" means installed AND logged in (`harness::detect`'s
//!   version-probe + auth-probe), with GROW-ONLY caching so a transient
//!   probe failure never un-lists a CLI mid-run (mirrors
//!   `apps/api/src/link-daemon/capabilities.ts`).
//! - No Ollama/LM Studio probing in v1 (the desktop migration contract decision #5); no third
//!   harness (no `"decopilot"`).

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;

pub async fn list(State(_state): State<AppState>) -> Json<Value> {
    let cache = harness::detect::ensure_detected().await;

    let harnesses: Vec<Value> = harness::HarnessId::ALL
        .iter()
        .map(|&h| {
            let detected = cache.get(h);
            let tiers = harness::tiers::tiers_for(h);
            json!({
                "harness": h.wire_id(),
                "detected": detected,
                "tiers": if detected { tiers.to_vec() } else { Vec::new() },
            })
        })
        .collect();

    Json(json!({ "harnesses": harnesses }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn harness_order_is_claude_code_then_codex() {
        assert_eq!(harness::HarnessId::ALL[0].wire_id(), "claude-code");
        assert_eq!(harness::HarnessId::ALL[1].wire_id(), "codex");
    }

    #[test]
    fn every_tier_id_is_prefixed_with_its_harness() {
        for h in harness::HarnessId::ALL {
            for tier in harness::tiers::tiers_for(h) {
                assert!(
                    tier.id.starts_with(&format!("{}:", h.wire_id())),
                    "{} does not start with {}:",
                    tier.id,
                    h.wire_id()
                );
                assert!(!tier.label.is_empty());
            }
        }
    }
}
