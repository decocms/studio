import { describe, expect, test } from "bun:test";
import { BrowserSessionError } from "../ports.ts";
import { HOST_SOCKET } from "./browser-host.ts";
import { type DaemonCall, sandboxBrowser } from "./sandbox-browser.ts";

type Json = Record<string, unknown>;

/**
 * A daemon that answers `/_sandbox/bash` and `/_sandbox/read` the way the real
 * one does, with `host` standing in for the process behind the socket: the
 * request is decoded from the command exactly as the shell would.
 */
function fakeDaemon(host: (req: Json) => Json | "down" | "crash") {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const backgrounds: string[] = [];
  let hostFile: string | null = null;
  const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

  const daemon: DaemonCall = async (path, body) => {
    const b = body as Json;
    if (path === "/_sandbox/read") {
      const content = files.get(String(b.path));
      if (content === undefined) {
        return Response.json({ error: "File not found" }, { status: 400 });
      }
      return Response.json({ kind: "text", content: `1\t${content}` });
    }
    if (path !== "/_sandbox/bash") return new Response("nope", { status: 404 });
    const command = String(b.command);
    commands.push(command);
    if (b.mode === "background") {
      backgrounds.push(command);
      return Response.json({ taskId: "t1", status: "running" });
    }
    const ok = (stdout = "") =>
      Response.json({ stdout, stderr: "", exitCode: 0, timedOut: false });
    const install = command.match(/printf %s '([^']+)' \| base64 -d > (\S+)/);
    if (install?.[1] && install[2]) {
      hostFile = decode(install[1]);
      return ok();
    }
    const chunk = command.match(/printf %s '([^']+)' >> (\S+)/);
    if (chunk?.[1] && chunk[2]) {
      files.set(chunk[2], (files.get(chunk[2]) ?? "") + chunk[1]);
      return ok();
    }
    if (command.startsWith("rm -f -- ")) {
      files.delete(command.slice("rm -f -- ".length).replace(/'/g, ""));
      return ok();
    }
    const inline = command.match(/printf %s '([^']+)' \| base64 -d \| curl/);
    const fromFile = command.match(/base64 -d (\S+) \| curl/);
    const b64 = inline?.[1] ?? (fromFile?.[1] ? files.get(fromFile[1]) : null);
    if (!b64) throw new Error(`unexpected command: ${command.slice(0, 80)}`);
    expect(command).toContain(`--unix-socket ${HOST_SOCKET}`);
    const answer = host(JSON.parse(decode(b64)) as Json);
    if (answer === "down" || answer === "crash") {
      return Response.json({
        stdout: "",
        stderr: answer === "down" ? "curl 7" : "curl 52",
        exitCode: 10,
      });
    }
    const out = JSON.stringify(answer);
    if (out.length <= 200_000) return ok(out);
    const file = command.match(/-o (\S+)/)?.[1] ?? "";
    files.set(file, out);
    return ok(`@file ${file}`);
  };
  return {
    daemon,
    commands,
    backgrounds,
    files,
    installed: () => hostFile,
  };
}

const page = { url: "https://loja-exemplo.com.br/p", blocked: 0 };

/** A host that is up, and answers each op through `ops`. */
function liveHost(
  ops: Record<string, (req: Json) => unknown> = {},
  info: Partial<Json> = {},
) {
  const seen: Json[] = [];
  const host = (req: Json): Json => {
    seen.push(req);
    if (req.op === "ping") {
      return {
        ok: true,
        result: {
          instance: "i1",
          startedAt: Date.now(),
          ready: true,
          error: null,
          pages: 0,
          ...info,
        },
      };
    }
    const op = ops[String(req.op)];
    if (op) return { ok: true, result: op(req) };
    if (req.op === "newPage")
      return { ok: true, result: { page: "p1", ...page } };
    if (req.op === "close") return { ok: true, result: { blocked: 3 } };
    return { ok: false, error: `unhandled ${String(req.op)}` };
  };
  return { host, seen };
}

const noWait = { sleep: async () => {} };

