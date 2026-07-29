//! `ConfigStore` — the shared handle behind `GET/POST /_sandbox/config`.
//!
//! Single-writer serial actor: `patch()` holds the lock across the whole
//! merge -> validate -> classify -> apply sequence, so two concurrent
//! `POST`/`PUT /_sandbox/config` calls compose deterministically (last
//! write wins on the same field) — the same guarantee the TS daemon gets
//! from `TenantConfigStore`'s FIFO apply queue (`config-store/store.ts`),
//! achieved here with a `Mutex` instead of an explicit queue since axum
//! handlers already run on a thread pool rather than a single event loop.
//!
//! Every OTHER family only ever calls the read-only accessors
//! (`snapshot()`, `is_configured()`) — for `/health`'s `configured` field,
//! the exec/scripts family's "409 when no package manager is configured
//! yet" gate, and git's "409 not-ready" gate. Only `routes/config.rs` calls
//! `patch()`.
//!
//! Byte-parity target: `packages/sandbox/daemon/config-store/` (`classify.ts`
//! precedence, `merge.ts` deep-merge, `validate.ts` field validation,
//! `store.ts`'s reject/apply/no-op branching). See `config/classify.rs`,
//! `config/merge.rs`, `config/validate.rs` for the ported pieces.

use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::error::ApiError;

use super::classify::{classify, Transition};
use super::merge::deep_merge;
use super::validate::validate_tenant_config;

/// Opaque JSON `TenantConfig` (`git`/`operator`/`application`/`env` keys) —
/// see the module doc on why this stays JSON rather than a typed struct.
pub type TenantConfig = Value;

/// `GET /_sandbox/config`'s read model. `config` deliberately EXCLUDES `env`
/// (byte-parity with `routes/config.ts::stripDerived`, which strips it too)
/// — env is only ever exposed as key names via `env_keys`, never values.
///
/// `configured` mirrors `is_configured()` and is part of the documented
/// bootstrap shape (the native module-ownership contract's `ConfigStore`
/// section: `{ config, env_keys, ready, configured }`) for any future
/// consumer of `snapshot()` as a whole — `routes/config.rs`'s `GET` handler
/// itself reads `is_configured()`'s twin `ready` field but doesn't echo
/// `configured` on the wire (not in the contract doc's GET response field
/// list), hence the allow.
#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
pub struct ConfigSnapshot {
    pub config: Option<TenantConfig>,
    pub env_keys: Vec<String>,
    pub ready: bool,
    pub configured: bool,
}

/// A successful `patch()` — the shape `routes/config.rs` needs to build the
/// `{ bootId, transition, config }` response and decide whether to emit a
/// `"lifecycle"` broadcaster event (only on a non-`"no-op"` transition,
/// byte-parity with the TS store only notifying subscribers on a real
/// state change).
///
/// Deliberate signature change from the bootstrap stub's
/// `patch(&self, Value) -> Result<ConfigSnapshot, ApiError>`: `ConfigSnapshot`
/// has no room for `transition`, and nothing outside this family calls
/// `patch()` (see the native module-ownership contract's config section),
/// so widening it here doesn't break another family's build.
#[derive(Debug, Clone)]
pub struct ApplyOutcome {
    pub transition: &'static str,
    /// The merged `TenantConfig` INCLUDING `env` values — byte-parity with
    /// `routes/config.ts::makeApplyResponse`, which returns `result.after`
    /// (the raw merged object) unstripped, unlike the `GET` handler. This
    /// is the TS daemon's actual behavior, not a Rust-side embellishment;
    /// see the module doc on `routes/config.rs` for the full reasoning.
    pub config: Value,
}

pub struct ConfigStore {
    /// `None` until the first non-no-op `patch()` — mirrors
    /// `TenantConfigStore.current` staying `null` through a `{}` patch on a
    /// fresh store (see `classify`'s "null -> null = no-op" case).
    current: Mutex<Option<TenantConfig>>,
}

