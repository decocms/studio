//! Thread collection CRUD — `POST /api/:org/tools/COLLECTION_THREADS_*` and
//! `COLLECTION_THREAD_MESSAGES_LIST`. Every id-based operation is scoped to
//! the authenticated upstream/user account and raw `:org` path segment: an id
//! from any other scope is treated exactly like an unknown id. Wire contract:
//! the native interception contract §3.1.
//!
//! `apps/api/src/api/routes/tools-rest.ts`'s own contract is "body = tool
//! arguments verbatim JSON, response = raw tool output JSON, no envelope" —
//! every handler below mirrors that exactly: parse the POST body as the
//! tool's own input shape, return the tool's own output shape, `200 OK`,
//! no `{content,structuredContent}` wrapper (the real client,
//! `rest-self-client.ts`, synthesizes that wrapper itself — map §3.1).
//!
//! Backed by `routes::threads::db::ThreadsDb`'s `rt_*` methods (a
//! SEPARATE table pair from the mini-app's `threads`/`messages`/`runs` —
//! see that file's `SCHEMA` doc comment for why).

use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};

use crate::error::ApiError;
use crate::routes::threads::authority::{lock_account_scope, resolve_scoped_thread, ThreadAccess};
use crate::routes::threads::db::{
    DbError, RtAccountScope, RtThreadListOptions, RtThreadPatch, ThreadsDb,
};
use crate::routes::threads::shared_db;
use crate::sandbox::manager::SandboxAccount;
use crate::state::AppState;

use super::sandbox_authority::manager_error;

#[cfg(test)]
pub async fn dispatch(
    state: &AppState,
    org: &str,
    tool_name: &str,
    body: &Bytes,
) -> Option<Response> {
    let scope = crate::routes::threads::authority::current_account_scope()
        .await
        .ok()?;
    dispatch_scoped(state, &scope, org, tool_name, body).await
}

pub async fn dispatch_scoped(
    state: &AppState,
    scope: &RtAccountScope,
    org: &str,
    tool_name: &str,
    body: &Bytes,
) -> Option<Response> {
    match tool_name {
        "COLLECTION_THREADS_LIST" => Some(list(state, scope, org, body).await),
        "COLLECTION_THREADS_GET" => Some(get(state, scope, org, body).await),
        "COLLECTION_THREADS_CREATE" => Some(create(state, scope, org, body).await),
        "COLLECTION_THREADS_UPDATE" => Some(update(state, scope, org, body).await),
        "COLLECTION_THREADS_DELETE" => Some(delete(state, scope, org, body).await),
        "COLLECTION_THREAD_MESSAGES_LIST" => Some(messages_list(state, scope, org, body).await),
        _ => None,
    }
}

// `ApiError`, not `Response`, is this pair's error type — clippy's
// `result_large_err` flags a bare `Response` (128+ bytes) as an oversized
// `Err` variant; `ApiError` (a small `{status, body: Value}`) is both the
// idiomatic type this crate's other handlers already use and small enough
// to pass the lint. Call sites convert via `.map_err(ApiError::into_response)`.
fn parse_json(body: &Bytes) -> Result<Value, ApiError> {
    // An empty body means "no arguments" — an empty OBJECT, not
    // `Value::default()` (null), which is why this can't be
    // `json_body_or_default::<Value>`.
    if body.is_empty() {
        return Ok(json!({}));
    }
    crate::http_util::json_body(body)
}

fn sandbox_account_for_scope(
    state: &AppState,
    scope: &RtAccountScope,
) -> Result<SandboxAccount, ApiError> {
    crate::routes::sandbox_account::admit_scope(state, scope)
}

fn expect_object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, ApiError> {
    value
        .as_object()
        .ok_or_else(|| ApiError::bad_request(format!("{path} must be an object")))
}

fn optional_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    path: &str,
) -> Result<Option<&'a str>, ApiError> {
    match object.get(field) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(ApiError::bad_request(format!(
            "{path}.{field} must be a string"
        ))),
    }
}

fn optional_bool(
    object: &Map<String, Value>,
    field: &str,
    path: &str,
) -> Result<Option<bool>, ApiError> {
    match object.get(field) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(ApiError::bad_request(format!(
            "{path}.{field} must be a boolean"
        ))),
    }
}

fn optional_nullable_string<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    path: &str,
) -> Result<Option<Option<&'a str>>, ApiError> {
    match object.get(field) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(value)) => Ok(Some(Some(value))),
        Some(_) => Err(ApiError::bad_request(format!(
            "{path}.{field} must be a string or null"
        ))),
    }
}

fn pagination(input: &Map<String, Value>, default_limit: i64) -> Result<(i64, i64), ApiError> {
    let limit = match input.get("limit") {
        None => default_limit,
        Some(value) => value
            .as_i64()
            .filter(|limit| (1..=1000).contains(limit))
            .ok_or_else(|| ApiError::bad_request("limit must be an integer between 1 and 1000"))?,
    };
    let offset = match input.get("offset") {
        None => 0,
        Some(value) => value
            .as_i64()
            .filter(|offset| *offset >= 0)
            .ok_or_else(|| ApiError::bad_request("offset must be a non-negative integer"))?,
    };
    Ok((limit, offset))
}

fn validate_order_by(input: &Map<String, Value>) -> Result<Option<&str>, ApiError> {
    let Some(value) = input.get("orderBy") else {
        return Ok(None);
    };
    let entries = value
        .as_array()
        .ok_or_else(|| ApiError::bad_request("orderBy must be an array"))?;
    for entry in entries {
        let entry = expect_object(entry, "orderBy item")?;
        let fields = entry
            .get("field")
            .and_then(Value::as_array)
            .ok_or_else(|| ApiError::bad_request("orderBy item.field must be an array"))?;
        if fields.iter().any(|field| !field.is_string()) {
            return Err(ApiError::bad_request(
                "orderBy item.field entries must be strings",
            ));
        }
        let direction = entry
            .get("direction")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad_request("orderBy item.direction must be asc or desc"))?;
        if !matches!(direction, "asc" | "desc") {
            return Err(ApiError::bad_request(
                "orderBy item.direction must be asc or desc",
            ));
        }
        if let Some(nulls) = entry.get("nulls") {
            if !matches!(nulls.as_str(), Some("first" | "last")) {
                return Err(ApiError::bad_request(
                    "orderBy item.nulls must be first or last",
                ));
            }
        }
    }
    Ok(entries
        .first()
        .and_then(Value::as_object)
        .and_then(|entry| entry.get("direction"))
        .and_then(Value::as_str))
}

fn validate_datetime(value: &str, path: &str) -> Result<(), ApiError> {
    // `z.string().datetime()` (the production schema) accepts the UTC shape the
    // real UI emits with `Date#toISOString`: YYYY-MM-DDTHH:mm:ss(.sss)Z. Keep
    // this dependency-free parser deliberately strict so a malformed date is a
    // 400, never a silently-ignored broad query.
    let bytes = value.as_bytes();
    let fixed_digits = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];
    let punctuation_ok = bytes.len() >= 20
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes.last() == Some(&b'Z')
        && fixed_digits
            .iter()
            .all(|index| bytes.get(*index).is_some_and(u8::is_ascii_digit));
    let fraction_ok = match bytes.len() {
        20 => true,
        length if length > 21 => {
            bytes.get(19) == Some(&b'.') && bytes[20..length - 1].iter().all(u8::is_ascii_digit)
        }
        _ => false,
    };
    let parse = |range: std::ops::Range<usize>| {
        std::str::from_utf8(&bytes[range])
            .ok()
            .and_then(|part| part.parse::<u32>().ok())
    };
    let year = parse(0..4);
    let month = parse(5..7);
    let day = parse(8..10);
    let days_in_month = match (year, month) {
        (Some(year), Some(2)) if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        (Some(_), Some(2)) => 28,
        (Some(_), Some(4 | 6 | 9 | 11)) => 30,
        (Some(_), Some(1 | 3 | 5 | 7 | 8 | 10 | 12)) => 31,
        _ => 0,
    };
    let calendar_ok = punctuation_ok
        && day.is_some_and(|day| (1..=days_in_month).contains(&day))
        && parse(11..13).is_some_and(|hour| hour <= 23)
        && parse(14..16).is_some_and(|minute| minute <= 59)
        && parse(17..19).is_some_and(|second| second <= 59);
    if calendar_ok && fraction_ok {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "{path} must be an ISO UTC datetime"
        )))
    }
}

fn validate_thread_metadata(value: &Value) -> Result<(), ApiError> {
    let metadata = expect_object(value, "data.metadata")?;
    let Some(expanded_tools) = metadata.get("expanded_tools") else {
        return Ok(());
    };
    let expanded_tools = expanded_tools
        .as_array()
        .ok_or_else(|| ApiError::bad_request("data.metadata.expanded_tools must be an array"))?;
    for (index, expanded_tool) in expanded_tools.iter().enumerate() {
        let path = format!("data.metadata.expanded_tools[{index}]");
        let expanded_tool = expect_object(expanded_tool, &path)?;
        for field in ["toolName", "appId"] {
            if optional_string(expanded_tool, field, &path)?.is_none() {
                return Err(ApiError::bad_request(format!("{path}.{field} is required")));
            }
        }
        match expanded_tool.get("args") {
            Some(Value::Object(_)) => {}
            _ => {
                return Err(ApiError::bad_request(format!(
                    "{path}.args must be an object"
                )))
            }
        }
        let expanded_at = optional_string(expanded_tool, "expandedAt", &path)?
            .ok_or_else(|| ApiError::bad_request(format!("{path}.expandedAt is required")))?;
        validate_datetime(expanded_at, &format!("{path}.expandedAt"))?;
    }
    Ok(())
}

