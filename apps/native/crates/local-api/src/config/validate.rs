//! Validate a fully-merged `TenantConfig` (post-merge, pre-persist). Byte-parity
//! port of `packages/sandbox/daemon/validate.ts`'s `validateTenantConfig` +
//! `packages/sandbox/git-co-author.ts`'s `normalizeCoAuthorIdentity` (needed
//! by `operator` validation).
//!
//! All fields are optional — partial configs are valid so callers can patch
//! one field at a time; only PRESENT field *values* are validated.
//!
//! Divergence from the TS source (deliberate, matches this repo's "no
//! `unwrap()`/panic on a request path" convention): a present-but-wrong-type
//! value that the TS source would reach via an unchecked property access
//! (e.g. a numeric `git.repository.branch`, which TS's `isSyntheticBranch`
//! would call `.startsWith` on and throw) is instead classified as invalid
//! here — same 400 outcome, no crash. No test in either e2e suite pins the
//! TS crash path, so this doesn't cost byte-parity on anything exercised.

use regex::Regex;
use serde_json::Value;
use std::path::{Component, Path};
use std::sync::LazyLock;

static BRANCH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._/-]+$").unwrap());
static ENV_KEY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap());
static EMAIL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$").unwrap());

const ENV_VALUE_MAX_BYTES: usize = 32 * 1024;
const VALID_RUNTIMES: &[&str] = &["node", "bun", "deno"];
const VALID_PMS: &[&str] = &["npm", "pnpm", "yarn", "bun", "deno"];

/// `Ok(())` mirrors `{kind:"ok"}`; `Err(reason)` mirrors `{kind:"invalid",
/// reason}` — note the wire response only ever surfaces the constant
/// `"invalid"` (see `config-store/store.ts`'s `REJECTION_REASONS.INVALID`,
/// which discards `reason`), so `reason` here is for local diagnostics/tests
/// only, never echoed to the caller.
pub fn validate_tenant_config(config: &Value) -> Result<(), String> {
    if let Some(git) = present(config, "git") {
        validate_git(git)?;
    }
    if let Some(app) = present(config, "application") {
        validate_application(app)?;
    }
    if let Some(env) = present(config, "env") {
        validate_env(env)?;
    }
    if let Some(operator) = present(config, "operator") {
        validate_operator(operator)?;
    }
    Ok(())
}

fn present<'a>(config: &'a Value, key: &str) -> Option<&'a Value> {
    config.get(key).filter(|v| !v.is_null())
}

fn validate_env(env: &Value) -> Result<(), String> {
    let obj = env
        .as_object()
        .ok_or_else(|| "env must be an object".to_string())?;
    for (k, v) in obj {
        if !ENV_KEY_RE.is_match(k) {
            return Err(format!("env key invalid: {k}"));
        }
        let s = v
            .as_str()
            .ok_or_else(|| format!("env value for {k} must be a string"))?;
        if s.contains('\0') {
            return Err(format!("env value for {k} contains NUL"));
        }
        if s.len() > ENV_VALUE_MAX_BYTES {
            return Err(format!(
                "env value for {k} exceeds {ENV_VALUE_MAX_BYTES} bytes"
            ));
        }
    }
    Ok(())
}

fn validate_git(git: &Value) -> Result<(), String> {
    let repository = git.get("repository");
    let clone_url = repository
        .and_then(|r| r.get("cloneUrl"))
        .and_then(Value::as_str);
    let clone_url = clone_url.ok_or_else(|| "git.repository.cloneUrl is required".to_string())?;
    if clone_url.is_empty() {
        return Err("git.repository.cloneUrl is empty".to_string());
    }
    if let Some(branch) = repository.and_then(|r| present(r, "branch")) {
        let is_synthetic = branch
            .as_str()
            .is_some_and(|b| b == "ephemeral" || b.starts_with("thread:"));
        if !is_synthetic {
            let valid = branch
                .as_str()
                .is_some_and(|b| BRANCH_RE.is_match(b) && !b.starts_with('-'));
            if !valid {
                return Err(format!(
                    "git.repository.branch invalid: {}",
                    display_value(branch)
                ));
            }
        }
    }
    if let Some(identity) = present(git, "identity") {
        let user_name = identity.get("userName").and_then(Value::as_str);
        if user_name.is_none_or(str::is_empty) {
            return Err("git.identity.userName is required".to_string());
        }
        let user_email = identity.get("userEmail").and_then(Value::as_str);
        if user_email.is_none_or(str::is_empty) {
            return Err("git.identity.userEmail is required".to_string());
        }
    }
    Ok(())
}

