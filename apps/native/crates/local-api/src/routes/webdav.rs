//! A minimal WebDAV/1 server over the org filesystem, targeting exactly one
//! client: rclone's `webdav` backend (`--webdav-vendor other`, no locking).
//! P1 of `apps/native/docs/org-fs-plan.md`: the mount manager (P2) points a
//! supervised `rclone` child at this loopback surface and re-serves it as NFS
//! so macOS can mount `org/home`, `org/public/<set>`, `org/uploads` and
//! `org/outputs` kext-free.
//!
//! Port of `packages/sandbox/orgfs/webdav.ts`. The PROPFIND XML
//! shape, the status codes and the `Depth` handling are what rclone actually
//! depends on, so they are reproduced verbatim; see `dav.rs` for the pure
//! translation half (and the one deliberate divergence: hrefs carry this
//! router's mount prefix, because the daemon served one volume per origin
//! root and this serves every volume under
//! `/_sandbox/orgfs/:account_id/:org/:volume`).
//!
//! Mounted as a nested catchall rather than a set of `:param` routes: the
//! request pathname after `<account-id>/<org>/<volume>` IS the in-volume path, so the
//! router must not have an opinion about how many segments it has, whether
//! it ends in a slash, or which extension method addresses it (`PROPFIND`,
//! `MKCOL` and `MOVE` are not `Method` constants axum can route on).
//!
//! ## Authentication
//!
//! Nothing is minted here. In embedded mode, `router.rs` accepts rclone's
//! mount-scoped token only for this `/_sandbox/orgfs/*` surface; standalone
//! mode keeps its ordinary local bearer. The upstream leg attaches the
//! signed-in user's Keychain-backed access token server-side via
//! [`crate::routes::upstream::send_org_request`]. The
//! daemon's `ORGFS_CONFIG` fs-scoped API key — provisioned because a cluster
//! pod had no identity of its own — has no counterpart here and is
//! deliberately gone.
//!
//! Two consequences the P2 mount manager owns, noted here so they are not
//! rediscovered from a failing mount:
//!
//! - The shipped Tauri app boots local-api in EMBEDDED mode
//!   (`src-tauri/src/setup.rs` -> `local_api::start_embedded`). rclone uses a
//!   dedicated mount token plus the exact `Host` and `Origin`; that token is
//!   accepted only on `/_sandbox/orgfs/*`, never as a whole-API credential.
//! - `router.rs`'s `intercept_options` layer answers EVERY `OPTIONS` with
//!   `204` before routing, so this module's `OPTIONS` branch (`DAV: 1`) is
//!   currently unreachable through the main listener. rclone's `webdav`
//!   backend with `vendor = other` does not probe with `OPTIONS`, so this
//!   costs nothing today; a client that does would need that layer to
//!   exempt this prefix.
//!
//! ## Blocking
//!
//! Every path is async end to end: upstream reads stream through
//! `Body::from_stream` rather than buffering, and the only `to_bytes` call is
//! the bounded PUT body. The TS daemon documented a real deadlock here
//! (kernel -> rclone -> WebDAV -> blocked event loop); a handler that blocks
//! the executor while the kernel waits on the mount reproduces it.

mod dav;
mod junk;
mod org_fs;

use axum::body::{Body, Bytes};
use axum::extract::{OriginalUri, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;

use self::dav::{OrgFsNode, RequestTarget, TargetError};
use self::org_fs::{OrgFs, OrgFsError, SharedOrgRequestTicket, UpstreamOrgFs};
use crate::routes::upstream::OrgRequestTicket;
use crate::sandbox::org_mount::MOUNT_ACCOUNT_HEADER;
use crate::state::AppState;

type Request = axum::extract::Request;

/// Ceiling on a single PUT body. Matches the org-fs contract's own per-file
/// limit (`MAX_UPLOAD_BYTES` in `apps/api/src/api/routes/org-fs.ts`), so a
/// body this layer accepts is one upstream can also accept.
const MAX_PUT_BYTES: usize = 500 * 1024 * 1024;

/// The nested sub-router `router.rs` mounts at `/_sandbox/orgfs`. One
/// wildcard route (plus the bare prefix, which `/*path` does not match) and
/// a catchall fallback, all pointing at the same handler — see this module's
/// doc comment for why the router must not decompose the path itself.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", any(handle))
        .route("/*path", any(handle))
        .fallback(any(handle))
}

async fn handle(
    State(state): State<AppState>,
    OriginalUri(original): OriginalUri,
    req: Request,
) -> Response {
    let target = match dav::parse_target(original.path(), req.uri().path()) {
        Ok(target) => target,
        Err(TargetError::NotAVolume) => {
            return text(StatusCode::NOT_FOUND, "Not Found");
        }
        Err(TargetError::Traversal | TargetError::InvalidMount) => {
            return text(StatusCode::BAD_REQUEST, "Bad Request");
        }
    };
    let identity = match WebDavIdentity::capture(&state).await {
        Ok(identity) => identity,
        Err(response) => return response,
    };
    if target.account_id != identity.account_id
        || !mount_account_header_matches(req.headers(), &identity.account_id)
    {
        return stale_identity_response();
    }

    let fs = UpstreamOrgFs::new(&target.org, &target.volume, identity.ticket.clone());
    let response = serve_inner(&fs, &target, req, Some(&identity)).await;
    identity.fence_response(response).await
}

