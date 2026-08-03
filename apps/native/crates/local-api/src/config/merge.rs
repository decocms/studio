//! Deep-merge a `ConfigPatch`-shaped JSON value into the current
//! `TenantConfig`. Byte-parity port of
//! `packages/sandbox/daemon-go/internal/config/merge.go`.
//!
//! Semantics (unchanged from the TS source):
//!   - field absent (key missing) -> leave existing
//!   - field present -> set (nested objects merge field-by-field, arrays and
//!     primitives replace wholesale)
//!   - `env` is per-key: string -> upsert, `null` -> delete that key only

use serde_json::{Map, Value};

/// `deepMerge(current, patch)` — always returns an object with only the
/// top-level keys that ended up with a value (mirrors `JSON.stringify`
/// silently dropping `undefined`-valued keys on the TS side).
pub fn deep_merge(current: Option<&Value>, patch: &Value) -> Value {
    let base = current.and_then(Value::as_object);
    let patch_obj = patch.as_object();

    let mut out = Map::new();
    for field in ["git", "operator", "application"] {
        if let Some(v) = merge_optional_field(
            base.and_then(|b| b.get(field)),
            patch_obj.and_then(|p| p.get(field)),
        ) {
            out.insert(field.to_string(), v);
        }
    }
    if let Some(env) = merge_env(
        base.and_then(|b| b.get("env")),
        patch_obj.and_then(|p| p.get("env")),
    ) {
        out.insert("env".to_string(), env);
    }
    Value::Object(out)
}

fn merge_env(current: Option<&Value>, patch: Option<&Value>) -> Option<Value> {
    let Some(patch) = patch else {
        return current.cloned();
    };
    let mut out: Map<String, Value> = current
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(patch_obj) = patch.as_object() {
        for (k, v) in patch_obj {
            if v.is_null() {
                out.remove(k);
            } else {
                // Byte-parity with the TS `else (out as any)[k] = v` fallback
                // for a non-string, non-null value — passed through verbatim
                // so validation (not merge) is the layer that rejects it.
                out.insert(k.clone(), v.clone());
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

fn merge_optional_field(current: Option<&Value>, patch: Option<&Value>) -> Option<Value> {
    let Some(patch) = patch else {
        return current.cloned();
    };
    match current {
        None => Some(patch.clone()),
        Some(current) => Some(merge_objects(current, patch)),
    }
}

fn merge_objects(current: &Value, patch: &Value) -> Value {
    let (Some(cur_obj), Some(patch_obj)) = (current.as_object(), patch.as_object()) else {
        // Non-object patch (array/primitive) replaces wholesale, byte-parity
        // with the TS `mergeOptional`'s `isPlainObject` guard.
        return patch.clone();
    };
    let mut out = cur_obj.clone();
    for (k, v) in patch_obj {
        let existing = cur_obj.get(k);
        // `Value::as_object()` only matches the `Object` variant (never
        // `Array`), so this already mirrors the TS `isPlainObject` guard
        // (plain object on both sides, not an array) without a separate
        // array check.
        match (existing.and_then(Value::as_object), v.as_object()) {
            (Some(existing_obj), Some(_)) => {
                out.insert(
                    k.clone(),
                    merge_objects(&Value::Object(existing_obj.clone()), v),
                );
            }
            _ => {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn returns_patch_when_current_is_none() {
        let patch = json!({"application": {"packageManager": {"name": "npm"}, "runtime": "node"}});
        let merged = deep_merge(None, &patch);
        assert_eq!(merged["application"]["packageManager"]["name"], "npm");
    }

    #[test]
    fn preserves_fields_not_in_patch() {
        let current = json!({
            "git": {"repository": {"cloneUrl": "x", "branch": "main"}},
            "application": {"packageManager": {"name": "npm"}, "runtime": "node"},
        });
        let patch = json!({"application": {"packageManager": {"name": "pnpm"}, "runtime": "node"}});
        let merged = deep_merge(Some(&current), &patch);
        assert_eq!(merged["git"]["repository"]["cloneUrl"], "x");
        assert_eq!(merged["application"]["packageManager"]["name"], "pnpm");
    }

    #[test]
    fn preserves_operator_when_git_patch_omits_it() {
        let current = json!({
            "operator": {"userName": "Jane Doe", "userEmail": "jane@example.com"},
            "git": {"repository": {"cloneUrl": "old"}},
        });
        let patch = json!({
            "git": {
                "repository": {"cloneUrl": "new"},
                "identity": {"userName": "Bot", "userEmail": "bot@example.com"},
            },
        });
        let merged = deep_merge(Some(&current), &patch);
        assert_eq!(
            merged["operator"],
            json!({"userName": "Jane Doe", "userEmail": "jane@example.com"})
        );
        assert_eq!(merged["git"]["repository"]["cloneUrl"], "new");
    }

    #[test]
    fn absent_fields_dont_overwrite_existing_ones() {
        let current = json!({
            "application": {"packageManager": {"name": "npm"}, "runtime": "node", "port": 3000},
        });
        let patch = json!({"application": {"packageManager": {"name": "pnpm"}, "runtime": "node"}});
        let merged = deep_merge(Some(&current), &patch);
        assert_eq!(merged["application"]["port"], 3000);
        assert_eq!(merged["application"]["packageManager"]["name"], "pnpm");
    }

    #[test]
    fn env_upserts_keys_without_touching_siblings() {
        let merged = deep_merge(
            Some(&json!({"env": {"FOO": "1", "BAR": "2"}})),
            &json!({"env": {"FOO": "x"}}),
        );
        assert_eq!(merged["env"], json!({"FOO": "x", "BAR": "2"}));
    }

    #[test]
    fn env_deletes_a_key_when_its_value_is_null() {
        let merged = deep_merge(
            Some(&json!({"env": {"FOO": "1", "BAR": "2"}})),
            &json!({"env": {"FOO": null}}),
        );
        assert_eq!(merged["env"], json!({"BAR": "2"}));
    }

    #[test]
    fn env_collapses_to_absent_when_all_keys_are_deleted() {
        let merged = deep_merge(
            Some(&json!({"env": {"FOO": "1"}})),
            &json!({"env": {"FOO": null}}),
        );
        assert!(merged.get("env").is_none());
    }

    #[test]
    fn env_preserved_when_patch_omits_it() {
        let merged = deep_merge(
            Some(&json!({"env": {"FOO": "1"}})),
            &json!({"application": {"runtime": "node"}}),
        );
        assert_eq!(merged["env"], json!({"FOO": "1"}));
    }
}
