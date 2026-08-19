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
//! a CA per machine keeps every private key local to the machine that made it.
//!
//! The root's DNS name form is NAME-CONSTRAINED to the control domain and
//! `localhost`, and its trust is scoped to the SSL policy at install time
//! (`add-trusted-cert -p ssl`). Both matter: without them a stolen
//! `ca-key.pem` — readable by any process running as this user, including
//! code the app itself runs in sandboxes — would be a general-purpose
//! authority for every TLS connection this user makes. The IP name form must
//! remain unrestricted for BoringSSL compatibility, as detailed below, so a
//! leaked key still could sign trusted leaves for arbitrary IP addresses.
//!
//! Only the root persists; the leaf is re-minted on every launch (Apple
//! rejects TLS leaves valid for more than 398 days, and minting costs
//! milliseconds), so the app can never serve an expired certificate to its own
//! webview.
//!
//! ## Trust has two arms, and only one of them is an OS-level change
//!
//! **macOS**: the root is installed into the user's login keychain
//! ([`ensure_trusted`]), which asks once and then covers the webview and every
//! child that verifies against the keychain. Because the root persists, the
//! prompt never repeats.
//!
//! **Linux**: nothing is installed and the user is never prompted. An AppImage
//! has no install hook to add a system anchor from, so the webview instead
//! gets a per-host exception registered in-process before its first
//! navigation, and children get [`ensure_child_ca_bundle`]'s superset store.
//! Neither outlives the process.

use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;

use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose,
    GeneralSubtree, IsCa, KeyPair, KeyUsagePurpose, NameConstraints, SanType,
};
use time::{Duration, OffsetDateTime};

use crate::control_origin::CONTROL_HOST;

/// Apple refuses a TLS server certificate valid for more than 398 days, so the
/// leaf is re-minted well inside that. The root is not a server certificate
/// and is not subject to it.
const LEAF_DAYS: i64 = 390;
const ROOT_DAYS: i64 = 3650;

