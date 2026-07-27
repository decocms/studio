//! Access + refresh token storage. Production storage is the macOS
//! Keychain via the `keyring` crate (see the native implementation contract
//! section 3 for the crate choice) — service `"com.decocms.studio"` in
//! release builds and `"com.decocms.studio.dev"` in debug builds, with ONE
//! account per upstream host. Release/non-macOS processes call `keyring`
//! directly. A macOS debug build delegates to the fixed helper installed by
//! `bun run --cwd=apps/native dev:signing:setup`, because the app executable's
//! CDHash changes on every rebuild while that helper's does not. The secret
//! protocol uses JSON stdin/stdout, never argv or logs. Keeping dev and release
//! in different Keychain namespaces prevents their different signing
//! identities from competing for the same item ACL. The secret payload is a
//! single JSON blob
//! (this module's [`StoredSession`]) written via `Entry::set_password` —
//! there is no plaintext-on-disk fallback anywhere in this crate; a
//! Keychain failure surfaces as [`TokenStoreError`], never a degraded
//! on-disk write.
//!
//! ## iCloud-sync verification (spike follow-up)
//!
//! the native implementation contract flags a pre-ship check: confirm the macOS store's default
//! `kSecAttrAccessible`/`kSecAttrSynchronizable` behavior doesn't let a
//! refresh token silently sync via iCloud Keychain. Read `keyring` 4.1.5's
//! `apple-native-keyring-store` v1.0.1 source
//! (`src/keychain.rs`, the module the default `v1` feature actually wires
//! up — NOT `src/protected.rs`, an opt-in module for a different feature):
//! it never sets `kSecAttrSynchronizable` on the `SecItemAdd` query
//! dictionary at all. Apple's documented default for an omitted
//! `kSecAttrSynchronizable` is a NON-synchronizable item (see Apple's
//! Keychain Services docs for `kSecAttrSynchronizable`: "If the attribute
//! is not explicitly specified, keychain items are treated as if the
//! attribute is set to `false`"). That satisfies the spike's core
//! requirement ("never syncs via iCloud Keychain") without needing the
//! `security-framework`-direct escape hatch the spike reserved. The
//! narrower ask — pinning `kSecAttrAccessible` to the maximally-strict
//! `...ThisDeviceOnly` variant rather than the platform default
//! (`kSecAttrAccessibleWhenUnlocked`, still device-unlock-gated, just also
//! eligible for inclusion in an encrypted local device backup) — is left
//! at the platform default: the spike's stated blocking concern was iCloud
//! sync specifically, which this already satisfies, and the `v1` feature's
//! `Entry` type exposes no knob to change it (only the opt-in `protected`
//! module does, which would mean dropping `keyring` entirely for a
//! different dependency shape than the spike chose). Flagged here rather
//! than silently assumed, per this repo's "a comment that takes a
//! paragraph to justify a workaround is a signal the code is wrong"
//! guidance — this isn't a workaround, it's a verified, documented,
//! deliberately-accepted default.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use wait_timeout::ChildExt;

use crate::keychain_helper::{
    KeychainHelperOutcome, KeychainHelperRequest, KeychainHelperResponse,
    KEYCHAIN_HELPER_APP_DIRECTORY, KEYCHAIN_HELPER_FILENAME, KEYCHAIN_HELPER_PROTOCOL_VERSION,
};

/// The production Keychain service. Never change this after release: doing so
/// would strand every installed app's stored session.
pub const KEYCHAIN_SERVICE: &str = "com.decocms.studio";

/// Debug builds use a separate Keychain namespace. This remains an OS-backed
/// Keychain credential — it is not a file or in-memory fallback.
pub const DEV_KEYCHAIN_SERVICE: &str = "com.decocms.studio.dev";

#[cfg(debug_assertions)]
const DEFAULT_KEYCHAIN_SERVICE: &str = DEV_KEYCHAIN_SERVICE;

#[cfg(not(debug_assertions))]
const DEFAULT_KEYCHAIN_SERVICE: &str = KEYCHAIN_SERVICE;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserInfo {
    pub sub: String,
    pub email: Option<String>,
    pub name: Option<String>,
}

/// The full session record persisted as one Keychain secret (JSON), one
/// entry per upstream host. Field shape deliberately mirrors
/// `apps/api/src/cli/lib/session.ts`'s `Session` type so the two remain
/// easy to compare/port from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredSession {
    /// OAuth issuer / decocms target, e.g. `https://studio.decocms.com`.
    pub target: String,
    /// Dynamically-registered OAuth client id for this app install.
    pub client_id: String,
    pub user: UserInfo,
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix epoch seconds when `access_token` expires, when known.
    pub expires_at: Option<i64>,
    /// RFC3339 timestamp this session was minted (login) or last refreshed.
    pub created_at: String,
    /// The Better Auth session cookie (`name=value`, e.g.
    /// `"better-auth.session_token=..."`), persisted alongside the OAuth
    /// tokens for this session's ENTIRE lifetime (not purged after a bridge
    /// completes, unlike Phase 3's original design) — see `session.rs`'s
    /// `cookie_header()`/`remember_cookie()` doc comments for why: the real
    /// production web shell's own sign-in gate
    /// (`RequiredAuthLayout`/`authClient.useSession()`) and org switcher
    /// (`authClient.organization.list()`) hit Better Auth's NATIVE
    /// `/api/auth/*` endpoints, which only recognize a session COOKIE — the
    /// MCP OAuth bearer this crate otherwise uses satisfies org-scoped
    /// tool/data routes but is rejected there.
    ///
    /// Populated by BOTH login paths, via two different mechanisms:
    /// - Embedded email/password/OTP: captured directly during the
    ///   cookie-relay login (`crates/upstream/src/bridge.rs`'s
    ///   `complete_via_cookie_jar`) — Better Auth's own `Set-Cookie` lands in
    ///   this process's `CookieJar` because the login POSTs transit THIS
    ///   proxy.
    /// - System-browser Google/GitHub/SAML: that flow's Better Auth session
    ///   cookie is set in the SYSTEM BROWSER's own cookie jar (a separate OS
    ///   process) and never transits the OAuth redirect, so this process
    ///   cannot capture it directly. Instead, `login.rs::perform_interactive_login`
    ///   exchanges the OAuth access token it always ends up with for a REAL
    ///   Better Auth session via the mesh-side bridge
    ///   (`login.rs`'s `mint_session_from_access_token`,
    ///   `POST /api/auth/desktop/session-from-oauth`) and populates this
    ///   field with the result. See
    ///   the native authentication contract for the empirical trail
    ///   this closes.
    ///
    /// `#[serde(default)]` so a session persisted by a build before this
    /// field existed still deserializes (as `None`) instead of corrupting.
    #[serde(default)]
    pub cookie: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum TokenStoreError {
    #[error("keychain unavailable: {0}")]
    Backend(String),
    #[error("stored session was not valid JSON: {0}")]
    Corrupt(String),
    #[error("keychain {operation} timed out after {timeout_ms}ms")]
    Timeout {
        operation: &'static str,
        timeout_ms: u128,
    },
}

