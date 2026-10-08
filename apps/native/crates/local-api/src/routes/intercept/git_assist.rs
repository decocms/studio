//! Local answer for the AI-assisted git endpoint of the sandbox proxy:
//! `POST …/git/judge-review`.
//!
//! On the cluster this runs an LLM (`apps/api/src/lib/judge-requires-review.ts`).
//! The desktop cannot reach that model — mesh's handler guards on a VM claim
//! this machine's sandboxes never have (`requireRunner` → 503), so forwarding
//! is not an option either. Answering 405 would make the smart-review gate —
//! whose own design is *"on any failure … a permissive verdict … so the AI's
//! absence never blocks publish"* — fail open silently instead of by declared
//! policy.
//!
//! So the endpoint answers with the SAME degradation mesh itself ships for the
//! no-LLM case: `ALLOW_FALLBACK` (`{requiresReview: false, reason: ""}`).

use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// `POST …/git/judge-review` — mesh's `ALLOW_FALLBACK`, verbatim.
///
/// Permissive by DESIGN, not by accident: `smartReviewGate` already treats a
/// missing verdict as allowed, and mesh's judge returns exactly this shape
/// whenever its model is unavailable. The desktop has no model, so it is
/// permanently in that case — answering it declares the policy instead of
/// erroring into it.
pub(super) fn judge_review() -> Response {
    Json(json!({ "requiresReview": false, "reason": "" })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    /// The exact verdict mesh's `ALLOW_FALLBACK` ships — `smartReviewGate`
    /// reads it as "allowed" with no reason banner.
    #[tokio::test]
    async fn the_judge_answers_the_permissive_fallback() {
        let bytes = to_bytes(judge_review().into_body(), usize::MAX)
            .await
            .unwrap();
        let out: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            out,
            serde_json::json!({ "requiresReview": false, "reason": "" })
        );
    }
}
