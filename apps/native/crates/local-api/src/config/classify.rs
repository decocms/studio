//! Pure: derive the single highest-impact transition between two configs.
//! Byte-parity port of `packages/sandbox/daemon-go/internal/config/classify.go`.
//!
//! Precedence (highest first): identity-conflict, then bootstrap,
//! branch-change, runtime-change, pm-change, port-change, env-change,
//! git-credential-refresh, and finally no-op.
//!
//! Callers MUST run [`crate::config::validate::validate_tenant_config`] on
//! `after` before calling this (same ordering as the TS store's `runOne`) —
//! classify assumes `after`'s fields are already well-typed (e.g. `branch`
//! is a string when present) and degrades a malformed field to "absent"
//! rather than panicking, which is a deliberate, harmless divergence from
//! the TS source (which would throw on some malformed inputs — see the
//! module doc on `validate.rs`).

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transition {
    Bootstrap,
    BranchChange {
        from: Option<String>,
        to: String,
    },
    PmChange {
        from: Option<Value>,
        to: Value,
    },
    RuntimeChange {
        from: Option<String>,
        to: String,
    },
    PortChange {
        from: Option<i64>,
        to: Option<i64>,
    },
    EnvChange {
        set: Vec<String>,
        deleted: Vec<String>,
    },
    GitCredentialRefresh {
        clone_url: String,
    },
    IdentityConflict {
        field: &'static str,
    },
    NoOp,
}

impl Transition {
    /// The wire-shape `transition` string (`result.transition.kind` on the
    /// TS side) — byte-parity with the daemon's `Transition["kind"]` union.
    pub fn kind(&self) -> &'static str {
        match self {
            Transition::Bootstrap => "bootstrap",
            Transition::BranchChange { .. } => "branch-change",
            Transition::PmChange { .. } => "pm-change",
            Transition::RuntimeChange { .. } => "runtime-change",
            Transition::PortChange { .. } => "port-change",
            Transition::EnvChange { .. } => "env-change",
            Transition::GitCredentialRefresh { .. } => "git-credential-refresh",
            Transition::IdentityConflict { .. } => "identity-conflict",
            Transition::NoOp => "no-op",
        }
    }
}

pub fn classify(before: Option<&Value>, after: &Value) -> Transition {
    let before_url = before.and_then(|b| get_str_path(b, &["git", "repository", "cloneUrl"]));
    let after_url = get_str_path(after, &["git", "repository", "cloneUrl"]);

    if let (Some(bu), Some(au)) = (&before_url, &after_url) {
        if strip_credentials(bu) != strip_credentials(au) {
            return Transition::IdentityConflict { field: "cloneUrl" };
        }
    }

    // Byte-parity with the TS `after.application !== undefined` check: key
    // PRESENCE, not truthiness — an explicit `application: null` patch (an
    // edge case no schema forbids pre-merge) still counts as "meaningful".
    let is_meaningful = after_url.is_some() || after.get("application").is_some();

    let Some(before) = before else {
        if is_meaningful {
            return Transition::Bootstrap;
        }
        return match diff_env(None, after.get("env")) {
            Some((set, deleted)) => Transition::EnvChange { set, deleted },
            None => Transition::NoOp,
        };
    };

    let before_branch = get_str_path(before, &["git", "repository", "branch"]);
    if let Some(after_branch) = get_present_str(after, &["git", "repository", "branch"]) {
        if Some(&after_branch) != before_branch.as_ref() {
            return Transition::BranchChange {
                from: before_branch,
                to: after_branch,
            };
        }
    }

    let before_runtime = get_str_path(before, &["application", "runtime"]);
    if let Some(after_runtime) = get_present_str(after, &["application", "runtime"]) {
        if Some(&after_runtime) != before_runtime.as_ref() {
            return Transition::RuntimeChange {
                from: before_runtime,
                to: after_runtime,
            };
        }
    }

    let before_pm = get_path(before, &["application", "packageManager"]);
    if let Some(after_pm) = get_path(after, &["application", "packageManager"]) {
        if !after_pm.is_null() {
            let before_name = before_pm
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str);
            let after_name = after_pm.get("name").and_then(Value::as_str);
            let before_path = before_pm
                .and_then(|p| p.get("path"))
                .and_then(Value::as_str);
            let after_path = after_pm.get("path").and_then(Value::as_str);
            if before_name != after_name || before_path != after_path {
                return Transition::PmChange {
                    from: before_pm.cloned(),
                    to: after_pm.clone(),
                };
            }
        }
    }

    let before_port = get_path(before, &["application", "port"]).and_then(Value::as_i64);
    let after_port = get_path(after, &["application", "port"]).and_then(Value::as_i64);
    if before_port != after_port {
        return Transition::PortChange {
            from: before_port,
            to: after_port,
        };
    }

    if let Some((set, deleted)) = diff_env(before.get("env"), after.get("env")) {
        return Transition::EnvChange { set, deleted };
    }

    if let (Some(bu), Some(au)) = (&before_url, &after_url) {
        if bu != au && strip_credentials(bu) == strip_credentials(au) {
            return Transition::GitCredentialRefresh {
                clone_url: au.clone(),
            };
        }
    }

    Transition::NoOp
}