fn validate_application(app: &Value) -> Result<(), String> {
    if let Some(runtime) = present(app, "runtime") {
        let valid = runtime
            .as_str()
            .is_some_and(|r| VALID_RUNTIMES.contains(&r));
        if !valid {
            return Err(format!("runtime invalid: {}", display_value(runtime)));
        }
    }
    if let Some(pm) = present(app, "packageManager") {
        if let Some(name) = present(pm, "name") {
            let name_str = name
                .as_str()
                .ok_or_else(|| "application.packageManager.name must be a string".to_string())?;
            if !VALID_PMS.contains(&name_str) {
                return Err(format!("packageManager invalid: {name_str}"));
            }
        }
        if let Some(path) = present(pm, "path") {
            let path = path
                .as_str()
                .filter(|path| !path.is_empty())
                .ok_or_else(|| "packageManager.path must be non-empty".to_string())?;
            validate_package_manager_path(path)?;
        }
    }
    if let Some(port) = present(app, "port") {
        if !is_valid_port(port) {
            return Err(format!("port invalid: {}", display_value(port)));
        }
    }
    Ok(())
}

pub(crate) fn validate_package_manager_path(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if path.is_absolute() {
        return Err("packageManager.path must be relative to the repository".to_string());
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("packageManager.path must stay inside the repository".to_string());
    }
    Ok(())
}

fn validate_operator(operator: &Value) -> Result<(), String> {
    let user_name = operator
        .get("userName")
        .and_then(Value::as_str)
        .ok_or_else(|| "operator.userName is required".to_string())?;
    let user_email = operator.get("userEmail").and_then(Value::as_str);
    let normalized = normalize_co_author_identity(user_name, user_email);
    let normalized = normalized.ok_or_else(|| "operator.userName is required".to_string())?;

    if let Some(email_field) = present(operator, "userEmail") {
        let email_str = email_field
            .as_str()
            .ok_or_else(|| "operator.userEmail must be a string".to_string())?;
        if !email_str.trim().is_empty() && normalized.1.is_none() {
            return Err("operator.userEmail is invalid".to_string());
        }
    }
    Ok(())
}

fn is_valid_port(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|p| p.fract() == 0.0 && p > 0.0 && p <= 65535.0)
}

/// Byte-parity port of `packages/sandbox/git-co-author.ts::normalizeCoAuthorIdentity`.
/// Returns `(userName, userEmail)` — `userEmail` is `None` when absent or
/// invalid (matching the TS source's "degrade, don't reject" email handling
/// once the name itself is valid).
fn normalize_co_author_identity(
    user_name: &str,
    user_email: Option<&str>,
) -> Option<(String, Option<String>)> {
    let name = user_name.trim();
    if name.is_empty() || has_invalid_co_author_chars(name) {
        return None;
    }
    let Some(email) = user_email.map(str::trim).filter(|e| !e.is_empty()) else {
        return Some((name.to_string(), None));
    };
    if has_invalid_co_author_chars(email) || !EMAIL_RE.is_match(email) {
        return Some((name.to_string(), None));
    }
    Some((name.to_string(), Some(email.to_string())))
}

fn has_invalid_co_author_chars(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '\r' | '\n' | '<' | '>'))
}