fn validate_where_expression(value: &Value) -> Result<(), ApiError> {
    let expression = expect_object(value, "where")?;
    let operator = expression
        .get("operator")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::bad_request("where.operator is required"))?;
    match operator {
        "and" | "or" | "not" => {
            let conditions = expression
                .get("conditions")
                .and_then(Value::as_array)
                .ok_or_else(|| ApiError::bad_request("where.conditions must be an array"))?;
            for condition in conditions {
                validate_where_expression(condition)?;
            }
        }
        "eq" | "gt" | "gte" | "lt" | "lte" | "in" | "like" | "contains" => {
            let fields = expression
                .get("field")
                .and_then(Value::as_array)
                .ok_or_else(|| ApiError::bad_request("where.field must be an array"))?;
            if fields.iter().any(|field| !field.is_string()) {
                return Err(ApiError::bad_request("where.field entries must be strings"));
            }
            if !expression.contains_key("value") {
                return Err(ApiError::bad_request("where.value is required"));
            }
        }
        _ => return Err(ApiError::bad_request("where.operator is invalid")),
    }
    Ok(())
}

fn extract_thread_id_from_where(value: &Value) -> Option<String> {
    let expression = value.as_object()?;
    let operator = expression.get("operator")?.as_str()?;
    if operator == "eq"
        && expression
            .get("field")?
            .as_array()?
            .first()
            .and_then(Value::as_str)
            == Some("thread_id")
    {
        return expression.get("value").map(js_string);
    }
    if matches!(operator, "and" | "or") {
        for condition in expression.get("conditions")?.as_array()? {
            if let Some(thread_id) = extract_thread_id_from_where(condition) {
                return Some(thread_id);
            }
        }
    }
    None
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(values) => values
            .iter()
            .map(|value| match value {
                Value::Null => String::new(),
                value => js_string(value),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn db(state: &AppState) -> Result<&'static ThreadsDb, ApiError> {
    shared_db(state)
}

// --- COLLECTION_THREADS_LIST -------------------------------------------------

async fn list(state: &AppState, scope: &RtAccountScope, org: &str, body: &Bytes) -> Response {
    let input = match parse_json(body) {
        Ok(v) => v,
        Err(r) => return r.into_response(),
    };
    let input = match expect_object(&input, "request body") {
        Ok(input) => input,
        Err(error) => return error.into_response(),
    };
    // Deliberate divergence from the tool contract: the thread list is NOT
    // paginated here, and a caller-supplied `limit`/`offset` is ignored.
    //
    // The store is local SQLite holding one account's threads, so "every open
    // thread" is a few hundred rows at most and costs a few milliseconds — far
    // less than the round-trips the client would otherwise make walking pages.
    // Answering in full is what lets the desktop UI treat its in-memory list as
    // COMPLETE rather than as a paginated sample, which turns "is anyone else
    // on this branch" from a server query into a local predicate. `hasMore` is
    // therefore always false and `totalCount` always equals `items.len()`, so a
    // client paging loop terminates immediately instead of spinning.
    //
    // `limit`/`offset` are still PARSED, so a malformed value is still a 400 —
    // silently accepting garbage because we no longer use it would be a
    // contract regression of a different kind.
    if let Err(error) = pagination(input, 100) {
        return error.into_response();
    }
    if let Err(error) = validate_order_by(input) {
        return error.into_response();
    }

    let where_input = match input.get("where") {
        None => None,
        Some(value) => match expect_object(value, "where") {
            Ok(value) => Some(value),
            Err(error) => return error.into_response(),
        },
    };
    let where_created_by = match where_input {
        Some(where_input) => match optional_string(where_input, "created_by", "where") {
            Ok(value) => value,
            Err(error) => return error.into_response(),
        },
        None => None,
    };
    let user_id = match optional_string(input, "userId", "request body") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let created_by = user_id.or_else(|| {
        where_created_by.map(|value| {
            if value == "me" {
                scope.user_id.as_str()
            } else {
                value
            }
        })
    });
    let hidden = match where_input {
        Some(where_input) => match optional_bool(where_input, "hidden", "where") {
            Ok(value) => value.unwrap_or(false),
            Err(error) => return error.into_response(),
        },
        None => false,
    };
    let search = match optional_string(input, "search", "request body") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };

    let trigger_ids = match where_input.and_then(|where_input| where_input.get("trigger_ids")) {
        None => None,
        Some(Value::Array(values)) => {
            let mut trigger_ids = Vec::with_capacity(values.len());
            for value in values {
                let Some(value) = value.as_str() else {
                    return ApiError::bad_request("where.trigger_ids must contain only strings")
                        .into_response();
                };
                trigger_ids.push(value.to_string());
            }
            Some(trigger_ids)
        }
        Some(_) => {
            return ApiError::bad_request("where.trigger_ids must be an array").into_response()
        }
    };
    let virtual_mcp_id = match where_input {
        Some(where_input) => match optional_string(where_input, "virtual_mcp_id", "where") {
            Ok(value) => value,
            Err(error) => return error.into_response(),
        },
        None => None,
    };
    let has_trigger = match where_input {
        Some(where_input) => match optional_bool(where_input, "has_trigger", "where") {
            Ok(value) => value,
            Err(error) => return error.into_response(),
        },
        None => None,
    };
    let start_date = match optional_string(input, "startDate", "request body") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    if let Some(value) = start_date {
        if let Err(error) = validate_datetime(value, "startDate") {
            return error.into_response();
        }
    }
    let end_date = match optional_string(input, "endDate", "request body") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    if let Some(value) = end_date {
        if let Err(error) = validate_datetime(value, "endDate") {
            return error.into_response();
        }
    }
    let status = match optional_string(input, "status", "request body") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let agent_id = match optional_string(input, "agentId", "request body") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };

    let db = match db(state) {
        Ok(d) => d,
        Err(r) => return r.into_response(),
    };

    let result = {
        let _account_guard = match lock_account_scope(scope).await {
            Ok(guard) => guard,
            Err(error) => return error.into_response(),
        };
        db.rt_list_threads_scoped(
            scope,
            org,
            RtThreadListOptions {
                created_by,
                hidden: Some(hidden),
                search,
                trigger_ids: trigger_ids.as_deref(),
                virtual_mcp_id,
                has_trigger,
                start_date,
                end_date,
                status,
                agent_id,
            },
        )
    };
    match result {
        Ok((items, total_count)) => Json(json!({
            "items": items,
            "totalCount": total_count,
            "hasMore": false,
        }))
        .into_response(),
        Err(e) => ApiError::internal(format!("thread database error: {e}")).into_response(),
    }
}

// --- COLLECTION_THREADS_GET --------------------------------------------------

async fn get(state: &AppState, scope: &RtAccountScope, org: &str, body: &Bytes) -> Response {
    let input = match parse_json(body) {
        Ok(v) => v,
        Err(r) => return r.into_response(),
    };
    let db = match db(state) {
        Ok(d) => d,
        Err(r) => return r.into_response(),
    };
    let Some(id) = input.get("id").and_then(Value::as_str) else {
        return ApiError::bad_request("id is required").into_response();
    };
    let result = {
        let _account_guard = match lock_account_scope(scope).await {
            Ok(guard) => guard,
            Err(error) => return error.into_response(),
        };
        db.rt_get_thread_in_scope(scope, org, id)
    };
    match result {
        Ok(item) => Json(json!({ "item": item })).into_response(),
        Err(e) => ApiError::internal(format!("thread database error: {e}")).into_response(),
    }
}

// --- COLLECTION_THREADS_CREATE -----------------------------------------------

