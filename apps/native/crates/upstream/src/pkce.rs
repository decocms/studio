//! OAuth 2.1 + PKCE (RFC 7636) code-verifier / code-challenge generation.
//! Port of `apps/api/src/cli/lib/pkce.ts::generatePkcePair` — same shape
//! (32 random bytes -> base64url verifier; `S256` challenge = base64url of
//! the verifier's SHA-256 digest), same "generate a fresh pair per login
//! attempt" call site (`login.rs`).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

pub struct PkcePair {
    /// Sent to the token endpoint (`code_verifier`) to prove possession of
    /// the same secret that produced `challenge`. Never sent to the
    /// authorize endpoint or the browser.
    pub verifier: String,
    /// Sent up-front in the authorize URL (`code_challenge`,
    /// `code_challenge_method=S256`).
    pub challenge: String,
}

/// Generates a fresh, high-entropy verifier (32 random bytes, base64url —
/// 43 characters, well within RFC 7636's 43-128 char requirement) and its
/// derived `S256` challenge.
pub fn generate() -> PkcePair {
    let mut raw = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut raw);
    let verifier = base64_url_no_pad(&raw);
    let challenge = challenge_for(&verifier);
    PkcePair {
        verifier,
        challenge,
    }
}

/// `code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))` per
/// RFC 7636 §4.2 — split out from [`generate`] so it's independently
/// testable against the RFC's Appendix B worked example.
pub fn challenge_for(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64_url_no_pad(&digest)
}

fn base64_url_no_pad(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7636 Appendix B's worked example — the one pinned, external
    /// source-of-truth test vector for the S256 transform.
    #[test]
    fn matches_rfc_7636_appendix_b_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = challenge_for(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn generated_verifier_is_43_chars_of_the_unreserved_alphabet() {
        let pair = generate();
        assert_eq!(
            pair.verifier.len(),
            43,
            "32 random bytes -> 43 base64url chars, no padding"
        );
        assert!(pair
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn generated_challenge_matches_generated_verifier() {
        let pair = generate();
        assert_eq!(challenge_for(&pair.verifier), pair.challenge);
    }

    #[test]
    fn two_generated_pairs_never_collide() {
        let a = generate();
        let b = generate();
        assert_ne!(
            a.verifier, b.verifier,
            "verifier must be freshly random per pair"
        );
        assert_ne!(a.challenge, b.challenge);
    }

    #[test]
    fn base64url_output_never_contains_padding_or_url_unsafe_chars() {
        let pair = generate();
        for s in [&pair.verifier, &pair.challenge] {
            assert!(!s.contains('='), "must be unpadded");
            assert!(
                !s.contains('+') && !s.contains('/'),
                "must be URL-safe alphabet"
            );
        }
    }
}