impl From<keyring::Error> for TokenStoreError {
    fn from(err: keyring::Error) -> Self {
        TokenStoreError::Backend(err.to_string())
    }
}

/// Storage abstraction so `session.rs`/`refresh.rs` are testable without
/// touching a real OS Keychain (see `KeychainTokenStore`'s doc comment for
/// why hitting the real backend from `cargo test` would be actively
/// harmful, not just slow). `host` is the Keychain "account" — one entry
/// per upstream host, per the module ownership brief.
#[async_trait]
pub trait TokenStore: Send + Sync {
    async fn load(&self, host: &str) -> Result<Option<StoredSession>, TokenStoreError>;
    async fn save(&self, host: &str, session: StoredSession) -> Result<(), TokenStoreError>;
    /// Idempotent — clearing an already-empty/never-set entry is success,
    /// not an error (mirrors this crate's other idempotent-delete
    /// conventions, e.g. the contract doc's `/threads/:id` DELETE).
    async fn clear(&self, host: &str) -> Result<(), TokenStoreError>;
}

/// The production store: macOS Keychain via `keyring::Entry`.
///
/// `keyring::Entry`'s `get_password`/`set_password`/`delete_credential`
/// are SYNCHRONOUS and can block for an arbitrary, user-paced amount of
/// time (a Keychain ACL prompt waits on the human). Every call here goes
/// through `tokio::task::spawn_blocking` so a slow/blocked Keychain prompt
/// never stalls a tokio worker thread — the same "no synchronous work on
/// the async runtime" discipline this repo's `CONTRIBUTING.md` rule #1
/// applies to the sandbox daemon's event loop.
#[derive(Clone)]
pub struct KeychainTokenStore {
    service: &'static str,
    backend: Arc<dyn BlockingKeychainBackend>,
    operation_gate: Arc<tokio::sync::Mutex<()>>,
    timeouts: KeychainTimeouts,
}

impl std::fmt::Debug for KeychainTokenStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KeychainTokenStore")
            .field("service", &self.service)
            .finish_non_exhaustive()
    }
}

/// How long a Keychain READ may block on an interactive ACL prompt before we
/// give up and treat the credential as absent for this attempt. Properly
/// configured builds should not prompt repeatedly, but stale credentials or
/// a changed signing identity can still make `get_password` wait for a human.
/// Thirty seconds gives a visible prompt time to be answered while remaining
/// bounded so an abandoned or hidden dialog cannot wedge the auth gate
/// forever. The frontend re-polls `auth_status`, so a later approval
/// self-heals into signed-in.
/// Writes and clears have their own shorter commit deadline below: unlike a
/// read, timing either mutation out must surface as an error, never success.
const KEYCHAIN_LOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Writes and clears use a shorter deadline: mutations must either commit or
/// return an error promptly, never leave sign-in reporting false success.
const KEYCHAIN_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

/// The helper must finish first so the blocking worker can kill + reap it and
/// release the operation fence before the outer async deadline expires.
const HELPER_LOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(29);
const HELPER_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const MAX_HELPER_RESPONSE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy)]
struct KeychainTimeouts {
    load: std::time::Duration,
    write: std::time::Duration,
}

impl Default for KeychainTimeouts {
    fn default() -> Self {
        Self {
            load: KEYCHAIN_LOAD_TIMEOUT,
            write: KEYCHAIN_WRITE_TIMEOUT,
        }
    }
}

trait BlockingKeychainBackend: Send + Sync + 'static {
    fn load(&self, service: &str, host: &str) -> Result<Option<StoredSession>, TokenStoreError>;
    fn save(
        &self,
        service: &str,
        host: &str,
        session: &StoredSession,
    ) -> Result<(), TokenStoreError>;
    fn clear(&self, service: &str, host: &str) -> Result<(), TokenStoreError>;
}

#[derive(Debug, Default)]
struct SystemKeychainBackend;

impl BlockingKeychainBackend for SystemKeychainBackend {
    fn load(&self, service: &str, host: &str) -> Result<Option<StoredSession>, TokenStoreError> {
        load_blocking(service, host)
    }

    fn save(
        &self,
        service: &str,
        host: &str,
        session: &StoredSession,
    ) -> Result<(), TokenStoreError> {
        save_blocking(service, host, session)
    }

