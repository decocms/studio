const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");
const claude_config = @import("claude_config.zig");
const studio_api = @import("studio_api.zig");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const bridge = native_sdk.bridge;

/// Origins allowed to call the `deco.*` bridge commands: the packaged app
/// (`zero://app`/`zero://inline`) and the Vite dev server.
const dev_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" };

const App = struct {
    env_map: *std.process.Environ.Map,
    io: std.Io,

    fn app(self: *App) native_sdk.App {
        return .{
            .context = self,
            .name = "companion",
            .source = native_sdk.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
        };
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        const self: *App = @ptrCast(@alignCast(context));
        return native_sdk.frontend.sourceFromEnv(self.env_map, .{
            .dist = "frontend/dist",
            .entry = "index.html",
        });
    }

    fn env(self: *App, key: []const u8) ?[]const u8 {
        return self.env_map.get(key);
    }

    fn home(self: *App) []const u8 {
        return self.env("HOME") orelse ".";
    }

    fn dataDir(self: *App, a: std.mem.Allocator) ![]const u8 {
        if (self.env("DATA_DIR")) |d| return d;
        if (self.env("DECOCMS_HOME")) |d| return d;
        return std.fmt.allocPrint(a, "{s}/deco", .{self.home()});
    }

    fn studioUrl(self: *App) []const u8 {
        return self.env("DECO_STUDIO_URL") orelse
            self.env("MESH_CLUSTER_URL") orelse
            "https://studio.decocms.com";
    }

    fn claudeConfigPath(self: *App, a: std.mem.Allocator) ![]const u8 {
        if (self.env("DECO_CLAUDE_CONFIG")) |p| return p;
        return std.fmt.allocPrint(a, "{s}/.claude.json", .{self.home()});
    }
};

// ── core logic (shared by the bridge handlers and headless mode) ────────────

/// Result of `runStatus`/`runProvision`: a JSON string allocated in `a`.
fn runStatus(self: *App, a: std.mem.Allocator) ![]const u8 {
    const data_dir = self.dataDir(a) catch ".";
    const logged_in = blk: {
        const session = studio_api.readSession(a, self.io, data_dir, self.studioUrl()) catch break :blk false;
        break :blk session.token.len > 0;
    };
    return std.fmt.allocPrint(a, "{{\"loggedIn\":{},\"studioUrl\":\"{s}\"}}", .{ logged_in, self.studioUrl() });
}

/// Read the session token, call the provisioning endpoint, and surgically merge
/// the returned orgs into `~/.claude.json`. Returns `{ count, orgs: [...] }`.
fn runProvision(self: *App, a: std.mem.Allocator) ![]const u8 {
    const data_dir = try self.dataDir(a);
    const session = try studio_api.readSession(a, self.io, data_dir, self.studioUrl());

    const body = try studio_api.curlProvision(a, self.io, self.studioUrl(), session.token);
    const provisioned = try studio_api.parseEntries(a, body);
    if (provisioned.entries.len == 0) return "{\"count\":0,\"orgs\":[]}";

    // Surgical merge into ~/.claude.json (never clobber other servers/keys).
    const claude_path = try self.claudeConfigPath(a);
    const dir = std.Io.Dir.cwd();
    const existing = dir.readFileAlloc(self.io, claude_path, a, .limited(32 * 1024 * 1024)) catch null;
    const merged = try claude_config.merge(a, existing, provisioned.entries);

    // Best-effort backup, then atomic write (temp + rename).
    if (existing) |prev| {
        const bak = try std.fmt.allocPrint(a, "{s}.deco-bak", .{claude_path});
        dir.writeFile(self.io, .{ .sub_path = bak, .data = prev }) catch {};
    }
    const tmp = try std.fmt.allocPrint(a, "{s}.deco-tmp", .{claude_path});
    try dir.writeFile(self.io, .{ .sub_path = tmp, .data = merged });
    try std.Io.Dir.rename(dir, tmp, dir, claude_path, self.io);

    // Build { count, orgs: ["slug", ...] }.
    var buf: std.ArrayList(u8) = .empty;
    try buf.appendSlice(a, "{\"count\":");
    var numbuf: [24]u8 = undefined;
    try buf.appendSlice(a, try std.fmt.bufPrint(&numbuf, "{d}", .{provisioned.entries.len}));
    try buf.appendSlice(a, ",\"orgs\":[");
    for (provisioned.entries, 0..) |e, i| {
        if (i > 0) try buf.append(a, ',');
        try buf.append(a, '"');
        try buf.appendSlice(a, e.slug);
        try buf.append(a, '"');
    }
    try buf.appendSlice(a, "]}");
    return buf.items;
}

// ── bridge handlers ────────────────────────────────────────────────────────

fn writeResult(output: []u8, result: []const u8) anyerror![]const u8 {
    if (result.len > output.len) return error.ResultTooLarge;
    @memcpy(output[0..result.len], result);
    return output[0..result.len];
}

fn handleStatus(context: *anyopaque, invocation: bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    return writeResult(output, try runStatus(self, arena.allocator()));
}

fn handleProvision(context: *anyopaque, invocation: bridge.Invocation, output: []u8) anyerror![]const u8 {
    _ = invocation;
    const self: *App = @ptrCast(@alignCast(context));
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    return writeResult(output, try runProvision(self, arena.allocator()));
}

var handlers = [_]bridge.Handler{
    .{ .name = "deco.status", .context = undefined, .invoke_fn = handleStatus },
    .{ .name = "deco.provision", .context = undefined, .invoke_fn = handleProvision },
};

const command_policies = [_]bridge.CommandPolicy{
    .{ .name = "deco.status", .origins = &dev_origins },
    .{ .name = "deco.provision", .origins = &dev_origins },
};

pub fn main(init: std.process.Init) !void {
    var app = App{ .env_map = init.environ_map, .io = init.io };

    // Headless test/automation seam: `DECO_COMPANION_HEADLESS=status|provision`
    // runs the exact bridge logic and prints the JSON result, then exits — no
    // window. Lets the whole native code path be driven from a script.
    if (app.env("DECO_COMPANION_HEADLESS")) |mode| {
        var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const result = if (std.mem.eql(u8, mode, "provision"))
            try runProvision(&app, a)
        else
            try runStatus(&app, a);
        std.debug.print("{s}\n", .{result});
        return;
    }

    for (&handlers) |*h| h.context = &app;

    const dispatcher = native_sdk.BridgeDispatcher{
        .policy = .{ .enabled = true, .commands = &command_policies },
        .registry = .{ .handlers = &handlers },
    };

    try runner.runWithOptions(app.app(), .{
        .app_name = "Deco Companion",
        .window_title = "Deco Companion",
        .bundle_id = "com.deco.companion",
        .icon_path = "assets/icon.png",
        .bridge = dispatcher,
        .js_window_api = true,
        .security = .{
            .navigation = .{ .allowed_origins = &dev_origins },
        },
    }, init);
}
