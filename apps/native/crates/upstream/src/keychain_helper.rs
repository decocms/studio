//! Stable debug-Keychain helper protocol.
//!
//! A self-signed macOS development app gets a new code-directory hash after
//! every Rust rebuild. Keychain partition ACLs therefore cannot recognize the
//! rebuilt app as the process that created the credential, even when its
//! designated requirement is stable. Debug builds solve that at the process
//! boundary: the one-time signing setup installs one fixed helper executable,
//! and only that never-rebuilt executable touches the debug Keychain service.
//! The app sends one JSON request over stdin and reads one JSON response from
//! stdout. Secrets are never command-line arguments or log messages.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

use crate::tokens::{host_key, StoredSession, DEV_KEYCHAIN_SERVICE};

/// Installed-helper compatibility and upgrade boundary. Any behavior change to
/// this helper must bump the version together with
/// `scripts/dev-signing-identity.sh`; the setup command deliberately keeps
/// already-installed bytes while this version remains compatible.
pub const KEYCHAIN_HELPER_PROTOCOL_VERSION: u16 = 2;
pub const KEYCHAIN_HELPER_FILENAME: &str = "decocms-keychain-helper";
pub const KEYCHAIN_HELPER_APP_DIRECTORY: &str = "com.decocms.studio/dev";

