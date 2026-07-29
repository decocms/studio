//! CSP adaptation for the HTTP-served bundled UI.
//!
//! Tauri derives the base policy and injects the entry script hashes.
//! local-api adds the exact sandbox preview origin when it serves
//! `index.html`. This module only grants the self-test harness its script
//! injection mechanisms; production never receives these sources.

use std::collections::HashMap;

use tauri::utils::config::{Csp, CspDirectiveSources};

pub fn for_http_asset(base: &str, selftest_mode: bool) -> String {
    if !selftest_mode {
        return base.to_string();
    }
    let mut directives: HashMap<String, CspDirectiveSources> = Csp::Policy(base.to_string()).into();
    let script_sources = directives.entry("script-src".to_string()).or_default();
    script_sources.push("'unsafe-eval'");
    script_sources.push("'unsafe-inline'");
    Csp::from(directives).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_policy_is_unchanged() {
        let base = "default-src 'self'; script-src 'self'";
        assert_eq!(for_http_asset(base, false), base);
    }

    #[test]
    fn selftest_policy_allows_its_injected_scripts() {
        let csp = for_http_asset("default-src 'self'; script-src 'self'", true);
        assert!(csp.contains("'unsafe-eval'"));
        assert!(csp.contains("'unsafe-inline'"));
        assert!(csp.contains("default-src 'self'"));
    }
}
