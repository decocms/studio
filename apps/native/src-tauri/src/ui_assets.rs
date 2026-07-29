use std::collections::HashSet;
use std::sync::Arc;

use tauri::{AppHandle, AssetResolver, Wry};

/// Adapter from Tauri's embedded frontend archive to local-api's
/// Tauri-independent static asset contract.
pub struct TauriUiAssets {
    resolver: AssetResolver<Wry>,
    known_paths: Arc<HashSet<String>>,
    index: local_api::UiAsset,
    content_security_policy: String,
}

impl TauriUiAssets {
    pub fn new(app: &AppHandle, selftest_mode: bool) -> Result<Self, String> {
        let resolver = app.asset_resolver();
        let known_paths = resolver
            .iter()
            .map(|(path, _)| normalize_asset_path(&path))
            .collect::<HashSet<_>>();
        let index = resolver
            .get("index.html".to_string())
            .ok_or_else(|| "the bundled frontend does not contain index.html".to_string())?;
        let content_security_policy = index
            .csp_header()
            .map(|value| crate::csp::for_http_asset(value, selftest_mode))
            .ok_or_else(|| {
                "the bundled frontend index has no Content-Security-Policy".to_string()
            })?;

        Ok(Self {
            resolver,
            known_paths: Arc::new(known_paths),
            index: convert_asset(index, "index.html"),
            content_security_policy,
        })
    }
}

impl local_api::UiAssetProvider for TauriUiAssets {
    fn asset(&self, path: &str) -> Option<local_api::UiAsset> {
        let path = normalize_asset_path(path);
        if path == "index.html" || !self.known_paths.contains(&path) {
            return None;
        }
        self.resolver
            .get(path.clone())
            .map(|asset| convert_asset(asset, &path))
    }

    fn index(&self) -> Option<local_api::UiAsset> {
        Some(self.index.clone())
    }

    fn content_security_policy(&self) -> String {
        self.content_security_policy.clone()
    }
}

fn normalize_asset_path(path: &str) -> String {
    path.trim_start_matches('/').to_string()
}

fn convert_asset(asset: tauri::Asset, path: &str) -> local_api::UiAsset {
    local_api::UiAsset::new(
        asset.bytes,
        asset.mime_type,
        if path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        },
    )
}