async fn create(state: &AppState, scope: &RtAccountScope, org: &str, body: &Bytes) -> Response {
    let input = match parse_json(body) {
        Ok(v) => v,
        Err(r) => return r.into_response(),
    };
    let input = match expect_object(&input, "request body") {
        Ok(input) => input,
        Err(error) => return error.into_response(),
    };
    let data = match input.get("data") {
        Some(data) => match expect_object(data, "data") {
            Ok(data) => data,
            Err(error) => return error.into_response(),
        },
        None => return ApiError::bad_request("data is required").into_response(),
    };
    let virtual_mcp_id = match optional_string(data, "virtual_mcp_id", "data") {
        Ok(Some(value)) => value,
        Ok(None) => {
            return ApiError::bad_request("data.virtual_mcp_id is required").into_response()
        }
        Err(error) => return error.into_response(),
    };
    let id = match optional_string(data, "id", "data") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let title = match optional_string(data, "title", "data") {
        Ok(value) => value.unwrap_or(crate::routes::threads::db::DEFAULT_THREAD_TITLE),
        Err(error) => return error.into_response(),
    };
    let description = match optional_nullable_string(data, "description", "data") {
        Ok(value) => value.flatten(),
        Err(error) => return error.into_response(),
    };
    let branch = match optional_string(data, "branch", "data") {
        Ok(Some("")) => {
            return ApiError::bad_request("data.branch must not be empty").into_response()
        }
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    if let Some(branch) = branch {
        if let Err(error) = validate_thread_branch_identity(branch, id, "data.id") {
            return error.into_response();
        }
    }
    let db = match db(state) {
        Ok(d) => d,
        Err(r) => return r.into_response(),
    };
    let user = &scope.user_id;

    let result = {
        let _account_guard = match lock_account_scope(scope).await {
            Ok(guard) => guard,
            Err(error) => return error.into_response(),
        };
        db.rt_create_thread_scoped(
            scope,
            id,
            org,
            title,
            description,
            virtual_mcp_id,
            branch,
            user,
        )
    };
    match result {
        Ok(item) => Json(json!({ "item": item })).into_response(),
        // An explicit id already owned by another account or organization is
        // neither returned nor described: expose only that this caller cannot
        // use the id, not which tenant owns it.
        Err(DbError::IdempotencyConflict { .. } | DbError::RetiredThreadId { .. }) => {
            ApiError::conflict("thread id is unavailable").into_response()
        }
        Err(DbError::ThreadDeletePending { .. }) => {
            ApiError::conflict("thread is being deleted").into_response()
        }
        Err(e) => ApiError::internal(format!("thread database error: {e}")).into_response(),
    }
}

// --- COLLECTION_THREADS_UPDATE -----------------------------------------------

async fn update(state: &AppState, scope: &RtAccountScope, org: &str, body: &Bytes) -> Response {
    let input = match parse_json(body) {
        Ok(v) => v,
        Err(r) => return r.into_response(),
    };
    let input = match expect_object(&input, "request body") {
        Ok(input) => input,
        Err(error) => return error.into_response(),
    };
    let id = match optional_string(input, "id", "request body") {
        Ok(Some(value)) => value,
        Ok(None) => return ApiError::bad_request("id is required").into_response(),
        Err(error) => return error.into_response(),
    };
    let data = match input.get("data") {
        Some(data) => match expect_object(data, "data") {
            Ok(data) => data,
            Err(error) => return error.into_response(),
        },
        None => return ApiError::bad_request("data is required").into_response(),
    };
    let title = match optional_string(data, "title", "data") {
        Ok(value) => value.map(String::from),
        Err(error) => return error.into_response(),
    };
    let description = match optional_nullable_string(data, "description", "data") {
        Ok(value) => value.map(|value| value.map(String::from)),
        Err(error) => return error.into_response(),
    };
    let hidden = match optional_bool(data, "hidden", "data") {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let status = match optional_string(data, "status", "data") {
        // Validated against the canonical vocabulary in `threads/db.rs`, not
        // a local literal list — an allowlist typed here would 400 a status
        // the storage layer later learns to persist.
        Ok(Some(value)) if !crate::routes::threads::db::is_thread_status(value) => {
            return ApiError::bad_request("data.status is invalid").into_response()
        }
        Ok(value) => value.map(String::from),
        Err(error) => return error.into_response(),
    };
    let metadata = match data.get("metadata") {
        None => None,
        Some(value) => {
            if let Err(error) = validate_thread_metadata(value) {
                return error.into_response();
            }
            Some(Some(value.clone()))
        }
    };
    let branch = match optional_nullable_string(data, "branch", "data") {
        Ok(value) => value.map(|value| value.map(String::from)),
        Err(error) => return error.into_response(),
    };
    if let Some(Some(branch)) = branch.as_ref() {
        if let Err(error) = validate_thread_branch_identity(branch, Some(id), "id") {
            return error.into_response();
        }
    }
    let virtual_mcp_id = match optional_string(data, "virtual_mcp_id", "data") {
        Ok(value) => value.map(String::from),
        Err(error) => return error.into_response(),
    };
    let patch = RtThreadPatch {
        title,
        description,
        hidden,
        status,
        metadata,
        branch,
        virtual_mcp_id,
    };
    let result = if patch_requires_workspace_lock(&patch) {
        // This first read is only a lock-key hint. Authority is resolved again
        // after taking the lifecycle lock and account-transition fence, before
        // any side effect or durable mutation can use the captured scope.
        let lock_hint = {
            let _account_guard = match lock_account_scope(scope).await {
                Ok(guard) => guard,
                Err(error) => return error.into_response(),
            };
            match resolve_scoped_thread(state, scope.clone(), org, id, ThreadAccess::Owner) {
                Ok(resolved) => resolved.fence,
                Err(error) => return error.into_response(),
            }
        };
        let workspace_lock = state.agent_sessions.start_lock(&lock_hint);
        let _workspace_guard = workspace_lock.lock().await;
        let account_guard = match lock_account_scope(scope).await {
            Ok(guard) => guard,
            Err(error) => return error.into_response(),
        };
        let resolved =
            match resolve_scoped_thread(state, scope.clone(), org, id, ThreadAccess::Owner) {
                Ok(resolved) if resolved.fence == lock_hint => resolved,
                Ok(_) => return ApiError::not_found("thread not found").into_response(),
                Err(error) => return error.into_response(),
            };
        let db = resolved.db;
        let fence = resolved.fence;
        let thread = resolved.thread;
        match db.rt_validate_workspace_identity_patch_fenced(&fence, &patch) {
            Ok(()) => {}
            Err(DbError::ThreadWorkspaceLocked { .. }) => {
                return ApiError::conflict(
                    "The chat workspace cannot be changed after its coding agent starts.",
                )
                .into_response()
            }
            Err(DbError::ThreadDeletePending { .. }) => {
                return ApiError::conflict("thread is being deleted").into_response()
            }
            Err(DbError::StaleThreadGeneration { .. }) => {
                return ApiError::not_found("thread not found").into_response()
            }
            Err(error) => {
                return ApiError::internal(format!("thread database error: {error}"))
                    .into_response()
            }
        }
        let changes_workspace_identity = workspace_identity_changes(&patch, &thread);
        if patch.hidden == Some(true) || changes_workspace_identity {
            let account = match sandbox_account_for_scope(state, scope) {
                Ok(account) => account,
                Err(error) => return error.into_response(),
            };
            // The per-thread lifecycle lock keeps this generation stable.
            // Release the process-wide account transition gate before any
            // bounded preparation or child-process drain.
            drop(account_guard);
            if let Err(error) = cancel_preparing_terminal(state, db, &fence).await {
                return error.into_response();
            }
            if patch.hidden == Some(true) {
                if let Err(error) = state.agent_sessions.terminate_fence(&fence).await {
                    return ApiError::internal(format!(
                        "chat was not archived because its coding agent could not be stopped: {error}"
                    ))
                    .into_response();
                }
            }
            if let Err(error) =
                quiesce_thread_sandbox(state, &account, &thread.id, &thread.virtual_mcp_id).await
            {
                return error.into_response();
            }
            let _account_guard = match lock_account_scope(scope).await {
                Ok(guard) => guard,
                Err(error) => return error.into_response(),
            };
            let resolved =
                match resolve_scoped_thread(state, scope.clone(), org, id, ThreadAccess::Owner) {
                    Ok(resolved) if resolved.fence == fence => resolved,
                    Ok(_) => return ApiError::not_found("thread not found").into_response(),
                    Err(error) => return error.into_response(),
                };
            if let Err(error) = resolved
                .db
                .rt_validate_workspace_identity_patch_fenced(&fence, &patch)
            {
                return workspace_patch_error(error).into_response();
            }
            resolved
                .db
                .rt_update_thread_in_scope(scope, org, id, &scope.user_id, &patch)
        } else {
            db.rt_update_thread_in_scope(scope, org, id, &scope.user_id, &patch)
        }
    } else {
        let _account_guard = match lock_account_scope(scope).await {
            Ok(guard) => guard,
            Err(error) => return error.into_response(),
        };
        let db = match resolve_scoped_thread(state, scope.clone(), org, id, ThreadAccess::Owner) {
            Ok(resolved) => resolved.db,
            Err(error) => return error.into_response(),
        };
        db.rt_update_thread_in_scope(scope, org, id, &scope.user_id, &patch)
    };
    match result {
        Ok(Some(item)) => Json(json!({ "item": item })).into_response(),
        Ok(None) => ApiError::not_found("thread not found").into_response(),
        Err(DbError::ThreadDeletePending { .. }) => {
            ApiError::conflict("thread is being deleted").into_response()
        }
        Err(DbError::ThreadWorkspaceLocked { .. }) => ApiError::conflict(
            "The chat workspace cannot be changed after its coding agent starts.",
        )
        .into_response(),
        Err(e) => ApiError::internal(format!("thread database error: {e}")).into_response(),
    }
}

fn patch_requires_workspace_lock(patch: &RtThreadPatch) -> bool {
    patch.hidden == Some(true) || patch.branch.is_some() || patch.virtual_mcp_id.is_some()
}

fn workspace_identity_changes(
    patch: &RtThreadPatch,
    thread: &crate::routes::threads::db::RtThread,
) -> bool {
    patch
        .branch
        .as_ref()
        .is_some_and(|branch| branch != &thread.branch)
        || patch
            .virtual_mcp_id
            .as_ref()
            .is_some_and(|virtual_mcp_id| virtual_mcp_id != &thread.virtual_mcp_id)
}

fn validate_thread_branch_identity(
    branch: &str,
    expected_thread_id: Option<&str>,
    expected_id_path: &str,
) -> Result<(), ApiError> {
    let Some(branch_thread_id) = crate::sandbox::synthetic_thread_id_from_input(branch)
        .map_err(|error| ApiError::bad_request(format!("data.branch is invalid: {error}")))?
    else {
        return Ok(());
    };
    let expected_thread_id = expected_thread_id.ok_or_else(|| {
        ApiError::bad_request(format!(
            "{expected_id_path} is required when data.branch is thread-backed"
        ))
    })?;
    if branch_thread_id != expected_thread_id {
        return Err(ApiError::bad_request(format!(
            "data.branch must belong to {expected_id_path}"
        )));
    }
    Ok(())
}

fn workspace_patch_error(error: DbError) -> ApiError {
    match error {
        DbError::ThreadWorkspaceLocked { .. } => ApiError::conflict(
            "The chat workspace cannot be changed after its coding agent starts.",
        ),
        DbError::ThreadDeletePending { .. } => ApiError::conflict("thread is being deleted"),
        DbError::StaleThreadGeneration { .. } => ApiError::not_found("thread not found"),
        error => ApiError::internal(format!("thread database error: {error}")),
    }
}

async fn cancel_preparing_terminal(
    state: &AppState,
    db: &'static ThreadsDb,
    fence: &crate::routes::threads::db::RtThreadFence,
) -> Result<(), ApiError> {
    let preparation = state.agent_sessions.cancel_preparation(fence);
    let cleanup_fences = preparation.fences();
    preparation.wait().await.map_err(|error| {
        ApiError::internal(format!(
            "could not stop coding agent preparation before cleanup: {error}"
        ))
    })?;
    for cleanup_fence in cleanup_fences {
        crate::terminal::launch_context::cleanup_managed_state(&state.app_root, &cleanup_fence)
            .await
            .map_err(|error| {
                ApiError::internal(format!(
                    "could not clean canceled coding agent preparation: {error}"
                ))
            })?;
        state
            .agent_sessions
            .complete_managed_cleanup(&cleanup_fence);
    }
    let live = db
        .rt_get_live_terminal_session_fenced(fence)
        .map_err(|error| {
            ApiError::internal(format!(
                "could not inspect coding agent before cleanup: {error}"
            ))
        })?;
    if let Some(session) = live {
        crate::routes::terminal::mark_starting_session_exited_if_present(
            db,
            fence,
            &session.id,
            "coding agent start was canceled before process creation",
            true,
        );
    }
    Ok(())
}

/// Every live synthetic `thread:<id>[/...]` sandbox belongs only to that thread
/// and is safe to quiesce with its lifecycle. The manager rechecks both the
/// pre-patch virtual-MCP id and exact synthetic thread identity under each
/// handle lock before closing the generation. Real git branches are shared by
/// every native chat on that repository branch and must never be stopped when
/// one chat is archived, deleted, or changes workspace identity.
async fn quiesce_thread_sandbox(
    state: &AppState,
    account: &SandboxAccount,
    thread_id: &str,
    virtual_mcp_id: &str,
) -> Result<(), ApiError> {
    state
        .sandbox_manager
        .delete_live_thread_sandboxes_for_account(account, virtual_mcp_id, thread_id)
        .await
        .map(|_| ())
        .map_err(manager_error)
}

// --- COLLECTION_THREADS_DELETE -----------------------------------------------

async fn delete(state: &AppState, scope: &RtAccountScope, org: &str, body: &Bytes) -> Response {
    let input = match parse_json(body) {
        Ok(v) => v,
        Err(r) => return r.into_response(),
    };
    let Some(id) = input.get("id").and_then(Value::as_str) else {
        return ApiError::bad_request("id is required").into_response();
    };

    let resolved = {
        let _account_guard = match lock_account_scope(scope).await {
            Ok(guard) => guard,
            Err(error) => return error.into_response(),
        };
        match resolve_scoped_thread(state, scope.clone(), org, id, ThreadAccess::Owner) {
            Ok(resolved) => resolved,
            Err(error) => return error.into_response(),
        }
    };
    let fence = resolved.fence;
    let start_lock = state.agent_sessions.start_lock(&fence);
    let _start_guard = start_lock.lock().await;
    let account_guard = match lock_account_scope(scope).await {
        Ok(guard) => guard,
        Err(error) => return error.into_response(),
    };
    let resolved = match resolve_scoped_thread(state, scope.clone(), org, id, ThreadAccess::Owner) {
        Ok(resolved) if resolved.fence == fence => resolved,
        Ok(_) => return ApiError::not_found("thread not found").into_response(),
        Err(error) => return error.into_response(),
    };
    let db = resolved.db;
    let item = resolved.thread;
    let account = match sandbox_account_for_scope(state, scope) {
        Ok(account) => account,
        Err(error) => return error.into_response(),
    };
    match db.rt_mark_thread_delete_pending(&fence) {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("thread not found").into_response(),
        Err(e) => {
            return ApiError::internal(format!("thread database error: {e}")).into_response();
        }
    }
    // `delete_pending` durably closes new starts and the lifecycle lock keeps
    // this generation stable, so process cleanup must not hold the global
    // account transition gate.
    drop(account_guard);
    if let Err(error) = cancel_preparing_terminal(state, db, &fence).await {
        return error.into_response();
    }
    if let Err(error) = state.agent_sessions.terminate_fence(&fence).await {
        // `delete_pending` deliberately survives failed reaping. A retry can
        // complete the same generation-fenced cascade, while new terminal
        // starts remain closed by the durable marker.
        return ApiError::internal(format!("could not stop coding agent: {error}")).into_response();
    }
    if let Err(error) =
        quiesce_thread_sandbox(state, &account, &item.id, &item.virtual_mcp_id).await
    {
        return error.into_response();
    }
    let account_guard = match lock_account_scope(scope).await {
        Ok(guard) => guard,
        Err(error) => return error.into_response(),
    };
    match resolve_scoped_thread(state, scope.clone(), org, id, ThreadAccess::Owner) {
        Ok(resolved) if resolved.fence == fence => {}
        Ok(_) => return ApiError::not_found("thread not found").into_response(),
        Err(error) => return error.into_response(),
    }

    match db.rt_delete_owned_thread_if_generation(&fence, &scope.user_id) {
        Ok(true) => {
            drop(account_guard);
            state.agent_sessions.forget_fence(&fence);
            if let Err(error) =
                crate::terminal::launch_context::cleanup_managed_state(&state.app_root, &fence)
                    .await
            {
                tracing::warn!(%error, thread_id = %fence.thread_id, "could not remove deleted chat agent state");
            } else {
                state.agent_sessions.complete_managed_cleanup(&fence);
            }
            Json(json!({ "item": item })).into_response()
        }
        // A concurrent deletion between the scoped read and delete is still a
        // not-found result; never return a success envelope for a row this call
        // did not remove.
        Ok(false) => ApiError::not_found("thread not found").into_response(),
        Err(e) => {
            // Keep the live row durably closed. The queued tail was never
            // discarded and a later DELETE retries the same fenced cascade.
            ApiError::internal(format!("thread database error: {e}")).into_response()
        }
    }
}

// --- COLLECTION_THREAD_MESSAGES_LIST -----------------------------------------

async fn messages_list(
    state: &AppState,
    scope: &RtAccountScope,
    org: &str,
    body: &Bytes,
) -> Response {
    let input = match parse_json(body) {
        Ok(v) => v,
        Err(r) => return r.into_response(),
    };
    let input = match expect_object(&input, "request body") {
        Ok(input) => input,
        Err(error) => return error.into_response(),
    };
    let top_level_thread_id = match optional_string(input, "thread_id", "request body") {
        Ok(value) => value.map(String::from),
        Err(error) => return error.into_response(),
    };
    let where_thread_id = match input.get("where") {
        None => None,
        Some(where_input) => {
            if let Err(error) = validate_where_expression(where_input) {
                return error.into_response();
            }
            extract_thread_id_from_where(where_input)
        }
    };
    let Some(thread_id) = top_level_thread_id.or(where_thread_id) else {
        return ApiError::bad_request(
            "thread_id is required (provide as top-level param or in where clause)",
        )
        .into_response();
    };
    let (limit, offset) = match pagination(input, 100) {
        Ok(pagination) => pagination,
        Err(error) => return error.into_response(),
    };
    let direction = match validate_order_by(input) {
        Ok(direction) => direction,
        Err(error) => return error.into_response(),
    };
    let db = match db(state) {
        Ok(d) => d,
        Err(r) => return r.into_response(),
    };
    // Byte-parity with `list-messages.ts`: `sort = orderBy[0].direction ?? "asc"`.
    // The chat sends `orderBy: [{ field: ["created_at"], direction: "desc" }]`
    // to fetch the LATEST page; ignoring it (always ASC/oldest) dropped the
    // newest turn out of the refetch window and mis-ordered the chat.
    let desc = direction == Some("desc");

    // Byte-parity with `list-messages.ts`'s own "unknown thread -> empty
    // page, not an error" behavior (see that file's handler).
    let result = {
        let _account_guard = match lock_account_scope(scope).await {
            Ok(guard) => guard,
            Err(error) => return error.into_response(),
        };
        db.rt_list_messages_in_scope(scope, org, &thread_id, limit, offset, desc)
    };
    match result {
        Ok((items, total_count)) => {
            let has_more = offset + limit < total_count;
            Json(json!({
                "items": items,
                "totalCount": total_count,
                "hasMore": has_more,
            }))
            .into_response()
        }
        Err(e) => ApiError::internal(format!("thread database error: {e}")).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::intercept::test_state;
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use std::sync::OnceLock;

    /// `shared_db` and the native sandbox registry are process-wide test
    /// resources. Cache the whole state so parallel tests neither unlink the
    /// shared database nor race separate registry connections while enabling
    /// SQLite WAL mode.
    fn persistent_test_state() -> AppState {
        static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
        static STATE: OnceLock<AppState> = OnceLock::new();
        STATE
            .get_or_init(|| test_state(ROOT.get_or_init(|| tempfile::tempdir().unwrap()).path()))
            .clone()
    }

    async fn body_json(res: Response) -> Value {
        let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn create_then_get_round_trips() {
        let state = persistent_test_state();
        let create_body = Bytes::from(
            json!({"data": {"title": "hello", "virtual_mcp_id": "vmcp-1"}}).to_string(),
        );
        let res = dispatch(&state, "acme", "COLLECTION_THREADS_CREATE", &create_body)
            .await
            .unwrap();
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        let created = body_json(res).await;
        let id = created["item"]["id"].as_str().unwrap().to_string();
        assert_eq!(created["item"]["organization_id"], "acme");
        assert_eq!(created["item"]["title"], "hello");
        assert_eq!(created["item"]["virtual_mcp_id"], "vmcp-1");
        assert_eq!(created["item"]["hidden"], false);
        assert!(!created["item"]
            .as_object()
            .unwrap()
            .contains_key("updated_by"));
        assert!(!created["item"]
            .as_object()
            .unwrap()
            .contains_key("metadata"));

        let get_body = Bytes::from(json!({"id": id}).to_string());
        let res = dispatch(&state, "acme", "COLLECTION_THREADS_GET", &get_body)
            .await
            .unwrap();
        assert_eq!(res.status(), axum::http::StatusCode::OK);
        let fetched = body_json(res).await;
        assert_eq!(fetched["item"]["id"], id);
    }

    #[tokio::test]
    async fn create_requires_virtual_mcp_id() {
        let state = persistent_test_state();
        let body = Bytes::from(json!({"data": {"title": "x"}}).to_string());
        let res = dispatch(&state, "acme", "COLLECTION_THREADS_CREATE", &body)
            .await
            .unwrap();
        assert_eq!(res.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn reserved_thread_branches_require_the_matching_explicit_thread_id() {
        let state = persistent_test_state();
        let org = "thread-tools-reserved-branch";
        for input in [
            json!({"data": {
                "virtual_mcp_id": "vmcp-reserved",
                "branch": "thread:generated-id-is-not-authority"
            }}),
            json!({"data": {
                "id": "reserved-whitespace",
                "virtual_mcp_id": "vmcp-reserved",
                "branch": " thread:reserved-whitespace "
            }}),
            json!({"data": {
                "id": "reserved-mismatch",
                "virtual_mcp_id": "vmcp-reserved",
                "branch": "thread:another-thread"
            }}),
            json!({"data": {
                "id": "reserved-malformed",
                "virtual_mcp_id": "vmcp-reserved",
                "branch": "thread:"
            }}),
        ] {
            let response = dispatch(
                &state,
                org,
                "COLLECTION_THREADS_CREATE",
                &Bytes::from(input.to_string()),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }

        let thread_id = "reserved-exact";
        let create = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_CREATE",
            &Bytes::from(
                json!({"data": {
                    "id": thread_id,
                    "virtual_mcp_id": "vmcp-reserved",
                    "branch": format!("thread:{thread_id}/connection-1")
                }})
                .to_string(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(create.status(), StatusCode::OK);

        for branch in [
            "thread:another-thread",
            "thread:reserved-exact/",
            " thread:reserved-exact ",
        ] {
            let update = dispatch(
                &state,
                org,
                "COLLECTION_THREADS_UPDATE",
                &Bytes::from(json!({"id": thread_id, "data": {"branch": branch}}).to_string()),
            )
            .await
            .unwrap();
            assert_eq!(update.status(), StatusCode::BAD_REQUEST);
        }

        let get = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_GET",
            &Bytes::from(json!({"id": thread_id}).to_string()),
        )
        .await
        .unwrap();
        assert_eq!(
            body_json(get).await["item"]["branch"],
            format!("thread:{thread_id}/connection-1")
        );
    }

    #[tokio::test]
    async fn create_and_update_reject_schema_invalid_fields_instead_of_coercing_them() {
        let state = persistent_test_state();
        let invalid_creates = [
            json!([]),
            json!({}),
            json!({"data": null}),
            json!({"data": []}),
            json!({"data": {"virtual_mcp_id": 7}}),
            json!({"data": {"virtual_mcp_id": "v", "id": 7}}),
            json!({"data": {"virtual_mcp_id": "v", "title": null}}),
            json!({"data": {"virtual_mcp_id": "v", "description": false}}),
            json!({"data": {"virtual_mcp_id": "v", "branch": null}}),
            json!({"data": {"virtual_mcp_id": "v", "branch": ""}}),
        ];
        for (index, input) in invalid_creates.into_iter().enumerate() {
            let response = dispatch(
                &state,
                "thread-tools-invalid-create",
                "COLLECTION_THREADS_CREATE",
                &Bytes::from(input.to_string()),
            )
            .await
            .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "invalid create case {index} must be rejected"
            );
        }

        let invalid_updates = [
            json!([]),
            json!({}),
            json!({"id": "t", "data": null}),
            json!({"id": "t", "data": []}),
            json!({"id": 7, "data": {}}),
            json!({"id": "t", "data": {"title": null}}),
            json!({"id": "t", "data": {"description": false}}),
            json!({"id": "t", "data": {"hidden": "true"}}),
            json!({"id": "t", "data": {"status": "expired"}}),
            json!({"id": "t", "data": {"metadata": null}}),
            json!({"id": "t", "data": {"metadata": []}}),
            json!({"id": "t", "data": {"metadata": {"expanded_tools": {}}}}),
            json!({
                "id": "t",
                "data": {
                    "metadata": {
                        "expanded_tools": [{
                            "toolName": "TOOL",
                            "appId": "app",
                            "args": {},
                            "expandedAt": "not-a-date"
                        }]
                    }
                }
            }),
            json!({"id": "t", "data": {"branch": 7}}),
            json!({"id": "t", "data": {"virtual_mcp_id": null}}),
        ];
        for (index, input) in invalid_updates.into_iter().enumerate() {
            let response = dispatch(
                &state,
                "thread-tools-invalid-update",
                "COLLECTION_THREADS_UPDATE",
                &Bytes::from(input.to_string()),
            )
            .await
            .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "invalid update case {index} must be rejected before lookup"
            );
        }
    }

    #[tokio::test]
    async fn update_accepts_every_production_typed_optional_field() {
        let state = persistent_test_state();
        let org = "thread-tools-valid-update-fields";
        let create = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_CREATE",
            &Bytes::from(json!({"data": {"virtual_mcp_id": "v"}}).to_string()),
        )
        .await
        .unwrap();
        let id = body_json(create).await["item"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let response = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_UPDATE",
            &Bytes::from(
                json!({
                    "id": id,
                    "data": {
                        "title": "updated",
                        "description": null,
                        "hidden": true,
                        "status": "requires_action",
                        "metadata": {"expanded_tools": []},
                        "branch": null,
                        "virtual_mcp_id": "v2"
                    }
                })
                .to_string(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let item = body_json(response).await["item"].clone();
        assert_eq!(item["title"], "updated");
        assert_eq!(item["description"], Value::Null);
        assert_eq!(item["hidden"], true);
        assert_eq!(item["status"], "requires_action");
        assert_eq!(item["metadata"], json!({"expanded_tools": []}));
        assert_eq!(item["branch"], Value::Null);
        assert_eq!(item["virtual_mcp_id"], "v2");
        assert_eq!(item["updated_by"], "local-desktop-user");

        let empty_metadata = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_UPDATE",
            &Bytes::from(json!({"id": id, "data": {"metadata": {}}}).to_string()),
        )
        .await
        .unwrap();
        let empty_metadata = body_json(empty_metadata).await;
        assert!(!empty_metadata["item"]
            .as_object()
            .unwrap()
            .contains_key("metadata"));
    }

    #[tokio::test]
    async fn explicit_id_create_maps_a_retired_id_to_conflict() {
        let state = persistent_test_state();
        let scope = RtAccountScope::new("test.invalid", "local-desktop-user").unwrap();
        let org = "thread-tools-retired-create-org";
        let id = "thread-tools-retired-create";
        let database = shared_db(&state).unwrap();
        database
            .rt_create_thread_scoped(
                &scope,
                Some(id),
                org,
                "deleted",
                None,
                "v",
                None,
                &scope.user_id,
            )
            .unwrap();
        let fence = database
            .rt_thread_fence_in_scope(&scope, org, id)
            .unwrap()
            .unwrap();
        assert!(database
            .rt_delete_thread_in_org_if_generation(&fence)
            .unwrap());

        let body = Bytes::from(
            json!({
                "data": {
                    "id": id,
                    "title": "must remain deleted",
                    "virtual_mcp_id": "v",
                },
            })
            .to_string(),
        );
        let response = dispatch(&state, org, "COLLECTION_THREADS_CREATE", &body)
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
        assert_eq!(
            body_json(response).await["error"],
            "thread id is unavailable"
        );
    }

    #[tokio::test]
    async fn list_filters_by_org_and_paginates() {
        let state = persistent_test_state();
        // `shared_db` is a PROCESS-WIDE `OnceLock` (see its own doc comment
        // — by design, for the single-`AppState`-per-real-process case),
        // so every test in this binary shares ONE underlying SQLite
        // instance regardless of each test's own (unused, for this reason)
        // tempdir. A count-by-org assertion therefore needs organization
        // ids no OTHER test in this file uses, or it would flakily observe
        // other tests' rows too — everything else in this file asserts by
        // exact (randomly-generated) thread id instead, which has no such
        // collision risk.
        for org in [
            "list-filters-test-org-a",
            "list-filters-test-org-a",
            "list-filters-test-org-b",
        ] {
            let body =
                Bytes::from(json!({"data": {"title": "t", "virtual_mcp_id": "v"}}).to_string());
            dispatch(&state, org, "COLLECTION_THREADS_CREATE", &body)
                .await
                .unwrap();
        }
        let list_body = Bytes::from(json!({"limit": 50, "offset": 0}).to_string());
        let res = dispatch(
            &state,
            "list-filters-test-org-a",
            "COLLECTION_THREADS_LIST",
            &list_body,
        )
        .await
        .unwrap();
        let listed = body_json(res).await;
        assert_eq!(listed["totalCount"], 2);
        assert_eq!(listed["items"].as_array().unwrap().len(), 2);
        assert_eq!(listed["hasMore"], false);
    }

    #[tokio::test]
    async fn list_returns_every_visible_thread_unpaginated() {
        let state = persistent_test_state();
        let database = shared_db(&state).unwrap();
        let org = "thread-tools-default-visible-limit";
        for index in 0..101 {
            database
                .rt_create_thread(
                    Some(&format!("thread-tools-default-visible-{index}")),
                    org,
                    "visible",
                    None,
                    "v",
                    None,
                    "local-desktop-user",
                )
                .unwrap();
        }
        let hidden_id = "thread-tools-default-hidden";
        database
            .rt_create_thread(
                Some(hidden_id),
                org,
                "hidden",
                None,
                "v",
                None,
                "local-desktop-user",
            )
            .unwrap();
        database
            .rt_update_thread_in_org(
                org,
                hidden_id,
                "local-desktop-user",
                &RtThreadPatch {
                    hidden: Some(true),
                    ..RtThreadPatch::default()
                },
            )
            .unwrap();

        let visible = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_LIST",
            &Bytes::from_static(b"{}"),
        )
        .await
        .unwrap();
        let visible = body_json(visible).await;
        // Inverted from the old paged behavior (100 items / hasMore: true):
        // the local list now answers in FULL so the desktop UI can treat its
        // in-memory copy as complete. 101 visible rows means 101 items, and a
        // client paging loop must terminate on the first response.
        assert_eq!(visible["totalCount"], 101);
        assert_eq!(visible["items"].as_array().unwrap().len(), 101);
        assert_eq!(visible["hasMore"], false);
        assert!(visible["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["hidden"] == false));

        let archived = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_LIST",
            &Bytes::from_static(br#"{"where":{"hidden":true}}"#),
        )
        .await
        .unwrap();
        let archived = body_json(archived).await;
        assert_eq!(archived["totalCount"], 1);
        assert_eq!(archived["items"][0]["id"], hidden_id);
    }

    #[tokio::test]
    async fn list_validates_pagination_and_supported_filter_shapes() {
        let state = persistent_test_state();
        for input in [
            json!({"limit": 0}),
            json!({"limit": -1}),
            json!({"limit": 1001}),
            json!({"limit": 1.5}),
            json!({"limit": "50"}),
            json!({"offset": -1}),
            json!({"offset": 1.5}),
            json!({"offset": "0"}),
            json!({"where": null}),
            json!({"where": {"hidden": "false"}}),
            json!({"where": {"created_by": 1}}),
            json!({"where": {"trigger_ids": ["ok", 1]}}),
            json!({"where": {"virtual_mcp_id": 1}}),
            json!({"where": {"has_trigger": "true"}}),
            json!({"search": 1}),
            json!({"status": false}),
            json!({"startDate": "2026-02-30T00:00:00.000Z"}),
            json!({"orderBy": [{"field": ["updated_at"], "direction": "sideways"}]}),
        ] {
            let response = dispatch(
                &state,
                "thread-tools-list-validation",
                "COLLECTION_THREADS_LIST",
                &Bytes::from(input.to_string()),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "input: {input}");
        }
    }

    #[tokio::test]
    async fn list_applies_production_filters_and_agent_fallback_without_ignoring_them() {
        let state = persistent_test_state();
        let database = shared_db(&state).unwrap();
        let org = "thread-tools-list-all-filters";
        for (id, title, virtual_mcp_id) in [
            (
                "thread-tools-filter-primary",
                "Needle primary",
                "vm-primary",
            ),
            ("thread-tools-filter-agent", "Needle fallback", "vm-agent"),
            ("thread-tools-filter-hidden", "Needle hidden", "vm-primary"),
        ] {
            database
                .rt_create_thread(
                    Some(id),
                    org,
                    title,
                    None,
                    virtual_mcp_id,
                    None,
                    "local-desktop-user",
                )
                .unwrap();
        }
        database
            .rt_update_thread_in_org(
                org,
                "thread-tools-filter-agent",
                "local-desktop-user",
                &RtThreadPatch {
                    status: Some("failed".to_string()),
                    ..RtThreadPatch::default()
                },
            )
            .unwrap();
        database
            .rt_update_thread_in_org(
                org,
                "thread-tools-filter-hidden",
                "local-desktop-user",
                &RtThreadPatch {
                    hidden: Some(true),
                    ..RtThreadPatch::default()
                },
            )
            .unwrap();

        // `virtual_mcp_id` wins over `agentId`; every other normal predicate
        // composes, and count uses the identical WHERE clause as items.
        let filtered = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_LIST",
            &Bytes::from(
                json!({
                    "where": {
                        "hidden": false,
                        "virtual_mcp_id": "vm-primary",
                        "has_trigger": false
                    },
                    "startDate": "2000-01-01T00:00:00.000Z",
                    "endDate": "2999-01-01T00:00:00Z",
                    "search": "needle",
                    "status": "completed",
                    "userId": "local-desktop-user",
                    "agentId": "vm-agent"
                })
                .to_string(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(filtered.status(), StatusCode::OK);
        let filtered = body_json(filtered).await;
        assert_eq!(filtered["totalCount"], 1);
        assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
        assert_eq!(filtered["items"][0]["id"], "thread-tools-filter-primary");

        let fallback = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_LIST",
            &Bytes::from_static(br#"{"where":{"has_trigger":false},"agentId":"vm-agent"}"#),
        )
        .await
        .unwrap();
        let fallback = body_json(fallback).await;
        assert_eq!(fallback["totalCount"], 1);
        assert_eq!(fallback["items"][0]["id"], "thread-tools-filter-agent");

        let non_matching_trigger = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_LIST",
            &Bytes::from_static(br#"{"where":{"trigger_ids":["missing"]}}"#),
        )
        .await
        .unwrap();
        assert_eq!(non_matching_trigger.status(), StatusCode::OK);
        assert_eq!(body_json(non_matching_trigger).await["totalCount"], 0);

        let empty_trigger_ids = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_LIST",
            &Bytes::from_static(br#"{"where":{"trigger_ids":[],"virtual_mcp_id":"vm-primary"}}"#),
        )
        .await
        .unwrap();
        assert_eq!(empty_trigger_ids.status(), StatusCode::OK);
        assert_eq!(body_json(empty_trigger_ids).await["totalCount"], 1);
    }

    /// The local list ignores `limit`/`offset` on purpose — the desktop UI
    /// depends on its in-memory copy being COMPLETE, so a client asking for one
    /// row still gets all of them and is told there is no next page. A
    /// malformed value is still rejected, because "ignored" must not degrade
    /// into "unvalidated".
    #[tokio::test]
    async fn list_ignores_caller_pagination_but_still_validates_it() {
        let state = persistent_test_state();
        let org = "thread-tools-ignores-pagination";
        for _ in 0..3 {
            let body =
                Bytes::from(json!({"data": {"title": "t", "virtual_mcp_id": "v"}}).to_string());
            dispatch(&state, org, "COLLECTION_THREADS_CREATE", &body)
                .await
                .unwrap();
        }

        let one = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_LIST",
            &Bytes::from_static(br#"{"limit":1,"offset":0}"#),
        )
        .await
        .unwrap();
        let one = body_json(one).await;
        assert_eq!(one["items"].as_array().unwrap().len(), 3);
        assert_eq!(one["totalCount"], 3);
        assert_eq!(one["hasMore"], false);

        // An offset past the end would have emptied a paged response; here it
        // changes nothing, which is what makes the client's loop terminate.
        let offset = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_LIST",
            &Bytes::from_static(br#"{"offset":99}"#),
        )
        .await
        .unwrap();
        assert_eq!(
            body_json(offset).await["items"].as_array().unwrap().len(),
            3
        );

        let malformed = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_LIST",
            &Bytes::from_static(br#"{"limit":0}"#),
        )
        .await
        .unwrap();
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn routes_isolate_same_org_slug_by_upstream_and_authenticated_user() {
        let state = persistent_test_state();
        let org = "route-account-scope-shared-org";
        let id = "route-account-scope-local-thread";
        let local = RtAccountScope::new("test.invalid", "local-desktop-user").unwrap();
        let prod_alice = RtAccountScope::new("studio.decocms.com", "alice").unwrap();
        let dev_alice = RtAccountScope::new("localhost:4000", "alice").unwrap();
        let body = Bytes::from(json!({"data": {"id": id, "virtual_mcp_id": "vmcp"}}).to_string());
        let created = dispatch_scoped(&state, &local, org, "COLLECTION_THREADS_CREATE", &body)
            .await
            .unwrap();
        assert_eq!(created.status(), axum::http::StatusCode::OK);
        let created = body_json(created).await;
        assert_eq!(created["item"]["organization_id"], org);
        assert_eq!(created["item"]["created_by"], "local-desktop-user");
        assert_eq!(created["item"]["title"], "New chat");

        let database = shared_db(&state).unwrap();
        for (scope, foreign_id) in [
            (&prod_alice, "route-account-scope-prod-alice"),
            (&dev_alice, "route-account-scope-dev-alice"),
        ] {
            database
                .rt_create_thread_scoped(
                    scope,
                    Some(foreign_id),
                    org,
                    "foreign",
                    None,
                    "vmcp",
                    None,
                    &scope.user_id,
                )
                .unwrap();
        }

        let list_body = Bytes::from(json!({"where": {"created_by": "me"}}).to_string());
        let local_list = body_json(
            dispatch_scoped(&state, &local, org, "COLLECTION_THREADS_LIST", &list_body)
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(local_list["totalCount"], 1);

        for foreign_id in [
            "route-account-scope-prod-alice",
            "route-account-scope-dev-alice",
        ] {
            let get = body_json(
                dispatch_scoped(
                    &state,
                    &local,
                    org,
                    "COLLECTION_THREADS_GET",
                    &Bytes::from(json!({"id": foreign_id}).to_string()),
                )
                .await
                .unwrap(),
            )
            .await;
            assert_eq!(get, json!({"item": null}));
        }

        let stale_scope = dispatch_scoped(
            &state,
            &prod_alice,
            org,
            "COLLECTION_THREADS_LIST",
            &list_body,
        )
        .await
        .unwrap();
        assert_eq!(stale_scope.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn update_hides_a_thread() {
        let state = persistent_test_state();
        let create_body =
            Bytes::from(json!({"data": {"title": "t", "virtual_mcp_id": "v"}}).to_string());
        let created = body_json(
            dispatch(&state, "acme", "COLLECTION_THREADS_CREATE", &create_body)
                .await
                .unwrap(),
        )
        .await;
        let id = created["item"]["id"].as_str().unwrap().to_string();

        let update_body = Bytes::from(json!({"id": id, "data": {"hidden": true}}).to_string());
        let res = dispatch(&state, "acme", "COLLECTION_THREADS_UPDATE", &update_body)
            .await
            .unwrap();
        let updated = body_json(res).await;
        assert_eq!(updated["item"]["hidden"], true);
    }

    #[tokio::test]
    async fn update_unknown_thread_is_404() {
        let state = persistent_test_state();
        let body = Bytes::from(json!({"id": "nope", "data": {"title": "x"}}).to_string());
        let res = dispatch(&state, "acme", "COLLECTION_THREADS_UPDATE", &body)
            .await
            .unwrap();
        assert_eq!(res.status(), axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn teammate_thread_update_and_delete_are_forbidden() {
        let state = persistent_test_state();
        let scope = RtAccountScope::new("test.invalid", "local-desktop-user").unwrap();
        let org = "thread-tools-teammate-authority";
        let id = "thread-tools-teammate-thread";
        shared_db(&state)
            .unwrap()
            .rt_create_thread_scoped(
                &scope,
                Some(id),
                org,
                "Teammate chat",
                None,
                "vmcp",
                None,
                "teammate-user",
            )
            .unwrap();

        let update = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_UPDATE",
            &Bytes::from(json!({"id": id, "data": {"title": "hijacked"}}).to_string()),
        )
        .await
        .unwrap();
        assert_eq!(update.status(), StatusCode::FORBIDDEN);

        let delete = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_DELETE",
            &Bytes::from(json!({"id": id}).to_string()),
        )
        .await
        .unwrap();
        assert_eq!(delete.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            shared_db(&state)
                .unwrap()
                .rt_get_thread_in_scope(&scope, org, id)
                .unwrap()
                .unwrap()
                .title,
            "Teammate chat"
        );
    }

    #[tokio::test]
    async fn changing_a_reserved_terminal_workspace_returns_conflict() {
        let state = persistent_test_state();
        let org = "thread-tools-workspace-lock";
        let created = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_CREATE",
            &Bytes::from(json!({"data": {"virtual_mcp_id": "vmcp", "branch": "main"}}).to_string()),
        )
        .await
        .unwrap();
        let id = body_json(created).await["item"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let database = shared_db(&state).unwrap();
        let fence = database.rt_thread_fence_in_org(org, &id).unwrap().unwrap();
        database
            .rt_create_terminal_session_fenced(&fence, "workspace-lock-terminal", "codex")
            .unwrap();

        let response = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_UPDATE",
            &Bytes::from(
                json!({"id": id, "data": {"branch": "feature", "hidden": true}}).to_string(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            body_json(response).await,
            json!({"error": "The chat workspace cannot be changed after its coding agent starts."})
        );
        assert!(database
            .rt_get_live_terminal_session_fenced(&fence)
            .unwrap()
            .is_some());
        assert!(
            !database
                .rt_get_thread_in_org(org, &id)
                .unwrap()
                .unwrap()
                .hidden
        );
    }

    #[tokio::test]
    async fn routing_update_waits_for_the_workspace_lifecycle_lock() {
        let state = persistent_test_state();
        let org = "thread-tools-routing-linearization";
        let id = "thread-tools-routing-linearization-thread";
        let database = shared_db(&state).unwrap();
        database
            .rt_create_thread(
                Some(id),
                org,
                "Routing chat",
                None,
                "vmcp-a",
                Some("main"),
                "local-desktop-user",
            )
            .unwrap();
        let fence = database.rt_thread_fence_in_org(org, id).unwrap().unwrap();
        let lifecycle_lock = state.agent_sessions.start_lock(&fence);
        let lifecycle_guard = lifecycle_lock.lock().await;

        let update_state = state.clone();
        let update = tokio::spawn(async move {
            dispatch(
                &update_state,
                org,
                "COLLECTION_THREADS_UPDATE",
                &Bytes::from(
                    json!({"id": id, "data": {"branch": "feature", "virtual_mcp_id": "vmcp-b"}})
                        .to_string(),
                ),
            )
            .await
            .unwrap()
        });
        tokio::task::yield_now().await;
        assert!(!update.is_finished());
        let before = database.rt_get_thread_in_org(org, id).unwrap().unwrap();
        assert_eq!(before.branch.as_deref(), Some("main"));
        assert_eq!(before.virtual_mcp_id, "vmcp-a");

        drop(lifecycle_guard);
        let response = tokio::time::timeout(std::time::Duration::from_secs(1), update)
            .await
            .expect("routing update should resume after the lifecycle lock")
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let after = body_json(response).await["item"].clone();
        assert_eq!(after["branch"], "feature");
        assert_eq!(after["virtual_mcp_id"], "vmcp-b");
    }

    #[tokio::test]
    async fn routing_update_quiesces_the_pre_patch_synthetic_sandbox() {
        let state = persistent_test_state();
        let org = "thread-tools-routing-old-sandbox";
        let id = "thread-tools-routing-old-sandbox-thread";
        let branch = format!("thread:{id}");
        let database = shared_db(&state).unwrap();
        database
            .rt_create_thread(
                Some(id),
                org,
                "Routing chat",
                None,
                "test-agent",
                Some(&branch),
                "local-desktop-user",
            )
            .unwrap();
        let account = state
            .sandbox_manager
            .test_account_for_scope(
                &RtAccountScope::new("test.invalid", "local-desktop-user").unwrap(),
            )
            .unwrap();
        let handle = state.sandbox_manager.register_for_test_account(
            &account,
            "https://github.com/acme/routing-old-sandbox.git",
            &branch,
        );
        let old_generation = state
            .sandbox_manager
            .adopt_for_account(&account, &handle)
            .await
            .unwrap()
            .expect("synthetic sandbox is live before the identity patch");
        assert!(!old_generation.tasks.is_admission_closed());

        let response = dispatch(
            &state,
            org,
            "COLLECTION_THREADS_UPDATE",
            &Bytes::from(json!({"id": id, "data": {"virtual_mcp_id": "vmcp-b"}}).to_string()),
        )
        .await
        .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body_json(response).await["item"]["virtual_mcp_id"],
            "vmcp-b"
        );
        assert!(state
            .sandbox_manager
            .get_for_account(&account, &handle)
            .unwrap()
            .is_none());
        assert!(old_generation.tasks.is_admission_closed());
        assert!(old_generation.tasks.list(None).is_empty());
        assert_eq!(
            state
                .sandbox_manager
                .registry_record_for_account(&account, &handle)
                .unwrap()
                .unwrap()
                .desired_status,
            "stopped"
        );
    }

    #[tokio::test]
    async fn explicit_id_owned_by_another_org_is_a_non_disclosing_conflict() {
        let state = persistent_test_state();
        let id = "thread-tools-cross-org-create-conflict";
        let create = |title: &str| {
            Bytes::from(
                json!({
                    "data": {
                        "id": id,
                        "title": title,
                        "virtual_mcp_id": "v",
                    },
                })
                .to_string(),
            )
        };

        let first = dispatch(
            &state,
            "thread-tools-owner-org",
            "COLLECTION_THREADS_CREATE",
            &create("owner title"),
        )
        .await
        .unwrap();
        assert_eq!(first.status(), axum::http::StatusCode::OK);

        let conflict = dispatch(
            &state,
            "thread-tools-other-org",
            "COLLECTION_THREADS_CREATE",
            &create("attacker title"),
        )
        .await
        .unwrap();
        assert_eq!(conflict.status(), axum::http::StatusCode::CONFLICT);
        assert_eq!(
            body_json(conflict).await,
            json!({ "error": "thread id is unavailable" })
        );

        let owner = shared_db(&state)
            .unwrap()
            .rt_get_thread_in_org("thread-tools-owner-org", id)
            .unwrap()
            .unwrap();
        assert_eq!(owner.title, "owner title");
    }

    #[tokio::test]
    async fn id_operations_are_org_scoped_and_delete_cascades_messages() {
        let state = persistent_test_state();
        let db = shared_db(&state).unwrap();
        let owner_org = "thread-tools-scope-owner";
        let other_org = "thread-tools-scope-other";
        let id = "thread-tools-scoped-delete";
        db.rt_create_thread(
            Some(id),
            owner_org,
            "original",
            None,
            "v",
            None,
            "local-desktop-user",
        )
        .unwrap();
        db.rt_append_message("scoped-u", id, "user", &json!([]), None)
            .unwrap();
        db.rt_append_message("scoped-a", id, "assistant", &json!([]), None)
            .unwrap();

        let id_body = Bytes::from(json!({ "id": id }).to_string());
        let foreign_get = dispatch(&state, other_org, "COLLECTION_THREADS_GET", &id_body)
            .await
            .unwrap();
        assert_eq!(body_json(foreign_get).await, json!({ "item": null }));

        let update_body =
            Bytes::from(json!({ "id": id, "data": { "title": "hijacked" } }).to_string());
        let foreign_update = dispatch(&state, other_org, "COLLECTION_THREADS_UPDATE", &update_body)
            .await
            .unwrap();
        assert_eq!(foreign_update.status(), axum::http::StatusCode::NOT_FOUND);

        let messages_body = Bytes::from(json!({ "thread_id": id }).to_string());
        let foreign_messages = dispatch(
            &state,
            other_org,
            "COLLECTION_THREAD_MESSAGES_LIST",
            &messages_body,
        )
        .await
        .unwrap();
        assert_eq!(
            body_json(foreign_messages).await,
            json!({ "items": [], "totalCount": 0, "hasMore": false })
        );

        let foreign_delete = dispatch(&state, other_org, "COLLECTION_THREADS_DELETE", &id_body)
            .await
            .unwrap();
        assert_eq!(foreign_delete.status(), axum::http::StatusCode::NOT_FOUND);
        let owner = db
            .rt_get_thread_in_org(owner_org, id)
            .unwrap()
            .expect("foreign operations must not remove the owner's row");
        assert_eq!(owner.title, "original");
        assert_eq!(db.rt_list_messages(id, 100, 0, false).unwrap().1, 2);

        let owner_delete = dispatch(&state, owner_org, "COLLECTION_THREADS_DELETE", &id_body)
            .await
            .unwrap();
        assert_eq!(owner_delete.status(), axum::http::StatusCode::OK);
        assert_eq!(body_json(owner_delete).await["item"]["id"], id);
        assert!(db.rt_get_thread(id).unwrap().is_none());
        assert_eq!(
            db.rt_list_messages(id, 100, 0, false).unwrap().1,
            0,
            "foreign-key cascade must physically remove the messages"
        );
    }

    #[tokio::test]
    async fn messages_list_is_empty_for_a_fresh_thread() {
        let state = persistent_test_state();
        let create_body =
            Bytes::from(json!({"data": {"title": "t", "virtual_mcp_id": "v"}}).to_string());
        let created = body_json(
            dispatch(&state, "acme", "COLLECTION_THREADS_CREATE", &create_body)
                .await
                .unwrap(),
        )
        .await;
        let id = created["item"]["id"].as_str().unwrap().to_string();

        let body = Bytes::from(json!({"thread_id": id}).to_string());
        let res = dispatch(&state, "acme", "COLLECTION_THREAD_MESSAGES_LIST", &body)
            .await
            .unwrap();
        let listed = body_json(res).await;
        assert_eq!(listed["items"].as_array().unwrap().len(), 0);
        assert_eq!(listed["totalCount"], 0);
    }

    #[tokio::test]
    async fn messages_list_supports_recursive_legacy_where_with_top_level_precedence() {
        let state = persistent_test_state();
        let database = shared_db(&state).unwrap();
        let org = "thread-tools-message-legacy-where";
        let first_thread = "thread-tools-message-legacy-first";
        let second_thread = "thread-tools-message-legacy-second";
        for thread_id in [first_thread, second_thread] {
            database
                .rt_create_thread(
                    Some(thread_id),
                    org,
                    thread_id,
                    None,
                    "v",
                    None,
                    "local-desktop-user",
                )
                .unwrap();
        }
        database
            .rt_append_message(
                "legacy-where-first-message",
                first_thread,
                "user",
                &json!([]),
                None,
            )
            .unwrap();
        database
            .rt_append_message(
                "legacy-where-second-message",
                second_thread,
                "user",
                &json!([]),
                None,
            )
            .unwrap();

        let nested_where = json!({
            "where": {
                "operator": "and",
                "conditions": [
                    {"field": ["role"], "operator": "eq", "value": "user"},
                    {
                        "operator": "or",
                        "conditions": [
                            {"field": ["thread_id"], "operator": "eq", "value": first_thread}
                        ]
                    }
                ]
            }
        });
        let response = dispatch(
            &state,
            org,
            "COLLECTION_THREAD_MESSAGES_LIST",
            &Bytes::from(nested_where.to_string()),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = body_json(response).await;
        assert_eq!(response["items"][0]["id"], "legacy-where-first-message");

        let top_level_wins = json!({
            "thread_id": second_thread,
            "where": {"field": ["thread_id"], "operator": "eq", "value": first_thread}
        });
        let response = dispatch(
            &state,
            org,
            "COLLECTION_THREAD_MESSAGES_LIST",
            &Bytes::from(top_level_wins.to_string()),
        )
        .await
        .unwrap();
        let response = body_json(response).await;
        assert_eq!(response["items"][0]["id"], "legacy-where-second-message");
    }

    #[tokio::test]
    async fn messages_list_validates_collection_pagination_and_where_shapes() {
        let state = persistent_test_state();
        for input in [
            json!([]),
            json!({"thread_id": 1}),
            json!({"thread_id": "t", "limit": 0}),
            json!({"thread_id": "t", "limit": 1001}),
            json!({"thread_id": "t", "limit": 1.5}),
            json!({"thread_id": "t", "offset": -1}),
            json!({"thread_id": "t", "offset": 1.5}),
            json!({"where": null}),
            json!({"where": {"operator": "eq", "field": "thread_id", "value": "t"}}),
            json!({"where": {"operator": "and", "conditions": [null]}}),
            json!({
                "thread_id": "t",
                "orderBy": [{"field": ["created_at"], "direction": "sideways"}]
            }),
        ] {
            let response = dispatch(
                &state,
                "thread-tools-message-validation",
                "COLLECTION_THREAD_MESSAGES_LIST",
                &Bytes::from(input.to_string()),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "input: {input}");
        }
    }

    #[tokio::test]
    async fn messages_list_items_carry_ascending_seq() {
        let state = persistent_test_state();
        // Append messages directly via the (process-wide) db — there is no
        // thread_tools HTTP handler that writes messages (that's decopilot's
        // send_message). A thread id no other test uses avoids collisions on
        // the shared `shared_db` OnceLock (see `list_filters_by_org` note).
        let db = shared_db(&state).unwrap();
        let tid = "messages-list-seq-thread";
        db.rt_create_thread(Some(tid), "acme", "", None, "v", None, "u")
            .unwrap();
        db.rt_append_message("u1", tid, "user", &json!([]), None)
            .unwrap();
        db.rt_append_message("a1", tid, "assistant", &json!([]), None)
            .unwrap();

        let body = Bytes::from(
            json!({
                "thread_id": tid,
                "orderBy": [{"field": ["created_at"], "direction": "asc"}],
            })
            .to_string(),
        );
        let res = dispatch(&state, "acme", "COLLECTION_THREAD_MESSAGES_LIST", &body)
            .await
            .unwrap();
        let listed = body_json(res).await;
        let items = listed["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        let s0 = items[0]["seq"].as_i64().expect("seq present on item 0");
        let s1 = items[1]["seq"].as_i64().expect("seq present on item 1");
        assert!(s0 < s1, "asc items must carry strictly increasing seq");
        assert_eq!(items[0]["id"], "u1");
        assert_eq!(items[1]["id"], "a1");
    }

    #[tokio::test]
    async fn unrecognized_tool_name_is_not_intercepted() {
        let state = persistent_test_state();
        let res = dispatch(&state, "acme", "SOME_OTHER_TOOL", &Bytes::new()).await;
        assert!(res.is_none());
    }
}