/// Bumped when the ROOT's shape changes in a way that requires re-minting it
/// (v2 added the name constraints, v3 removed the IP subtree from them). A
/// mismatch regenerates the CA and asks for trust again — one explainable
/// prompt, instead of silently keeping an unconstrained root forever.
const CA_VERSION: &str = "3";
const CA_VERSION_FILE: &str = "ca-version";

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
    /// The PEM of the root that ACTUALLY signed this launch's leaf.
    ///
    /// Not the same thing as reading [`Self::ca_cert`] back: the reuse path
    /// below existence-checks that file and never opens it, re-deriving the
    /// issuer from `ca-key.pem` instead. A truncated `ca-cert.pem`, or the
    /// cert/key skew a crash between the two writes leaves behind, would make
    /// the file name a root that signed nothing.
    ///
    /// Scope, precisely: this covers [`ensure_child_ca_bundle`] and nothing
    /// else. It does NOT make the on-disk file unused — `setup.rs` still puts
    /// [`Self::ca_cert`], the PATH, in `local_api::TlsFiles::ca`, which
    /// becomes `MountCredentials::ca_cert` and is exported to children as
    /// `NODE_EXTRA_CA_CERTS` (`local-api`'s `terminal::launch_context`). That
    /// is the claude CLI's only trust path for the local origin, and it reads
    /// the file. So a skewed `ca-cert.pem` still breaks that consumer; what
    /// this field buys is that the REPLACEMENT store handed to `SSL_CERT_FILE`
    /// consumers can no longer be silently built without the real issuer.
    /// Writing a per-boot `ca-current.pem` for the path-taking consumers too
    /// is the fix for the rest, and is deliberately not attempted here.
    pub ca_pem: String,
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

    let mut paths = LocalTls {
        ca_cert: dir.join("ca-cert.pem"),
        leaf_cert: dir.join("leaf-cert.pem"),
        leaf_key: dir.join("leaf-key.pem"),
        ca_pem: String::new(),
    };
    let ca_key = dir.join("ca-key.pem");

    // The CA is regenerated only when it is missing outright or its VERSION
    // is behind (a shape change like adding name constraints). Casual rotation
    // would silently invalidate the trust the user already granted, which
    // presents as an unexplained TLS failure rather than a new prompt — but
    // keeping an unconstrained root to avoid one prompt is the wrong trade.
    let version_path = dir.join(CA_VERSION_FILE);
    let version_current = std::fs::read_to_string(&version_path)
        .map(|value| value.trim() == CA_VERSION)
        .unwrap_or(false);
    let (ca_params, ca_keypair) = if paths.ca_cert.exists() && ca_key.exists() && version_current {
        let key_pem = read(&ca_key)?;
        let keypair = KeyPair::from_pem(&key_pem)?;
        (ca_params()?, keypair)
    } else {
        // Retire the outgoing root's trust before overwriting its file —
        // after the overwrite there is nothing left to name it by. Best
        // effort: a failure leaves a stale trusted cert, which the new
        // prompt supersedes for every name this app uses. Nothing to retire
        // where trust was never installed into the OS at all.
        #[cfg(target_os = "macos")]
        if paths.ca_cert.exists() {
            let _ = Command::new("security")
                .arg("remove-trusted-cert")
                .arg(&paths.ca_cert)
                .output();
        }
        let keypair = KeyPair::generate()?;
        let params = ca_params()?;
        let cert = params.self_signed(&keypair)?;
        write(&paths.ca_cert, cert.pem().as_bytes())?;
        write_private(&ca_key, keypair.serialize_pem().as_bytes())?;
        write(&version_path, CA_VERSION.as_bytes())?;
        (ca_params()?, keypair)
    };
    let ca_cert = ca_params.self_signed(&ca_keypair)?;
    paths.ca_pem = ca_cert.pem();

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
    // `pathlen:0` stops intermediate minting; the NAME constraints stop the
    // far worse thing — a stolen key minting a trusted leaf for an arbitrary
    // host. DNS subtrees ONLY, deliberately: BoringSSL rejects any chain whose
    // CA carries an IP-address subtree (`UNSUPPORTED_CONSTRAINT_TYPE`), and
    // the claude CLI is a Bun/BoringSSL binary — with an IP subtree here it
    // cannot reach the agent MCP even when handed this CA explicitly. Leaving
    // the IP FORM unconstrained is how the leaf's `127.0.0.1` SAN stays valid
    // (RFC 5280 §4.2.1.10: a name form absent from the constraints is
    // unrestricted), which does concede that a stolen key could mint a
    // trusted leaf for an arbitrary IP — but browsers connect by the DNS
    // names, and those stay pinned to this app's own hosts.
    params.name_constraints = Some(NameConstraints {
        permitted_subtrees: vec![
            GeneralSubtree::DnsName(CONTROL_HOST.to_string()),
            GeneralSubtree::DnsName("localhost".to_string()),
        ],
        excluded_subtrees: Vec::new(),
    });
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
    // Multiple app namespaces can leave same-subject roots in the Keychain.
    // AKI makes every verifier choose this launch's issuer deterministically.
    params.use_authority_key_identifier_extension = true;
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
#[cfg(target_os = "macos")]
pub fn ensure_trusted(ca_cert: &Path) -> Result<(), TlsError> {
    if is_trusted(ca_cert) {
        return Ok(());
    }
    let login_keychain = login_keychain_path();
    let output = Command::new("security")
        .arg("add-trusted-cert")
        // Trust for the SSL policy ONLY. Without `-p`, the root would be
        // trusted for code signing, S/MIME and everything else — none of
        // which this CA has any business vouching for.
        .arg("-p")
        .arg("ssl")
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
#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
fn login_keychain_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("Library/Keychains/login.keychain-db")
}

/// Where a system root store is looked for, in order. First match wins.
///
/// An admin-set `$SSL_CERT_FILE` is preferred over all of these — see
/// [`ensure_child_ca_bundle`].
#[cfg(target_os = "linux")]
const SYSTEM_CA_BUNDLES: &[&str] = &[
    // Debian / Ubuntu / Arch
    "/etc/ssl/certs/ca-certificates.crt",
    // Fedora / RHEL (extracted)
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    // Fedora / RHEL (compat)
    "/etc/pki/tls/certs/ca-bundle.crt",
    // openSUSE
    "/etc/ssl/ca-bundle.pem",
    // Alpine
    "/etc/ssl/cert.pem",
];

