pub mod classify;
pub mod merge;
pub mod store;
pub mod validate;

// `ConfigSnapshot`/`TenantConfig` aren't referenced outside `config::store`
// yet — `state.rs` (a shared file) only imports `ConfigStore`. Kept as a
// re-export (not dead in the "delete it" sense) so a future consumer of the
// documented `snapshot()` shape (see the native module-ownership contract)
// doesn't have to reach into `config::store` directly.
#[allow(unused_imports)]
pub use store::{ConfigSnapshot, ConfigStore, TenantConfig};

/// Borrows a nested string out of a tenant-config `Value` by key path —
/// `get_str(config, &["git", "repository", "branch"])`. `None` for a missing
/// key, a non-object on the way down, or a non-string leaf.
///
/// The ONE copy for every consumer of the tenant-config JSON (setup's
/// clone/install/dev steps, `classify`); each step used to carry its own
/// verbatim walker, which is exactly how one step's idea of a config path
/// drifts from its siblings'.
pub(crate) fn get_str<'a>(config: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = config;
    for key in path {
        cur = cur.get(key)?;
    }
    cur.as_str()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::get_str;

    #[test]
    fn get_str_walks_objects_and_rejects_non_string_leaves() {
        let config = json!({
            "git": { "repository": { "cloneUrl": "https://example.com/r.git" } },
            "application": { "port": 4000 },
        });
        assert_eq!(
            get_str(&config, &["git", "repository", "cloneUrl"]),
            Some("https://example.com/r.git")
        );
        assert_eq!(get_str(&config, &["git", "repository", "branch"]), None);
        assert_eq!(get_str(&config, &["application", "port"]), None);
        assert_eq!(get_str(&config, &["application", "port", "deep"]), None);
    }
}
