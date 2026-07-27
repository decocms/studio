//! Model-tier tables — ported VERBATIM (same ids/labels) from
//! `packages/harness/src/{claude-code,codex}/model/agent-tiers.ts`
//! (`CLAUDE_CODE_TIERS` / `CODEX_TIERS`, keyed by `ChatTier =
//! "fast"|"smart"|"thinking"`), plus the composite-id → CLI `--model` flag
//! resolvers ported from
//! `packages/harness/src/{claude-code,codex}/model/index.ts`
//! (`resolveClaudeCodeModelId` / `resolveCodexModelId`).
//!
//! This is the canonical Rust copy — `crates/local-api/src/routes/models.rs`
//! (`GET /models`) and `crates/harness/src/run.rs` (building the CLI's
//! `--model` argument) both read through here so the two can never drift
//! independently the way two hand-duplicated copies eventually would.
//!
//! Cross-language duplication point: this table is hand-transcribed from
//! the TS source above, not generated. If a build-time codegen step
//! (TS → Rust literal) is ever wanted, that's a `Cargo.toml`/build-script
//! change — an interface request against the workspace owner, not
//! something this crate's implementer should add unilaterally (see
//! the native module-ownership contract's "Models / Tiers" section).

use serde::Serialize;

use crate::resolve::HarnessId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ModelTier {
    pub id: &'static str,
    pub label: &'static str,
}

/// Order matches `ChatTier` fast → smart → thinking, which is also the
/// order the contract doc's `GET /models` example JSON uses.
pub const CLAUDE_CODE_TIERS: [ModelTier; 3] = [
    ModelTier {
        id: "claude-code:haiku",
        label: "Haiku 4.5",
    },
    ModelTier {
        id: "claude-code:sonnet",
        label: "Sonnet 5",
    },
    ModelTier {
        id: "claude-code:opus-1m",
        label: "Opus 4.8 1M",
    },
];

pub const CODEX_TIERS: [ModelTier; 3] = [
    ModelTier {
        id: "codex:gpt-5.6-luna",
        label: "GPT-5.6 Luna",
    },
    ModelTier {
        id: "codex:gpt-5.6-terra",
        label: "GPT-5.6 Terra",
    },
    ModelTier {
        id: "codex:gpt-5.6-sol",
        label: "GPT-5.6 Sol",
    },
];

/// The static tier catalog for `harness` (fast, smart, thinking order).
pub fn tiers_for(harness: HarnessId) -> &'static [ModelTier; 3] {
    match harness {
        HarnessId::ClaudeCode => &CLAUDE_CODE_TIERS,
        HarnessId::Codex => &CODEX_TIERS,
    }
}

/// Composite id (`"claude-code:sonnet"`) → the claude CLI's `--model` flag
/// value (`"claude-sonnet-5"`). Mirrors `resolveClaudeCodeModelId`
/// (`packages/harness/src/claude-code/model/index.ts`) EXACTLY, including
/// its passthrough-on-unknown fallback: the ai-sdk-provider-claude-code
/// SDK only recognizes the short aliases "opus"/"sonnet"/"haiku"; models
/// without a short alias use the CLI's full model id.
pub fn resolve_claude_model_id(model_id: &str) -> String {
    match model_id {
        "claude-code:opus" => "opus",
        "claude-code:opus-1m" => "opus[1m]",
        "claude-code:sonnet" => "claude-sonnet-5",
        "claude-code:haiku" => "haiku",
        "claude-code:fable" => "claude-fable-5",
        other => return other.to_string(),
    }
    .to_string()
}