/// Build the SUPERSET store spawned CLIs are pointed at with
/// `SSL_CERT_FILE` — every public root the host trusts, plus the local CA —
/// returning its path, or `None` when there is nothing to build it from.
///
/// FAILS CLOSED, and that is the whole design: `SSL_CERT_FILE` REPLACES a
/// Go or rustls-native-certs consumer's root store rather than extending it
/// (see `crates/local-api/src/terminal/launch_context.rs`'s
/// `SSL_CERT_FILE_ENV`). Writing a file holding only
/// the local CA would therefore trade "the child cannot reach the LOCAL MCP
/// origin" for "the child cannot reach the public internet" — strictly worse,
/// and silently so. When no system store is found the caller exports nothing.
///
/// Rewritten on every boot rather than cached, so a rotated local CA and a
/// distro's `update-ca-certificates` both land without any invalidation
/// story. Plain (not `0600`) write: the contents are public certificates.
///
/// Takes [`LocalTls::ca_pem`], NOT the `ca-cert.pem` path: `ensure` never
/// reads that file back on its reuse path, so a truncated or key-skewed one
/// would produce a bundle of public roots WITHOUT the root that signed this
/// launch's leaf — and both this function and `ensure` would still return
/// `Ok`, so the `SSL_CERT_FILE` consumers would fail to verify the local
/// origin with no error at boot. Scoped to those consumers only: the ones
/// pointed at `NODE_EXTRA_CA_CERTS` still read `ca-cert.pem` itself, so this
/// does not harden them — see [`LocalTls::ca_pem`].
#[cfg(target_os = "linux")]
pub fn ensure_child_ca_bundle(app_root: &Path, ca_pem: &str) -> Result<Option<PathBuf>, TlsError> {
    let Some(body) = child_ca_bundle_body(system_ca_bundle().as_deref(), ca_pem) else {
        return Ok(None);
    };
    let dir = app_root.join("tls");
    fs::create_dir_all(&dir).map_err(|source| TlsError::CreateDir {
        path: dir.clone(),
        source,
    })?;
    let path = dir.join("ca-bundle.pem");
    write(&path, body.as_bytes())?;
    Ok(Some(path))
}

