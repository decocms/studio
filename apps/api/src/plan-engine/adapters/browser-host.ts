/**
 * The browser host: a Node process inside the run's sandbox that keeps one
 * Chromium (playwright-core and Debian's chromium, both baked into the sandbox
 * image) and its pages, and answers one JSON request per HTTP call on a Unix
 * socket only the sandbox can reach. Studio talks to it through the daemon's
 * authenticated `/_sandbox/bash` route (sandbox-browser.ts).
 *
 * ⚠️ `browserHostMain` is serialized (`toString()`) and run by Node in the
 * sandbox: it may use nothing from outside its own body, and reaches modules
 * through `process.getBuiltinModule` because a bundler rewrites `require`.
 */

/** Where the host lives in the sandbox. */
export const HOST_DIR = "/tmp/plan-browser";
export const HOST_SOCKET = `${HOST_DIR}/host.sock`;

export interface HostConfig {
  socket: string;
  /** Where `playwright-core` is installed globally. */
  modules: string;
  /** Exits after this long without a request. */
  idleMs: number;
}

/** The host program, ready for `node`. */
export function hostProgram(config: HostConfig): string {
  return `(${browserHostMain.toString()})(${JSON.stringify(config)});\n`;
}

/** The part of playwright-core the host drives. */
interface PwRequest {
  url(): string;
  isNavigationRequest(): boolean;
  frame(): unknown;
}
interface PwRoute {
  request(): PwRequest;
  abort(): Promise<void>;
  continue(): Promise<void>;
}
interface PwResponse {
  status(): number;
}
interface PwCdp {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
}
interface PwPage {
  url(): string;
  mainFrame(): unknown;
  on(event: "request", cb: (req: PwRequest) => void): void;
  on(event: "requestfinished" | "requestfailed", cb: () => void): void;
  route(pattern: string, cb: (route: PwRoute) => void): Promise<void>;
  goto(
    url: string,
    opts: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<PwResponse | null>;
  reload(opts: {
    waitUntil: "domcontentloaded";
    timeout: number;
  }): Promise<PwResponse | null>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(opts: { type: "jpeg"; quality: number }): Promise<Uint8Array>;
  waitForNavigation(opts: {
    waitUntil: "domcontentloaded";
    timeout: number;
  }): Promise<unknown>;
  mouse: {
    move(x: number, y: number, opts: { steps: number }): Promise<void>;
    click(x: number, y: number): Promise<void>;
  };
}
interface PwContext {
  newPage(): Promise<PwPage>;
  newCDPSession(page: PwPage): Promise<PwCdp>;
  addInitScript(script: { content: string }): Promise<void>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>;
  on(event: "disconnected", cb: () => void): void;
  close(): Promise<void>;
}
interface Playwright {
  chromium: {
    launch(opts: {
      executablePath: string;
      args: string[];
    }): Promise<PwBrowser>;
  };
}

/** The host process. Runs in Node in the sandbox, never in Studio. */
function browserHostMain(config: HostConfig): void {
  const http = process.getBuiltinModule("node:http");
  const fs = process.getBuiltinModule("node:fs");
  const vm = process.getBuiltinModule("node:vm");
  const { createRequire } = process.getBuiltinModule("node:module");
  const { randomUUID } = process.getBuiltinModule("node:crypto");

  type Json = Record<string, unknown>;
  interface Tab {
    context: PwContext;
    page: PwPage;
    cdp: PwCdp | null;
    inflight: number;
    blocked: number;
    nav: { armed: boolean; started: string | null };
  }

  const startedAt = Date.now();
  const instance = randomUUID();
  const tabs = new Map<string, Tab>();
  const scripts = new Map<string, string>();
  let lastActivity = Date.now();
  let browser: PwBrowser | null = null;
  let launchError: string | null = null;

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const messageOf = (err: unknown) =>
    err instanceof Error ? err.message : String(err);
  const str = (v: unknown, name: string): string => {
    if (typeof v !== "string") throw new Error(`${name} must be a string`);
    return v;
  };
  const num = (v: unknown, name: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`${name} must be a number`);
    }
    return v;
  };
  const tabOf = (req: Json): Tab => {
    const tab = tabs.get(str(req.page, "page"));
    if (!tab)
      throw Object.assign(new Error("page closed"), { code: "no_page" });
    return tab;
  };
  const state = (tab: Tab) => ({ url: tab.page.url(), blocked: tab.blocked });

  // As puppeteer's networkidle2: at most two requests in flight for 500 ms.
  const settle = async (tab: Tab, deadline: number): Promise<boolean> => {
    let quietSince = 0;
    while (Date.now() < deadline) {
      if (tab.inflight <= 2) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= 500) return true;
      } else {
        quietSince = 0;
      }
      await wait(100);
    }
    return false;
  };

  const launch = async () => {
    try {
      const pw = createRequire(`${config.modules}/`)(
        "playwright-core",
      ) as Playwright;
      browser = await pw.chromium.launch({
        executablePath: process.env.QA_CHROMIUM || "/usr/bin/chromium",
        args: ["--no-sandbox"],
      });
      browser.on("disconnected", () => shutdown(1));
    } catch (err) {
      launchError = `o Chromium não abriu: ${messageOf(err)}`;
    }
  };

  const ops: Record<string, (req: Json) => Promise<Json>> = {
    ping: async () => ({
      instance,
      startedAt,
      ready: browser !== null,
      error: launchError,
      pages: tabs.size,
    }),
    newPage: async (req) => {
      if (!browser) throw new Error(launchError ?? "o Chromium ainda abrindo");
      const device = req.device as Json;
      const block =
        typeof req.blockRequest === "string"
          ? (vm.runInNewContext(`(${req.blockRequest})`, { URL }) as (
              url: string,
            ) => boolean)
          : null;
      const context = await browser.newContext({
        viewport: {
          width: num(device.width, "width"),
          height: num(device.height, "height"),
        },
        deviceScaleFactor: num(device.deviceScaleFactor, "deviceScaleFactor"),
        isMobile: device.isMobile === true,
        hasTouch: device.hasTouch === true,
        userAgent: str(device.userAgent, "userAgent"),
        serviceWorkers: block ? "block" : "allow",
      });
      await context.addInitScript({
        content:
          "globalThis.__name = globalThis.__name || function (fn) { return fn; };",
      });
      const page = await context.newPage();
      const tab: Tab = {
        context,
        page,
        cdp: null,
        inflight: 0,
        blocked: 0,
        nav: { armed: false, started: null },
      };
      page.on("request", (r) => {
        tab.inflight++;
        if (
          tab.nav.armed &&
          !tab.nav.started &&
          r.isNavigationRequest() &&
          r.frame() === page.mainFrame()
        ) {
          tab.nav.started = r.url();
        }
      });
      const done = () => {
        tab.inflight = Math.max(0, tab.inflight - 1);
      };
      page.on("requestfinished", done);
      page.on("requestfailed", done);
      if (block) {
        await page.route("**/*", (route) => {
          let blocked = false;
          try {
            blocked = block(route.request().url());
          } catch {
            blocked = false;
          }
          if (blocked) tab.blocked++;
          (blocked ? route.abort() : route.continue()).catch(() => {});
        });
      }
      const id = randomUUID();
      tabs.set(id, tab);
      return { page: id, ...state(tab) };
    },
    goto: async (req) => {
      const tab = tabOf(req);
      const timeout = num(req.timeoutMs, "timeoutMs");
      const deadline = Date.now() + timeout;
      try {
        const res = await tab.page.goto(str(req.url, "url"), {
          waitUntil: "domcontentloaded",
          timeout,
        });
        if (!(await settle(tab, deadline))) {
          return {
            status: null,
            error: `a rede não acalmou em ${timeout} ms`,
            ...state(tab),
          };
        }
        return { status: res ? res.status() : 0, error: null, ...state(tab) };
      } catch (err) {
        return { status: null, error: messageOf(err), ...state(tab) };
      }
    },
    reload: async (req) => {
      const tab = tabOf(req);
      const timeout = num(req.timeoutMs, "timeoutMs");
      const deadline = Date.now() + timeout;
      await tab.page.reload({ waitUntil: "domcontentloaded", timeout });
      await settle(tab, deadline);
      return state(tab);
    },
    evaluate: async (req) => {
      const tab = tabOf(req);
      const id = str(req.fn, "fn");
      if (typeof req.source === "string") scripts.set(id, req.source);
      const source = scripts.get(id);
      if (!source) {
        throw Object.assign(new Error("unknown script"), {
          code: "unknown_fn",
        });
      }
      const args = JSON.stringify(Array.isArray(req.args) ? req.args : []);
      const value = await tab.page.evaluate(
        `globalThis.__name = globalThis.__name || function (fn) { return fn; };\n(${source}).apply(null, ${args})`,
      );
      return { value, ...state(tab) };
    },
    screenshot: async (req) => {
      const tab = tabOf(req);
      const quality = num(req.quality, "quality");
      const clip = req.clip as Json | undefined;
      let data: string;
      if (!clip) {
        const bytes = await tab.page.screenshot({ type: "jpeg", quality });
        data = Buffer.from(bytes).toString("base64");
      } else {
        tab.cdp ??= await tab.context.newCDPSession(tab.page);
        const shot = (await tab.cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality,
          clip: {
            x: num(clip.x, "x"),
            y: num(clip.y, "y"),
            width: num(clip.width, "width"),
            height: num(clip.height, "height"),
            scale: typeof clip.scale === "number" ? clip.scale : 1,
          },
          captureBeyondViewport: req.captureBeyondViewport === true,
          fromSurface: true,
        })) as { data?: unknown };
        data = str(shot.data, "screenshot data");
      }
      return { base64: data, ...state(tab) };
    },
    mouseMove: async (req) => {
      const tab = tabOf(req);
      await tab.page.mouse.move(num(req.x, "x"), num(req.y, "y"), {
        steps: num(req.steps, "steps"),
      });
      return state(tab);
    },
    click: async (req) => {
      const tab = tabOf(req);
      tab.nav.started = null;
      tab.nav.armed = true;
      try {
        await tab.page.mouse.click(num(req.x, "x"), num(req.y, "y"));
        await tab.page
          .waitForNavigation({
            waitUntil: "domcontentloaded",
            timeout: num(req.settleMs, "settleMs"),
          })
          .catch(() => null);
      } finally {
        tab.nav.armed = false;
      }
      return { navigation: tab.nav.started, ...state(tab) };
    },
    close: async (req) => {
      const id = str(req.page, "page");
      const tab = tabs.get(id);
      if (!tab) return { blocked: 0 };
      tabs.delete(id);
      await tab.context.close().catch(() => {});
      return { blocked: tab.blocked };
    },
    fetch: async (req) => {
      const maxBytes = num(req.maxBytes, "maxBytes");
      const res = await fetch(str(req.url, "url"), {
        redirect: "follow",
        headers: { "user-agent": str(req.userAgent, "userAgent") },
        signal: AbortSignal.timeout(num(req.timeoutMs, "timeoutMs")),
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = res.body?.getReader();
      while (reader && size < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
      await reader?.cancel().catch(() => {});
      const body = Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
      return { status: res.status, url: res.url, body };
    },
    shutdown: async () => {
      setTimeout(() => shutdown(0), 10);
      return {};
    },
  };

  let stopping = false;
  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    server.close();
    fs.rmSync(config.socket, { force: true });
    const closing = browser ? browser.close().catch(() => {}) : null;
    Promise.resolve(closing).finally(() => process.exit(code));
    setTimeout(() => process.exit(code), 5_000).unref();
  };

  const server = http.createServer((req, res) => {
    lastActivity = Date.now();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const reply = (body: Json) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      let parsed: Json;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
      } catch (err) {
        reply({ ok: false, error: `bad request: ${messageOf(err)}` });
        return;
      }
      const op = typeof parsed.op === "string" ? ops[parsed.op] : undefined;
      if (!op) {
        reply({ ok: false, error: `unknown op ${String(parsed.op)}` });
        return;
      }
      op(parsed).then(
        (result) => {
          lastActivity = Date.now();
          reply({ ok: true, result });
        },
        (err: unknown) => {
          const code =
            err && typeof err === "object" && "code" in err
              ? String(err.code)
              : undefined;
          reply({ ok: false, error: messageOf(err), code });
        },
      );
    });
  });

  // Another live host already answers on the socket: leave it be.
  const probe = http.request(
    { socketPath: config.socket, path: "/", method: "POST", timeout: 1_000 },
    () => process.exit(0),
  );
  probe.on("error", () => {
    fs.mkdirSync(config.socket.replace(/\/[^/]+$/, ""), { recursive: true });
    fs.rmSync(config.socket, { force: true });
    server.listen(config.socket, () => {
      fs.chmodSync(config.socket, 0o600);
      void launch();
    });
  });
  probe.on("timeout", () => probe.destroy(new Error("timeout")));
  probe.end("{}");

  setInterval(() => {
    if (Date.now() - lastActivity > config.idleMs) shutdown(0);
  }, 10_000).unref();
  process.on("SIGTERM", () => shutdown(0));
}