fn diff_env(before: Option<&Value>, after: Option<&Value>) -> Option<(Vec<String>, Vec<String>)> {
    let b = before.and_then(Value::as_object);
    let a = after.and_then(Value::as_object);

    let mut set = Vec::new();
    if let Some(a_obj) = a {
        for (k, v) in a_obj {
            let differs = match b.and_then(|bo| bo.get(k)) {
                Some(bv) => bv != v,
                None => true,
            };
            if differs {
                set.push(k.clone());
            }
        }
    }
    let mut deleted = Vec::new();
    if let Some(b_obj) = b {
        for k in b_obj.keys() {
            if a.is_none_or(|ao| !ao.contains_key(k)) {
                deleted.push(k.clone());
            }
        }
    }
    if set.is_empty() && deleted.is_empty() {
        None
    } else {
        Some((set, deleted))
    }
}

/// The `cloneUrl` embeds an OAuth token (e.g.
/// `x-access-token:TOKEN@github.com/…`) that gets refreshed independently of
/// the repo identity — strip username/password before comparing so only the
/// actual repo path is guarded (byte-parity with `classify.ts::stripCredentials`).
fn strip_credentials(raw_url: &str) -> String {
    match reqwest::Url::parse(raw_url) {
        Ok(mut u) => {
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.to_string()
        }
        Err(_) => raw_url.to_string(),
    }
}

fn get_path<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for k in path {
        cur = cur.as_object()?.get(*k)?;
    }
    Some(cur)
}

fn get_str_path(v: &Value, path: &[&str]) -> Option<String> {
    super::get_str(v, path).map(str::to_string)
}