struct WebDavIdentity {
    account_id: String,
    ticket: SharedOrgRequestTicket,
}

impl WebDavIdentity {
    async fn capture(state: &AppState) -> Result<Self, Response> {
        let ticket = OrgRequestTicket::capture(state)
            .await
            .map_err(IntoResponse::into_response)?;
        let account_id = ticket.account_id().to_string();
        Ok(Self {
            account_id,
            ticket: std::sync::Arc::new(tokio::sync::Mutex::new(Some(ticket))),
        })
    }

    async fn read_body(&self, body: Body, limit: usize) -> Result<Bytes, Response> {
        let mut guard = self.ticket.lock().await;
        let Some(ticket) = guard.as_mut() else {
            return Err(stale_identity_response());
        };
        if ticket.validate().is_err() {
            return Err(stale_identity_response());
        }
        let result = tokio::select! {
            biased;
            _ = ticket.validation_changed() => return Err(stale_identity_response()),
            result = axum::body::to_bytes(body, limit) => result,
        };
        if ticket.validate_identity().is_err() {
            return Err(stale_identity_response());
        }
        result.map_err(|_| text(StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large"))
    }

    async fn with_account_commit<T>(&self, commit: impl FnOnce(&str) -> T) -> Result<T, Response> {
        let mut guard = self.ticket.lock().await;
        let Some(ticket) = guard.as_mut() else {
            return Err(stale_identity_response());
        };
        ticket
            .with_account_commit(|| commit(&self.account_id))
            .map_err(|_| stale_identity_response())
    }

    async fn fence_response(&self, response: Response) -> Response {
        let ticket = self.ticket.lock().await.take();
        match ticket {
            Some(ticket) => ticket.fence_response(response),
            None => stale_identity_response(),
        }
    }
}

fn mount_account_header_matches(headers: &HeaderMap, account_id: &str) -> bool {
    let mut values = headers.get_all(MOUNT_ACCOUNT_HEADER).iter();
    let matches = values
        .next()
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == account_id);
    matches && values.next().is_none()
}

fn stale_identity_response() -> Response {
    text(
        StatusCode::CONFLICT,
        "Studio account changed while the filesystem request was running",
    )
}

/// The protocol core, over any [`OrgFs`] — see this module's tests.
async fn serve_inner(
    fs: &dyn OrgFs,
    target: &RequestTarget,
    req: Request,
    identity: Option<&WebDavIdentity>,
) -> Response {
    let (parts, body) = req.into_parts();
    let method = parts.method;
    let headers = parts.headers;
    let path = target.path.as_str();

    let is_write = matches!(
        method,
        Method::PUT | Method::DELETE | Method::POST | Method::PATCH
    ) || matches!(method.as_str(), "MKCOL" | "MOVE" | "COPY");

    // Read-only volumes are rejected HERE rather than trusting rclone's
    // `--read-only` mount flag, and BEFORE the mac-junk shortcut below: a
    // volume this app must never write to should not have a verb that writes
    // succeed, not even vacuously. The predicate is shared with the mount
    // manager (see `sandbox::org_view`) so the two layers agree on which
    // volumes those are.
    if is_write && crate::sandbox::org_view::is_read_only_volume(&target.volume) {
        return text(StatusCode::FORBIDDEN, "Read-only volume");
    }

    // mac junk never reaches the backing fs — but it must still behave like a
    // real file, because rclone re-reads an object right after uploading it to
    // confirm the write. Answering the write `201` and the confirming read
    // `404` puts rclone in an unbounded retry loop ("failed to upload try #1
    // … try #4, will retry in 16s", never converging). So writes are recorded
    // in the in-memory shadow store and reads are served from it; nothing
    // reaches ORG_FS, and directory listings still omit them. See `junk`.
    //
    // A MOVE whose *source* is junk just forgets it; a real file moved TO a
    // junk name falls through (a deliberate rename must not silently lose
    // data).
    if dav::is_mac_junk(path) {
        let (account_id, org, volume) = (
            target.account_id.as_str(),
            target.org.as_str(),
            target.volume.as_str(),
        );
        match method.as_str() {
            "PUT" => {
                let bytes = match read_request_body(identity, body, junk::MAX_TOTAL_BYTES).await {
                    Ok(bytes) => bytes,
                    Err(response) => return response,
                };
                let stored = match account_commit(identity, || {
                    junk::put(account_id, org, volume, path, bytes, false)
                })
                .await
                {
                    Ok(stored) => stored,
                    Err(response) => return response,
                };
                if !stored {
                    return text(StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large");
                }
                return empty(StatusCode::CREATED);
            }
            "MKCOL" => {
                if let Err(response) = account_commit(identity, || {
                    let stored = junk::put(account_id, org, volume, path, Bytes::new(), true);
                    debug_assert!(stored, "an empty junk directory must fit in the store");
                })
                .await
                {
                    return response;
                }
                return empty(StatusCode::CREATED);
            }
            "MOVE" => {
                if let Err(response) =
                    account_commit(identity, || junk::remove(account_id, org, volume, path)).await
                {
                    return response;
                }
                return empty(StatusCode::CREATED);
            }
            "DELETE" => {
                if let Err(response) =
                    account_commit(identity, || junk::remove(account_id, org, volume, path)).await
                {
                    return response;
                }
                return empty(StatusCode::NO_CONTENT);
            }
            "GET" | "HEAD" => {
                let snapshot = account_commit(identity, || {
                    junk::stat(account_id, org, volume, path).map(|node| {
                        let body = junk::get(account_id, org, volume, path).unwrap_or_default();
                        (node, body)
                    })
                })
                .await;
                let Some((node, bytes)) = (match snapshot {
                    Ok(snapshot) => snapshot,
                    Err(response) => return response,
                }) else {
                    return text(StatusCode::NOT_FOUND, "Not Found");
                };
                let body = if method == Method::HEAD {
                    Body::empty()
                } else {
                    Body::from(bytes)
                };
                return base_headers(Response::builder(), &dav::http_date(node.updated_at_secs))
                    .header(header::CONTENT_LENGTH, node.size)
                    .body(body)
                    .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR));
            }
            "PROPFIND" => {
                let node =
                    account_commit(identity, || junk::stat(account_id, org, volume, path)).await;
                let Some(node) = (match node {
                    Ok(node) => node,
                    Err(response) => return response,
                }) else {
                    return text(StatusCode::NOT_FOUND, "Not Found");
                };
                return multistatus(&[dav::prop_response(&target.mount_prefix, &node)]);
            }
            // OPTIONS/PROPPATCH/default fall through to normal handling.
            _ => {}
        }
    }

