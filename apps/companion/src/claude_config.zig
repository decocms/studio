//! Surgical merge of `deco-<slug>` MCP entries into Claude Code's global
//! `~/.claude.json`. The file holds far more than `mcpServers` (projects,
//! history, dozens of settings) and real installs carry other MCP servers —
//! so the merge MUST preserve every other top-level key and every non-`deco-`
//! server. Only `deco-<slug>` keys are added/overwritten (idempotent).
const std = @import("std");

pub const McpEntry = struct {
    slug: []const u8,
    url: []const u8,
    key: []const u8,
};

/// Merge `entries` into `existing` (a `~/.claude.json` body, or null/`{}` when
/// the file is absent) and return the serialized result (caller owns the
/// returned bytes; free with `alloc`).
///
/// Mutations happen inside the parsed doc's own arena so growth never mixes
/// allocators; only the final serialization uses the caller's `alloc`, so the
/// result outlives `parsed.deinit()`.
pub fn merge(
    alloc: std.mem.Allocator,
    existing: ?[]const u8,
    entries: []const McpEntry,
) ![]u8 {
    var parsed = try parseObject(alloc, existing orelse "{}");
    defer parsed.deinit();
    const a = parsed.arena.allocator();

    var root = &parsed.value.object;

    // Ensure a `mcpServers` object exists (create/replace if missing or wrong type).
    const existing_servers = root.getPtr("mcpServers");
    if (existing_servers == null or existing_servers.?.* != .object) {
        try root.put(a, "mcpServers", .{ .object = .empty });
    }
    var servers = &root.getPtr("mcpServers").?.object;

    for (entries) |e| {
        const name = try std.fmt.allocPrint(a, "deco-{s}", .{e.slug});
        const bearer = try std.fmt.allocPrint(a, "Bearer {s}", .{e.key});
        var headers: std.json.ObjectMap = .empty;
        try headers.put(a, "Authorization", .{ .string = bearer });
        var entry: std.json.ObjectMap = .empty;
        try entry.put(a, "type", .{ .string = "http" });
        try entry.put(a, "url", .{ .string = e.url });
        try entry.put(a, "headers", .{ .object = headers });
        try servers.put(a, name, .{ .object = entry });
    }

    return std.json.Stringify.valueAlloc(alloc, parsed.value, .{ .whitespace = .indent_2 });
}

/// Parse `src` into a JSON object. Falls back to an empty object when `src` is
/// malformed or is a non-object JSON value (never corrupts on a surprise).
fn parseObject(alloc: std.mem.Allocator, src: []const u8) !std.json.Parsed(std.json.Value) {
    const parsed = std.json.parseFromSlice(std.json.Value, alloc, src, .{}) catch
        return std.json.parseFromSlice(std.json.Value, alloc, "{}", .{});
    if (parsed.value != .object) {
        parsed.deinit();
        return std.json.parseFromSlice(std.json.Value, alloc, "{}", .{});
    }
    return parsed;
}

// ── tests ────────────────────────────────────────────────────────────────

const testing = std.testing;

fn expectContains(haystack: []const u8, needle: []const u8) !void {
    try testing.expect(std.mem.indexOf(u8, haystack, needle) != null);
}

test "adds a deco entry to an empty/absent config" {
    const out = try merge(testing.allocator, null, &.{
        .{ .slug = "acme", .url = "https://s/api/acme/mcp/virtual-mcp/decopilot_o1", .key = "k1" },
    });
    defer testing.allocator.free(out);
    try expectContains(out, "\"deco-acme\"");
    try expectContains(out, "\"url\": \"https://s/api/acme/mcp/virtual-mcp/decopilot_o1\"");
    try expectContains(out, "\"Authorization\": \"Bearer k1\"");
    try expectContains(out, "\"type\": \"http\"");
}

test "preserves existing mcpServers and other top-level keys" {
    const existing =
        \\{"numStartups":42,"mcpServers":{"posthog":{"type":"http","url":"https://ph"}},"projects":{"/x":{}}}
    ;
    const out = try merge(testing.allocator, existing, &.{
        .{ .slug = "acme", .url = "https://s/acme", .key = "k1" },
    });
    defer testing.allocator.free(out);
    // Untouched neighbors survive.
    try expectContains(out, "\"posthog\"");
    try expectContains(out, "\"numStartups\": 42");
    try expectContains(out, "\"projects\"");
    // New entry present.
    try expectContains(out, "\"deco-acme\"");
}

test "re-merge overwrites the same slug (idempotent, no duplicates)" {
    const first = try merge(testing.allocator, null, &.{
        .{ .slug = "acme", .url = "https://old", .key = "old" },
    });
    defer testing.allocator.free(first);
    const second = try merge(testing.allocator, first, &.{
        .{ .slug = "acme", .url = "https://new", .key = "new" },
    });
    defer testing.allocator.free(second);
    try expectContains(second, "https://new");
    try expectContains(second, "Bearer new");
    try testing.expect(std.mem.indexOf(u8, second, "https://old") == null);
    // Only one occurrence of the key name.
    const first_idx = std.mem.indexOf(u8, second, "\"deco-acme\"").?;
    try testing.expect(std.mem.indexOfPos(u8, second, first_idx + 1, "\"deco-acme\"") == null);
}
