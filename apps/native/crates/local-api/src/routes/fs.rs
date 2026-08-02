//! Filesystem routes — `POST /_sandbox/{read,write,unlink,mkdir,rename,
//! edit,grep,glob,write_from_url,upload_to_url,tools/sync}` (grouped here
//! because the daemon's own `fsH` dispatch table does the same, see
//! `entry.ts`).
//!
//! Byte-parity target: `packages/sandbox/daemon-go/internal/routes/fs.go` +
//! `paths.ts::safePath` + `routes/tools.ts` + `tools-catalog.ts`. Oracle:
//! `daemon.e2e.test.ts`'s `fs` describe block + `daemon.tools.e2e.test.ts`.
//!
//! Pure logic lives in submodules (each with co-located `#[cfg(test)]`
//! unit tests) so it's diffable against its TS counterpart and testable
//! without spinning up the HTTP server:
//! - `fs::safe_path` — `paths.ts::safePath` / `resolveReadPath`
//! - `fs::glob_logic` — the glob-handler helper functions in `fs.ts`
//! - `fs::git_exclude` — `git-exclude.ts::ensureGitExclude`
//! - `fs::tools_catalog` — `tools-catalog.ts` (catalog file shape, prune)
//! - `fs::mcp_client` — a minimal hand-rolled MCP Streamable HTTP client
//!   (no MCP SDK crate exists in this workspace — see that module's doc)

mod git_exclude;
mod glob_logic;
mod mcp_client;
mod safe_path;
mod tools_catalog;
mod tools_transaction;

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::FutureExt;
use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

use crate::error::ApiError;
use crate::mutation::{MutationCancellation, MutationOwnerError};
use crate::process_group::ProcessGroupChild;
use crate::process_util::{exit_status_to_code, CancelOnDrop};
use crate::state::AppState;
use crate::tasks::{now_ms, KillSignal, ProcessController, TaskEntry, TaskStatus, TaskSummary};

use glob_logic::{
    collect_empty_directories, repo_relative_prefix, resolve_glob_result_limit, scan_glob,
    walk_repo_within_max_depth, GlobScanState,
};
use safe_path::{resolve_read_path, safe_path};

/// Cap on bytes returned for image responses. ~5MB matches Anthropic's
/// vision input ceiling and keeps tool result payloads bounded.
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// Cap on bytes for write_from_url / upload_to_url.
const MAX_TRANSFER_BYTES: u64 = 500 * 1024 * 1024;
/// Wall-clock cap for fetches in write_from_url / upload_to_url.
const TRANSFER_DEADLINE: Duration = Duration::from_secs(5 * 60);

static TOOLS_CATALOG_COMMIT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn shutting_down() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "application is shutting down",
    )
}

async fn run_commit_owned<T, F, Fut>(state: &AppState, operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, ApiError>> + Send + 'static,
{
    let mutations = state.shutdown.mutations();
    match mutations.run_commit(operation).await {
        Ok(result) => result,
        Err(error) => Err(map_owner_error(error)),
    }
}

fn map_owner_error(error: MutationOwnerError) -> ApiError {
    match error {
        MutationOwnerError::ShuttingDown => shutting_down(),
        MutationOwnerError::Panicked | MutationOwnerError::Stopped => {
            tracing::error!(?error, "filesystem mutation owner failed");
            ApiError::internal("filesystem mutation owner failed")
        }
    }
}

async fn new_stage_dir(app_root: &Path) -> Result<PathBuf, ApiError> {
    let dir = app_root
        .join(".decocms")
        .join("mutations")
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
    }
    Ok(dir)
}

pub(crate) async fn recover_mutation_stages(
    mutation_root: &Path,
    repo_dir: &Path,
) -> std::io::Result<()> {
    tools_transaction::recover_mutation_stages(
        mutation_root,
        &repo_dir.join(tools_catalog::CATALOG_DIR),
    )
    .await
}

async fn remove_staged_path(path: &Path) {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => return,
    };
    if metadata.is_dir() {
        let _ = tokio::fs::remove_dir_all(path).await;
    } else {
        let _ = tokio::fs::remove_file(path).await;
    }
}

async fn stage_bytes(app_root: &Path, bytes: &[u8]) -> Result<(PathBuf, PathBuf), ApiError> {
    let stage_dir = new_stage_dir(app_root).await?;
    let staged = stage_dir.join("payload");
    if let Err(error) = tokio::fs::write(&staged, bytes).await {
        remove_staged_path(&stage_dir).await;
        return Err(ApiError::internal(error.to_string()));
    }
    Ok((stage_dir, staged))
}

async fn preserve_existing_permissions(staged: &Path, target: &Path) -> Result<(), ApiError> {
    let Ok(metadata) = tokio::fs::metadata(target).await else {
        return Ok(());
    };
    tokio::fs::set_permissions(staged, metadata.permissions())
        .await
        .map_err(|error| ApiError::internal(error.to_string()))
}

async fn commit_staged_file_owned(
    state: &AppState,
    staged: PathBuf,
    target: PathBuf,
) -> Result<(), ApiError> {
    run_commit_owned(state, move || async move {
        preserve_existing_permissions(&staged, &target).await?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
        }
        tokio::fs::rename(staged, target)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))
    })
    .await
}

// "Failed to parse body" (NOT this crate's usual "invalid JSON body") is the
// fs family's daemon-parity wording — see `daemon/routes/body-parser.ts`.
fn parse_body<T: DeserializeOwned + Default>(bytes: &[u8]) -> Result<T, ApiError> {
    crate::http_util::json_body_or_default(bytes, "Failed to parse body")
}

// --- read --------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct ReadBody {
    path: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
    full: Option<bool>,
}

