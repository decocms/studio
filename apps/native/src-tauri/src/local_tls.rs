//! Per-machine TLS material for the local control UI and sandbox previews.
//!
//! ## Why the app needs HTTPS at all
//!
//! Nothing here is about protecting traffic — it never leaves the machine.
//! It is about the origin the webview runs on, which has to satisfy two rules
//! that pull in opposite directions:
//!
//! 1. **Per-sandbox cookie jars.** Cookies ignore the port (RFC 6265 §8.5), so
//!    serving every sandbox from `localhost` put them all in one jar: the
//!    control session cookie reached every sandbox's dev server, and one
//!    sandbox's cookies reached the next. Fixing that needs a distinct HOST
//!    per sandbox, under a domain the browser groups as one site — measured in
//!    WebKit, `*.localhost` does NOT group (each is its own site, and the
//!    preview iframe then stores no cookies at all). See
//!    [`crate::control_origin`].
//! 2. **Secure context.** `localhost` is on the browser's hardcoded
//!    potentially-trustworthy list; a real domain over plain http is not. Move
//!    off `localhost` and `crypto.randomUUID` (62 call sites) and
//!    `crypto.subtle` (the PKCE challenge in `packages/runtime`) disappear and
//!    the shell fails to boot.
//!
//! A real domain satisfies (1) and only TLS restores (2), so the app
//! terminates HTTPS locally.
//!
//! ## Why generate rather than ship
//!
//! A wildcard certificate bundled with the app would need its private key on
//! every user's disk — extractable, and therefore public in practice. Minting
//! a CA per machine keeps every private key local to the machine that made it:
//! a leak compromises one laptop's loopback, not the domain.
//!
//! The user is asked to trust the ROOT once. Only the root persists; the leaf
//! is re-minted on every launch (Apple rejects TLS leaves valid for more than
//! 398 days, and minting costs milliseconds), so the app can never serve an
//! expired certificate to its own webview and never prompts twice.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose, SanType,
};
use time::{Duration, OffsetDateTime};

use crate::control_origin::CONTROL_HOST;

/// Apple refuses a TLS server certificate valid for more than 398 days, so the
/// leaf is re-minted well inside that. The root is not a server certificate
/// and is not subject to it.
const LEAF_DAYS: i64 = 390;
const ROOT_DAYS: i64 = 3650;

#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    #[error("could not create the certificate directory {path}: {source}")]
    CreateDir {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("could not read or write {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("could not generate local TLS material: {0}")]
    Generate(#[from] rcgen::Error),
    #[error("could not ask macOS to trust the local CA: {0}")]
    Trust(String),
}

/// Paths to the material the listeners serve, all inside the app data dir.
pub struct LocalTls {
    pub ca_cert: PathBuf,
    pub leaf_cert: PathBuf,
    pub leaf_key: PathBuf,
}

/// Ensure a usable CA + leaf exist under `app_root`: the CA is reused across
/// launches, the leaf is always freshly minted. Does NOT install trust — see
/// [`ensure_trusted`].
pub fn ensure(app_root: &Path) -> Result<LocalTls, TlsError> {
    let dir = app_root.join("tls");
    fs::create_dir_all(&dir).map_err(|source| TlsError::CreateDir {
        path: dir.clone(),
        source,
    })?;

    let paths = LocalTls {
        ca_cert: dir.join("ca-cert.pem"),
        leaf_cert: dir.join("leaf-cert.pem"),
        leaf_key: dir.join("leaf-key.pem"),
    };
    let ca_key = dir.join("ca-key.pem");

    // The CA is only regenerated when it is missing outright. Rotating it
    // would silently invalidate the trust the user already granted, which
    // presents as an unexplained TLS failure rather than a new prompt.
    let (ca_params, ca_keypair) = if paths.ca_cert.exists() && ca_key.exists() {
        let key_pem = read(&ca_key)?;
        let keypair = KeyPair::from_pem(&key_pem)?;
        (ca_params()?, keypair)
    } else {
        let keypair = KeyPair::generate()?;
        let params = ca_params()?;
        let cert = params.self_signed(&keypair)?;
        write(&paths.ca_cert, cert.pem().as_bytes())?;
        write_private(&ca_key, keypair.serialize_pem().as_bytes())?;
        (ca_params()?, keypair)
    };
    let ca_cert = ca_params.self_signed(&ca_keypair)?;

    // Minted fresh on every launch rather than cached with a renewal window:
    // it costs milliseconds, and it removes an entire class of "the app served
    // an expired certificate to its own webview" bug. Only the ROOT persists,
    // because only the root carries trust the user granted.
    let leaf_keypair = KeyPair::generate()?;
    let leaf = leaf_params()?.signed_by(&leaf_keypair, &ca_cert, &ca_keypair)?;
    write(&paths.leaf_cert, leaf.pem().as_bytes())?;
    write_private(&paths.leaf_key, leaf_keypair.serialize_pem().as_bytes())?;
    Ok(paths)
}

fn ca_params() -> Result<CertificateParams, rcgen::Error> {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "deco Studio Local Development CA");
    dn.push(DnType::OrganizationName, "deco Studio");
    params.distinguished_name = dn;
    // `pathlen:0` — this CA may sign leaves and nothing else, so a stolen key
    // cannot be used to mint further CAs.
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.not_before = OffsetDateTime::now_utc() - Duration::days(1);
    params.not_after = OffsetDateTime::now_utc() + Duration::days(ROOT_DAYS);
    Ok(params)
}

fn leaf_params() -> Result<CertificateParams, rcgen::Error> {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, CONTROL_HOST);
    params.distinguished_name = dn;
    params.is_ca = IsCa::NoCa;
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let mut sans = vec![
        SanType::DnsName(CONTROL_HOST.try_into()?),
        // One label under the control host: every sandbox preview.
        SanType::DnsName(format!("*.{CONTROL_HOST}").try_into()?),
    ];
    // Kept so the old origin still serves during a rollback, unless it IS the
    // control host — a duplicate SAN is just noise.
    if CONTROL_HOST != "localhost" {
        sans.push(SanType::DnsName("localhost".try_into()?));
    }
    sans.push(SanType::IpAddress(std::net::IpAddr::from([127, 0, 0, 1])));
    params.subject_alt_names = sans;
    params.not_before = OffsetDateTime::now_utc() - Duration::days(1);
    params.not_after = OffsetDateTime::now_utc() + Duration::days(LEAF_DAYS);
    Ok(params)
}

