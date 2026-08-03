//! Port of `packages/sandbox/daemon-go/internal/toolscatalog/catalog.go` — materializes an
//! org's Virtual MCP tool catalog onto the sandbox filesystem (one JSON
//! Schema file per tool under `<repo>/.deco/tools/`) plus the pre-
//! authenticated endpoint file scripts/typegen use to call tools without
//! flags. Byte-parity target for the pure filename-sanitizing logic
//! (`toolCatalogFiles`); the fetch step lives in `mcp_client.rs`.

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

/// Where the catalog lands, relative to the repo root.
pub const CATALOG_DIR: &str = ".deco/tools";
/// The run's pre-authenticated MCP endpoint, written next to the catalog —
/// see `tools-catalog.ts`'s doc comment for why it's a dotfile.
pub const ENDPOINT_FILENAME: &str = ".endpoint.json";

#[derive(Debug, Clone)]
pub struct McpEndpoint {
    pub url: String,
    pub headers: Value,
    pub expires_at: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogTool {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
}

pub struct CatalogFile {
    pub filename: String,
    pub content: String,
}

#[expect(
    clippy::unwrap_used,
    reason = "the pattern is a literal in this file, so `Regex::new` can only fail \
              if THIS SOURCE is wrong — a compile-time mistake a test catches, \
              not a runtime input. `static_regexes_compile` forces every one."
)]
fn sanitize_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[^A-Za-z0-9_.\-]").unwrap())
}

/// One JSON Schema file per tool: `<TOOL>.json` holding `{ name,
/// description?, inputSchema, outputSchema? }`. Distinct tools whose names
/// sanitize to the same filename get a `-2`, `-3`… suffix so no tool is
/// silently dropped; stable for a given input order.
pub fn tool_catalog_files(tools: &[CatalogTool]) -> Vec<CatalogFile> {
    let mut used: HashSet<String> = HashSet::new();
    tools
        .iter()
        .map(|tool| {
            let mut body = serde_json::Map::new();
            body.insert("name".to_string(), Value::String(tool.name.clone()));
            if let Some(desc) = &tool.description {
                if !desc.is_empty() {
                    body.insert("description".to_string(), Value::String(desc.clone()));
                }
            }
            body.insert(
                "inputSchema".to_string(),
                tool.input_schema
                    .clone()
                    .unwrap_or_else(|| json!({"type": "object"})),
            );
            if let Some(out) = &tool.output_schema {
                body.insert("outputSchema".to_string(), out.clone());
            }
            let sanitized = sanitize_re().replace_all(&tool.name, "_").to_string();
            let base = if sanitized.is_empty() {
                "tool".to_string()
            } else {
                sanitized
            };
            let mut filename = format!("{base}.json");
            let mut i = 2_u32;
            while used.contains(&filename) {
                filename = format!("{base}-{i}.json");
                i = i.saturating_add(1);
            }
            used.insert(filename.clone());
            let content = format!(
                "{}\n",
                serde_json::to_string_pretty(&Value::Object(body)).unwrap_or_default()
            );
            CatalogFile { filename, content }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_catalog_files_sanitizes_and_dedupes_names() {
        let tools = vec![
            CatalogTool {
                name: "a/b".to_string(),
                description: None,
                input_schema: None,
                output_schema: None,
            },
            CatalogTool {
                name: "a_b".to_string(),
                description: None,
                input_schema: None,
                output_schema: None,
            },
        ];
        let files = tool_catalog_files(&tools);
        assert_eq!(files[0].filename, "a_b.json");
        assert_eq!(files[1].filename, "a_b-2.json");
    }

    #[test]
    fn tool_catalog_files_defaults_input_schema_to_object() {
        let tools = vec![CatalogTool {
            name: "LIST_CUSTOMERS".to_string(),
            description: Some("List customers".to_string()),
            input_schema: None,
            output_schema: None,
        }];
        let files = tool_catalog_files(&tools);
        let parsed: Value = serde_json::from_str(&files[0].content).unwrap();
        assert_eq!(parsed["name"], "LIST_CUSTOMERS");
        assert_eq!(parsed["description"], "List customers");
        assert_eq!(parsed["inputSchema"], json!({"type": "object"}));
    }
}