/// Magic-byte sniffer for the image types Claude vision accepts. Returns
/// `None` for everything else — this doesn't try to be clever about
/// arbitrary binary formats.
fn sniff_image_media_type(probe: &[u8]) -> Option<&'static str> {
    if probe.len() >= 3 && probe[0..3] == [0xff, 0xd8, 0xff] {
        return Some("image/jpeg");
    }
    if probe.len() >= 8 && probe[0..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some("image/png");
    }
    if probe.len() >= 6 && probe[0..4] == [0x47, 0x49, 0x46, 0x38] {
        return Some("image/gif");
    }
    if probe.len() >= 12
        && probe[0..4] == [0x52, 0x49, 0x46, 0x46]
        && probe[8..12] == [0x57, 0x45, 0x42, 0x50]
    {
        return Some("image/webp");
    }
    None
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard (padded) base64 — no `base64` crate in this workspace's
/// dependency table (see `mcp_client.rs`'s doc comment for the "shared
/// Cargo.toml, don't add deps" constraint); this is a self-contained ~15
/// line encoder, unit-tested against known vectors below.
fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(BASE64_ALPHABET[(b0 >> 2) as usize] as char);
        out.push(BASE64_ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            BASE64_ALPHABET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_ALPHABET[(b2 & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// On-disk name of the merged decofile artifact, and the directory it merges.
const DECOFILE_GEN_BASENAME: &str = "blocks.gen.json";
const DECOFILE_BLOCKS_DIRNAME: &str = "blocks";

/// Rebuild `.deco/blocks.gen.json` from the sibling `.deco/blocks/*.json`.
///
/// Each file becomes `{ decodeURIComponent(<stem>): <file contents> }` — the
/// filename stem is the percent-encoded block id, which is what the deco
/// runtime emits. Contents are spliced in as RAW TEXT rather than parsed and
/// re-serialized: the payload is routinely multi-megabyte and only the small
/// keys need encoding.
///
/// `None` when there is no `blocks` directory or nothing mergeable in it, so
/// the caller falls through to its normal not-found path. A malformed block is
/// not rejected here — the client's own parse fails and it falls back to "no
/// snapshot", exactly as when the file is genuinely absent.
async fn generate_decofile_from_blocks(blocks_dir: &std::path::Path) -> Option<String> {
    let mut dir = tokio::fs::read_dir(blocks_dir).await.ok()?;
    let mut names: Vec<String> = Vec::new();
    while let Ok(Some(entry)) = dir.next_entry().await {
        if !entry
            .file_type()
            .await
            .map(|t| t.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.to_ascii_lowercase().ends_with(".json") {
            names.push(name);
        }
    }
    if names.is_empty() {
        return None;
    }
    // Sorted so the merged artifact is byte-for-byte deterministic.
    names.sort();

    let mut parts: Vec<String> = Vec::with_capacity(names.len());
    for name in names {
        let stem = &name[..name.len() - ".json".len()];
        // A stem that is not valid percent-encoding keeps its literal form,
        // mirroring the frontend's own fallback.
        let key = urlencoding::decode(stem)
            .map(|decoded| decoded.into_owned())
            .unwrap_or_else(|_| stem.to_string());
        let Ok(raw) = tokio::fs::read_to_string(blocks_dir.join(&name)).await else {
            continue;
        };
        let raw = raw.trim();
        // An empty file would emit `"key":` with no value and break the merge.
        if raw.is_empty() {
            continue;
        }
        let Ok(encoded_key) = serde_json::to_string(&key) else {
            continue;
        };
        parts.push(format!("{encoded_key}:{raw}"));
    }
    Some(format!("{{{}}}", parts.join(",")))
}

pub async fn read(State(state): State<AppState>, body: Bytes) -> Response {
    let body: ReadBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let user_path = body.path.unwrap_or_default();
    let Some(file_path) = resolve_read_path(&state.app_root, &state.repo_dir, &user_path) else {
        return ApiError::bad_request("Path escapes project root").into_response();
    };
    let meta = match tokio::fs::metadata(&file_path).await {
        Ok(m) => m,
        Err(_) => {
            // Decofile fallback: `.deco/blocks.gen.json` is the runtime's merge
            // of every `.deco/blocks/*.json`, and repos commonly gitignore it
            // (a multi-MB single line that conflicts on every content PR), so a
            // FRESH worktree has the block sources but not the merged file.
            // Rebuilding it on read is what makes the CMS readable before the
            // dev server has booted — without this the sections editor reports
            // "File not found: .deco/blocks.gen.json" against a repo that
            // plainly has its blocks. Byte-parity with `daemon/routes/fs.ts`.
            if file_path.file_name().and_then(|name| name.to_str()) == Some(DECOFILE_GEN_BASENAME) {
                if let Some(dir) = file_path
                    .parent()
                    .map(|dir| dir.join(DECOFILE_BLOCKS_DIRNAME))
                {
                    if let Some(merged) = generate_decofile_from_blocks(&dir).await {
                        // `lineCount` is advisory: the client consumes this as
                        // one blob and its line-number stripper is a no-op on
                        // output that never carries a `\d+\t` prefix.
                        return Json(json!({
                            "kind": "text",
                            "content": merged,
                            "lineCount": 1,
                        }))
                        .into_response();
                    }
                }
            }
            return ApiError::bad_request(format!("File not found: {user_path}")).into_response();
        }
    };
    if meta.is_dir() {
        return ApiError::bad_request("Path is a directory").into_response();
    }
    let data = match tokio::fs::read(&file_path).await {
        Ok(d) => d,
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let probe = &data[..data.len().min(8192)];

    if let Some(media_type) = sniff_image_media_type(probe) {
        if data.len() as u64 > MAX_IMAGE_BYTES {
            return ApiError::bad_request(format!(
                "Image too large ({} bytes; cap is {MAX_IMAGE_BYTES})",
                data.len()
            ))
            .into_response();
        }
        return Json(json!({
            "kind": "image",
            "mediaType": media_type,
            "size": data.len(),
            "base64": base64_encode(&data),
        }))
        .into_response();
    }

    if probe.contains(&0u8) {
        return ApiError::bad_request(
            "File appears to be binary and is not a supported image format (jpeg/png/gif/webp).",
        )
        .into_response();
    }

    let text = String::from_utf8_lossy(&data);
    let lines: Vec<&str> = text.split('\n').collect();
    let full = body.full.unwrap_or(false);
    let offset: usize = if full {
        1
    } else {
        body.offset.unwrap_or(1).max(1) as usize
    };
    let limit: usize = if full {
        lines.len()
    } else {
        body.limit.unwrap_or(2000).max(0) as usize
    };
    let start = offset.saturating_sub(1).min(lines.len());
    let end = start.saturating_add(limit).min(lines.len());
    let slice = &lines[start..end];
    let numbered = slice
        .iter()
        .enumerate()
        .map(|(i, l)| format!("{}\t{l}", offset + i))
        .collect::<Vec<_>>()
        .join("\n");
    Json(json!({ "kind": "text", "content": numbered, "lineCount": lines.len() })).into_response()
}

// --- write -------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct WriteBody {
    path: Option<String>,
    content: Option<String>,
}

pub async fn write(State(state): State<AppState>, body: Bytes) -> Response {
    let body: WriteBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let Some(content) = body.content else {
        return ApiError::bad_request("content is required").into_response();
    };
    let user_path = body.path.unwrap_or_default();
    let Some(file_path) = safe_path(&state.app_root, &state.repo_dir, &user_path) else {
        return ApiError::bad_request("Path escapes app root").into_response();
    };
    let (stage_dir, staged) = match stage_bytes(&state.app_root, content.as_bytes()).await {
        Ok(staged) => staged,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = commit_staged_file_owned(&state, staged, file_path).await {
        remove_staged_path(&stage_dir).await;
        return error.into_response();
    }
    remove_staged_path(&stage_dir).await;
    state
        .broadcaster
        .emit("file-changed", json!({ "path": user_path }));
    Json(json!({ "ok": true, "bytesWritten": content.len() })).into_response()
}

// --- unlink ------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct UnlinkBody {
    path: Option<String>,
    recursive: Option<bool>,
}

/// Paths that must not be deleted via the sandbox unlink API.
fn assert_unlink_allowed(normalized: &str, recursive: bool) -> Option<&'static str> {
    if normalized.is_empty() || normalized.contains("..") {
        return Some("Invalid path");
    }
    if recursive && normalized == "." {
        return Some("Refusing to recursively delete the repository root");
    }
    let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    if segments.contains(&".git") {
        return Some("Refusing to delete .git");
    }
    None
}

pub async fn unlink(State(state): State<AppState>, body: Bytes) -> Response {
    let body: UnlinkBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let raw_path = match body.path.as_deref() {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return ApiError::bad_request("path is required").into_response(),
    };
    let recursive = body.recursive.unwrap_or(false);
    let normalized = raw_path.replace('\\', "/");
    if let Some(msg) = assert_unlink_allowed(&normalized, recursive) {
        return ApiError::bad_request(msg).into_response();
    }
    let Some(file_path) = safe_path(&state.app_root, &state.repo_dir, &raw_path) else {
        return ApiError::bad_request("Path escapes app root").into_response();
    };
    let trash_dir = if recursive {
        match new_stage_dir(&state.app_root).await {
            Ok(dir) => Some(dir),
            Err(error) => return error.into_response(),
        }
    } else {
        None
    };
    let trash_for_commit = trash_dir.clone();
    let (existed, trashed) = match run_commit_owned(&state, move || async move {
        match tokio::fs::symlink_metadata(&file_path).await {
            Ok(meta) => {
                if meta.is_dir() && !recursive {
                    return Err(ApiError::bad_request(
                        "Refusing to unlink directory without recursive: true",
                    ));
                }
                if recursive {
                    let trash_path = trash_for_commit.unwrap().join("deleted");
                    tokio::fs::rename(&file_path, &trash_path)
                        .await
                        .map_err(|error| ApiError::internal(error.to_string()))?;
                    Ok((true, Some(trash_path)))
                } else {
                    tokio::fs::remove_file(&file_path)
                        .await
                        .map_err(|error| ApiError::internal(error.to_string()))?;
                    Ok((true, None))
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((false, None)),
            Err(error) => Err(ApiError::internal(error.to_string())),
        }
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            if let Some(trash_dir) = &trash_dir {
                remove_staged_path(trash_dir).await;
            }
            return error.into_response();
        }
    };
    if let Some(trashed) = &trashed {
        remove_staged_path(trashed).await;
    }
    if let Some(trash_dir) = &trash_dir {
        remove_staged_path(trash_dir).await;
    }
    if existed {
        state
            .broadcaster
            .emit("file-changed", json!({ "path": raw_path }));
    }
    Json(json!({ "ok": true, "existed": existed })).into_response()
}

// --- mkdir -------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct MkdirBody {
    path: Option<String>,
}

pub async fn mkdir(State(state): State<AppState>, body: Bytes) -> Response {
    let body: MkdirBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let raw_path = match body.path.as_deref() {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return ApiError::bad_request("path is required").into_response(),
    };
    let normalized = raw_path.replace('\\', "/");
    if normalized.is_empty() || normalized.contains("..") {
        return ApiError::bad_request("Invalid path").into_response();
    }
    let Some(dir_path) = safe_path(&state.app_root, &state.repo_dir, &raw_path) else {
        return ApiError::bad_request("Path escapes app root").into_response();
    };
    if let Err(error) = run_commit_owned(&state, move || async move {
        tokio::fs::create_dir_all(&dir_path)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))
    })
    .await
    {
        return error.into_response();
    }
    state
        .broadcaster
        .emit("file-changed", json!({ "path": raw_path }));
    Json(json!({ "ok": true })).into_response()
}

// --- rename ------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct RenameBody {
    from: Option<String>,
    to: Option<String>,
}

pub async fn rename(State(state): State<AppState>, body: Bytes) -> Response {
    let body: RenameBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let raw_from = match body.from.as_deref() {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return ApiError::bad_request("from is required").into_response(),
    };
    let raw_to = match body.to.as_deref() {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return ApiError::bad_request("to is required").into_response(),
    };
    let from_normalized = raw_from.replace('\\', "/");
    let to_normalized = raw_to.replace('\\', "/");
    if from_normalized.contains("..") || to_normalized.contains("..") {
        return ApiError::bad_request("Invalid path").into_response();
    }
    let Some(from_path) = safe_path(&state.app_root, &state.repo_dir, &raw_from) else {
        return ApiError::bad_request("Path escapes app root").into_response();
    };
    let Some(to_path) = safe_path(&state.app_root, &state.repo_dir, &raw_to) else {
        return ApiError::bad_request("Path escapes app root").into_response();
    };
    let from_label = raw_from.clone();
    let to_label = raw_to.clone();
    if let Err(error) = run_commit_owned(&state, move || async move {
        if tokio::fs::metadata(&from_path).await.is_err() {
            return Err(ApiError::bad_request(format!(
                "Path not found: {from_label}"
            )));
        }
        match tokio::fs::metadata(&to_path).await {
            Ok(_) => {
                return Err(ApiError::bad_request(format!(
                    "Path already exists: {to_label}"
                )))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(ApiError::internal(error.to_string())),
        }
        if let Some(parent) = to_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
        }
        tokio::fs::rename(&from_path, &to_path)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))
    })
    .await
    {
        return error.into_response();
    }
    state
        .broadcaster
        .emit("file-changed", json!({ "path": raw_to }));
    Json(json!({ "ok": true })).into_response()
}