/// A field the TS side reads as `after.foo?.bar !== undefined` — present
/// (any non-null JSON value) AND actually a string. A present-but-wrong-type
/// value (which `validate_tenant_config` should already have rejected) is
/// treated as absent rather than causing a spurious transition.
fn get_present_str(v: &Value, path: &[&str]) -> Option<String> {
    let field = get_path(v, path)?;
    if field.is_null() {
        return None;
    }
    field.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn null_to_null_is_no_op() {
        assert_eq!(classify(None, &json!({})).kind(), "no-op");
    }

    #[test]
    fn null_to_meaningful_clone_url_is_bootstrap() {
        let after = json!({"git": {"repository": {"cloneUrl": "https://x.git"}}});
        assert_eq!(classify(None, &after).kind(), "bootstrap");
    }

    #[test]
    fn null_to_meaningful_application_only_is_bootstrap() {
        let after = json!({"application": {"packageManager": {"name": "npm"}, "runtime": "node"}});
        assert_eq!(classify(None, &after).kind(), "bootstrap");
    }

    #[test]
    fn clone_url_mismatch_is_identity_conflict() {
        let before =
            json!({"git": {"repository": {"cloneUrl": "https://github.com/org/repo-a.git"}}});
        let after =
            json!({"git": {"repository": {"cloneUrl": "https://github.com/org/repo-b.git"}}});
        assert_eq!(classify(Some(&before), &after).kind(), "identity-conflict");
    }

    #[test]
    fn clone_url_credential_only_change_is_not_identity_conflict() {
        let before = json!({"git": {"repository": {"cloneUrl": "https://x-access-token:OLD@github.com/org/repo.git"}}});
        let after = json!({"git": {"repository": {"cloneUrl": "https://x-access-token:NEW@github.com/org/repo.git"}}});
        assert_ne!(classify(Some(&before), &after).kind(), "identity-conflict");
    }

    #[test]
    fn clone_url_credential_only_change_is_git_credential_refresh() {
        let before = json!({"git": {"repository": {"cloneUrl": "https://x-access-token:OLD@github.com/org/repo.git"}}});
        let after = json!({"git": {"repository": {"cloneUrl": "https://x-access-token:NEW@github.com/org/repo.git"}}});
        let t = classify(Some(&before), &after);
        assert_eq!(t.kind(), "git-credential-refresh");
        if let Transition::GitCredentialRefresh { clone_url } = t {
            assert_eq!(
                clone_url,
                "https://x-access-token:NEW@github.com/org/repo.git"
            );
        } else {
            panic!("expected git-credential-refresh");
        }
    }

    #[test]
    fn branch_change() {
        let before = json!({"git": {"repository": {"cloneUrl": "x", "branch": "main"}}});
        let after = json!({"git": {"repository": {"cloneUrl": "x", "branch": "feature"}}});
        let t = classify(Some(&before), &after);
        assert_eq!(t.kind(), "branch-change");
        if let Transition::BranchChange { from, to } = t {
            assert_eq!(from.as_deref(), Some("main"));
            assert_eq!(to, "feature");
        } else {
            panic!("expected branch-change");
        }
    }

    #[test]
    fn runtime_change_without_pm() {
        let before = json!({"application": {"packageManager": {"name": "npm"}, "runtime": "node"}});
        let after = json!({"application": {"packageManager": {"name": "npm"}, "runtime": "bun"}});
        assert_eq!(classify(Some(&before), &after).kind(), "runtime-change");
    }

    #[test]
    fn pm_name_change() {
        let before = json!({"application": {"packageManager": {"name": "npm"}, "runtime": "node"}});
        let after = json!({"application": {"packageManager": {"name": "pnpm"}, "runtime": "node"}});
        assert_eq!(classify(Some(&before), &after).kind(), "pm-change");
    }

    #[test]
    fn pm_path_change() {
        let before = json!({"application": {"packageManager": {"name": "npm"}, "runtime": "node"}});
        let after = json!({"application": {"packageManager": {"name": "npm", "path": "apps/web"}, "runtime": "node"}});
        assert_eq!(classify(Some(&before), &after).kind(), "pm-change");
    }

    #[test]
    fn port_change() {
        let before = json!({"application": {"port": 3000}});
        let after = json!({"application": {"port": 5173}});
        assert_eq!(classify(Some(&before), &after).kind(), "port-change");
    }

    #[test]
    fn identical_configs_is_no_op() {
        let config = json!({"application": {"packageManager": {"name": "npm"}, "runtime": "node"}});
        assert_eq!(classify(Some(&config), &config).kind(), "no-op");
    }

    #[test]
    fn branch_and_pm_change_emits_the_higher_impact_one() {
        let before = json!({
            "git": {"repository": {"cloneUrl": "x", "branch": "main"}},
            "application": {"packageManager": {"name": "npm"}, "runtime": "node"},
        });
        let after = json!({
            "git": {"repository": {"cloneUrl": "x", "branch": "feature"}},
            "application": {"packageManager": {"name": "pnpm"}, "runtime": "node"},
        });
        assert_eq!(classify(Some(&before), &after).kind(), "branch-change");
    }

    #[test]
    fn env_added_is_env_change_with_key_names_only() {
        let before = json!({"application": {"packageManager": {"name": "npm"}, "runtime": "node"}});
        let after = json!({
            "application": {"packageManager": {"name": "npm"}, "runtime": "node"},
            "env": {"STRIPE_KEY": "sk_test_secret"},
        });
        let t = classify(Some(&before), &after);
        assert_eq!(t.kind(), "env-change");
        if let Transition::EnvChange { set, deleted } = t {
            assert_eq!(set, vec!["STRIPE_KEY".to_string()]);
            assert!(deleted.is_empty());
        } else {
            panic!("expected env-change");
        }
    }

    #[test]
    fn port_change_beats_env_change() {
        let before = json!({"application": {"port": 3000}, "env": {"FOO": "1"}});
        let after = json!({"application": {"port": 4000}, "env": {"FOO": "2"}});
        assert_eq!(classify(Some(&before), &after).kind(), "port-change");
    }
}