/// Composite id → the codex CLI's `--model` flag value. Mirrors
/// `resolveCodexModelId` (`packages/harness/src/codex/model/index.ts`)
/// EXCEPT that function throws on an unrecognized id; this returns a
/// best-effort fallback (strip the `codex:` prefix) instead. Dispatch's
/// pre-stream gates already validated `models.thinking.id` is *a* string,
/// not that it's a KNOWN one — an unresolvable id here should reach the
/// CLI and let ITS `--model` validation reject it (surfacing as a
/// `harness_crashed` stream error with the CLI's own message), not crash
/// this resolver into a local-api 500.
pub fn resolve_codex_model_id(model_id: &str) -> String {
    match model_id {
        "codex:gpt-5.6-sol" => "gpt-5.6-sol",
        "codex:gpt-5.6-terra" => "gpt-5.6-terra",
        "codex:gpt-5.6-luna" => "gpt-5.6-luna",
        "codex:gpt-5.5" => "gpt-5.5",
        "codex:gpt-5.4" => "gpt-5.4",
        "codex:gpt-5.4-mini" => "gpt-5.4-mini",
        "codex:gpt-5.3-codex-spark" => "gpt-5.3-codex-spark",
        other => return other.strip_prefix("codex:").unwrap_or(other).to_string(),
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_order_is_claude_code_then_codex() {
        assert_eq!(HarnessId::ALL[0].wire_id(), "claude-code");
        assert_eq!(HarnessId::ALL[1].wire_id(), "codex");
    }

    #[test]
    fn every_tier_id_is_prefixed_with_its_harness() {
        for harness in HarnessId::ALL {
            for tier in tiers_for(harness) {
                assert!(
                    tier.id.starts_with(&format!("{}:", harness.wire_id())),
                    "{} does not start with {}:",
                    tier.id,
                    harness.wire_id()
                );
                assert!(!tier.label.is_empty());
            }
        }
    }

    #[test]
    fn claude_model_ids_match_agent_tiers_ts_verbatim() {
        assert_eq!(CLAUDE_CODE_TIERS[0].id, "claude-code:haiku");
        assert_eq!(CLAUDE_CODE_TIERS[0].label, "Haiku 4.5");
        assert_eq!(CLAUDE_CODE_TIERS[1].id, "claude-code:sonnet");
        assert_eq!(CLAUDE_CODE_TIERS[1].label, "Sonnet 5");
        assert_eq!(CLAUDE_CODE_TIERS[2].id, "claude-code:opus-1m");
        assert_eq!(CLAUDE_CODE_TIERS[2].label, "Opus 4.8 1M");
    }

    #[test]
    fn codex_model_ids_match_agent_tiers_ts_verbatim() {
        assert_eq!(CODEX_TIERS[0].id, "codex:gpt-5.6-luna");
        assert_eq!(CODEX_TIERS[0].label, "GPT-5.6 Luna");
        assert_eq!(CODEX_TIERS[1].id, "codex:gpt-5.6-terra");
        assert_eq!(CODEX_TIERS[1].label, "GPT-5.6 Terra");
        assert_eq!(CODEX_TIERS[2].id, "codex:gpt-5.6-sol");
        assert_eq!(CODEX_TIERS[2].label, "GPT-5.6 Sol");
    }

    #[test]
    fn resolve_claude_model_id_maps_known_composites() {
        assert_eq!(resolve_claude_model_id("claude-code:opus"), "opus");
        assert_eq!(resolve_claude_model_id("claude-code:opus-1m"), "opus[1m]");
        assert_eq!(
            resolve_claude_model_id("claude-code:sonnet"),
            "claude-sonnet-5"
        );
        assert_eq!(resolve_claude_model_id("claude-code:haiku"), "haiku");
        assert_eq!(
            resolve_claude_model_id("claude-code:fable"),
            "claude-fable-5"
        );
    }

    #[test]
    fn resolve_claude_model_id_passes_through_unknown_ids() {
        assert_eq!(
            resolve_claude_model_id("claude-code:some-future-model"),
            "claude-code:some-future-model"
        );
    }

    #[test]
    fn resolve_codex_model_id_maps_known_composites() {
        assert_eq!(resolve_codex_model_id("codex:gpt-5.6-sol"), "gpt-5.6-sol");
        assert_eq!(
            resolve_codex_model_id("codex:gpt-5.6-terra"),
            "gpt-5.6-terra"
        );
        assert_eq!(resolve_codex_model_id("codex:gpt-5.6-luna"), "gpt-5.6-luna");
    }

    #[test]
    fn resolve_codex_model_id_strips_prefix_for_unknown_ids() {
        assert_eq!(
            resolve_codex_model_id("codex:some-future-model"),
            "some-future-model"
        );
        // No prefix at all — passes through verbatim.
        assert_eq!(resolve_codex_model_id("bare-model-name"), "bare-model-name");
    }

    #[test]
    fn every_tier_composite_id_resolves_to_a_non_empty_cli_model() {
        for tier in CLAUDE_CODE_TIERS {
            assert!(!resolve_claude_model_id(tier.id).is_empty());
        }
        for tier in CODEX_TIERS {
            assert!(!resolve_codex_model_id(tier.id).is_empty());
        }
    }
}