    fn clear(&self, service: &str, host: &str) -> Result<(), TokenStoreError> {
        clear_blocking(service, host)
    }
}

#[derive(Debug)]
struct StableDevHelperBackend {
    executable: PathBuf,
    timeouts: KeychainTimeouts,
    #[cfg(test)]
    spawned_pids: Option<Arc<std::sync::Mutex<Vec<u32>>>>,
}

impl StableDevHelperBackend {
    fn installed() -> Self {
        Self {
            executable: installed_dev_helper_path(),
            timeouts: KeychainTimeouts {
                load: HELPER_LOAD_TIMEOUT,
                write: HELPER_WRITE_TIMEOUT,
            },
            #[cfg(test)]
            spawned_pids: None,
        }
    }

    fn invoke(
        &self,
        operation: &'static str,
        timeout: std::time::Duration,
        request: KeychainHelperRequest,
    ) -> Result<Option<StoredSession>, TokenStoreError> {
        validate_dev_helper(&self.executable)?;
        let input = serde_json::to_vec(&request)
            .map_err(|error| TokenStoreError::Corrupt(error.to_string()))?;

        let mut child = helper_command(&self.executable)
            .spawn()
            .map_err(|error| helper_backend_error("launch", error))?;
        #[cfg(test)]
        if let Some(spawned_pids) = &self.spawned_pids {
            spawned_pids.lock().unwrap().push(child.id());
        }
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| {
                TokenStoreError::Backend(
                    "installed development Keychain helper had no stdin".to_string(),
                )
            })
            .inspect_err(|_| kill_and_reap_helper(&mut child))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| {
                TokenStoreError::Backend(
                    "installed development Keychain helper had no stdout".to_string(),
                )
            })
            .inspect_err(|_| kill_and_reap_helper(&mut child))?;

        // Drain both pipes concurrently with process waiting. Writing first
        // can block if a malformed/oversized session fills stdin; waiting
        // first can deadlock if a response fills stdout. Killing the child
        // closes both pipes, so these workers always join before the operation
        // fence is released.
        let writer = std::thread::Builder::new()
            .name("decocms-keychain-helper-stdin".to_string())
            .spawn(move || {
                let mut stdin = stdin;
                stdin.write_all(&input)
            })
            .map_err(|error| {
                kill_and_reap_helper(&mut child);
                helper_backend_error("start the stdin worker for", error)
            })?;
        let reader_result = std::thread::Builder::new()
            .name("decocms-keychain-helper-stdout".to_string())
            .spawn(move || {
                let mut output = Vec::new();
                stdout
                    .take(MAX_HELPER_RESPONSE_BYTES + 1)
                    .read_to_end(&mut output)?;
                Ok::<_, std::io::Error>(output)
            });
        let reader = match reader_result {
            Ok(reader) => reader,
            Err(error) => {
                kill_and_reap_helper(&mut child);
                let _ = writer.join();
                return Err(helper_backend_error("start the stdout worker for", error));
            }
        };

        let status = match child.wait_timeout(timeout) {
            Ok(Some(status)) => status,
            Ok(None) => {
                kill_and_reap_helper(&mut child);
                let _ = writer.join();
                let _ = reader.join();
                return Err(keychain_timeout(operation, timeout));
            }
            Err(error) => {
                kill_and_reap_helper(&mut child);
                let _ = writer.join();
                let _ = reader.join();
                return Err(helper_backend_error("wait for", error));
            }
        };

        join_helper_writer(writer)?;
        let output = join_helper_reader(reader)?;
        if !status.success() {
            return Err(TokenStoreError::Backend(format!(
                "installed development Keychain helper exited with {}",
                status
            )));
        }
        if output.len() as u64 > MAX_HELPER_RESPONSE_BYTES {
            return Err(TokenStoreError::Backend(
                "installed development Keychain helper response exceeded the size limit"
                    .to_string(),
            ));
        }

        let response: KeychainHelperResponse = serde_json::from_slice(&output).map_err(|_| {
            TokenStoreError::Backend(
                "installed development Keychain helper returned an invalid response".to_string(),
            )
        })?;
        if response.version != KEYCHAIN_HELPER_PROTOCOL_VERSION {
            return Err(TokenStoreError::Backend(
                "installed development Keychain helper uses an unsupported protocol version"
                    .to_string(),
            ));
        }
        match response.outcome {
            KeychainHelperOutcome::Ok { session } => Ok(session.map(|value| *value)),
            KeychainHelperOutcome::Error { message } => Err(TokenStoreError::Backend(format!(
                "development Keychain helper: {message}"
            ))),
        }
    }
}

impl BlockingKeychainBackend for StableDevHelperBackend {
    fn load(&self, service: &str, host: &str) -> Result<Option<StoredSession>, TokenStoreError> {
        ensure_dev_helper_service(service)?;
        self.invoke(
            "read",
            self.timeouts.load,
            KeychainHelperRequest::load(host),
        )
    }

    fn save(
        &self,
        service: &str,
        host: &str,
        session: &StoredSession,
    ) -> Result<(), TokenStoreError> {
        ensure_dev_helper_service(service)?;
        match self.invoke(
            "write",
            self.timeouts.write,
            KeychainHelperRequest::save(host, session.clone()),
        )? {
            None => Ok(()),
            Some(_) => Err(TokenStoreError::Backend(
                "development Keychain helper returned a session for a save request".to_string(),
            )),
        }
    }

    fn clear(&self, service: &str, host: &str) -> Result<(), TokenStoreError> {
        ensure_dev_helper_service(service)?;
        match self.invoke(
            "clear",
            self.timeouts.write,
            KeychainHelperRequest::clear(host),
        )? {
            None => Ok(()),
            Some(_) => Err(TokenStoreError::Backend(
                "development Keychain helper returned a session for a clear request".to_string(),
            )),
        }
    }
}