// --- edit --------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct EditBody {
    path: Option<String>,
    old_string: Option<String>,
    new_string: Option<String>,
    replace_all: Option<bool>,
}

pub async fn edit(State(state): State<AppState>, body: Bytes) -> Response {
    let body: EditBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let user_path = body.path.clone().unwrap_or_default();
    let Some(file_path) = safe_path(&state.app_root, &state.repo_dir, &user_path) else {
        return ApiError::bad_request("Path escapes app root").into_response();
    };
    let old_string = match body.old_string.as_deref() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return ApiError::bad_request("old_string is required").into_response(),
    };
    let Some(new_string) = body.new_string else {
        return ApiError::bad_request("new_string is required").into_response();
    };
    if old_string == new_string {
        return ApiError::bad_request("old_string and new_string must differ").into_response();
    }
    let content = match tokio::fs::read_to_string(&file_path).await {
        Ok(c) => c,
        Err(_) => {
            return ApiError::bad_request(format!("File not found: {user_path}")).into_response()
        }
    };
    let replace_all = body.replace_all.unwrap_or(false);
    let count = content.matches(old_string.as_str()).count();
    if count == 0 {
        return ApiError::bad_request("old_string not found in file").into_response();
    }
    if !replace_all && count > 1 {
        return ApiError::bad_request(format!(
            "old_string found {count} times. Use replace_all or provide more context to make it unique."
        ))
        .into_response();
    }
    let updated = if replace_all {
        content.replace(old_string.as_str(), &new_string)
    } else {
        content.replacen(old_string.as_str(), &new_string, 1)
    };
    let (stage_dir, staged) = match stage_bytes(&state.app_root, updated.as_bytes()).await {
        Ok(staged) => staged,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = commit_staged_file_owned(&state, staged, file_path).await {
        remove_staged_path(&stage_dir).await;
        return error.into_response();
    }
    remove_staged_path(&stage_dir).await;
    state
        .broadcaster
        .emit("file-changed", json!({ "path": user_path }));
    Json(json!({
        "ok": true,
        "replacements": if replace_all { count } else { 1 },
        "content": updated,
    }))
    .into_response()
}

