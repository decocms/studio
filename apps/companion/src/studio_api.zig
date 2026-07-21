//! Talks to Studio on behalf of the companion app:
//!  - reads the `deco link` session token from `~/deco/session.*.json`
//!  - calls `POST /api/companion/provision` (via `curl`, so we avoid Zig 0.16's
//!    std.http/TLS surface and keep the token out of the WebView/JS)
//!
//! The provisioning endpoint returns `{ studioUrl, orgs: [{slug,name,url,key}] }`.
const std = @import("std");
const claude_config = @import("claude_config.zig");

pub const Session = struct {
    token: []const u8,
    target: []const u8,
};

/// Filename-safe key from a studio host (mirrors the CLI's `sessionKey`).
fn sessionKey(alloc: std.mem.Allocator, target: []const u8) ![]u8 {
    const host = hostOf(target);
    const buf = try alloc.alloc(u8, host.len);
    for (host, 0..) |ch, i| {
        buf[i] = if (std.ascii.isAlphanumeric(ch) or ch == '.' or ch == '-') ch else '_';
    }
    return buf;
}

fn hostOf(target: []const u8) []const u8 {
    var s = target;
    if (std.mem.indexOf(u8, s, "://")) |i| s = s[i + 3 ..];
    if (std.mem.indexOfScalar(u8, s, '/')) |i| s = s[0..i];
    return s;
}

/// Read the session for `target` from `data_dir`, falling back to the legacy
/// `session.json`. Returns the bearer token + the session's studio target.
pub fn readSession(
    alloc: std.mem.Allocator,
    io: std.Io,
    data_dir: []const u8,
    target: []const u8,
) !Session {
    const key = try sessionKey(alloc, target);
    const primary = try std.fmt.allocPrint(alloc, "{s}/session.{s}.json", .{ data_dir, key });
    const legacy = try std.fmt.allocPrint(alloc, "{s}/session.json", .{data_dir});

    const body = readFileMaybe(alloc, io, primary) orelse
        readFileMaybe(alloc, io, legacy) orelse
        return error.NoSession;

    var parsed = try std.json.parseFromSlice(std.json.Value, alloc, body, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return error.BadSession;
    const token_v = parsed.value.object.get("accessToken") orelse return error.NoToken;
    const target_v = parsed.value.object.get("target");
    if (token_v != .string) return error.NoToken;
    return .{
        .token = try alloc.dupe(u8, token_v.string),
        .target = if (target_v != null and target_v.? == .string)
            try alloc.dupe(u8, target_v.?.string)
        else
            try alloc.dupe(u8, target),
    };
}

fn readFileMaybe(alloc: std.mem.Allocator, io: std.Io, path: []const u8) ?[]u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, alloc, .limited(4 * 1024 * 1024)) catch null;
}

/// Call `POST <studio_url>/api/companion/provision` with the bearer and return
/// the raw response body (caller owns).
pub fn curlProvision(
    alloc: std.mem.Allocator,
    io: std.Io,
    studio_url: []const u8,
    token: []const u8,
) ![]const u8 {
    const url = try std.fmt.allocPrint(alloc, "{s}/api/companion/provision", .{studio_url});
    const auth = try std.fmt.allocPrint(alloc, "Authorization: Bearer {s}", .{token});
    const result = try std.process.run(alloc, io, .{
        .argv = &.{ "curl", "-sS", "-X", "POST", "-H", auth, "-H", "content-type: application/json", url },
        .stdout_limit = .limited(4 * 1024 * 1024),
    });
    if (result.term != .exited or result.term.exited != 0) {
        return error.CurlFailed;
    }
    return result.stdout;
}

/// Parse the provisioning response body into `McpEntry`s (arena-allocated via
/// `alloc`; slices borrow from `parsed`, which the caller must keep alive —
/// simplest is to pass an arena allocator and use the result before freeing).
pub fn parseEntries(
    alloc: std.mem.Allocator,
    body: []const u8,
) !struct { studio_url: []const u8, entries: []claude_config.McpEntry } {
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc, body, .{});
    // NOTE: intentionally not deinit'd — strings below borrow from it; caller
    // passes an arena so everything frees together.
    if (parsed.value != .object) return error.BadResponse;
    const root = parsed.value.object;
    const orgs_v = root.get("orgs") orelse return error.BadResponse;
    if (orgs_v != .array) return error.BadResponse;

    var list = try std.ArrayList(claude_config.McpEntry).initCapacity(alloc, orgs_v.array.items.len);
    for (orgs_v.array.items) |org_v| {
        if (org_v != .object) continue;
        const o = org_v.object;
        const slug = o.get("slug") orelse continue;
        const url = o.get("url") orelse continue;
        const key = o.get("key") orelse continue;
        if (slug != .string or url != .string or key != .string) continue;
        try list.append(alloc, .{ .slug = slug.string, .url = url.string, .key = key.string });
    }
    const studio_url_v = root.get("studioUrl");
    const studio_url = if (studio_url_v != null and studio_url_v.? == .string)
        studio_url_v.?.string
    else
        "";
    return .{ .studio_url = studio_url, .entries = list.items };
}