fn kill_and_reap_helper(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn join_helper_writer(
    writer: std::thread::JoinHandle<Result<(), std::io::Error>>,
) -> Result<(), TokenStoreError> {
    writer
        .join()
        .map_err(|_| {
            TokenStoreError::Backend(
                "development Keychain helper stdin worker panicked".to_string(),
            )
        })?
        .map_err(|error| helper_backend_error("write request to", error))
}

fn join_helper_reader(
    reader: std::thread::JoinHandle<Result<Vec<u8>, std::io::Error>>,
) -> Result<Vec<u8>, TokenStoreError> {
    reader
        .join()
        .map_err(|_| {
            TokenStoreError::Backend(
                "development Keychain helper stdout worker panicked".to_string(),
            )
        })?
        .map_err(|error| helper_backend_error("read response from", error))
}

fn helper_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

fn helper_backend_error(action: &str, error: std::io::Error) -> TokenStoreError {
    TokenStoreError::Backend(format!(
        "could not {action} the installed development Keychain helper: {error}"
    ))
}

fn ensure_dev_helper_service(service: &str) -> Result<(), TokenStoreError> {
    if service == DEV_KEYCHAIN_SERVICE {
        Ok(())
    } else {
        Err(TokenStoreError::Backend(
            "development Keychain helper refused a non-development service".to_string(),
        ))
    }
}

fn installed_dev_helper_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_default()
        .join(KEYCHAIN_HELPER_APP_DIRECTORY)
        .join(KEYCHAIN_HELPER_FILENAME)
}