// --- grep --------------------------------------------------------------------

async fn drive_owned_rg(
    child: &mut ProcessGroupChild,
    controller: ProcessController,
) -> std::io::Result<std::process::Output> {
    let mut stdout = child
        .take_stdout()
        .ok_or_else(|| std::io::Error::other("spawn error: missing grep stdout pipe"))?;
    let mut stderr = child
        .take_stderr()
        .ok_or_else(|| std::io::Error::other("spawn error: missing grep stderr pipe"))?;
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut exit_status = None;
    let mut exited = false;
    let mut observed_signal = None;
    let mut stdout_chunk = [0u8; 8192];
    let mut stderr_chunk = [0u8; 8192];

    loop {
        if exited && !stdout_open && !stderr_open {
            break;
        }
        tokio::select! {
            read = stdout.read(&mut stdout_chunk), if stdout_open => {
                match read {
                    Ok(0) | Err(_) => stdout_open = false,
                    Ok(n) => stdout_bytes.extend_from_slice(&stdout_chunk[..n]),
                }
            }
            read = stderr.read(&mut stderr_chunk), if stderr_open => {
                match read {
                    Ok(0) | Err(_) => stderr_open = false,
                    Ok(n) => stderr_bytes.extend_from_slice(&stderr_chunk[..n]),
                }
            }
            status = child.wait(), if !exited && !stdout_open && !stderr_open => {
                exited = true;
                exit_status = Some(status?);
            }
            signal = controller.wait_for_change(observed_signal), if !exited => {
                observed_signal = Some(signal);
                child.signal(signal).await;
            }
        }
    }

    Ok(std::process::Output {
        status: exit_status.ok_or_else(|| std::io::Error::other("grep exited without status"))?,
        stdout: stdout_bytes,
        stderr: stderr_bytes,
    })
}