impl ConfigStore {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }

    /// Current snapshot. Never errors — safe to call from any route,
    /// including `/health` (no-auth) and other families' gating checks.
    pub fn snapshot(&self) -> ConfigSnapshot {
        let current = self.read();
        let config = current.as_ref().map(strip_env);
        let env_keys = current
            .as_ref()
            .and_then(|c| c.get("env"))
            .and_then(Value::as_object)
            .map(sorted_keys)
            .unwrap_or_default();
        let configured = current.is_some();
        ConfigSnapshot {
            config,
            env_keys,
            // No setup/lifecycle pipeline to wait on (dropped family, see
            // the contract doc's §C) — "ready" collapses onto "configured",
            // the closest local-api has to the TS daemon's
            // `lifecycle.current().phase === "running"`. A judgment call:
            // no oracle test asserts `ready` becomes `true` post-configure,
            // only that it starts `false` on a fresh store (satisfied
            // either way).
            ready: configured,
            configured,
        }
    }

    pub fn is_configured(&self) -> bool {
        self.read().is_some()
    }

    /// Apply a `ConfigPatch`-shaped JSON value (already stripped of the
    /// wire-only `auth` field by the caller). Byte-parity outcomes:
    ///
    /// - invalid merged config -> `400 {"error":"invalid"}` (the TS store
    ///   discards the detailed validation reason on the wire too — see
    ///   `REJECTION_REASONS.INVALID` in `config-store/types.ts`).
    /// - identity conflict (immutable `cloneUrl` change) -> `409
    ///   {"error":"immutable: cloneUrl"}`.
    /// - no-op transition -> `200`, but internal state is NOT overwritten
    ///   (byte-parity with `store.ts::runOne`'s early return before
    ///   `this.current = enrich(merged)`).
    /// - otherwise -> `200`, state updated to the merged config.
    pub fn patch(&self, patch: Value) -> Result<ApplyOutcome, ApiError> {
        let mut guard = self.lock();
        let before = guard.clone();
        let merged = deep_merge(before.as_ref(), &patch);

        if validate_tenant_config(&merged).is_err() {
            return Err(ApiError::bad_request("invalid"));
        }

        let transition = classify(before.as_ref(), &merged);
        if let Transition::IdentityConflict { field } = &transition {
            return Err(ApiError::conflict(format!("immutable: {field}")));
        }

        if !matches!(transition, Transition::NoOp) {
            *guard = Some(merged.clone());
        }

        Ok(ApplyOutcome {
            transition: transition.kind(),
            config: merged,
        })
    }

    fn read(&self) -> std::sync::MutexGuard<'_, Option<TenantConfig>> {
        self.lock()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<TenantConfig>> {
        match self.current.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

impl Default for ConfigStore {
    fn default() -> Self {
        Self::new()
    }
}

/// `{ git, operator, application }` — byte-parity with
/// `routes/config.ts::stripDerived` (env is deliberately omitted; see
/// `ConfigSnapshot`'s doc comment).
fn strip_env(config: &TenantConfig) -> Value {
    let mut out = Map::new();
    for key in ["git", "operator", "application"] {
        if let Some(v) = config.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    Value::Object(out)
}

fn sorted_keys(obj: &Map<String, Value>) -> Vec<String> {
    let mut keys: Vec<String> = obj.keys().cloned().collect();
    keys.sort();
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fresh_store_is_unconfigured() {
        let store = ConfigStore::new();
        assert!(!store.is_configured());
        let snap = store.snapshot();
        assert!(snap.config.is_none());
        assert!(snap.env_keys.is_empty());
        assert!(!snap.ready);
    }

    #[test]
    fn bootstrap_patch_configures_the_store() {
        let store = ConfigStore::new();
        let outcome = store
            .patch(json!({"application": {"packageManager": {"name": "npm"}}}))
            .expect("apply ok");
        assert_eq!(outcome.transition, "bootstrap");
        assert!(store.is_configured());
        let snap = store.snapshot();
        assert_eq!(
            snap.config.unwrap()["application"]["packageManager"]["name"],
            "npm"
        );
    }

    #[test]
    fn empty_patch_on_fresh_store_stays_unconfigured() {
        let store = ConfigStore::new();
        let outcome = store.patch(json!({})).expect("apply ok");
        assert_eq!(outcome.transition, "no-op");
        assert!(!store.is_configured());
    }

    #[test]
    fn immutable_clone_url_change_is_rejected_with_409() {
        let store = ConfigStore::new();
        store
            .patch(json!({"git": {"repository": {"cloneUrl": "https://example.com/a.git"}}}))
            .expect("first apply ok");
        let err = store
            .patch(json!({"git": {"repository": {"cloneUrl": "https://example.com/b.git"}}}))
            .expect_err("second apply should be rejected");
        assert_eq!(err.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(err.body["error"], "immutable: cloneUrl");
    }

    #[test]
    fn invalid_patch_is_rejected_with_400_and_no_detail_leak() {
        let store = ConfigStore::new();
        let err = store
            .patch(json!({"application": {"runtime": "python"}}))
            .expect_err("invalid runtime rejected");
        assert_eq!(err.status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(err.body["error"], "invalid");
    }

    #[test]
    fn env_keys_round_trip_without_values() {
        let store = ConfigStore::new();
        store
            .patch(json!({"env": {"FOO": "bar", "BAZ": "qux"}}))
            .expect("apply ok");
        let snap = store.snapshot();
        assert_eq!(snap.env_keys, vec!["BAZ".to_string(), "FOO".to_string()]);
        // `config` (the GET-shaped view) never carries env values.
        assert!(snap.config.unwrap().get("env").is_none());
    }

    #[test]
    fn git_credential_refresh_updates_state_and_notifies_via_non_no_op_transition() {
        let store = ConfigStore::new();
        store
            .patch(json!({
                "git": {"repository": {"cloneUrl": "https://x-access-token:OLD@github.com/org/repo.git"}},
                "application": {"packageManager": {"name": "npm"}, "runtime": "node"},
            }))
            .expect("first apply ok");
        let outcome = store
            .patch(json!({
                "git": {"repository": {"cloneUrl": "https://x-access-token:NEW@github.com/org/repo.git"}},
            }))
            .expect("refresh apply ok");
        assert_eq!(outcome.transition, "git-credential-refresh");
        let snap = store.snapshot();
        assert_eq!(
            snap.config.unwrap()["git"]["repository"]["cloneUrl"],
            "https://x-access-token:NEW@github.com/org/repo.git"
        );
    }
}