fn validate_dev_helper(path: &Path) -> Result<(), TokenStoreError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        TokenStoreError::Backend(format!(
            "development Keychain helper is not installed at {}: {error}; run `bun run --cwd=apps/native dev:signing:setup`",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(TokenStoreError::Backend(format!(
            "development Keychain helper at {} is not a regular file",
            path.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o700 {
            return Err(TokenStoreError::Backend(format!(
                "development Keychain helper at {} must have mode 0700",
                path.display()
            )));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeychainAccessKind {
    Direct,
    StableDevHelper,
}

const fn keychain_access_kind(debug_build: bool, macos: bool) -> KeychainAccessKind {
    if debug_build && macos {
        KeychainAccessKind::StableDevHelper
    } else {
        KeychainAccessKind::Direct
    }
}

fn keychain_operation_gate() -> Arc<tokio::sync::Mutex<()>> {
    static GATE: std::sync::OnceLock<Arc<tokio::sync::Mutex<()>>> = std::sync::OnceLock::new();
    Arc::clone(GATE.get_or_init(|| Arc::new(tokio::sync::Mutex::new(()))))
}

impl KeychainTokenStore {
    pub fn new() -> Self {
        let access_kind = keychain_access_kind(cfg!(debug_assertions), cfg!(target_os = "macos"));
        let backend: Arc<dyn BlockingKeychainBackend> = match access_kind {
            KeychainAccessKind::Direct => Arc::new(SystemKeychainBackend),
            KeychainAccessKind::StableDevHelper => Arc::new(StableDevHelperBackend::installed()),
        };
        Self {
            service: keyring_service(),
            backend,
            operation_gate: keychain_operation_gate(),
            timeouts: KeychainTimeouts::default(),
        }
    }

    #[cfg(test)]
    fn with_backend(
        backend: Arc<dyn BlockingKeychainBackend>,
        operation_gate: Arc<tokio::sync::Mutex<()>>,
        timeouts: KeychainTimeouts,
    ) -> Self {
        Self {
            service: KEYCHAIN_SERVICE,
            backend,
            operation_gate,
            timeouts,
        }
    }

    async fn run_blocking<T>(
        &self,
        operation: &'static str,
        timeout: std::time::Duration,
        action: impl FnOnce(Arc<dyn BlockingKeychainBackend>) -> Result<T, TokenStoreError>
            + Send
            + 'static,
    ) -> Result<T, TokenStoreError>
    where
        T: Send + 'static,
    {
        // A timed-out `spawn_blocking` task cannot be cancelled once it has
        // started. Acquire one process-wide FIFO fence BEFORE spawning it, and
        // move the owned guard into the worker. If the caller times out, the
        // unfinished Keychain operation keeps the fence until it really exits,
        // so a retry, logout, or refresh can never overtake it.
        let deadline = tokio::time::Instant::now() + timeout;
        let guard =
            tokio::time::timeout_at(deadline, Arc::clone(&self.operation_gate).lock_owned())
                .await
                .map_err(|_| keychain_timeout(operation, timeout))?;

        let backend = Arc::clone(&self.backend);
        let abandoned = Arc::new(AtomicBool::new(false));
        let worker_abandoned = Arc::clone(&abandoned);
        let mut task = tokio::task::spawn_blocking(move || {
            let _guard = guard;
            // `abort()` can cancel a queued spawn_blocking task, but not one
            // that has begun. This flag closes the small queue/start race: a
            // worker first scheduled after its deadline must not perform a
            // stale save or clear.
            if worker_abandoned.load(Ordering::Acquire) {
                return Err(TokenStoreError::Backend(format!(
                    "keychain {operation} was abandoned before execution"
                )));
            }
            action(backend)
        });

        match tokio::time::timeout_at(deadline, &mut task).await {
            Ok(joined) => joined.map_err(|error| {
                TokenStoreError::Backend(format!("keychain {operation} task failed: {error}"))
            })?,
            Err(_) => {
                abandoned.store(true, Ordering::Release);
                task.abort();
                Err(keychain_timeout(operation, timeout))
            }
        }
    }
}

impl Default for KeychainTokenStore {
    fn default() -> Self {
        Self::new()
    }
}

fn keychain_timeout(operation: &'static str, timeout: std::time::Duration) -> TokenStoreError {
    TokenStoreError::Timeout {
        operation,
        timeout_ms: timeout.as_millis(),
    }
}

/// `LOCAL_API_KEYRING_SERVICE` overrides the direct Keychain service name so
/// release/non-macOS harnesses can isolate credentials. macOS debug builds
/// deliberately ignore it: their installed helper is hardcoded to
/// [`DEV_KEYCHAIN_SERVICE`], and tests must use `LOCAL_API_TOKEN_STORE=memory`
/// instead of weakening that boundary.
fn keyring_service() -> &'static str {
    static SERVICE: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    SERVICE.get_or_init(|| {
        if keychain_access_kind(cfg!(debug_assertions), cfg!(target_os = "macos"))
            == KeychainAccessKind::StableDevHelper
        {
            return DEV_KEYCHAIN_SERVICE;
        }
        match std::env::var("LOCAL_API_KEYRING_SERVICE") {
            Ok(s) if !s.trim().is_empty() => Box::leak(s.into_boxed_str()),
            _ => DEFAULT_KEYCHAIN_SERVICE,
        }
    })
}

#[async_trait]
impl TokenStore for KeychainTokenStore {
    async fn load(&self, host: &str) -> Result<Option<StoredSession>, TokenStoreError> {
        let service = self.service;
        let host_owned = host.to_string();
        let result = self
            .run_blocking("read", self.timeouts.load, move |backend| {
                backend.load(service, &host_owned)
            })
            .await;
        if matches!(result, Err(TokenStoreError::Timeout { .. })) {
            tracing::warn!(
                host,
                timeout_s = self.timeouts.load.as_secs(),
                "keychain read timed out (likely an interactive ACL prompt awaiting Always Allow)"
            );
        }
        result
    }

    async fn save(&self, host: &str, session: StoredSession) -> Result<(), TokenStoreError> {
        let service = self.service;
        let host_owned = host.to_string();
        let result = self
            .run_blocking("write", self.timeouts.write, move |backend| {
                backend.save(service, &host_owned, &session)
            })
            .await;
        if matches!(result, Err(TokenStoreError::Timeout { .. })) {
            tracing::warn!(
                    host,
                    timeout_s = self.timeouts.write.as_secs(),
                    "keychain write timed out (likely an interactive ACL prompt); sign-in is not committed"
                );
        }
        result
    }

    async fn clear(&self, host: &str) -> Result<(), TokenStoreError> {
        let service = self.service;
        let host_owned = host.to_string();
        let result = self
            .run_blocking("clear", self.timeouts.write, move |backend| {
                backend.clear(service, &host_owned)
            })
            .await;
        if matches!(result, Err(TokenStoreError::Timeout { .. })) {
            tracing::warn!(
                    host,
                    timeout_s = self.timeouts.write.as_secs(),
                    "keychain clear timed out (likely an interactive ACL prompt); sign-out is not committed"
                );
        }
        result
    }
}

/// Process-lifetime in-memory [`TokenStore`], selected in the SHIPPING
/// binary only via `LOCAL_API_TOKEN_STORE=memory` (see
/// `session::global`) — for headless drives / CI where a real Keychain ACL
/// prompt would wedge sign-in. Distinct from the `#[cfg(test)]`
/// `test_support::MemoryTokenStore`, which is not compiled into the release
/// binary. Never the default; tokens vanish on exit.
#[derive(Default)]
pub struct InMemoryTokenStore {
    entries: std::sync::Mutex<std::collections::HashMap<String, StoredSession>>,
}

#[async_trait]
impl TokenStore for InMemoryTokenStore {
    async fn load(&self, host: &str) -> Result<Option<StoredSession>, TokenStoreError> {
        Ok(self.entries.lock().unwrap().get(host).cloned())
    }
    async fn save(&self, host: &str, session: StoredSession) -> Result<(), TokenStoreError> {
        self.entries
            .lock()
            .unwrap()
            .insert(host.to_string(), session);
        Ok(())
    }
    async fn clear(&self, host: &str) -> Result<(), TokenStoreError> {
        self.entries.lock().unwrap().remove(host);
        Ok(())
    }
}

fn load_blocking(service: &str, host: &str) -> Result<Option<StoredSession>, TokenStoreError> {
    let entry = keyring::Entry::new(service, host)?;
    match entry.get_password() {
        Ok(json) => serde_json::from_str(&json)
            .map(Some)
            .map_err(|e| TokenStoreError::Corrupt(e.to_string())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn save_blocking(
    service: &str,
    host: &str,
    session: &StoredSession,
) -> Result<(), TokenStoreError> {
    let entry = keyring::Entry::new(service, host)?;
    let json =
        serde_json::to_string(session).map_err(|e| TokenStoreError::Corrupt(e.to_string()))?;
    entry.set_password(&json)?;
    Ok(())
}

fn clear_blocking(service: &str, host: &str) -> Result<(), TokenStoreError> {
    let entry = keyring::Entry::new(service, host)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Derives the Keychain "account" (this crate's per-host scoping key) from
/// an upstream base URL. `https://studio.decocms.com` -> `studio.decocms.com`;
/// a non-default port is preserved (`http://localhost:4000` ->
/// `localhost:4000`) so a local dev target never collides with prod in the
/// same Keychain. Falls back to the raw string if it doesn't parse as a
/// URL (defensive — `session.rs` always passes an already-validated
/// target, but this function has no way to enforce that from here).
pub fn host_key(target: &str) -> String {
    let without_scheme = target
        .strip_prefix("https://")
        .or_else(|| target.strip_prefix("http://"))
        .unwrap_or(target);
    without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(without_scheme)
        .to_string()
}

#[cfg(any(test, feature = "test-support"))]
pub mod test_support {
    //! Gated behind `test` (this crate's OWN test builds) OR the
    //! `test-support` Cargo feature (so a DOWNSTREAM crate's tests —
    //! `local-api`'s `routes/upstream.rs`, specifically — can also use it:
    //! `#[cfg(test)]` only compiles a module into the crate being tested
    //! itself, never into a dependency's rlib as linked by another crate's
    //! `cargo test`. `local-api` enables this feature from its own
    //! `[dev-dependencies]` entry for `upstream` — see that crate's
    //! Cargo.toml).
    //!
    //! An in-memory [`TokenStore`] so tests never touch the real OS
    //! Keychain — see [`KeychainTokenStore`]'s doc comment for why that
    //! would be actively unsafe to do from `cargo test` (it would write
    //! real app-service entries into whoever's Keychain runs the test suite,
    //! and on a headless/locked-Keychain CI runner a Keychain
    //! prompt could hang the test forever).

    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MemoryTokenStore {
        entries: Mutex<HashMap<String, StoredSession>>,
    }

    impl MemoryTokenStore {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn seeded(host: &str, session: StoredSession) -> Self {
            let store = Self::new();
            store
                .entries
                .lock()
                .unwrap()
                .insert(host.to_string(), session);
            store
        }
    }

    #[async_trait]
    impl TokenStore for MemoryTokenStore {
        async fn load(&self, host: &str) -> Result<Option<StoredSession>, TokenStoreError> {
            Ok(self.entries.lock().unwrap().get(host).cloned())
        }

        async fn save(&self, host: &str, session: StoredSession) -> Result<(), TokenStoreError> {
            self.entries
                .lock()
                .unwrap()
                .insert(host.to_string(), session);
            Ok(())
        }

        async fn clear(&self, host: &str) -> Result<(), TokenStoreError> {
            self.entries.lock().unwrap().remove(host);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::MemoryTokenStore;
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{self, Receiver, Sender};
    use tokio::sync::Notify;

    #[derive(Default)]
    struct FakeBlockingKeychainBackend {
        save_calls: AtomicUsize,
        clear_calls: AtomicUsize,
        save_started: Notify,
        save_finished: Notify,
        clear_started: Notify,
        clear_finished: Notify,
        save_release: std::sync::Mutex<Option<Receiver<()>>>,
        clear_release: std::sync::Mutex<Option<Receiver<()>>>,
    }

    impl FakeBlockingKeychainBackend {
        fn blocking_save() -> (Arc<Self>, Sender<()>) {
            let (release, receiver) = mpsc::channel();
            (
                Arc::new(Self {
                    save_release: std::sync::Mutex::new(Some(receiver)),
                    ..Self::default()
                }),
                release,
            )
        }

        fn blocking_clear() -> (Arc<Self>, Sender<()>) {
            let (release, receiver) = mpsc::channel();
            (
                Arc::new(Self {
                    clear_release: std::sync::Mutex::new(Some(receiver)),
                    ..Self::default()
                }),
                release,
            )
        }
    }

    impl BlockingKeychainBackend for FakeBlockingKeychainBackend {
        fn load(
            &self,
            _service: &str,
            _host: &str,
        ) -> Result<Option<StoredSession>, TokenStoreError> {
            Ok(None)
        }

        fn save(
            &self,
            _service: &str,
            _host: &str,
            _session: &StoredSession,
        ) -> Result<(), TokenStoreError> {
            self.save_calls.fetch_add(1, Ordering::SeqCst);
            self.save_started.notify_one();
            if let Some(receiver) = self.save_release.lock().unwrap().take() {
                receiver.recv().map_err(|error| {
                    TokenStoreError::Backend(format!("fake save release failed: {error}"))
                })?;
            }
            self.save_finished.notify_one();
            Ok(())
        }

        fn clear(&self, _service: &str, _host: &str) -> Result<(), TokenStoreError> {
            self.clear_calls.fetch_add(1, Ordering::SeqCst);
            self.clear_started.notify_one();
            if let Some(receiver) = self.clear_release.lock().unwrap().take() {
                receiver.recv().map_err(|error| {
                    TokenStoreError::Backend(format!("fake clear release failed: {error}"))
                })?;
            }
            self.clear_finished.notify_one();
            Ok(())
        }
    }

    fn fake_keychain_store(backend: Arc<dyn BlockingKeychainBackend>) -> KeychainTokenStore {
        KeychainTokenStore::with_backend(
            backend,
            Arc::new(tokio::sync::Mutex::new(())),
            KeychainTimeouts {
                load: std::time::Duration::from_millis(100),
                write: std::time::Duration::from_millis(100),
            },
        )
    }

    fn assert_timeout(error: TokenStoreError, operation: &'static str) {
        assert!(
            matches!(
                error,
                TokenStoreError::Timeout {
                    operation: actual,
                    timeout_ms: 100
                } if actual == operation
            ),
            "expected a {operation} timeout, got {error:?}"
        );
    }

    fn sample_session() -> StoredSession {
        StoredSession {
            target: "https://studio.decocms.com".to_string(),
            client_id: "client_abc".to_string(),
            user: UserInfo {
                sub: "user_1".to_string(),
                email: Some("a@b.com".to_string()),
                name: None,
            },
            access_token: "access-1".to_string(),
            refresh_token: Some("refresh-1".to_string()),
            expires_at: Some(1_000_000),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            cookie: Some("better-auth.session_token=abc".to_string()),
        }
    }

    /// A session serialized by a build BEFORE the `cookie` field existed —
    /// exercises the `#[serde(default)]` backward-compat path.
    fn pre_cookie_field_json() -> &'static str {
        r#"{"target":"https://studio.decocms.com","client_id":"client_abc","user":{"sub":"user_1","email":"a@b.com","name":null},"access_token":"access-1","refresh_token":"refresh-1","expires_at":1000000,"created_at":"2026-01-01T00:00:00Z"}"#
    }

    #[test]
    fn a_session_persisted_before_the_cookie_field_existed_still_deserializes() {
        let back: StoredSession = serde_json::from_str(pre_cookie_field_json()).unwrap();
        assert_eq!(back.cookie, None);
        assert_eq!(back.access_token, "access-1");
    }

    #[test]
    fn host_key_strips_scheme_and_path() {
        assert_eq!(host_key("https://studio.decocms.com"), "studio.decocms.com");
        assert_eq!(
            host_key("https://studio.decocms.com/"),
            "studio.decocms.com"
        );
        assert_eq!(host_key("http://localhost:4000"), "localhost:4000");
        assert_eq!(host_key("studio.decocms.com"), "studio.decocms.com");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_build_uses_an_isolated_keychain_service() {
        assert_eq!(DEFAULT_KEYCHAIN_SERVICE, DEV_KEYCHAIN_SERVICE);
        assert_ne!(DEFAULT_KEYCHAIN_SERVICE, KEYCHAIN_SERVICE);
    }

    #[cfg(not(debug_assertions))]
    #[test]
    fn release_build_uses_the_production_keychain_service() {
        assert_eq!(DEFAULT_KEYCHAIN_SERVICE, KEYCHAIN_SERVICE);
        assert_ne!(DEFAULT_KEYCHAIN_SERVICE, DEV_KEYCHAIN_SERVICE);
    }

    #[test]
    fn stored_session_json_round_trips() {
        let session = sample_session();
        let json = serde_json::to_string(&session).unwrap();
        let back: StoredSession = serde_json::from_str(&json).unwrap();
        assert_eq!(back, session);
    }

    #[test]
    fn only_debug_macos_uses_the_stable_helper() {
        assert_eq!(
            keychain_access_kind(true, true),
            KeychainAccessKind::StableDevHelper
        );
        assert_eq!(
            keychain_access_kind(false, true),
            KeychainAccessKind::Direct
        );
        assert_eq!(
            keychain_access_kind(true, false),
            KeychainAccessKind::Direct
        );
        assert_eq!(
            keychain_access_kind(false, false),
            KeychainAccessKind::Direct
        );
    }

    #[test]
    fn helper_command_never_places_secrets_in_arguments() {
        let command = helper_command(Path::new("/fixed/helper"));
        assert_eq!(command.get_program(), "/fixed/helper");
        assert_eq!(command.get_args().count(), 0);
    }

    fn test_helper_backend(
        executable: PathBuf,
        timeout: std::time::Duration,
    ) -> StableDevHelperBackend {
        StableDevHelperBackend {
            executable,
            timeouts: KeychainTimeouts {
                load: timeout,
                write: timeout,
            },
            spawned_pids: None,
        }
    }

    #[test]
    fn missing_helper_is_a_storage_backend_error_not_a_direct_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let backend = test_helper_backend(
            temp.path().join("missing-helper"),
            std::time::Duration::from_millis(100),
        );
        let error = backend
            .load(DEV_KEYCHAIN_SERVICE, "studio.decocms.com")
            .unwrap_err();
        assert!(
            matches!(error, TokenStoreError::Backend(message) if message.contains("dev:signing:setup"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn helper_with_group_or_world_permissions_is_rejected() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("permissive-helper");
        std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();

        let error = validate_dev_helper(&executable).unwrap_err();
        assert!(
            matches!(error, TokenStoreError::Backend(message) if message.contains("mode 0700"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn stable_helper_receives_a_save_only_through_stdin() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("fake-keychain-helper");
        std::fs::write(
            &executable,
            r#"#!/bin/sh
if [ "$#" -ne 0 ]; then
  exit 40
fi
request=$(cat)
case "$request" in
  *'"operation":"save"'*'"access_token":"access-1"'*)
    printf '%s\n' '{"version":2,"status":"ok"}'
    ;;
  *)
    exit 41
    ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();

        let backend = test_helper_backend(executable, std::time::Duration::from_secs(2));
        backend
            .save(
                DEV_KEYCHAIN_SERVICE,
                "studio.decocms.com",
                &sample_session(),
            )
            .unwrap();
    }

    #[cfg(unix)]
    fn hanging_helper() -> (
        tempfile::TempDir,
        StableDevHelperBackend,
        Arc<std::sync::Mutex<Vec<u32>>>,
    ) {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("hanging-keychain-helper");
        std::fs::write(
            &executable,
            r#"#!/bin/sh
cat >/dev/null
exec /bin/sleep 60
"#,
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let spawned_pids = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut backend = test_helper_backend(executable, std::time::Duration::from_millis(500));
        backend.spawned_pids = Some(Arc::clone(&spawned_pids));
        (temp, backend, spawned_pids)
    }

    #[cfg(unix)]
    fn assert_helper_timed_out_and_was_reaped(
        error: TokenStoreError,
        operation: &'static str,
        spawned_pids: &Arc<std::sync::Mutex<Vec<u32>>>,
    ) {
        assert!(
            matches!(
                error,
                TokenStoreError::Timeout {
                    operation: actual,
                    timeout_ms: 500
                } if actual == operation
            ),
            "expected a typed {operation} timeout, got {error:?}"
        );
        let pids = spawned_pids.lock().unwrap();
        assert_eq!(pids.len(), 1);
        let pid = pids[0].to_string();
        let still_alive = Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!still_alive, "timed-out helper PID {} survived", pid.trim());
    }

    #[cfg(unix)]
    #[test]
    fn hanging_helper_load_is_killed_and_reaped() {
        let (_temp, backend, spawned_pids) = hanging_helper();
        let error = backend
            .load(DEV_KEYCHAIN_SERVICE, "studio.decocms.com")
            .unwrap_err();
        assert_helper_timed_out_and_was_reaped(error, "read", &spawned_pids);
    }

    #[cfg(unix)]
    #[test]
    fn hanging_helper_save_is_killed_and_reaped() {
        let (_temp, backend, spawned_pids) = hanging_helper();
        let error = backend
            .save(
                DEV_KEYCHAIN_SERVICE,
                "studio.decocms.com",
                &sample_session(),
            )
            .unwrap_err();
        assert_helper_timed_out_and_was_reaped(error, "write", &spawned_pids);
    }

    #[cfg(unix)]
    #[test]
    fn hanging_helper_clear_is_killed_and_reaped() {
        let (_temp, backend, spawned_pids) = hanging_helper();
        let error = backend
            .clear(DEV_KEYCHAIN_SERVICE, "studio.decocms.com")
            .unwrap_err();
        assert_helper_timed_out_and_was_reaped(error, "clear", &spawned_pids);
    }

    #[tokio::test]
    async fn memory_store_load_save_clear_round_trip() {
        let store = MemoryTokenStore::new();
        assert!(store.load("studio.decocms.com").await.unwrap().is_none());

        let session = sample_session();
        store
            .save("studio.decocms.com", session.clone())
            .await
            .unwrap();
        assert_eq!(
            store.load("studio.decocms.com").await.unwrap(),
            Some(session)
        );

        store.clear("studio.decocms.com").await.unwrap();
        assert!(store.load("studio.decocms.com").await.unwrap().is_none());
        // Idempotent: clearing an already-empty entry is not an error.
        store.clear("studio.decocms.com").await.unwrap();
    }

    #[tokio::test]
    async fn memory_store_scopes_entries_per_host() {
        let store = MemoryTokenStore::new();
        let mut prod = sample_session();
        prod.target = "https://studio.decocms.com".to_string();
        let mut dev = sample_session();
        dev.target = "http://localhost:4000".to_string();
        dev.access_token = "dev-token".to_string();

        store
            .save("studio.decocms.com", prod.clone())
            .await
            .unwrap();
        store.save("localhost:4000", dev.clone()).await.unwrap();

        assert_eq!(store.load("studio.decocms.com").await.unwrap(), Some(prod));
        assert_eq!(store.load("localhost:4000").await.unwrap(), Some(dev));
    }

    #[tokio::test]
    async fn timed_out_save_is_an_error_and_fences_later_operations() {
        let (backend, release_save) = FakeBlockingKeychainBackend::blocking_save();
        let store = fake_keychain_store(backend.clone());

        let save_started = backend.save_started.notified();
        let save = tokio::spawn({
            let store = store.clone();
            async move { store.save("studio.decocms.com", sample_session()).await }
        });
        save_started.await;
        assert_timeout(save.await.unwrap().unwrap_err(), "write");

        // `spawn_blocking` cannot cancel the already-running save. Its owned
        // operation fence must remain held, so a clear cannot overtake it and
        // delete an item before the late save finally returns.
        let clear = tokio::spawn({
            let store = store.clone();
            async move { store.clear("studio.decocms.com").await }
        });
        assert_timeout(clear.await.unwrap().unwrap_err(), "clear");
        assert_eq!(backend.clear_calls.load(Ordering::SeqCst), 0);

        let save_finished = backend.save_finished.notified();
        release_save.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), save_finished)
            .await
            .expect("late save should finish after the fake backend is released");

        // The clear that timed out while waiting was cancelled, not queued for
        // a surprise future mutation. A new explicit clear is the only one
        // that executes after the save releases the fence.
        store.clear("studio.decocms.com").await.unwrap();
        assert_eq!(backend.clear_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn timed_out_clear_is_an_error_not_false_success() {
        let (backend, release_clear) = FakeBlockingKeychainBackend::blocking_clear();
        let store = fake_keychain_store(backend.clone());

        let clear_started = backend.clear_started.notified();
        let clear = tokio::spawn(async move { store.clear("studio.decocms.com").await });
        clear_started.await;
        assert_timeout(clear.await.unwrap().unwrap_err(), "clear");
        assert_eq!(backend.clear_calls.load(Ordering::SeqCst), 1);

        let clear_finished = backend.clear_finished.notified();
        release_clear.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), clear_finished)
            .await
            .expect("late clear should finish after the fake backend is released");
    }

    /// Real-Keychain round trip — deliberately `#[ignore]`d. Writes an
    /// actual debug-service entry into whoever runs its macOS
    /// Keychain, and `keyring`'s Keychain backend can trigger a one-time
    /// OS access-consent prompt the first time a given binary reads it —
    /// both wrong for an unattended `cargo test` run (CI or an agent
    /// sandbox). Run manually on a macOS dev machine to sanity-check the
    /// real backend:
    ///   cargo test -p upstream keychain_round_trip -- --ignored
    #[tokio::test]
    #[ignore]
    async fn keychain_round_trip() {
        let store = KeychainTokenStore::new();
        let host = "upstream-crate-manual-test.invalid";
        let session = sample_session();
        store.save(host, session.clone()).await.unwrap();
        assert_eq!(store.load(host).await.unwrap(), Some(session));
        store.clear(host).await.unwrap();
        assert!(store.load(host).await.unwrap().is_none());
    }
}