/// Ask macOS to trust the local CA, if it does not already.
///
/// Writes to the USER trust domain, not the admin one: the effect is identical
/// for this user and it needs only their own password or Touch ID, where the
/// system keychain would demand an administrator. Idempotent — an
/// already-trusted CA returns without prompting.
pub fn ensure_trusted(ca_cert: &Path) -> Result<(), TlsError> {
    if is_trusted(ca_cert) {
        return Ok(());
    }
    let login_keychain = login_keychain_path();
    let output = Command::new("security")
        .arg("add-trusted-cert")
        .arg("-r")
        .arg("trustRoot")
        .arg("-k")
        .arg(&login_keychain)
        .arg(ca_cert)
        .output()
        .map_err(|source| TlsError::Trust(source.to_string()))?;
    if output.status.success() {
        return Ok(());
    }
    Err(TlsError::Trust(
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    ))
}

/// Whether the CA already verifies as an SSL root for this user.
fn is_trusted(ca_cert: &Path) -> bool {
    Command::new("security")
        .arg("verify-cert")
        .arg("-c")
        .arg(ca_cert)
        .arg("-p")
        .arg("ssl")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn login_keychain_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("Library/Keychains/login.keychain-db")
}

fn read(path: &Path) -> Result<String, TlsError> {
    fs::read_to_string(path).map_err(|source| TlsError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn write(path: &Path, bytes: &[u8]) -> Result<(), TlsError> {
    fs::write(path, bytes).map_err(|source| TlsError::Io {
        path: path.to_path_buf(),
        source,
    })
}

/// Private keys are written `0600`. They never leave this machine, and nothing
/// else on it has any business reading them.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), TlsError> {
    write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|source| {
            TlsError::Io {
                path: path.to_path_buf(),
                source,
            }
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Apple rejects a TLS server certificate valid for more than 398 days, so
    /// a leaf that drifts past it fails as an untrusted connection rather than
    /// as anything that names the real cause.
    #[test]
    fn the_leaf_stays_inside_apples_validity_limit() {
        let params = leaf_params().expect("params");
        let validity = params.not_after - params.not_before;
        assert!(
            validity < Duration::days(398),
            "leaf valid for {validity:?}, which macOS rejects for serverAuth"
        );
        // The root is not a server certificate and is deliberately long-lived,
        // because re-minting it would invalidate the trust the user granted.
        let root = ca_params().expect("params");
        assert!(root.not_after - root.not_before > Duration::days(398));
    }

    /// The whole point of generating per machine: the leaf must cover both the
    /// control host and every one-label preview host under it.
    #[test]
    fn the_leaf_covers_the_control_host_and_its_preview_wildcard() {
        let params = leaf_params().expect("params");
        let names: Vec<String> = params
            .subject_alt_names
            .iter()
            .map(|san| format!("{san:?}"))
            .collect();
        let joined = names.join(" ");
        assert!(joined.contains(CONTROL_HOST), "{joined}");
        assert!(joined.contains(&format!("*.{CONTROL_HOST}")), "{joined}");
    }

    /// A CA that could mint further CAs would turn one stolen laptop key into
    /// a general-purpose signing authority.
    #[test]
    fn the_local_ca_cannot_issue_intermediate_cas() {
        let params = ca_params().expect("params");
        assert!(matches!(
            params.is_ca,
            IsCa::Ca(BasicConstraints::Constrained(0))
        ));
    }
}
