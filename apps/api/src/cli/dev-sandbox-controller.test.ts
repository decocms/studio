import { afterAll, describe, expect, it } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controllerArgv,
  type DevControllerProbes,
  type DevControllerEndpoints,
  generateDevCerts,
  planDevController,
  prepareDevController,
  studioControllerEnv,
} from "./dev-sandbox-controller";

/** Every probe passes unless `failing` names it; `calls` records the order. */
function probes(...failing: Array<keyof DevControllerProbes>) {
  const calls: string[] = [];
  const answer = (name: keyof DevControllerProbes) => {
    calls.push(name);
    return !failing.includes(name);
  };
  const all: DevControllerProbes = {
    hasGo: () => answer("hasGo"),
    hasOpenssl: () => answer("hasOpenssl"),
    dockerAnswers: async () => answer("dockerAnswers"),
  };
  return { probes: all, calls };
}

const enabled = { STUDIO_AGENT_SANDBOX_ENABLED: "true" };

describe("planDevController", () => {
  it.each([{}, { STUDIO_AGENT_SANDBOX_ENABLED: "false" }])(
    "stays off without agent sandboxes and probes nothing (%p)",
    async (env) => {
      const { probes: p, calls } = probes();
      expect(await planDevController(env, p)).toEqual({ kind: "off" });
      expect(calls).toEqual([]);
    },
  );

  it("leaves a configured controller alone", async () => {
    const { probes: p, calls } = probes();
    expect(
      await planDevController(
        { ...enabled, STUDIO_SANDBOX_CONTROLLER_URL: "https://ctl:8443" },
        p,
      ),
    ).toEqual({ kind: "configured" });
    expect(calls).toEqual([]);
  });

  it("starts one when every probe passes", async () => {
    const { probes: p } = probes();
    const env = { STUDIO_AGENT_SANDBOX_ENABLED: "1" };
    expect(await planDevController(env, p)).toEqual({ kind: "start" });
  });

  it.each([
    ["hasGo", "install Go"],
    ["hasOpenssl", "install OpenSSL"],
    ["dockerAnswers", "`docker version` failed"],
  ] as const)(
    "skips when %s fails, saying what to install",
    async (probe, hint) => {
      const { probes: p } = probes(probe);
      const plan = await planDevController(enabled, p);
      expect(plan.kind).toBe("skip");
      expect(plan.kind === "skip" && plan.reason).toContain(hint);
    },
  );

  it("does not ask docker once Go is missing", async () => {
    const { probes: p, calls } = probes("hasGo");
    await planDevController(enabled, p);
    expect(calls).toEqual(["hasGo"]);
  });
});

describe("prepareDevController", () => {
  it("tells Studio why there is no controller when it skips one", async () => {
    const prepared = await prepareDevController({
      env: enabled,
      home: "/nonexistent",
      repoRoot: "/nonexistent",
      probes: probes("hasGo").probes,
    });
    expect(prepared.endpoints).toBeNull();
    expect(prepared.env.STUDIO_SANDBOX_CONTROLLER_UNAVAILABLE).toContain(
      "install Go",
    );
  });

  it("leaves Studio's env alone with agent sandboxes off", async () => {
    const prepared = await prepareDevController({
      env: {},
      home: "/nonexistent",
      repoRoot: "/nonexistent",
      probes: probes().probes,
    });
    expect(prepared).toEqual({ env: {}, endpoints: null });
  });
});

const endpoints: DevControllerEndpoints = {
  binary: "/dev-home/sandbox-controller",
  image: "ghcr.io/decocms/studio/studio-sandbox-go:1.2.3",
  claimsPort: 7443,
  callbackPort: 7444,
  certs: {
    ca: "/dev-home/ca.crt",
    controllerCert: "/dev-home/controller.crt",
    controllerKey: "/dev-home/controller.key",
    studioCert: "/dev-home/studio.crt",
    studioKey: "/dev-home/studio.key",
  },
};