    match method.as_str() {
        "OPTIONS" => options_response(),

        "PROPFIND" => {
            let node = match stat_node(fs, path).await {
                Ok(Some(node)) => node,
                Ok(None) => return text(StatusCode::NOT_FOUND, "Not Found"),
                Err(err) => return error_response(err),
            };
            let depth = headers
                .get("depth")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("1");
            let mut bodies = vec![dav::prop_response(&target.mount_prefix, &node)];
            if depth != "0" && node.is_dir {
                let children = match fs.list_dir(path).await {
                    Ok(children) => children,
                    Err(err) => return error_response(err),
                };
                for child in children {
                    // Hide junk that leaked into the volume before this filter.
                    if dav::is_mac_junk(&child.path) {
                        continue;
                    }
                    bodies.push(dav::prop_response(&target.mount_prefix, &child));
                }
            }
            multistatus(&bodies)
        }

        "GET" | "HEAD" => {
            let node = match stat_node(fs, path).await {
                Ok(Some(node)) => node,
                Ok(None) => return text(StatusCode::NOT_FOUND, "Not Found"),
                Err(err) => return error_response(err),
            };
            if node.is_dir {
                return text(StatusCode::METHOD_NOT_ALLOWED, "Is a directory");
            }
            let last_modified = dav::http_date(node.updated_at_secs);
            if method == Method::HEAD {
                return base_headers(Response::builder(), &last_modified)
                    .header(header::CONTENT_LENGTH, node.size)
                    .body(Body::empty())
                    .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR));
            }

            let range = headers
                .get(header::RANGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);