async fn run_owned_rg(state: &AppState, args: &[String]) -> Result<std::process::Output, ApiError> {
    let Some(admission) = state.shutdown.admit_work().await else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "application is shutting down",
        ));
    };

    let mut command = Command::new("rg");
    command
        .args(args)
        .current_dir(&state.repo_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child =
        ProcessGroupChild::spawn(&mut command, state.tasks.child_lifetime_lock_path())
            .await
            .map_err(|error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!(
                        "grep unavailable: {error}. Install ripgrep (\"brew install ripgrep\") or use bash + grep."
                    ),
                )
            })?;
    // Grep was never a task-list surface; keep it fully invisible, including
    // not advancing the public background-task id counter.
    let id = format!("internal-grep-{}", uuid::Uuid::new_v4());
    let controller = ProcessController::new();
    let kill_handle = controller.kill_handle();
    state.tasks.insert(TaskEntry::new_internal(
        TaskSummary {
            id: id.clone(),
            command: format!("rg {}", args.join(" ")),
            status: TaskStatus::Running,
            exit_code: None,
            started_at: now_ms(),
            finished_at: None,
            timed_out: false,
            truncated: false,
            log_name: None,
            intentional: None,
        },
        Some(kill_handle.clone()),
    ));

    let tasks = state.tasks.clone();
    let owner_id = id.clone();
    let (result_tx, result_rx) = oneshot::channel();
    tokio::spawn(async move {
        let driven = std::panic::AssertUnwindSafe(drive_owned_rg(&mut child, controller))
            .catch_unwind()
            .await;
        let output = match driven {
            Ok(output) => output,
            Err(_) => Err(std::io::Error::other("grep process owner panicked")),
        };
        if output.is_err() {
            child
                .kill_and_reap(Duration::from_secs(2), "grep process-owner error cleanup")
                .await;
        }
        let (status, exit_code) = match &output {
            Ok(output) => {
                let exit_code = exit_status_to_code(output.status);
                let status = if exit_code > 128 {
                    TaskStatus::Killed
                } else {
                    TaskStatus::Exited
                };
                (status, exit_code)
            }
            Err(_) => (TaskStatus::Failed, -1),
        };
        tasks.finalize(&owner_id, status, exit_code, false);
        let _ = tasks.remove(&owner_id).await;
        let _ = result_tx.send(output);
    });
    drop(admission);

    // `rg` has no graceful-shutdown protocol. Use KILL on request
    // cancellation so an aborted HTTP future cannot leave an internal
    // search alive; app shutdown still uses the registry's bounded
    // TERM -> KILL policy.
    let mut cancel_on_drop = CancelOnDrop::new(kill_handle, KillSignal::Kill);
    let output = result_rx
        .await
        .map_err(|_| ApiError::internal("grep process owner stopped unexpectedly"))?
        .map_err(|error| ApiError::internal(format!("rg failed: {error}")))?;
    cancel_on_drop.disarm();
    Ok(output)
}

#[derive(Deserialize, Default)]
struct GrepBody {
    pattern: Option<String>,
    path: Option<String>,
    output_mode: Option<String>,
    ignore_case: Option<bool>,
    context: Option<i64>,
    glob: Option<String>,
    limit: Option<i64>,
}

pub async fn grep(State(state): State<AppState>, body: Bytes) -> Response {
    let body: GrepBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let Some(pattern) = body.pattern.filter(|p| !p.is_empty()) else {
        return ApiError::bad_request("pattern is required").into_response();
    };
    let search_path: PathBuf = match &body.path {
        Some(p) => match safe_path(&state.app_root, &state.repo_dir, p) {
            Some(sp) => sp,
            None => return ApiError::bad_request("Path escapes app root").into_response(),
        },
        None => state.repo_dir.clone(),
    };

    let mode = body.output_mode.as_deref().unwrap_or("files");
    let mut args: Vec<String> = Vec::new();
    match mode {
        "files" => args.push("--files-with-matches".to_string()),
        "count" => args.push("--count".to_string()),
        _ => args.push("--line-number".to_string()),
    }
    if body.ignore_case.unwrap_or(false) {
        args.push("-i".to_string());
    }
    if let Some(ctx) = body.context {
        if mode == "content" {
            args.push("-C".to_string());
            args.push(ctx.to_string());
        }
    }
    if let Some(g) = &body.glob {
        args.push("--glob".to_string());
        args.push(g.clone());
    }
    args.push("--".to_string());
    args.push(pattern);
    args.push(search_path.to_string_lossy().to_string());

    let limit = body.limit.unwrap_or(250).max(0) as usize;
    let output = match run_owned_rg(&state, &args).await {
        Ok(output) => output,
        Err(error) => return error.into_response(),
    };
    if let Some(code) = output.status.code() {
        if code > 1 {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let msg = if stderr.is_empty() {
                format!("rg failed with code {code}")
            } else {
                stderr
            };
            return ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, msg).into_response();
        }
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines_out: Vec<&str> = Vec::new();
    for line in stdout.split('\n') {
        if lines_out.len() >= limit {
            break;
        }
        if !line.is_empty() {
            lines_out.push(line);
        }
    }
    let results = lines_out.join("\n");
    Json(json!({ "results": results, "matchCount": lines_out.len() })).into_response()
}

// --- glob --------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct GlobBody {
    pattern: Option<String>,
    path: Option<String>,
    limit: Option<f64>,
    #[serde(rename = "maxDepth")]
    max_depth: Option<f64>,
}

pub async fn glob(State(state): State<AppState>, body: Bytes) -> Response {
    let body: GlobBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let Some(pattern) = body.pattern.filter(|p| !p.is_empty()) else {
        return ApiError::bad_request("pattern is required").into_response();
    };
    let search_path: PathBuf = match &body.path {
        Some(p) => match safe_path(&state.app_root, &state.repo_dir, p) {
            Some(sp) => sp,
            None => return ApiError::bad_request("Path escapes app root").into_response(),
        },
        None => state.repo_dir.clone(),
    };
    let result_limit = resolve_glob_result_limit(body.limit);
    let max_depth = body.max_depth.map(|d| (d.max(1.0).floor()) as usize);

    let (file_paths, directory_paths, truncated) = if let Some(md) = max_depth {
        if pattern == "**/*" {
            let mut scan_state = GlobScanState {
                file_paths: Vec::new(),
                directory_paths: HashSet::new(),
                result_limit,
            };
            let prefix = repo_relative_prefix(&search_path, &state.repo_dir);
            let truncated = walk_repo_within_max_depth(&search_path, &prefix, md, &mut scan_state);
            (scan_state.file_paths, scan_state.directory_paths, truncated)
        } else {
            match scan_glob(
                &search_path,
                &state.repo_dir,
                &pattern,
                Some(md),
                result_limit,
            ) {
                Ok(m) => (m.file_paths, m.directory_paths, m.truncated),
                Err(e) => return ApiError::internal(e.to_string()).into_response(),
            }
        }
    } else {
        match scan_glob(&search_path, &state.repo_dir, &pattern, None, result_limit) {
            Ok(m) => (m.file_paths, m.directory_paths, m.truncated),
            Err(e) => return ApiError::internal(e.to_string()).into_response(),
        }
    };

    let dirs_vec: Vec<String> = directory_paths.into_iter().collect();
    let empty_dirs = collect_empty_directories(&file_paths, &dirs_vec);
    let mut out = json!({ "files": file_paths, "directories": empty_dirs });
    if truncated {
        out["truncated"] = json!(true);
    }
    Json(out).into_response()
}