/// The host's own root store, read: an explicitly configured one first, then
/// the distro defaults. A candidate that cannot be read, or that holds
/// nothing, is skipped rather than failing — the next one may work, and no
/// store at all is an outcome this design handles.
#[cfg(target_os = "linux")]
fn system_ca_bundle() -> Option<String> {
    let configured =
        std::env::var_os("SSL_CERT_FILE").and_then(|path| read_store(Path::new(&path)));
    if configured.is_some() {
        return configured;
    }
    for candidate in SYSTEM_CA_BUNDLES {
        if let Some(pem) = read_store(Path::new(candidate)) {
            return Some(pem);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn read_store(path: &Path) -> Option<String> {
    let pem = fs::read_to_string(path).ok()?;
    let mut reader = pem.as_bytes();
    let has_certificate = rustls_pemfile::certs(&mut reader).any(|certificate| certificate.is_ok());
    has_certificate.then_some(pem)
}

/// The bundle's contents, or `None` when there is no system store to be a
/// superset OF. Pure, and compiled on every OS, so the refusal is pinned by a
/// test wherever this crate is built.
#[cfg(any(test, target_os = "linux"))]
fn child_ca_bundle_body(system_pem: Option<&str>, local_pem: &str) -> Option<String> {
    let system_pem = system_pem?;
    // A store that exists but is empty is the same hazard as no store: what
    // would be written is our CA alone.
    if system_pem.trim().is_empty() {
        return None;
    }
    Some(concat_pem(system_pem, local_pem))
}

/// Joins two PEM documents, normalizing the seam: a store whose first
/// certificate's `-----END-----` shares a line with the next one's
/// `-----BEGIN-----` parses as neither.
#[cfg(any(test, target_os = "linux"))]
fn concat_pem(first: &str, second: &str) -> String {
    let mut joined = String::with_capacity(first.len() + second.len() + 2);
    joined.push_str(first.trim_end());
    joined.push('\n');
    joined.push_str(second.trim_end());
    joined.push('\n');
    joined
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

    #[test]
    fn the_leaf_identifies_its_issuer_key() {
        let params = leaf_params().expect("params");
        assert!(
            params.use_authority_key_identifier_extension,
            "without an authority key identifier, TLS verifiers can choose a stale same-name Studio root"
        );
    }

    /// The name constraints prevent a stolen `ca-key.pem` from minting a
    /// trusted leaf for arbitrary DNS hosts this user's browsers will accept.
    /// They do not constrain IP-address leaves.
    ///
    /// DNS subtrees only — an IP subtree is a poison pill for BoringSSL
    /// verifiers (`UNSUPPORTED_CONSTRAINT_TYPE`), and the claude CLI is one.
    /// Reintroducing it would cut the agent MCP off from every claude thread
    /// again, so its absence is pinned as hard as the constraints themselves.
    #[test]
    fn the_ca_is_name_constrained_to_dns_names_only() {
        let params = ca_params().expect("params");
        let constraints = params
            .name_constraints
            .as_ref()
            .expect("the CA must carry name constraints");
        assert!(constraints.excluded_subtrees.is_empty());
        let rendered = format!("{:?}", constraints.permitted_subtrees);
        assert!(rendered.contains(CONTROL_HOST), "{rendered}");
        assert!(rendered.contains("localhost"), "{rendered}");
        assert!(
            constraints
                .permitted_subtrees
                .iter()
                .all(|subtree| matches!(subtree, GeneralSubtree::DnsName(_))),
            "non-DNS subtree would make BoringSSL clients reject the whole chain: {rendered}"
        );
        // Exactly the leaf's DNS names, nothing else: a new SAN on the leaf
        // must consciously widen the constraint too.
        assert_eq!(constraints.permitted_subtrees.len(), 2, "{rendered}");
    }

    const SYSTEM_PEM: &str = "-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----\n";
    const LOCAL_PEM: &str = "-----BEGIN CERTIFICATE-----\nlocal\n-----END CERTIFICATE-----\n";

    #[cfg(target_os = "linux")]
    #[test]
    fn system_store_candidates_must_contain_a_parseable_certificate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("ca-bundle.pem");
        fs::write(&path, "-----BEGIN CERTIFICATE-----\ntruncated").expect("write malformed");
        assert_eq!(read_store(&path), None);

        let certified =
            rcgen::generate_simple_self_signed(vec!["example.test".to_string()]).expect("cert");
        fs::write(&path, certified.cert.pem()).expect("write certificate");
        assert!(read_store(&path).is_some());
    }

    /// The refusal is the point. `SSL_CERT_FILE` REPLACES the child's root
    /// store, so a bundle built without a system store would hold our CA
    /// ALONE — trading the local MCP origin for the entire public internet,
    /// silently. No system store must mean no file and no variable.
    #[test]
    fn no_system_store_means_no_bundle_rather_than_a_local_ca_only_one() {
        assert_eq!(child_ca_bundle_body(None, LOCAL_PEM), None);
        // A store that exists but holds nothing is the same hazard wearing a
        // different shape.
        assert_eq!(child_ca_bundle_body(Some(""), LOCAL_PEM), None);
        assert_eq!(child_ca_bundle_body(Some(" \n\t "), LOCAL_PEM), None);
    }

    /// A superset, in that order, with a seam the parser can survive: an
    /// `-----END-----` sharing its line with the next `-----BEGIN-----`
    /// parses as neither certificate.
    #[test]
    fn the_bundle_is_every_public_root_plus_ours() {
        let bundle = child_ca_bundle_body(Some(SYSTEM_PEM), LOCAL_PEM).expect("a bundle");
        assert_eq!(bundle, format!("{SYSTEM_PEM}{LOCAL_PEM}"));

        // Whatever the inputs' trailing whitespace, exactly one newline joins
        // them and exactly one terminates the file.
        let ragged = concat_pem("-----END A-----\n\n\n", "-----BEGIN B-----");
        assert_eq!(ragged, "-----END A-----\n-----BEGIN B-----\n");
        assert_eq!(concat_pem("a", "b"), "a\nb\n");
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
