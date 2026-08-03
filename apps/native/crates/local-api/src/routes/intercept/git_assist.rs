//! Local answers for the two AI-assisted git endpoints of the sandbox proxy:
//! `POST …/git/suggest-commit` and `POST …/git/judge-review`.
//!
//! On the cluster these run an LLM (`apps/api/src/lib/suggest-commit-message.ts`,
//! `judge-requires-review.ts`). The desktop cannot reach that model — mesh's
//! handler guards on a VM claim this machine's sandboxes never have
//! (`requireRunner` → 503), so forwarding is not an option either, and before
//! this module existed the interceptor answered 405. That 405 was the worst of
//! all worlds: the commit-suggestion box errored, and the smart-review gate —
//! whose own design is *"on any failure … a permissive verdict … so the AI's
//! absence never blocks publish"* — failed open silently instead of by
//! declared policy.
//!
//! So each endpoint answers with the SAME degradation mesh itself ships for
//! the no-LLM case, ported faithfully:
//!
//! - `suggest-commit` → `fallbackCommitSuggestion`: a deterministic
//!   `<kind> <first-path> and N more` summary of the payload the frontend
//!   already sends (both call sites in `publish-dialog.tsx` pass
//!   `{status, diff}`).
//! - `judge-review` → `ALLOW_FALLBACK` (`{requiresReview: false, reason: ""}`),
//!   the exact verdict mesh returns whenever the model is unavailable.

use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize, Default)]
pub(super) struct SuggestBody {
    status: Option<GitStatusLike>,
    diff: Option<GitDiffLike>,
}

/// Mirrors `GitStatusLike` in `suggest-commit-message.ts`.
#[derive(Deserialize, Default)]
struct GitStatusLike {
    #[serde(default)]
    modified: Vec<String>,
    #[serde(default)]
    created: Vec<String>,
    #[serde(default)]
    deleted: Vec<String>,
    #[serde(default)]
    not_added: Vec<String>,
}

/// Mirrors `GitDiffLike`: only the KEYS matter to the fallback.
#[derive(Deserialize, Default)]
struct GitDiffLike {
    #[serde(default)]
    diffs: serde_json::Map<String, serde_json::Value>,
}

/// Mirrors `isGeneratedNoise`: build artifacts that would dominate the
/// summary without describing the change.
fn is_generated_noise(path: &str) -> bool {
    path.strip_prefix("static/")
        .is_some_and(|rest| rest.ends_with(".css"))
}

/// Mirrors `changedPaths`: working-tree paths plus diff keys, deduped in
/// first-seen order.
fn changed_paths(status: &GitStatusLike, diff: Option<&GitDiffLike>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let from_status = status
        .modified
        .iter()
        .chain(&status.created)
        .chain(&status.deleted)
        .chain(&status.not_added);
    let from_diff = diff.map(|d| d.diffs.keys()).into_iter().flatten();
    for path in from_status.chain(from_diff) {
        if is_generated_noise(path) {
            continue;
        }
        if seen.insert(path.clone()) {
            out.push(path.clone());
        }
    }
    out
}

/// Mirrors `pathChangeKind`.
fn path_change_kind(
    path: &str,
    status: &GitStatusLike,
    diff: Option<&GitDiffLike>,
) -> &'static str {
    let contains = |list: &[String]| list.iter().any(|p| p == path);
    if contains(&status.created) || contains(&status.not_added) {
        return "add";
    }
    if contains(&status.deleted) {
        return "delete";
    }
    if let Some(entry) = diff.and_then(|d| d.diffs.get(path)) {
        let from = entry.get("from").filter(|v| !v.is_null());
        let to = entry.get("to").filter(|v| !v.is_null());
        if from.is_none() && to.is_some() {
            return "add";
        }
        if from.is_some() && to.is_none() {
            return "delete";
        }
    }
    "update"
}