const MAX_PROTOCOL_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeychainHelperRequest {
    pub version: u16,
    #[serde(flatten)]
    pub operation: KeychainHelperOperation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum KeychainHelperOperation {
    Load {
        account: String,
    },
    Save {
        account: String,
        session: Box<StoredSession>,
    },
    Clear {
        account: String,
    },
    /// Setup-time health check. It round-trips a process-unique throwaway
    /// credential through the same hardcoded service as real debug sessions.
    Probe,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeychainHelperResponse {
    pub version: u16,
    #[serde(flatten)]
    pub outcome: KeychainHelperOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum KeychainHelperOutcome {
    Ok {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<Box<StoredSession>>,
    },
    Error {
        message: String,
    },
}

impl KeychainHelperRequest {
    pub fn load(account: impl Into<String>) -> Self {
        Self {
            version: KEYCHAIN_HELPER_PROTOCOL_VERSION,
            operation: KeychainHelperOperation::Load {
                account: account.into(),
            },
        }
    }

    pub fn save(account: impl Into<String>, session: StoredSession) -> Self {
        Self {
            version: KEYCHAIN_HELPER_PROTOCOL_VERSION,
            operation: KeychainHelperOperation::Save {
                account: account.into(),
                session: Box::new(session),
            },
        }
    }

    pub fn clear(account: impl Into<String>) -> Self {
        Self {
            version: KEYCHAIN_HELPER_PROTOCOL_VERSION,
            operation: KeychainHelperOperation::Clear {
                account: account.into(),
            },
        }
    }
}

impl KeychainHelperResponse {
    fn success(session: Option<StoredSession>) -> Self {
        Self {
            version: KEYCHAIN_HELPER_PROTOCOL_VERSION,
            outcome: KeychainHelperOutcome::Ok {
                session: session.map(Box::new),
            },
        }
    }

    fn error(message: impl Into<String>) -> Self {
        Self {
            version: KEYCHAIN_HELPER_PROTOCOL_VERSION,
            outcome: KeychainHelperOutcome::Error {
                message: message.into(),
            },
        }
    }
}

trait CredentialBackend {
    fn load(&self, account: &str) -> Result<Option<String>, String>;
    fn save(&self, account: &str, secret: &str) -> Result<(), String>;
    fn clear(&self, account: &str) -> Result<(), String>;
}

struct SystemCredentialBackend;

impl CredentialBackend for SystemCredentialBackend {
    fn load(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(DEV_KEYCHAIN_SERVICE, account)
            .map_err(|error| error.to_string())?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn save(&self, account: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(DEV_KEYCHAIN_SERVICE, account)
            .map_err(|error| error.to_string())?
            .set_password(secret)
            .map_err(|error| error.to_string())
    }

    fn clear(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(DEV_KEYCHAIN_SERVICE, account)
            .map_err(|error| error.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

fn validate_account(account: &str) -> Result<(), String> {
    if account.is_empty() || account.len() > 512 || account.chars().any(char::is_control) {
        return Err("invalid Keychain account".to_string());
    }
    Ok(())
}

fn handle_request(
    backend: &dyn CredentialBackend,
    request: KeychainHelperRequest,
) -> KeychainHelperResponse {
    if request.version != KEYCHAIN_HELPER_PROTOCOL_VERSION {
        return KeychainHelperResponse::error("unsupported helper protocol version");
    }

    let result = match request.operation {
        KeychainHelperOperation::Load { account } => {
            validate_account(&account).and_then(|()| match backend.load(&account)? {
                Some(json) => {
                    let session: StoredSession = serde_json::from_str(&json)
                        .map_err(|_| "stored session was not valid JSON".to_string())?;
                    if host_key(&session.target) != account {
                        return Err("stored session account did not match its target".to_string());
                    }
                    Ok(Some(session))
                }
                None => Ok(None),
            })
        }
        KeychainHelperOperation::Save { account, session } => {
            validate_account(&account).and_then(|()| {
                if host_key(&session.target) != account {
                    return Err("session target did not match its Keychain account".to_string());
                }
                let json = serde_json::to_string(&session)
                    .map_err(|_| "session could not be encoded".to_string())?;
                backend.save(&account, &json)?;
                Ok(None)
            })
        }
        KeychainHelperOperation::Clear { account } => validate_account(&account)
            .and_then(|()| backend.clear(&account))
            .map(|()| None),
        KeychainHelperOperation::Probe => {
            let account = format!("__decocms_helper_probe_{}__", uuid::Uuid::new_v4());
            let secret = uuid::Uuid::new_v4().to_string();
            backend.save(&account, &secret).and_then(|()| {
                let loaded = backend.load(&account);
                let clear_result = backend.clear(&account);
                let loaded = match loaded {
                    Ok(loaded) => loaded,
                    Err(error) => {
                        let _ = clear_result;
                        return Err(error);
                    }
                };
                if loaded.as_deref() != Some(secret.as_str()) {
                    let _ = clear_result;
                    return Err("helper probe read did not match its write".to_string());
                }
                clear_result?;
                Ok(None)
            })
        }
    };

    match result {
        Ok(session) => KeychainHelperResponse::success(session),
        Err(message) => KeychainHelperResponse::error(message),
    }
}

/// Serves exactly one request, then exits. The bounded input prevents an
/// accidentally connected stream from growing the helper process without
/// limit. Parse failures deliberately return a generic message so malformed
/// input can never be reflected into a log by a caller.
pub fn serve_stdio() -> std::io::Result<()> {
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_PROTOCOL_BYTES + 1)
        .read_to_end(&mut input)?;

    let response = if input.len() as u64 > MAX_PROTOCOL_BYTES {
        KeychainHelperResponse::error("helper request exceeded the size limit")
    } else {
        match serde_json::from_slice::<KeychainHelperRequest>(&input) {
            Ok(request) => handle_request(&SystemCredentialBackend, request),
            Err(_) => KeychainHelperResponse::error("invalid helper request"),
        }
    };

    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, &response)?;
    output.write_all(b"\n")?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::UserInfo;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryCredentialBackend {
        values: Mutex<HashMap<String, String>>,
    }

    impl CredentialBackend for MemoryCredentialBackend {
        fn load(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.values.lock().unwrap().get(account).cloned())
        }

        fn save(&self, account: &str, secret: &str) -> Result<(), String> {
            self.values
                .lock()
                .unwrap()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }

        fn clear(&self, account: &str) -> Result<(), String> {
            self.values.lock().unwrap().remove(account);
            Ok(())
        }
    }

    fn session() -> StoredSession {
        StoredSession {
            target: "https://studio.decocms.com".to_string(),
            client_id: "client".to_string(),
            user: UserInfo {
                sub: "user".to_string(),
                email: Some("dev@example.com".to_string()),
                name: Some("Dev".to_string()),
            },
            access_token: "access-secret".to_string(),
            refresh_token: Some("refresh-secret".to_string()),
            expires_at: Some(1_000_000),
            created_at: "2026-07-23T00:00:00Z".to_string(),
            cookie: Some("better-auth.session_token=cookie-secret".to_string()),
        }
    }

    #[test]
    fn protocol_round_trips_load_save_and_clear() {
        let backend = MemoryCredentialBackend::default();
        let account = "studio.decocms.com";
        let expected = session();

        assert_eq!(
            handle_request(
                &backend,
                KeychainHelperRequest::save(account, expected.clone())
            ),
            KeychainHelperResponse::success(None)
        );
        assert_eq!(
            handle_request(&backend, KeychainHelperRequest::load(account)),
            KeychainHelperResponse::success(Some(expected))
        );
        assert_eq!(
            handle_request(&backend, KeychainHelperRequest::clear(account)),
            KeychainHelperResponse::success(None)
        );
        assert_eq!(
            handle_request(&backend, KeychainHelperRequest::load(account)),
            KeychainHelperResponse::success(None)
        );
    }

    #[test]
    fn flattened_wire_types_serialize_and_deserialize() {
        let request = KeychainHelperRequest::save("studio.decocms.com", session());
        let request_json = serde_json::to_vec(&request).unwrap();
        assert_eq!(
            serde_json::from_slice::<KeychainHelperRequest>(&request_json).unwrap(),
            request
        );

        let response = KeychainHelperResponse::success(None);
        let response_json = serde_json::to_vec(&response).unwrap();
        assert_eq!(
            serde_json::from_slice::<KeychainHelperResponse>(&response_json).unwrap(),
            response
        );
    }

    #[test]
    fn save_rejects_an_account_that_does_not_match_the_session_target() {
        let response = handle_request(
            &MemoryCredentialBackend::default(),
            KeychainHelperRequest::save("attacker.invalid", session()),
        );
        assert!(matches!(
            response.outcome,
            KeychainHelperOutcome::Error { message }
                if message == "session target did not match its Keychain account"
        ));
    }

    #[test]
    fn protocol_rejects_unknown_versions_and_control_characters() {
        let backend = MemoryCredentialBackend::default();
        let mut request = KeychainHelperRequest::load("studio.decocms.com");
        request.version += 1;
        assert!(matches!(
            handle_request(&backend, request).outcome,
            KeychainHelperOutcome::Error { message }
                if message == "unsupported helper protocol version"
        ));
        assert!(matches!(
            handle_request(&backend, KeychainHelperRequest::load("bad\naccount")).outcome,
            KeychainHelperOutcome::Error { message } if message == "invalid Keychain account"
        ));
    }

    #[test]
    fn probe_leaves_no_persisted_entry() {
        let backend = MemoryCredentialBackend::default();
        let response = handle_request(
            &backend,
            KeychainHelperRequest {
                version: KEYCHAIN_HELPER_PROTOCOL_VERSION,
                operation: KeychainHelperOperation::Probe,
            },
        );
        assert_eq!(response, KeychainHelperResponse::success(None));
        assert!(backend.values.lock().unwrap().is_empty());
    }

    #[test]
    fn probe_clears_its_entry_even_when_the_read_fails() {
        struct LoadFailingBackend(MemoryCredentialBackend);

        impl CredentialBackend for LoadFailingBackend {
            fn load(&self, _account: &str) -> Result<Option<String>, String> {
                Err("probe read failed".to_string())
            }

            fn save(&self, account: &str, secret: &str) -> Result<(), String> {
                self.0.save(account, secret)
            }

            fn clear(&self, account: &str) -> Result<(), String> {
                self.0.clear(account)
            }
        }

        let backend = LoadFailingBackend(MemoryCredentialBackend::default());
        let response = handle_request(
            &backend,
            KeychainHelperRequest {
                version: KEYCHAIN_HELPER_PROTOCOL_VERSION,
                operation: KeychainHelperOperation::Probe,
            },
        );
        assert!(matches!(
            response.outcome,
            KeychainHelperOutcome::Error { message } if message == "probe read failed"
        ));
        assert!(backend.0.values.lock().unwrap().is_empty());
    }
}
