//! `POST /_sandbox/orgfs-config` — config-relay FILE WRITE ONLY.
//!
//! The full daemon feature (`packages/sandbox/daemon/routes/orgfs-config.ts`
//! plus `org-fs/config.ts`) is a two-part story. The first part validates
//! and relays the config to a shared-volume file a privileged sidecar
//! watches; the second part is that sidecar actually performing the rclone
//! mount. The mount part is explicitly DROPPED for local-api (see
//! the native local-API contract:
//! "No org/output/org/upload symlink plumbing; file sharing with the org
//! happens through the app-API proxy instead"). The relay part is what
//! THIS file implements, byte-parity with `makeOrgFsConfigHandler`, because
//! `daemon.e2e.test.ts`'s `orgfs-config` describe block exercises it
//! end-to-end (including a real `ORGFS_SIDECAR_CONFIG_PATH` file write) and
//! is NOT in the contract doc's dropped-tests list — only the mount lifecycle
//! is out of scope, not the relay's own request/response contract.
//!
//! `ORGFS_SIDECAR_CONFIG_PATH` is read directly from the process environment
//! per request (not threaded through `AppState`, which is a shared file this
//! family may not edit) — cheap enough that there's no need to cache it, and
//! it mirrors the TS handler's own "inert when unset" behavior exactly.

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::error::ApiError;
use crate::state::AppState;

pub async fn orgfs_config(State(_state): State<AppState>, body: Bytes) -> Response {
    if !is_valid_org_fs_config(&body) {
        return ApiError::bad_request("invalid org-fs config").into_response();
    }

    let Some(config_path) = std::env::var_os("ORGFS_SIDECAR_CONFIG_PATH") else {
        return Json(json!({ "written": false })).into_response();
    };
    let config_path = PathBuf::from(config_path);

    match write_relay_file(&config_path, &body) {
        Ok(()) => Json(json!({ "written": true })).into_response(),
        Err(_) => ApiError::internal("relay failed").into_response(),
    }
}

/// Byte-parity port of `org-fs/config.ts::parseOrgFsConfig`'s shape check
/// (`baseUrl`/`orgSlug`/`token` strings, `mounts` a non-empty array of
/// `{volume, path, readonly?}`).
fn is_valid_org_fs_config(raw: &[u8]) -> bool {
    let Ok(parsed) = serde_json::from_slice::<Value>(raw) else {
        return false;
    };
    let Some(obj) = parsed.as_object() else {
        return false;
    };
    let has_str = |key: &str| obj.get(key).and_then(Value::as_str).is_some();
    if !has_str("baseUrl") || !has_str("orgSlug") || !has_str("token") {
        return false;
    }
    let Some(mounts) = obj.get("mounts").and_then(Value::as_array) else {
        return false;
    };
    let valid_mounts = mounts.iter().filter(|m| is_valid_mount(m)).count();
    valid_mounts > 0
}

fn is_valid_mount(mount: &Value) -> bool {
    let Some(obj) = mount.as_object() else {
        return false;
    };
    let volume_ok = obj.get("volume").and_then(Value::as_str).is_some();
    let path_ok = obj.get("path").and_then(Value::as_str).is_some();
    let readonly_ok = obj.get("readonly").is_none_or(Value::is_boolean);
    volume_ok && path_ok && readonly_ok
}

/// Atomic write: the sidecar must never read a torn file — byte-parity with
/// the TS handler's write-to-tmp-then-rename sequence.
fn write_relay_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".config-{}.tmp", std::process::id()));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_body() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "baseUrl": "https://cluster.example",
            "orgSlug": "acme",
            "token": "fs-scoped-token",
            "mounts": [{"volume": "skills", "path": "skills", "readonly": true}],
        }))
        .unwrap()
    }

    #[test]
    fn valid_config_passes() {
        assert!(is_valid_org_fs_config(&valid_body()));
    }

    #[test]
    fn missing_fields_are_invalid() {
        assert!(!is_valid_org_fs_config(b"{}"));
        assert!(!is_valid_org_fs_config(
            br#"{"not":"a valid org-fs config"}"#
        ));
    }

    #[test]
    fn empty_mounts_array_is_invalid() {
        let body = json!({
            "baseUrl": "https://cluster.example",
            "orgSlug": "acme",
            "token": "t",
            "mounts": [],
        });
        assert!(!is_valid_org_fs_config(&serde_json::to_vec(&body).unwrap()));
    }

    #[test]
    fn malformed_json_is_invalid() {
        assert!(!is_valid_org_fs_config(b"}{not json"));
    }

    #[test]
    fn write_relay_file_creates_parent_and_is_atomic() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("nested").join("orgfs.json");
        write_relay_file(&target, b"hello").expect("write ok");
        let contents = std::fs::read(&target).expect("read back");
        assert_eq!(contents, b"hello");
    }
}