// --- write_from_url / upload_to_url ------------------------------------------

#[derive(Deserialize, Default)]
struct WriteFromUrlBody {
    path: Option<String>,
    url: Option<String>,
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(TRANSFER_DEADLINE)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

pub async fn write_from_url(State(state): State<AppState>, body: Bytes) -> Response {
    let body: WriteFromUrlBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let Some(url) = body.url.filter(|u| !u.is_empty()) else {
        return ApiError::bad_request("url is required").into_response();
    };
    let user_path = body.path.clone().unwrap_or_default();
    let Some(file_path) = safe_path(&state.app_root, &state.repo_dir, &user_path) else {
        return ApiError::bad_request("Path escapes app root").into_response();
    };

    let mutations = state.shutdown.mutations();
    let result = mutations
        .run_owned(move |cancellation| async move {
            write_from_url_owned(state, user_path, file_path, url, cancellation).await
        })
        .await;
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => error.into_response(),
        Err(error) => map_owner_error(error).into_response(),
    }
}

async fn write_from_url_owned(
    state: AppState,
    user_path: String,
    file_path: PathBuf,
    url: String,
    mut cancellation: MutationCancellation,
) -> Result<Value, ApiError> {
    let stage_dir = new_stage_dir(&state.app_root).await?;
    let staged = stage_dir.join("download");
    let prepared = async {
        let client = http_client();
        let request = tokio::time::timeout(TRANSFER_DEADLINE, client.get(&url).send());
        let resp = tokio::select! {
            _ = cancellation.cancelled() => return Err(shutting_down()),
            result = request => match result {
                Ok(Ok(response)) => response,
                Ok(Err(error)) => return Err(ApiError::bad_gateway(format!("fetch failed: {error}"))),
                Err(_) => return Err(ApiError::bad_gateway(format!(
                    "fetch deadline exceeded ({}ms)",
                    TRANSFER_DEADLINE.as_millis()
                ))),
            }
        };
        if !resp.status().is_success() {
            return Err(ApiError::bad_gateway(format!(
                "upstream returned HTTP {}",
                resp.status()
            )));
        }
        if let Some(len) = resp.content_length() {
            if len > MAX_TRANSFER_BYTES {
                return Err(ApiError::payload_too_large(format!(
                    "Payload too large ({len} > {MAX_TRANSFER_BYTES})"
                )));
            }
        }

        let mut out_file = tokio::fs::File::create(&staged)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let mut written: u64 = 0;
        let mut stream = resp.bytes_stream();
        loop {
            let next = tokio::select! {
                _ = cancellation.cancelled() => return Err(shutting_down()),
                result = tokio::time::timeout(TRANSFER_DEADLINE, stream.next()) => result,
            };
            let chunk = match next {
                Ok(Some(Ok(chunk))) => chunk,
                Ok(Some(Err(error))) => {
                    return Err(ApiError::bad_gateway(format!("stream failed: {error}")))
                }
                Ok(None) => break,
                Err(_) => {
                    return Err(ApiError::bad_gateway(format!(
                        "fetch deadline exceeded ({}ms)",
                        TRANSFER_DEADLINE.as_millis()
                    )))
                }
            };
            written += chunk.len() as u64;
            if written > MAX_TRANSFER_BYTES {
                return Err(ApiError::bad_gateway(format!(
                    "Stream exceeded {MAX_TRANSFER_BYTES} bytes"
                )));
            }
            out_file
                .write_all(&chunk)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
        }
        out_file
            .flush()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        drop(out_file);
        Ok(written)
    }
    .await;

    let written = match prepared {
        Ok(written) => written,
        Err(error) => {
            remove_staged_path(&stage_dir).await;
            return Err(error);
        }
    };
    if let Err(error) = commit_staged_file_owned(&state, staged, file_path).await {
        remove_staged_path(&stage_dir).await;
        return Err(error);
    }
    remove_staged_path(&stage_dir).await;
    Ok(json!({ "ok": true, "path": user_path, "size": written }))
}

#[derive(Deserialize, Default)]
struct UploadToUrlBody {
    path: Option<String>,
    url: Option<String>,
    #[serde(rename = "contentType")]
    content_type: Option<String>,
}

pub async fn upload_to_url(State(state): State<AppState>, body: Bytes) -> Response {
    let body: UploadToUrlBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let Some(url) = body.url.filter(|u| !u.is_empty()) else {
        return ApiError::bad_request("url is required").into_response();
    };
    let user_path = body.path.clone().unwrap_or_default();
    let Some(file_path) = resolve_read_path(&state.app_root, &state.repo_dir, &user_path) else {
        return ApiError::bad_request("Path escapes project root").into_response();
    };
    let meta = match tokio::fs::metadata(&file_path).await {
        Ok(m) => m,
        Err(_) => {
            return ApiError::bad_request(format!("File not found: {user_path}")).into_response()
        }
    };
    if meta.is_dir() {
        return ApiError::bad_request("Path is a directory").into_response();
    }
    if meta.len() > MAX_TRANSFER_BYTES {
        return ApiError::payload_too_large(format!(
            "File too large ({} > {MAX_TRANSFER_BYTES})",
            meta.len()
        ))
        .into_response();
    }

    let data = match tokio::fs::read(&file_path).await {
        Ok(d) => d,
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let client = http_client();
    let mut req = client
        .put(&url)
        .header("Content-Length", data.len().to_string())
        .body(data.clone());
    if let Some(ct) = &body.content_type {
        req = req.header("Content-Type", ct.clone());
    }
    let resp = match tokio::time::timeout(TRANSFER_DEADLINE, req.send()).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return ApiError::bad_gateway(format!("upload failed: {e}")).into_response(),
        Err(_) => {
            return ApiError::bad_gateway(format!(
                "upload deadline exceeded ({}ms)",
                TRANSFER_DEADLINE.as_millis()
            ))
            .into_response()
        }
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(500).collect();
        return ApiError::bad_gateway(format!("upstream returned HTTP {status}: {snippet}"))
            .into_response();
    }
    Json(json!({ "ok": true, "size": data.len() })).into_response()
}