            // Push the read down to the byte store when it can be streamed:
            // presigned URL + `Range` forwarded, so rclone's chunked reads of
            // a big file never buffer the whole object through the studio (or
            // through this process).
            match fs.read_stream(path, range.as_deref()).await {
                Err(err) => return error_response(err),
                Ok(Some(streamed)) => {
                    if streamed.status == StatusCode::RANGE_NOT_SATISFIABLE {
                        return text(StatusCode::RANGE_NOT_SATISFIABLE, "Range Not Satisfiable");
                    }
                    let mut builder =
                        base_headers(Response::builder(), &last_modified).status(streamed.status);
                    if let Some(value) = streamed.content_length {
                        builder = builder.header(header::CONTENT_LENGTH, value);
                    }
                    if let Some(value) = streamed.content_range {
                        builder = builder.header(header::CONTENT_RANGE, value);
                    }
                    return builder
                        .body(streamed.body)
                        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR));
                }
                Ok(None) => {}
            }

            let bytes = match fs.read(path).await {
                Ok(bytes) => bytes,
                Err(err) => return error_response(err),
            };
            match dav::parse_range(range.as_deref(), bytes.len() as u64) {
                Some((start, end)) => {
                    let slice = bytes[start as usize..=end as usize].to_vec();
                    base_headers(Response::builder(), &last_modified)
                        .status(StatusCode::PARTIAL_CONTENT)
                        .header(header::CONTENT_LENGTH, slice.len())
                        .header(
                            header::CONTENT_RANGE,
                            format!("bytes {start}-{end}/{}", bytes.len()),
                        )
                        .body(Body::from(slice))
                        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
                }
                None => base_headers(Response::builder(), &last_modified)
                    .header(header::CONTENT_LENGTH, bytes.len())
                    .body(Body::from(bytes))
                    .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
            }
        }

        "PUT" => {
            let bytes = match read_request_body(identity, body, MAX_PUT_BYTES).await {
                Ok(bytes) => bytes,
                Err(response) => return response,
            };
            let content_type = headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok());
            match fs.write(path, bytes, content_type).await {
                Ok(()) => empty(StatusCode::CREATED),
                Err(err) => error_response(err),
            }
        }

        "DELETE" => match fs.remove(path).await {
            Ok(()) => empty(StatusCode::NO_CONTENT),
            Err(err) => error_response(err),
        },

        "MKCOL" => match fs.mkdir(path).await {
            Ok(()) => empty(StatusCode::CREATED),
            Err(err) => error_response(err),
        },

        "MOVE" => {
            let Some(destination) = headers.get("destination").and_then(|v| v.to_str().ok()) else {
                return text(StatusCode::BAD_REQUEST, "Missing Destination");
            };
            let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
            let destination = match dav::parse_destination(destination, &target.mount_prefix, host)
            {
                Ok(destination) => destination,
                Err(502) => return text(StatusCode::BAD_GATEWAY, "Bad Gateway"),
                Err(_) => return text(StatusCode::BAD_REQUEST, "Bad Request"),
            };
            // Identical source and destination MUST be 403 (RFC 4918 §9.9.2).
            if destination == path {
                return text(StatusCode::FORBIDDEN, "Forbidden");
            }
            match fs.rename(path, &destination).await {
                Ok(()) => empty(StatusCode::CREATED),
                Err(err) => error_response(err),
            }
        }

        // rclone may PROPPATCH mtimes; accept as a no-op so it doesn't error.
        "PROPPATCH" => multistatus(&[dav::proppatch_response(&target.mount_prefix, path)]),

        _ => Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header("allow", dav::DAV_METHODS)
            .body(Body::from("Method Not Allowed"))
            .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

async fn read_request_body(
    identity: Option<&WebDavIdentity>,
    body: Body,
    limit: usize,
) -> Result<Bytes, Response> {
    match identity {
        Some(identity) => identity.read_body(body, limit).await,
        None => axum::body::to_bytes(body, limit)
            .await
            .map_err(|_| text(StatusCode::PAYLOAD_TOO_LARGE, "Payload Too Large")),
    }
}

async fn account_commit<T>(
    identity: Option<&WebDavIdentity>,
    commit: impl FnOnce() -> T,
) -> Result<T, Response> {
    match identity {
        Some(identity) => identity.with_account_commit(|_| commit()).await,
        None => Ok(commit()),
    }
}

/// Called only after an account's mount attempts, rclone children, and
/// kernel attachments have been drained. Keeping this narrow export here
/// prevents the mount manager from reaching into the shadow-store module.
pub(crate) fn purge_junk_account(account_id: &str) {
    junk::purge_account(account_id);
}

/// The volume root (`""`) is an implicit collection with no manifest entry,
/// so synthesize it; everything else comes from the backing fs.
async fn stat_node(fs: &dyn OrgFs, path: &str) -> Result<Option<OrgFsNode>, OrgFsError> {
    if path.is_empty() {
        return Ok(Some(OrgFsNode {
            path: String::new(),
            is_dir: true,
            size: 0,
            updated_at_secs: dav::now_secs(),
        }));
    }
    fs.stat(path).await
}

fn options_response() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("dav", "1")
        .header("allow", dav::DAV_METHODS)
        .header("ms-author-via", "DAV")
        .body(Body::empty())
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

fn base_headers(
    builder: axum::http::response::Builder,
    last_modified: &str,
) -> axum::http::response::Builder {
    builder
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::LAST_MODIFIED, last_modified)
        .header(header::ACCEPT_RANGES, "bytes")
}

fn multistatus(bodies: &[String]) -> Response {
    Response::builder()
        .status(StatusCode::MULTI_STATUS)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/xml; charset=\"utf-8\""),
        )
        .body(Body::from(dav::multistatus(bodies)))
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

fn text(status: StatusCode, message: &'static str) -> Response {
    (status, message).into_response()
}

fn empty(status: StatusCode) -> Response {
    (status, Body::empty()).into_response()
}