describe("sandboxBrowser: o protocolo com o host", () => {
  test("abre a página com o dispositivo e o bloqueio serializado", async () => {
    const h = liveHost();
    const d = fakeDaemon(h.host);
    const browser = sandboxBrowser(d.daemon, noWait);
    const block = (url: string) => url.includes("tracker");
    const p = await browser.newPage("mobile", { blockRequest: block });
    expect(p.url()).toBe("https://loja-exemplo.com.br/p");
    expect(p.viewport).toEqual({
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
    });
    const open = h.seen.find((r) => r.op === "newPage");
    const device = open?.device as Json | undefined;
    expect(open?.blockRequest).toBe(block.toString());
    expect(device?.isMobile).toBe(true);
    expect(String(device?.userAgent)).toContain("iPhone");
  });

  test("sem host no ar: instala, sobe em segundo plano e espera ficar pronto", async () => {
    let started = false;
    let pings = 0;
    const d = fakeDaemon((req) => {
      if (!started) return "down";
      if (req.op === "ping") {
        pings++;
        return {
          ok: true,
          result: {
            instance: "i2",
            startedAt: Date.now(),
            ready: pings > 1,
            error: null,
            pages: 0,
          },
        };
      }
      return { ok: true, result: { page: "p1", ...page } };
    });
    const daemon: DaemonCall = async (path, body) => {
      if ((body as Json).mode === "background") started = true;
      return d.daemon(path, body);
    };
    await sandboxBrowser(daemon, noWait).newPage("desktop");
    expect(d.backgrounds).toEqual(["exec node /tmp/plan-browser/host.js"]);
    expect(d.installed()).toContain("playwright-core");
    expect(d.installed()).toContain(HOST_SOCKET);
    expect(pings).toBe(2);
  });

  test("o Chromium não abriu: o motivo do host vira a falha da sessão", async () => {
    const h = liveHost({}, { ready: false, error: "o Chromium não abriu: x" });
    const browser = sandboxBrowser(fakeDaemon(h.host).daemon, noWait);
    await expect(browser.newPage("mobile")).rejects.toThrow(
      "o Chromium não abriu: x",
    );
  });

  test("o host caiu no meio: sobe outro e repete o pedido uma vez", async () => {
    let down = false;
    let restarts = 0;
    const d = fakeDaemon((req) => {
      if (down) return "down";
      if (req.op === "ping") {
        return {
          ok: true,
          result: {
            instance: `i${restarts}`,
            startedAt: Date.now(),
            ready: true,
            error: null,
            pages: 0,
          },
        };
      }
      if (req.op === "fetch" && restarts === 0) {
        down = true;
        return "down";
      }
      return {
        ok: true,
        result: { status: 200, url: String(req.url), body: "ok" },
      };
    });
    const daemon: DaemonCall = async (path, body) => {
      if ((body as Json).mode === "background") {
        restarts++;
        down = false;
      }
      return d.daemon(path, body);
    };
    const res = await sandboxBrowser(daemon, noWait).fetch(
      "https://loja-exemplo.com.br/robots.txt",
      { maxBytes: 100, timeoutMs: 1_000, userAgent: "x" },
    );
    expect(res.body).toBe("ok");
    expect(restarts).toBe(1);
  });

  test("o host morreu respondendo: falha da sessão, sem repetir", async () => {
    let gotos = 0;
    const h = liveHost();
    const d = fakeDaemon((req) => {
      if (req.op === "goto") {
        gotos++;
        return "crash";
      }
      return h.host(req);
    });
    const p = await sandboxBrowser(d.daemon, noWait).newPage("mobile");
    await expect(
      p.goto("https://loja-exemplo.com.br/", 1_000),
    ).rejects.toBeInstanceOf(BrowserSessionError);
    expect(gotos).toBe(1);
  });

  test("o script vai uma vez por host; um host novo pede de novo", async () => {
    const scripts = new Set<string>();
    const h = liveHost({
      evaluate: (req) => {
        if (typeof req.source === "string") scripts.add(String(req.fn));
        return { value: (req.args as number[])[0], ...page };
      },
    });
    const d = fakeDaemon((req) =>
      req.op === "evaluate" &&
      typeof req.source !== "string" &&
      !scripts.has(String(req.fn))
        ? { ok: false, error: "unknown script", code: "unknown_fn" }
        : h.host(req),
    );
    const p = await sandboxBrowser(d.daemon, noWait).newPage("mobile");
    const double = (n: number) => n * 2;
    expect(await p.evaluate(double, 4)).toBe(4);
    expect(await p.evaluate(double, 5)).toBe(5);
    const evals = h.seen.filter((r) => r.op === "evaluate");
    expect(evals.map((r) => typeof r.source)).toEqual(["string", "undefined"]);
    expect(evals[0]?.source).toBe(double.toString());
    expect(evals.map((r) => r.args)).toEqual([[4], [5]]);
    scripts.clear();
    expect(await p.evaluate(double, 6)).toBe(6);
    expect(
      h.seen.filter((r) => r.op === "evaluate").map((r) => typeof r.source),
    ).toEqual(["string", "undefined", "string"]);
  });

  test("erro da página mantém a mensagem do navegador", async () => {
    const h = liveHost();
    const d = fakeDaemon((req) =>
      req.op === "evaluate"
        ? {
            ok: false,
            error:
              "page.evaluate: Execution context was destroyed, most likely because of a navigation",
          }
        : h.host(req),
    );
    const p = await sandboxBrowser(d.daemon, noWait).newPage("mobile");
    const err = await p.evaluate(() => 1).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(BrowserSessionError);
    expect(String(err)).toContain("Execution context was destroyed");
  });

  test("página que o host não tem mais: falha da sessão", async () => {
    const h = liveHost();
    const d = fakeDaemon((req) =>
      req.op === "mouseMove"
        ? { ok: false, error: "page closed", code: "no_page" }
        : h.host(req),
    );
    const p = await sandboxBrowser(d.daemon, noWait).newPage("mobile");
    await expect(p.mouseMove(1, 2, 5)).rejects.toBeInstanceOf(
      BrowserSessionError,
    );
  });

  test("print grande volta por arquivo, que é apagado depois", async () => {
    const jpeg = Buffer.alloc(300_000, 7);
    const h = liveHost({
      screenshot: () => ({ base64: jpeg.toString("base64"), ...page }),
    });
    const d = fakeDaemon(h.host);
    const p = await sandboxBrowser(d.daemon, noWait).newPage("mobile");
    const bytes = await p.screenshot({
      quality: 60,
      clip: { x: 0, y: 0, width: 390, height: 6000, scale: 0.65 },
      captureBeyondViewport: true,
    });
    expect(bytes.byteLength).toBe(300_000);
    expect(bytes[0]).toBe(7);
    expect(d.files.size).toBe(0);
    const shot = h.seen.find((r) => r.op === "screenshot");
    expect(shot?.clip).toEqual({
      x: 0,
      y: 0,
      width: 390,
      height: 6000,
      scale: 0.65,
    });
  });

  test("pedido maior que um comando vai em pedaços", async () => {
    const big = "x".repeat(150_000);
    const h = liveHost({
      evaluate: (req) => ({
        value: (req.args as string[])[0]?.length,
        ...page,
      }),
    });
    const d = fakeDaemon(h.host);
    const p = await sandboxBrowser(d.daemon, noWait).newPage("mobile");
    expect(await p.evaluate((s: string) => s.length, big)).toBe(150_000);
    const appends = d.commands.filter((c) =>
      c.includes(">> /tmp/plan-browser/in/"),
    );
    expect(appends.length).toBeGreaterThan(1);
    for (const c of d.commands) expect(c.length).toBeLessThan(70_000);
  });

  test("resposta fora do formato: falha da sessão, não um valor inventado", async () => {
    const h = liveHost({
      goto: () => ({ status: "200", error: null, ...page }),
    });
    const p = await sandboxBrowser(fakeDaemon(h.host).daemon, noWait).newPage(
      "mobile",
    );
    await expect(
      p.goto("https://loja-exemplo.com.br/", 1_000),
    ).rejects.toBeInstanceOf(BrowserSessionError);
  });

  test("o clique devolve a navegação pedida; cada resposta atualiza URL e bloqueios", async () => {
    const h = liveHost({
      click: () => ({
        navigation: "https://loja-exemplo.com.br/outra/p",
        url: "https://loja-exemplo.com.br/p#x",
        blocked: 2,
      }),
    });
    const p = await sandboxBrowser(fakeDaemon(h.host).daemon, noWait).newPage(
      "mobile",
    );
    expect(await p.click(10, 20, 1500)).toEqual({
      navigation: "https://loja-exemplo.com.br/outra/p",
    });
    expect(p.url()).toBe("https://loja-exemplo.com.br/p#x");
    expect(p.blockedRequests()).toBe(2);
    await p.close();
    expect(p.blockedRequests()).toBe(3);
    await p.close();
    expect(h.seen.filter((r) => r.op === "close")).toHaveLength(1);
  });

  test("fetch que não alcançou o host: TypeError, como o fetch", async () => {
    const h = liveHost();
    const d = fakeDaemon((req) =>
      req.op === "fetch"
        ? { ok: false, error: "getaddrinfo ENOTFOUND" }
        : h.host(req),
    );
    await expect(
      sandboxBrowser(d.daemon, noWait).fetch("https://x.invalid/", {
        maxBytes: 1,
        timeoutMs: 1_000,
        userAgent: "x",
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("host velho e sem página é trocado antes de abrir outra", async () => {
    let instance = 0;
    const d = fakeDaemon((req) => {
      if (req.op === "ping") {
        return {
          ok: true,
          result: {
            instance: `i${instance}`,
            startedAt: instance === 0 ? Date.now() - 13 * 60_000 : Date.now(),
            ready: true,
            error: null,
            pages: 0,
          },
        };
      }
      if (req.op === "shutdown") {
        instance = -1;
        return { ok: true, result: {} };
      }
      return { ok: true, result: { page: "p1", ...page } };
    });
    const daemon: DaemonCall = async (path, body) => {
      if ((body as Json).mode === "background") instance = 1;
      if (instance === -1 && String((body as Json).command).includes("curl")) {
        const decoded = String((body as Json).command).match(
          /printf %s '([^']+)'/,
        );
        const req = decoded?.[1]
          ? (JSON.parse(Buffer.from(decoded[1], "base64").toString()) as Json)
          : {};
        if (req.op === "ping") {
          return Response.json({ stdout: "", stderr: "curl 7", exitCode: 10 });
        }
      }
      return d.daemon(path, body);
    };
    await sandboxBrowser(daemon, noWait).newPage("mobile");
    expect(d.backgrounds).toHaveLength(1);
  });

  test("o daemon recusou: falha da sessão com o status", async () => {
    const daemon: DaemonCall = async () =>
      new Response("unauthorized", { status: 401 });
    await expect(
      sandboxBrowser(daemon, noWait).newPage("mobile"),
    ).rejects.toThrow("401");
  });
});
