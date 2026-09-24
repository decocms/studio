/**
 * `bun run dev`'s sandbox controller: with agent sandboxes on and no
 * controller configured, dev runs one on the docker runtime and points Studio
 * at it over throwaway mTLS certificates.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { findAvailablePort } from "./find-available-port";

export type DevControllerPlan =
  | { kind: "off" }
  | { kind: "configured" }
  | { kind: "start" }
  | { kind: "skip"; reason: string };

/** Checked lazily, so a dev run with sandboxes off never shells out. */
export interface DevControllerProbes {
  hasGo(): boolean;
  hasOpenssl(): boolean;
  dockerAnswers(): Promise<boolean>;
}

/**
 * One degradation rule: when a controller cannot run here, say what to
 * install and start Studio without it.
 */
export async function planDevController(
  env: Record<string, string | undefined>,
  probes: DevControllerProbes,
): Promise<DevControllerPlan> {
  const enabled =
    env.STUDIO_AGENT_SANDBOX_ENABLED === "true" ||
    env.STUDIO_AGENT_SANDBOX_ENABLED === "1";
  if (!enabled) return { kind: "off" };
  if (env.STUDIO_SANDBOX_CONTROLLER_URL?.trim()) return { kind: "configured" };
  if (!probes.hasGo()) {
    return {
      kind: "skip",
      reason: "install Go (https://go.dev/dl) to run agent sandboxes in dev",
    };
  }
  if (!probes.hasOpenssl()) {
    return {
      kind: "skip",
      reason:
        "install OpenSSL to generate the dev sandbox controller certificates",
    };
  }
  if (!(await probes.dockerAnswers())) {
    return {
      kind: "skip",
      reason:
        "`docker version` failed; install and start Docker to run agent sandboxes in dev",
    };
  }
  return { kind: "start" };
}

export interface DevCerts {
  ca: string;
  controllerCert: string;
  controllerKey: string;
  studioCert: string;
  studioKey: string;
}

/** One CA; each side's leaf serves and calls, so it carries both usages. */
const OPENSSL_CONFIG = `[req]
distinguished_name = dn
[dn]
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth,clientAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
`;

const CERT_DAYS = "30";