/// `OrgFsApiError` -> response, byte-for-byte with the TS `mapError`: the
/// upstream status is preserved so rclone sees a 404 as a 404 rather than a
/// blanket 500 it would retry.
fn error_response(err: OrgFsError) -> Response {
    (err.status, err.message).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    const ACCOUNT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    async fn serve(fs: &dyn OrgFs, target: &RequestTarget, req: Request) -> Response {
        serve_inner(fs, target, req, None).await
    }

    /// An in-memory volume. Only the WebDAV translation is under test here —
    /// the upstream HTTP client has its own unit tests in `org_fs.rs`.
    #[derive(Default)]
    struct FakeFs {
        files: Mutex<BTreeMap<String, Vec<u8>>>,
        dirs: Mutex<Vec<String>>,
        moves: Mutex<Vec<(String, String)>>,
        fail_with: Option<OrgFsError>,
    }

    impl FakeFs {
        fn with_files(entries: &[(&str, &[u8])]) -> FakeFs {
            let files = entries
                .iter()
                .map(|(path, body)| (path.to_string(), body.to_vec()))
                .collect();
            FakeFs {
                files: Mutex::new(files),
                ..Default::default()
            }
        }

        fn node(&self, path: &str) -> Option<OrgFsNode> {
            if self.dirs.lock().unwrap().iter().any(|d| d == path) {
                return Some(OrgFsNode {
                    path: path.to_string(),
                    is_dir: true,
                    size: 0,
                    updated_at_secs: 1_700_000_000,
                });
            }
            let files = self.files.lock().unwrap();
            if let Some(body) = files.get(path) {
                return Some(OrgFsNode {
                    path: path.to_string(),
                    is_dir: false,
                    size: body.len() as u64,
                    updated_at_secs: 1_700_000_000,
                });
            }
            let prefix = format!("{path}/");
            files
                .keys()
                .any(|k| k.starts_with(&prefix))
                .then(|| OrgFsNode {
                    path: path.to_string(),
                    is_dir: true,
                    size: 0,
                    updated_at_secs: 1_700_000_000,
                })
        }

        fn check(&self) -> Result<(), OrgFsError> {
            match &self.fail_with {
                Some(err) => Err(err.clone()),
                None => Ok(()),
            }
        }
    }

    #[async_trait::async_trait]
    impl OrgFs for FakeFs {
        async fn list_dir(&self, path: &str) -> Result<Vec<OrgFsNode>, OrgFsError> {
            self.check()?;
            let prefix = if path.is_empty() {
                String::new()
            } else {
                format!("{path}/")
            };
            let mut names: Vec<String> = Vec::new();
            for key in self.files.lock().unwrap().keys() {
                let Some(rest) = key.strip_prefix(&prefix) else {
                    continue;
                };
                if rest.is_empty() {
                    continue;
                }
                let name = rest.split('/').next().unwrap_or(rest).to_string();
                let child = format!("{prefix}{name}");
                if !names.contains(&child) {
                    names.push(child);
                }
            }
            Ok(names.iter().filter_map(|p| self.node(p)).collect())
        }

        async fn stat(&self, path: &str) -> Result<Option<OrgFsNode>, OrgFsError> {
            self.check()?;
            Ok(self.node(path))
        }

        async fn read(&self, path: &str) -> Result<Vec<u8>, OrgFsError> {
            self.check()?;
            self.files
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .ok_or_else(|| OrgFsError {
                    status: StatusCode::NOT_FOUND,
                    message: "Not found".to_string(),
                })
        }

        /// Always falls back to the buffered path — the presign push-down has
        /// no in-memory equivalent, and the fallback is what needs the range
        /// arithmetic tested.
        async fn read_stream(
            &self,
            _path: &str,
            _range: Option<&str>,
        ) -> Result<Option<org_fs::StreamedRead>, OrgFsError> {
            self.check()?;
            Ok(None)
        }

        async fn write(
            &self,
            path: &str,
            body: Bytes,
            _content_type: Option<&str>,
        ) -> Result<(), OrgFsError> {
            self.check()?;
            self.files
                .lock()
                .unwrap()
                .insert(path.to_string(), body.to_vec());
            Ok(())
        }

        async fn mkdir(&self, path: &str) -> Result<(), OrgFsError> {
            self.check()?;
            self.dirs.lock().unwrap().push(path.to_string());
            Ok(())
        }

        async fn remove(&self, path: &str) -> Result<(), OrgFsError> {
            self.check()?;
            self.files.lock().unwrap().remove(path);
            Ok(())
        }

        async fn rename(&self, from: &str, to: &str) -> Result<(), OrgFsError> {
            self.check()?;
            self.moves
                .lock()
                .unwrap()
                .push((from.to_string(), to.to_string()));
            Ok(())
        }
    }

    const PREFIX: &str = "/_sandbox/orgfs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/acme/home";

    fn target(volume: &str, path: &str) -> RequestTarget {
        RequestTarget {
            account_id: ACCOUNT.to_string(),
            org: "acme".to_string(),
            volume: volume.to_string(),
            path: path.to_string(),
            mount_prefix: format!("/_sandbox/orgfs/{ACCOUNT}/acme/{volume}"),
        }
    }

    fn request_to(uri: &str, method: &str, headers: &[(&str, &str)], body: &[u8]) -> Request {
        let mut builder = axum::http::Request::builder()
            .method(Method::from_bytes(method.as_bytes()).unwrap())
            .uri(uri);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(Body::from(body.to_vec())).unwrap()
    }

    fn request(method: &str, headers: &[(&str, &str)], body: &[u8]) -> Request {
        request_to("/", method, headers, body)
    }

    fn body_must_not_be_read_request(uri: &str, account_header: &str) -> Request {
        let stream = futures::stream::poll_fn(
            |_| -> std::task::Poll<Option<Result<Bytes, std::convert::Infallible>>> {
                panic!("request body was polled before mount identity was rejected")
            },
        );
        axum::http::Request::builder()
            .method(Method::PUT)
            .uri(uri)
            .header(MOUNT_ACCOUNT_HEADER, account_header)
            .body(Body::from_stream(stream))
            .unwrap()
    }

    async fn body_string(res: Response) -> String {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .expect("body");
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn sample_fs() -> FakeFs {
        FakeFs::with_files(&[
            ("MEMORY.md", b"hello org"),
            ("docs/a.md", b"alpha"),
            ("docs/.DS_Store", b"junk"),
        ])
    }

    #[test]
    fn mount_account_header_must_be_one_exact_opaque_id() {
        let mut headers = HeaderMap::new();
        assert!(!mount_account_header_matches(&headers, ACCOUNT));

        headers.insert(MOUNT_ACCOUNT_HEADER, HeaderValue::from_static(ACCOUNT));
        assert!(mount_account_header_matches(&headers, ACCOUNT));
        assert!(!mount_account_header_matches(
            &headers,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ));

        headers.append(MOUNT_ACCOUNT_HEADER, HeaderValue::from_static(ACCOUNT));
        assert!(!mount_account_header_matches(&headers, ACCOUNT));
    }

    #[tokio::test]
    async fn options_advertises_dav_1_and_the_supported_methods() {
        let res = serve(
            &sample_fs(),
            &target("home", ""),
            request("OPTIONS", &[], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers().get("dav").unwrap(), "1");
        assert_eq!(res.headers().get("ms-author-via").unwrap(), "DAV");
        assert_eq!(res.headers().get("allow").unwrap(), dav::DAV_METHODS);
    }

    #[tokio::test]
    async fn propfind_depth_1_on_the_root_lists_children_and_hides_mac_junk() {
        let res = serve(
            &sample_fs(),
            &target("home", ""),
            request("PROPFIND", &[("depth", "1")], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::MULTI_STATUS);
        assert_eq!(
            res.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/xml; charset=\"utf-8\""
        );
        let xml = body_string(res).await;
        // The collection itself, then its immediate children.
        assert!(xml.contains(&format!("<D:href>{PREFIX}/</D:href>")));
        assert!(xml.contains(&format!("<D:href>{PREFIX}/MEMORY.md</D:href>")));
        assert!(xml.contains(&format!("<D:href>{PREFIX}/docs/</D:href>")));
        assert!(xml.contains("<D:getcontentlength>9</D:getcontentlength>"));
        assert_eq!(xml.matches("<D:response>").count(), 3);
    }

    #[tokio::test]
    async fn propfind_depth_0_returns_only_the_addressed_node() {
        let res = serve(
            &sample_fs(),
            &target("home", ""),
            request("PROPFIND", &[("depth", "0")], b""),
        )
        .await;
        let xml = body_string(res).await;
        assert_eq!(xml.matches("<D:response>").count(), 1);
        assert!(xml.contains(&format!("<D:href>{PREFIX}/</D:href>")));
    }

    #[tokio::test]
    async fn propfind_without_a_depth_header_defaults_to_1() {
        let res = serve(
            &sample_fs(),
            &target("home", "docs"),
            request("PROPFIND", &[], b""),
        )
        .await;
        let xml = body_string(res).await;
        // The `docs` collection plus `a.md` — `.DS_Store` is filtered.
        assert_eq!(xml.matches("<D:response>").count(), 2);
        assert!(xml.contains(&format!("<D:href>{PREFIX}/docs/a.md</D:href>")));
        assert!(!xml.contains("DS_Store"));
    }

    #[tokio::test]
    async fn propfind_on_a_file_never_lists_children() {
        let res = serve(
            &sample_fs(),
            &target("home", "docs/a.md"),
            request("PROPFIND", &[("depth", "1")], b""),
        )
        .await;
        let xml = body_string(res).await;
        assert_eq!(xml.matches("<D:response>").count(), 1);
        assert!(xml.contains("<D:resourcetype/><D:getcontentlength>5</D:getcontentlength>"));
    }

    #[tokio::test]
    async fn propfind_on_a_missing_path_is_404() {
        let res = serve(
            &sample_fs(),
            &target("home", "nope.md"),
            request("PROPFIND", &[], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn get_returns_the_bytes_with_length_and_last_modified() {
        let res = serve(
            &sample_fs(),
            &target("home", "MEMORY.md"),
            request("GET", &[], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers().get(header::CONTENT_LENGTH).unwrap(), "9");
        assert_eq!(res.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");
        assert_eq!(
            res.headers().get(header::LAST_MODIFIED).unwrap(),
            "Tue, 14 Nov 2023 22:13:20 GMT"
        );
        assert_eq!(body_string(res).await, "hello org");
    }

    #[tokio::test]
    async fn get_with_a_range_serves_206_and_a_content_range() {
        let res = serve(
            &sample_fs(),
            &target("home", "MEMORY.md"),
            request("GET", &[("range", "bytes=6-8")], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            res.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 6-8/9"
        );
        assert_eq!(body_string(res).await, "org");
    }

    #[tokio::test]
    async fn head_sends_the_length_without_a_body() {
        let res = serve(
            &sample_fs(),
            &target("home", "MEMORY.md"),
            request("HEAD", &[], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers().get(header::CONTENT_LENGTH).unwrap(), "9");
        assert_eq!(body_string(res).await, "");
    }

    #[tokio::test]
    async fn get_on_a_directory_is_405() {
        let res = serve(
            &sample_fs(),
            &target("home", "docs"),
            request("GET", &[], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn put_writes_through_and_returns_201() {
        let fs = sample_fs();
        let res = serve(
            &fs,
            &target("home", "docs/new.md"),
            request("PUT", &[("content-type", "text/markdown")], b"written"),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CREATED);
        assert_eq!(
            fs.files.lock().unwrap().get("docs/new.md").unwrap(),
            b"written"
        );
    }

    #[tokio::test]
    async fn delete_returns_204_and_removes_the_entry() {
        let fs = sample_fs();
        let res = serve(
            &fs,
            &target("home", "docs/a.md"),
            request("DELETE", &[], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert!(!fs.files.lock().unwrap().contains_key("docs/a.md"));
    }

    #[tokio::test]
    async fn mkcol_creates_the_collection() {
        let fs = sample_fs();
        let res = serve(&fs, &target("home", "notes"), request("MKCOL", &[], b"")).await;
        assert_eq!(res.status(), StatusCode::CREATED);
        assert_eq!(fs.dirs.lock().unwrap().clone(), vec!["notes".to_string()]);
    }

    #[tokio::test]
    async fn move_resolves_an_absolute_destination_url() {
        let fs = sample_fs();
        let res = serve(
            &fs,
            &target("home", "docs/a.md"),
            request(
                "MOVE",
                &[
                    ("host", "127.0.0.1:4000"),
                    (
                        "destination",
                        "http://127.0.0.1:4000/_sandbox/orgfs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/acme/home/docs/b.md",
                    ),
                ],
                b"",
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CREATED);
        assert_eq!(
            fs.moves.lock().unwrap().clone(),
            vec![("docs/a.md".to_string(), "docs/b.md".to_string())]
        );
    }

    #[tokio::test]
    async fn move_without_a_destination_is_400() {
        let res = serve(
            &sample_fs(),
            &target("home", "docs/a.md"),
            request("MOVE", &[], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn move_onto_itself_is_403() {
        let res = serve(
            &sample_fs(),
            &target("home", "docs/a.md"),
            request(
                "MOVE",
                &[(
                    "destination",
                    "/_sandbox/orgfs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/acme/home/docs/a.md",
                )],
                b"",
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn move_across_volumes_is_502() {
        let res = serve(
            &sample_fs(),
            &target("home", "docs/a.md"),
            request(
                "MOVE",
                &[(
                    "destination",
                    "/_sandbox/orgfs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/acme/outputs/a.md",
                )],
                b"",
            ),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn proppatch_is_an_accepted_no_op() {
        let res = serve(
            &sample_fs(),
            &target("home", "docs/a.md"),
            request("PROPPATCH", &[], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::MULTI_STATUS);
        let xml = body_string(res).await;
        assert!(xml.contains(&format!("<D:href>{PREFIX}/docs/a.md</D:href>")));
        assert!(xml.contains("<D:prop/><D:status>HTTP/1.1 200 OK</D:status>"));
    }

    #[tokio::test]
    async fn an_unsupported_method_is_405_with_an_allow_header() {
        let res = serve(&sample_fs(), &target("home", ""), request("LOCK", &[], b"")).await;
        assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(res.headers().get("allow").unwrap(), dav::DAV_METHODS);
    }

    #[tokio::test]
    async fn public_volumes_reject_every_mutating_verb() {
        let move_headers: &[(&str, &str)] =
            &[(
                "destination",
                "/_sandbox/orgfs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/acme/public/b.md",
            )];
        let cases: [(&str, &[(&str, &str)]); 4] = [
            ("PUT", &[]),
            ("DELETE", &[]),
            ("MKCOL", &[]),
            ("MOVE", move_headers),
        ];
        for (method, headers) in cases {
            let fs = sample_fs();
            let res = serve(
                &fs,
                &target("public", "docs/a.md"),
                request(method, headers, b"x"),
            )
            .await;
            assert_eq!(
                res.status(),
                StatusCode::FORBIDDEN,
                "{method} must be denied"
            );
            assert!(fs.moves.lock().unwrap().is_empty());
            assert!(fs.dirs.lock().unwrap().is_empty());
            assert_eq!(fs.files.lock().unwrap().len(), 3);
        }
    }

    #[tokio::test]
    async fn public_volumes_still_serve_reads() {
        let res = serve(
            &sample_fs(),
            &target("public", "MEMORY.md"),
            request("GET", &[], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    /// The regression this shadow store exists for: rclone re-reads an object
    /// right after uploading it to confirm the write. Answering the PUT `201`
    /// and the confirming read `404` made rclone retry forever ("failed to
    /// upload try #1 … try #4, will retry in 16s"), pinning the file in its
    /// VFS queue and burying real errors. So junk must READ BACK — while still
    /// never reaching the backing filesystem.
    #[tokio::test]
    async fn mac_junk_round_trips_in_memory_without_touching_the_backing_fs() {
        let fs = sample_fs();
        let t = target("home", "docs/._a.md");

        assert_eq!(
            serve(&fs, &t, request("PUT", &[], b"xattr")).await.status(),
            StatusCode::CREATED
        );
        // The confirming read now succeeds — this is the inverted assertion.
        for method in ["GET", "HEAD", "PROPFIND"] {
            let res = serve(&fs, &t, request(method, &[], b"")).await;
            assert!(
                res.status().is_success(),
                "{method} must confirm the upload, got {}",
                res.status()
            );
        }

        // DELETE forgets it, and the read goes back to 404.
        assert_eq!(
            serve(&fs, &t, request("DELETE", &[], b"")).await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            serve(&fs, &t, request("GET", &[], b"")).await.status(),
            StatusCode::NOT_FOUND
        );

        // Still nothing reached the backing fs.
        assert_eq!(fs.files.lock().unwrap().len(), 3);
        assert!(fs.dirs.lock().unwrap().is_empty());
        assert!(fs.moves.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_upstream_error_status_is_preserved_verbatim() {
        let fs = FakeFs {
            fail_with: Some(OrgFsError {
                status: StatusCode::PAYLOAD_TOO_LARGE,
                message: "Volume quota exceeded".to_string(),
            }),
            ..Default::default()
        };
        let res = serve(&fs, &target("home", "docs/a.md"), request("PUT", &[], b"x")).await;
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(body_string(res).await, "Volume quota exceeded");
    }

    /// Wiring, through the real axum stack: extension methods reach the
    /// catchall, a nested mount's `OriginalUri` survives, and an arbitrarily
    /// deep (or empty) in-volume path still routes. Both cases below are
    /// answered entirely locally — the read-only gate fires before any
    /// upstream call — so this test needs no session.
    #[tokio::test]
    async fn the_nested_catchall_routes_extension_methods_at_any_path_depth() {
        use tower::ServiceExt;

        let root = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(root.path());
        let authorization = crate::routes::sandbox_account::authorize(&state)
            .await
            .unwrap();
        let account_id = authorization.account().storage().id().to_string();
        drop(authorization);
        let app: Router = Router::new()
            .nest("/_sandbox", Router::new().nest("/orgfs", router()))
            .with_state(state);

        for (suffix, method) in [("deep/nested/a.md", "PUT"), ("", "MKCOL"), ("", "DELETE")] {
            let uri = format!("/_sandbox/orgfs/{account_id}/acme/public/{suffix}");
            let res = app
                .clone()
                .oneshot(request_to(
                    &uri,
                    method,
                    &[(MOUNT_ACCOUNT_HEADER, &account_id)],
                    b"x",
                ))
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{method} {uri}");
        }
    }

    #[tokio::test]
    async fn handle_rejects_a_path_that_names_no_volume() {
        let root = tempfile::tempdir().unwrap();
        let res = handle(
            State(crate::routes::intercept::test_state(root.path())),
            OriginalUri(format!("/_sandbox/orgfs/{ACCOUNT}/acme").parse().unwrap()),
            request_to(&format!("/{ACCOUNT}/acme"), "PROPFIND", &[], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn handle_rejects_a_traversal_segment_before_reaching_upstream() {
        let root = tempfile::tempdir().unwrap();
        let res = handle(
            State(crate::routes::intercept::test_state(root.path())),
            OriginalUri(
                format!("/_sandbox/orgfs/{ACCOUNT}/acme/home/../etc")
                    .parse()
                    .unwrap(),
            ),
            request_to(&format!("/{ACCOUNT}/acme/home/../etc"), "GET", &[], b""),
        )
        .await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn handle_rejects_stale_path_or_header_identity_before_reading_the_body() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(root.path());
        let authorization = crate::routes::sandbox_account::authorize(&state)
            .await
            .unwrap();
        let current = authorization.account().storage().id().to_string();
        drop(authorization);
        let other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

        for (path_account, header_account) in [(current.as_str(), other), (other, current.as_str())]
        {
            let relative = format!("/{path_account}/acme/home/file.txt");
            let original = format!("/_sandbox/orgfs{relative}");
            let response = handle(
                State(state.clone()),
                OriginalUri(original.parse().unwrap()),
                body_must_not_be_read_request(&relative, header_account),
            )
            .await;
            assert_eq!(response.status(), StatusCode::CONFLICT);
        }
    }
}