// --- tools/sync ----------------------------------------------------------------

#[derive(Deserialize, Default)]
struct ToolsSyncBody {
    url: Option<String>,
    headers: Option<Value>,
    #[serde(rename = "expiresAt")]
    expires_at: Option<f64>,
}

fn endpoint_content(endpoint: &tools_catalog::McpEndpoint) -> Result<String, ApiError> {
    let mut body = serde_json::Map::new();
    body.insert("url".to_string(), Value::String(endpoint.url.clone()));
    body.insert("headers".to_string(), endpoint.headers.clone());
    if let Some(expires_at) = endpoint.expires_at {
        if expires_at != 0.0 {
            body.insert(
                "expiresAt".to_string(),
                serde_json::Number::from_f64(expires_at)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
            );
        }
    }
    serde_json::to_string_pretty(&Value::Object(body))
        .map(|content| format!("{content}\n"))
        .map_err(|error| ApiError::internal(error.to_string()))
}

/// Atomically commits the credential-bearing endpoint descriptor, private
/// from creation — the temp/fsync/rename/cleanup mechanics live in
/// [`crate::fs_util::atomic_replace`]. The parent is created HERE with
/// default directory permissions: the catalog dir lives inside the user's
/// working tree and must stay readable by their own tooling.
async fn write_private_endpoint(path: &Path, content: &str) -> Result<(), ApiError> {
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::internal("tools endpoint path has no parent"))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let path = path.to_path_buf();
    let content = content.as_bytes().to_vec();
    tokio::task::spawn_blocking(move || crate::fs_util::atomic_replace(&path, &content))
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(|error| ApiError::internal(error.to_string()))
}

/// Publishes the endpoint descriptor before attempting MCP discovery. This is
/// an independent, short commit: `typegen call` needs only this credential and
/// must keep working when `tools/list` is temporarily unavailable. The later
/// whole-directory catalog swap includes the same endpoint again on success.
async fn commit_endpoint_file(state: &AppState, content: String) -> Result<(), ApiError> {
    let Some(catalog_dir) = safe_path(&state.app_root, &state.repo_dir, tools_catalog::CATALOG_DIR)
    else {
        return Err(ApiError::internal("tools catalog path escapes app root"));
    };
    let endpoint = catalog_dir.join(tools_catalog::ENDPOINT_FILENAME);
    let repo_dir = state.repo_dir.clone();
    let mutation_root = state.app_root.join(".decocms").join("mutations");
    run_commit_owned(state, move || async move {
        let commit_lock = TOOLS_CATALOG_COMMIT_LOCK.get_or_init(|| Mutex::new(()));
        let _serialized = commit_lock.lock().await;
        tokio::fs::create_dir_all(&catalog_dir)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        git_exclude::ensure_git_exclude(&repo_dir, &format!("/{}/", tools_catalog::CATALOG_DIR))
            .await;
        // Finish any prior catalog directory transaction before mutating a
        // file inside its target. Unrelated long mutation stages are retained.
        let endpoint_stage_sentinel = mutation_root.join(".endpoint-update");
        tools_transaction::recover_catalog_transactions(
            &mutation_root,
            &catalog_dir,
            &endpoint_stage_sentinel,
        )
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
        write_private_endpoint(&endpoint, &content).await
    })
    .await
}

async fn prepare_catalog_dir(
    path: &Path,
    endpoint_content: &str,
    tools: &[tools_catalog::CatalogTool],
    cancellation: &MutationCancellation,
) -> Result<Vec<String>, ApiError> {
    tokio::fs::create_dir_all(path)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    write_private_endpoint(
        &path.join(tools_catalog::ENDPOINT_FILENAME),
        endpoint_content,
    )
    .await?;

    let files = tools_catalog::tool_catalog_files(tools);
    for file in files {
        if cancellation.is_cancelled() {
            return Err(shutting_down());
        }
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut output = options
            .open(path.join(file.filename))
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        output
            .write_all(file.content.as_bytes())
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        output
            .sync_all()
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
    }
    Ok(tools.iter().map(|tool| tool.name.clone()).collect())
}

async fn commit_catalog_dir(
    state: &AppState,
    stage_dir: &Path,
    staged_catalog: &Path,
) -> Result<(), ApiError> {
    let Some(target) = safe_path(&state.app_root, &state.repo_dir, tools_catalog::CATALOG_DIR)
    else {
        remove_staged_path(stage_dir).await;
        return Err(ApiError::internal("tools catalog path escapes app root"));
    };
    let stage_dir = stage_dir.to_path_buf();
    let staged_catalog = staged_catalog.to_path_buf();
    let repo_dir = state.repo_dir.clone();
    let mutation_root = state.app_root.join(".decocms").join("mutations");
    run_commit_owned(state, move || async move {
        let commit_lock = TOOLS_CATALOG_COMMIT_LOCK.get_or_init(|| Mutex::new(()));
        let _serialized = commit_lock.lock().await;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| ApiError::internal(error.to_string()))?;
        }
        git_exclude::ensure_git_exclude(&repo_dir, &format!("/{}/", tools_catalog::CATALOG_DIR))
            .await;
        tools_transaction::recover_catalog_transactions(&mutation_root, &target, &stage_dir)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))?;
        tools_transaction::install(&stage_dir, &staged_catalog, &target)
            .await
            .map_err(|error| ApiError::internal(error.to_string()))
    })
    .await
}