fn display_value(v: &Value) -> String {
    v.as_str()
        .map(str::to_string)
        .unwrap_or_else(|| v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_config_is_valid() {
        assert!(validate_tenant_config(&json!({})).is_ok());
    }

    #[test]
    fn valid_full_config() {
        let cfg = json!({
            "git": {"repository": {"cloneUrl": "https://x.git", "branch": "main"}},
            "application": {"packageManager": {"name": "npm"}, "runtime": "node", "port": 3000},
            "env": {"FOO": "bar"},
            "operator": {"userName": "Jane Doe", "userEmail": "jane@example.com"},
        });
        assert!(validate_tenant_config(&cfg).is_ok());
    }

    #[test]
    fn empty_clone_url_is_invalid() {
        let cfg = json!({"git": {"repository": {"cloneUrl": ""}}});
        assert!(validate_tenant_config(&cfg).is_err());
    }

    #[test]
    fn missing_clone_url_is_invalid() {
        let cfg = json!({"git": {"repository": {}}});
        assert!(validate_tenant_config(&cfg).is_err());
    }

    #[test]
    fn synthetic_branch_skips_format_check() {
        let cfg = json!({"git": {"repository": {"cloneUrl": "x", "branch": "thread:abc-123"}}});
        assert!(validate_tenant_config(&cfg).is_ok());
        let cfg2 = json!({"git": {"repository": {"cloneUrl": "x", "branch": "ephemeral"}}});
        assert!(validate_tenant_config(&cfg2).is_ok());
    }

    #[test]
    fn branch_starting_with_dash_is_invalid() {
        let cfg = json!({"git": {"repository": {"cloneUrl": "x", "branch": "-evil"}}});
        assert!(validate_tenant_config(&cfg).is_err());
    }

    #[test]
    fn invalid_runtime_is_rejected() {
        let cfg = json!({"application": {"runtime": "python"}});
        assert!(validate_tenant_config(&cfg).is_err());
    }

    #[test]
    fn invalid_package_manager_is_rejected() {
        let cfg = json!({"application": {"packageManager": {"name": "cargo"}}});
        assert!(validate_tenant_config(&cfg).is_err());
    }

    #[test]
    fn repo_relative_package_manager_path_is_valid() {
        let cfg = json!({"application": {"packageManager": {"name": "bun", "path": "apps/web"}}});
        assert!(validate_tenant_config(&cfg).is_ok());
    }

    #[test]
    fn absolute_package_manager_path_is_rejected() {
        let cfg =
            json!({"application": {"packageManager": {"name": "bun", "path": "/tmp/outside"}}});
        let error = validate_tenant_config(&cfg).unwrap_err();
        assert!(error.contains("relative to the repository"));
    }

    #[test]
    fn traversing_package_manager_path_is_rejected() {
        for path in ["..", "../outside", "apps/../../outside"] {
            let cfg = json!({"application": {"packageManager": {"name": "bun", "path": path}}});
            let error = validate_tenant_config(&cfg).unwrap_err();
            assert!(
                error.contains("stay inside the repository"),
                "{path}: {error}"
            );
        }
    }

    #[test]
    fn out_of_range_port_is_rejected() {
        assert!(validate_tenant_config(&json!({"application": {"port": 0}})).is_err());
        assert!(validate_tenant_config(&json!({"application": {"port": 70000}})).is_err());
        assert!(validate_tenant_config(&json!({"application": {"port": 3000.5}})).is_err());
    }

    #[test]
    fn env_key_must_be_identifier_shaped() {
        let cfg = json!({"env": {"1FOO": "bar"}});
        assert!(validate_tenant_config(&cfg).is_err());
    }

    #[test]
    fn env_value_must_be_string() {
        let cfg = json!({"env": {"FOO": 1}});
        assert!(validate_tenant_config(&cfg).is_err());
    }

    #[test]
    fn operator_without_username_is_invalid() {
        assert!(validate_tenant_config(&json!({"operator": {}})).is_err());
    }

    #[test]
    fn operator_with_invalid_email_degrades_gracefully() {
        // Byte-parity: an invalid email doesn't reject the whole patch when
        // it round-trips through `userEmail is invalid` -- here it's a
        // non-empty string that fails EMAIL_RE, which normalize degrades to
        // `None`, and validate_operator's own check then rejects it.
        let cfg = json!({"operator": {"userName": "Jane", "userEmail": "not-an-email"}});
        assert!(validate_tenant_config(&cfg).is_err());
    }

    #[test]
    fn operator_without_email_is_valid() {
        let cfg = json!({"operator": {"userName": "Jane"}});
        assert!(validate_tenant_config(&cfg).is_ok());
    }

    #[test]
    fn non_string_branch_is_rejected_without_panicking() {
        let cfg = json!({"git": {"repository": {"cloneUrl": "x", "branch": 42}}});
        assert!(validate_tenant_config(&cfg).is_err());
    }
}