async function openssl(args: string[]): Promise<void> {
  const proc = Bun.spawn(["openssl", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${stderr.trim()}`);
  }
}

/** Replaces `dir` with a fresh CA and a controller and a Studio leaf. */
export async function generateDevCerts(dir: string): Promise<DevCerts> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const config = join(dir, "openssl.cnf");
  await writeFile(config, OPENSSL_CONFIG);
  const certs: DevCerts = {
    ca: join(dir, "ca.crt"),
    controllerCert: join(dir, "controller.crt"),
    controllerKey: join(dir, "controller.key"),
    studioCert: join(dir, "studio.crt"),
    studioKey: join(dir, "studio.key"),
  };
  const caKey = join(dir, "ca.key");
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    certs.ca,
    "-days",
    CERT_DAYS,
    "-subj",
    "/CN=Studio dev sandbox CA",
    "-config",
    config,
    "-extensions",
    "ca",
  ]);
  for (const [name, cert, key] of [
    ["sandbox-controller", certs.controllerCert, certs.controllerKey],
    ["studio", certs.studioCert, certs.studioKey],
  ] as const) {
    const csr = join(dir, `${name}.csr`);
    await openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      `/CN=${name}`,
      "-config",
      config,
    ]);
    await openssl([
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      certs.ca,
      "-CAkey",
      caKey,
      "-set_serial",
      `0x${randomBytes(16).toString("hex")}`,
      "-days",
      CERT_DAYS,
      "-out",
      cert,
      "-extfile",
      config,
      "-extensions",
      "leaf",
    ]);
    await rm(csr);
    await chmod(key, 0o600);
  }
  await chmod(caKey, 0o600);
  return certs;
}

export interface DevControllerEndpoints {
  /** The controller binary `buildController` wrote. */
  binary: string;
  image: string;
  claimsPort: number;
  callbackPort: number;
  certs: DevCerts;
}

/** The controller as dev runs it: claim API only, on the docker runtime. */
export function controllerArgv(e: DevControllerEndpoints): string[] {
  return [
    e.binary,
    "--kubernetes=false",
    "--docker",
    "--docker-image",
    e.image,
    "--claims-listen",
    `127.0.0.1:${e.claimsPort}`,
    "--claims-tls-cert",
    e.certs.controllerCert,
    "--claims-tls-key",
    e.certs.controllerKey,
    "--claims-client-ca",
    e.certs.ca,
    "--studio-callback-url",
    `https://127.0.0.1:${e.callbackPort}`,
    "--studio-ca",
    e.certs.ca,
  ];
}

/**
 * Compiles the controller from this checkout, as `go run` would. Dev runs the
 * binary itself because a signal to `go run` does not reach the program it
 * started: stopping dev would orphan the controller. Null on success, else
 * why the build failed.
 */
async function buildController(
  repoRoot: string,
  out: string,
): Promise<string | null> {
  const proc = Bun.spawn(["go", "build", "-o", out, "."], {
    cwd: join(repoRoot, "packages/sandbox/controller-go"),
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code === 0) return null;
  return stderr.trim().split("\n").at(-1) ?? `exit ${code}`;
}

/** What points Studio at that controller. */
export function studioControllerEnv(
  e: DevControllerEndpoints,
): Record<string, string> {
  return {
    STUDIO_SANDBOX_CONTROLLER_URL: `https://127.0.0.1:${e.claimsPort}`,
    STUDIO_SANDBOX_CONTROLLER_TLS_CERT: e.certs.studioCert,
    STUDIO_SANDBOX_CONTROLLER_TLS_KEY: e.certs.studioKey,
    STUDIO_SANDBOX_CONTROLLER_CA: e.certs.ca,
    STUDIO_SANDBOX_CONTROLLER_CALLBACK_PORT: String(e.callbackPort),
  };
}

const SandboxPackageSchema = z.object({ version: z.string().min(1) });

/** The base image tag this checkout's daemon ships as. */
async function defaultSandboxImage(repoRoot: string): Promise<string> {
  const pkg = SandboxPackageSchema.parse(
    await Bun.file(join(repoRoot, "packages/sandbox/package.json")).json(),
  );
  return `ghcr.io/decocms/studio/studio-sandbox-go:${pkg.version}`;
}

const DOCKER_PROBE_TIMEOUT_MS = 10_000;

const hostProbes: DevControllerProbes = {
  hasGo: () => Bun.which("go") !== null,
  hasOpenssl: () => Bun.which("openssl") !== null,
  dockerAnswers: async () => {
    if (!Bun.which("docker")) return false;
    const proc = Bun.spawn(
      ["docker", "version", "--format", "{{.Server.Version}}"],
      { stdout: "ignore", stderr: "ignore", timeout: DOCKER_PROBE_TIMEOUT_MS },
    );
    return (await proc.exited) === 0;
  },
};

export interface PreparedDevController {
  env: Record<string, string>;
  endpoints: DevControllerEndpoints | null;
}

/**
 * Decides and prepares the dev controller. The env it returns goes into
 * Studio's before settings resolve; `endpoints` is set when dev should spawn
 * the controller (after migrations, which create the table it owns).
 */
export async function prepareDevController(opts: {
  env: Record<string, string | undefined>;
  home: string;
  repoRoot: string;
  probes?: DevControllerProbes;
}): Promise<PreparedDevController> {
  const plan = await planDevController(opts.env, opts.probes ?? hostProbes);
  const skip = (reason: string): PreparedDevController => {
    console.warn(`[dev] sandbox controller not started: ${reason}`);
    return {
      env: { STUDIO_SANDBOX_CONTROLLER_UNAVAILABLE: reason },
      endpoints: null,
    };
  };
  if (plan.kind === "skip") return skip(plan.reason);
  if (plan.kind !== "start") return { env: {}, endpoints: null };
  const dir = resolve(opts.home, "sandbox-controller");
  const certs = await generateDevCerts(dir);
  const binary = join(dir, "sandbox-controller");
  const buildFailure = await buildController(opts.repoRoot, binary);
  if (buildFailure) {
    return skip(`building the sandbox controller failed: ${buildFailure}`);
  }
  const claimsPort = await findAvailablePort(7443);
  const endpoints: DevControllerEndpoints = {
    binary,
    image:
      opts.env.SANDBOX_DOCKER_IMAGE?.trim() ||
      (await defaultSandboxImage(opts.repoRoot)),
    claimsPort,
    callbackPort: await findAvailablePort(claimsPort + 1),
    certs,
  };
  return { env: studioControllerEnv(endpoints), endpoints };
}