/// Port of `fallbackCommitSuggestion` — mesh's own no-LLM degradation.
fn fallback_commit_suggestion(status: &GitStatusLike, diff: Option<&GitDiffLike>) -> Response {
    let paths = changed_paths(status, diff);
    let Some(first) = paths.first() else {
        return Json(json!({ "title": "No changes", "body": "", "message": "No changes" }))
            .into_response();
    };
    let label = format!("{} {first}", path_change_kind(first, status, diff));
    let extra = if paths.len() > 1 {
        format!(" and {} more", paths.len().saturating_sub(1))
    } else {
        String::new()
    };
    let message = format!("{label}{extra}");
    let mut title = message.clone();
    if let Some(head) = title.get(0..1) {
        let upper = head.to_uppercase();
        title.replace_range(0..1, &upper);
    }
    let body_paths = paths.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
    let body = if body_paths.is_empty() {
        String::new()
    } else {
        format!("Changes to {body_paths}.")
    };

    Json(json!({ "message": message, "title": title, "body": body })).into_response()
}

/// `POST …/git/suggest-commit`.
pub(super) fn suggest_commit(body: &Bytes) -> Response {
    let parsed: SuggestBody = serde_json::from_slice(body).unwrap_or_default();
    let status = parsed.status.unwrap_or_default();
    fallback_commit_suggestion(&status, parsed.diff.as_ref())
}

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

    async fn json_of(response: Response) -> serde_json::Value {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Byte-parity with `fallbackCommitSuggestion` for the common case: the
    /// first path names the change, the rest are counted, the body lists up
    /// to five.
    #[tokio::test]
    async fn suggestion_matches_the_mesh_fallback_shape() {
        let body = Bytes::from(
            serde_json::json!({
                "status": {
                    "modified": ["src/app.ts", "src/lib.ts"],
                    "created": ["src/new.ts"],
                    "deleted": [],
                    "not_added": []
                },
                "diff": { "diffs": { "src/app.ts": { "from": "a", "to": "b" } } }
            })
            .to_string(),
        );
        let out = json_of(suggest_commit(&body)).await;
        assert_eq!(out["message"], "update src/app.ts and 2 more");
        assert_eq!(out["title"], "Update src/app.ts and 2 more");
        assert_eq!(
            out["body"],
            "Changes to src/app.ts, src/lib.ts, src/new.ts."
        );
    }

    #[tokio::test]
    async fn generated_noise_is_excluded_and_empty_means_no_changes() {
        let body = Bytes::from(
            serde_json::json!({
                "status": {
                    "modified": ["static/styles/site.css"],
                    "created": [], "deleted": [], "not_added": []
                }
            })
            .to_string(),
        );
        let out = json_of(suggest_commit(&body)).await;
        assert_eq!(out["title"], "No changes");
        // A garbage body degrades the same way rather than erroring.
        let out = json_of(suggest_commit(&Bytes::from_static(b"not json"))).await;
        assert_eq!(out["title"], "No changes");
    }

    #[tokio::test]
    async fn created_paths_read_as_add_and_deleted_as_delete() {
        let body = Bytes::from(
            serde_json::json!({
                "status": { "modified": [], "created": ["a.ts"], "deleted": [], "not_added": [] }
            })
            .to_string(),
        );
        assert_eq!(json_of(suggest_commit(&body)).await["message"], "add a.ts");
        let body = Bytes::from(
            serde_json::json!({
                "status": { "modified": [], "created": [], "deleted": ["b.ts"], "not_added": [] }
            })
            .to_string(),
        );
        assert_eq!(
            json_of(suggest_commit(&body)).await["message"],
            "delete b.ts"
        );
    }

    /// The exact verdict mesh's `ALLOW_FALLBACK` ships — `smartReviewGate`
    /// reads it as "allowed" with no reason banner.
    #[tokio::test]
    async fn the_judge_answers_the_permissive_fallback() {
        let out = json_of(judge_review()).await;
        assert_eq!(
            out,
            serde_json::json!({ "requiresReview": false, "reason": "" })
        );
    }
}