/// Success-envelope parity target: `daemon/routes/tools.ts`
/// (`makeToolsSyncHandler`). The endpoint descriptor commits before discovery,
/// so it remains callable even if `tools/list` fails; a successful listing then
/// replaces endpoint + catalog together as one recoverable directory swap.
/// The catalog lives under `<repo>/.deco/tools/` — distinct from local-api's
/// own `<workdir>/.decocms/` (see the threads store doc).
pub async fn tools_sync(State(state): State<AppState>, body: Bytes) -> Response {
    let body: ToolsSyncBody = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return e.into_response(),
    };
    let Some(url) = body
        .url
        .filter(|u| !u.is_empty() && reqwest::Url::parse(u).is_ok())
    else {
        return ApiError::bad_request(
            "body must be { url: string (valid URL), headers: Record<string,string> }",
        )
        .into_response();
    };
    let headers = match body.headers {
        Some(v @ Value::Object(_)) => v,
        _ => {
            return ApiError::bad_request(
                "body must be { url: string (valid URL), headers: Record<string,string> }",
            )
            .into_response()
        }
    };

    let endpoint = tools_catalog::McpEndpoint {
        url: url.clone(),
        headers: headers.clone(),
        expires_at: body.expires_at,
    };
    let mutations = state.shutdown.mutations();
    let result = mutations
        .run_owned(move |mut cancellation| async move {
            let endpoint_content = endpoint_content(&endpoint)?;
            commit_endpoint_file(&state, endpoint_content.clone()).await?;
            let fetch = mcp_client::fetch_tool_catalog(&url, &headers);
            let tools = tokio::select! {
                _ = cancellation.cancelled() => {
                    return Err(shutting_down());
                }
                result = fetch => match result {
                    Ok(tools) => tools,
                    Err(error) => {
                        return Err(ApiError::bad_gateway(error.to_string()));
                    }
                }
            };

            let stage_dir = new_stage_dir(&state.app_root).await?;
            let staged_catalog = stage_dir.join("catalog");
            let tool_names = match prepare_catalog_dir(
                &staged_catalog,
                &endpoint_content,
                &tools,
                &cancellation,
            )
            .await
            {
                Ok(tool_names) => tool_names,
                Err(error) => {
                    remove_staged_path(&stage_dir).await;
                    return Err(error);
                }
            };
            commit_catalog_dir(&state, &stage_dir, &staged_catalog).await?;
            Ok(json!({ "count": tool_names.len(), "tools": tool_names }))
        })
        .await;
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => error.into_response(),
        Err(error) => map_owner_error(error).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh worktree has `.deco/blocks/*.json` but not the merged
    /// `blocks.gen.json` (repos gitignore it), and without this rebuild the
    /// sections editor reports "File not found" against a repo that plainly
    /// has its blocks.
    #[tokio::test]
    async fn decofile_merge_decodes_stems_sorts_and_skips_empty_files() {
        let root = tempfile::tempdir().expect("tempdir");
        let blocks = root.path().join("blocks");
        std::fs::create_dir_all(&blocks).expect("mkdir");
        // The stem is the percent-encoded block id.
        std::fs::write(blocks.join("Card%20config.json"), "{\"a\":1}").unwrap();
        std::fs::write(blocks.join("Alpha.json"), "  {\"b\":2}  ").unwrap();
        // Empty would emit `"key":` with no value and break the merge.
        std::fs::write(blocks.join("Empty.json"), "   ").unwrap();
        // Not JSON, not merged.
        std::fs::write(blocks.join("notes.txt"), "ignored").unwrap();

        let merged = generate_decofile_from_blocks(&blocks)
            .await
            .expect("blocks dir merges");
        assert_eq!(merged, r#"{"Alpha":{"b":2},"Card config":{"a":1}}"#);
        // Valid JSON, and the space in the key really was decoded.
        let parsed: serde_json::Value = serde_json::from_str(&merged).expect("valid json");
        assert!(parsed.get("Card config").is_some(), "{merged}");
    }

    /// No blocks directory (or nothing mergeable) must fall through to the
    /// caller's normal not-found path rather than inventing an empty decofile.
    #[tokio::test]
    async fn decofile_merge_is_none_when_there_is_nothing_to_merge() {
        let root = tempfile::tempdir().expect("tempdir");
        assert!(generate_decofile_from_blocks(&root.path().join("absent"))
            .await
            .is_none());
        let empty = root.path().join("blocks");
        std::fs::create_dir_all(&empty).expect("mkdir");
        assert!(generate_decofile_from_blocks(&empty).await.is_none());
    }

    #[test]
    fn base64_encode_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn sniff_image_media_type_detects_known_formats() {
        assert_eq!(
            sniff_image_media_type(&[0xff, 0xd8, 0xff, 0xe0]),
            Some("image/jpeg")
        );
        assert_eq!(
            sniff_image_media_type(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Some("image/png")
        );
        assert_eq!(sniff_image_media_type(b"GIF89a"), Some("image/gif"));
        assert_eq!(sniff_image_media_type(b"not-an-image"), None);
    }

    #[test]
    fn assert_unlink_allowed_rejects_escaping_and_git() {
        assert!(assert_unlink_allowed("../x", false).is_some());
        assert!(assert_unlink_allowed("", false).is_some());
        assert!(assert_unlink_allowed(".", true).is_some());
        assert!(assert_unlink_allowed(".git/HEAD", false).is_some());
        assert!(assert_unlink_allowed("a/.git", true).is_some());
        assert!(assert_unlink_allowed("a/b.txt", false).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn owned_grep_driver_reaps_on_request_cancellation_signal() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let lock_dir = tempfile::tempdir().expect("lifetime lock tempdir");
        let mut child =
            ProcessGroupChild::spawn(&mut command, &lock_dir.path().join("child-lifetime.lock"))
                .await
                .expect("spawn grep-owner fixture");
        let pid = child.id().expect("fixture pid");
        let controller = ProcessController::new();
        let owner_controller = controller.clone();
        let owner = tokio::spawn(async move { drive_owned_rg(&mut child, owner_controller).await });

        assert!((controller.kill_handle())(KillSignal::Kill));
        let output = tokio::time::timeout(Duration::from_secs(5), owner)
            .await
            .expect("owned grep process exited")
            .expect("owner task did not panic")
            .expect("owner returned exit status");
        assert_eq!(exit_status_to_code(output.status), 137);
        let alive = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        assert!(!alive, "cancelled grep process survived its owner");
    }
}