describe("controllerArgv", () => {
  it("runs the claim API on the docker runtime alone, on loopback", () => {
    const argv = controllerArgv(endpoints);
    expect(argv[0]).toBe("/dev-home/sandbox-controller");
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    expect(argv).toContain("--kubernetes=false");
    expect(argv).toContain("--docker");
    expect(flag("--docker-image")).toBe(endpoints.image);
    expect(flag("--claims-listen")).toBe("127.0.0.1:7443");
    expect(flag("--claims-tls-cert")).toBe("/dev-home/controller.crt");
    expect(flag("--claims-tls-key")).toBe("/dev-home/controller.key");
    expect(flag("--claims-client-ca")).toBe("/dev-home/ca.crt");
    expect(flag("--studio-callback-url")).toBe("https://127.0.0.1:7444");
    expect(flag("--studio-ca")).toBe("/dev-home/ca.crt");
  });

  it("points Studio at the same listener with its own leaf", () => {
    expect(studioControllerEnv(endpoints)).toEqual({
      STUDIO_SANDBOX_CONTROLLER_URL: "https://127.0.0.1:7443",
      STUDIO_SANDBOX_CONTROLLER_TLS_CERT: "/dev-home/studio.crt",
      STUDIO_SANDBOX_CONTROLLER_TLS_KEY: "/dev-home/studio.key",
      STUDIO_SANDBOX_CONTROLLER_CA: "/dev-home/ca.crt",
      STUDIO_SANDBOX_CONTROLLER_CALLBACK_PORT: "7444",
    });
  });
});

describe.skipIf(!Bun.which("openssl"))("generateDevCerts", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  async function generate() {
    const dir = await mkdtemp(join(tmpdir(), "dev-controller-certs-"));
    dirs.push(dir);
    return generateDevCerts(join(dir, "certs"));
  }

  it("issues both leaves from one CA, for loopback, with private keys", async () => {
    const certs = await generate();
    const ca = new X509Certificate(await Bun.file(certs.ca).text());
    expect(ca.ca).toBe(true);
    for (const [cert, key] of [
      [certs.controllerCert, certs.controllerKey],
      [certs.studioCert, certs.studioKey],
    ]) {
      const leaf = new X509Certificate(await Bun.file(cert!).text());
      expect(leaf.ca).toBe(false);
      expect(leaf.verify(ca.publicKey)).toBe(true);
      expect(leaf.checkIP("127.0.0.1")).toBe("127.0.0.1");
      expect(leaf.checkHost("localhost")).toBe("localhost");
      expect(((await stat(key!)).mode & 0o777).toString(8)).toBe("600");
    }
  });

  it("completes an mTLS handshake in both directions", async () => {
    const certs = await generate();
    const read = (path: string) => Bun.file(path).text();
    const [ca, controllerCert, controllerKey, studioCert, studioKey] =
      await Promise.all([
        read(certs.ca),
        read(certs.controllerCert),
        read(certs.controllerKey),
        read(certs.studioCert),
        read(certs.studioKey),
      ]);
    // Each side serves on its leaf and calls with it.
    for (const [serverCert, serverKey, clientCert, clientKey] of [
      [controllerCert, controllerKey, studioCert, studioKey],
      [studioCert, studioKey, controllerCert, controllerKey],
    ]) {
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        tls: {
          cert: serverCert,
          key: serverKey,
          ca,
          requestCert: true,
          rejectUnauthorized: true,
        },
        fetch: () => new Response("ok"),
      });
      try {
        const res = await fetch(`https://127.0.0.1:${server.port}/`, {
          tls: { cert: clientCert, key: clientKey, ca },
        });
        expect(await res.text()).toBe("ok");
      } finally {
        server.stop(true);
      }
    }
  });

  it("replaces a previous run's certificates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dev-controller-certs-"));
    dirs.push(dir);
    const first = await generateDevCerts(join(dir, "certs"));
    const firstCa = await Bun.file(first.ca).text();
    const second = await generateDevCerts(join(dir, "certs"));
    expect(await Bun.file(second.ca).text()).not.toBe(firstCa);
  });
});
