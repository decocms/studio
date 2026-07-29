import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the real shell scripts through their process boundary. The fake
// platform CLIs keep the suite deterministic and guarantee no Keychain access.
const IDENTITY_HASH = "0123456789ABCDEF0123456789ABCDEF01234567";
const IDENTITY_NAME = "decocms-dev";
const APP_IDENTIFIER = "com.decocms.studio";
const DESIGNATED_REQUIREMENT = `designated => identifier "${APP_IDENTIFIER}" and certificate leaf = H"${IDENTITY_HASH}"`;
const TEST_REQUIREMENT = `identifier "${APP_IDENTIFIER}" and certificate leaf = H"${IDENTITY_HASH}"`;

const runnerSource = fileURLToPath(
  new URL("../scripts/dev-runner.sh", import.meta.url),
);
const setupSource = fileURLToPath(
  new URL("../scripts/create-dev-signing-cert.sh", import.meta.url),
);
const identityHelperSource = fileURLToPath(
  new URL("../scripts/dev-signing-identity.sh", import.meta.url),
);

const fixtureRoots: string[] = [];

interface Fixture {
  root: string;
  runner: string;
  setup: string;
  app: string;
  otherBinary: string;
  codesignLog: string;
  securityLog: string;
  opensslLog: string;
  cargoLog: string;
  unameLog: string;
  executionLog: string;
  signatureState: string;
  certificateState: string;
  identityState: string;
  loginKeychain: string;
  configPath: string;
  helperPath: string;
}

function executable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "decocms-dev-signing-"));
  fixtureRoots.push(root);

  const scriptsDir = join(root, "scripts");
  const fakeBinDir = join(root, "fake-bin");
  mkdirSync(scriptsDir);
  mkdirSync(fakeBinDir);
  mkdirSync(join(root, "tmp"));

  const runner = join(scriptsDir, "dev-runner.sh");
  copyFileSync(runnerSource, runner);
  chmodSync(runner, 0o755);
  const setup = join(scriptsDir, "create-dev-signing-cert.sh");
  copyFileSync(setupSource, setup);
  chmodSync(setup, 0o755);
  copyFileSync(
    identityHelperSource,
    join(scriptsDir, "dev-signing-identity.sh"),
  );

  const configPath = join(root, ".dev-signing-identity");
  writeFileSync(configPath, `${IDENTITY_HASH}\n${IDENTITY_NAME}\n`, {
    mode: 0o600,
  });

  const executionLog = join(root, "executions.log");
  const codesignLog = join(root, "codesign.log");
  const securityLog = join(root, "security.log");
  const opensslLog = join(root, "openssl.log");
  const cargoLog = join(root, "cargo.log");
  const unameLog = join(root, "uname.log");
  const signatureState = join(root, "signature.state");
  const certificateState = join(root, "certificate.state");
  const identityState = join(root, "identity.state");
  const loginKeychain = join(root, "login.keychain-db");
  writeFileSync(loginKeychain, "");
  const targetSource = `#!/bin/sh
printf '%s\\n' "${basename(root)}:$*" >>"$FAKE_EXECUTION_LOG"
`;
  const app = join(root, "decocms-desktop");
  const otherBinary = join(root, "local-api-test");
  executable(app, targetSource);
  executable(otherBinary, targetSource);

  executable(
    join(fakeBinDir, "codesign"),
    `#!/bin/sh
set -eu

{
  printf 'codesign'
  for argument in "$@"; do
    printf '\\t%s' "$argument"
  done
  printf '\\n'
} >>"$FAKE_CODESIGN_LOG"

for argument in "$@"; do
  if [ "$argument" = "--force" ]; then
    if [ "\${FAKE_SIGN_STATUS:-0}" -ne 0 ]; then
      exit "$FAKE_SIGN_STATUS"
    fi
    cat >"$FAKE_SIGNATURE_STATE" <<EOF
Authority=${IDENTITY_NAME}
Identifier=${APP_IDENTIFIER}
${DESIGNATED_REQUIREMENT}
EOF
    exit 0
  fi
done

if [ "\${1:-}" = "-d" ]; then
  if [ -f "$FAKE_SIGNATURE_STATE" ]; then
    cat "$FAKE_SIGNATURE_STATE" >&2
  else
    printf '%s\\n' "Identifier=decocms-desktop" "Signature=adhoc" >&2
  fi
  exit 0
fi

if [ "\${1:-}" = "--verify" ]; then
  for argument in "$@"; do
    if [ "$argument" = "--test-requirement" ]; then
      # Real codesign runs the STANDARD verification before it evaluates an
      # explicit requirement — a binary that fails the former never reaches the
      # latter. Honor FAKE_VERIFY_STATUS here too so this stub models that
      # ordering instead of treating the two as independent failure modes.
      if [ "\${FAKE_VERIFY_STATUS:-0}" != "0" ]; then
        exit "$FAKE_VERIFY_STATUS"
      fi
      if [ -n "\${FAKE_REQUIREMENT_VERIFY_STATUS:-}" ]; then
        exit "$FAKE_REQUIREMENT_VERIFY_STATUS"
      fi
      [ -f "$FAKE_SIGNATURE_STATE" ]
      exit
    fi
  done
  exit "\${FAKE_VERIFY_STATUS:-0}"
fi

echo "unexpected codesign invocation: $*" >&2
exit 98
`,
  );

  executable(
    join(fakeBinDir, "security"),
    `#!/bin/sh
set -eu
{
  printf 'security'
  for argument in "$@"; do
    printf '\\t%s' "$argument"
  done
  printf '\\n'
} >>"$FAKE_SECURITY_LOG"

command="\${1:-}"
case "$command" in
  default-keychain)
    printf '"%s"\\n' "$FAKE_LOGIN_KEYCHAIN"
    ;;
  find-identity)
    if [ -f "$FAKE_IDENTITY_STATE" ]; then
      printf '%s\\n' '  1) ${IDENTITY_HASH} "${IDENTITY_NAME}"'
      printf '%s\\n' '     1 valid identities found'
    else
      printf '%s\\n' '     0 valid identities found'
    fi
    ;;
  find-certificate)
    wants_hashes=false
    for argument in "$@"; do
      if [ "$argument" = "-Z" ]; then
        wants_hashes=true
      fi
    done
    if [ "$wants_hashes" = true ]; then
      if [ -f "$FAKE_IDENTITY_STATE" ] || [ -f "$FAKE_CERTIFICATE_STATE" ]; then
        printf '%s\\n' 'SHA-1 hash: ${IDENTITY_HASH}'
        printf '%s\\n' '    "alis"<blob>="${IDENTITY_NAME}"'
      fi
    else
      printf '%s\\n' '-----BEGIN CERTIFICATE-----'
      printf '%s\\n' 'fake-certificate'
      printf '%s\\n' '-----END CERTIFICATE-----'
    fi
    ;;
  import)
    previous=""
    item_type=""
    for argument in "$@"; do
      if [ "$previous" = "-t" ]; then
        item_type="$argument"
      fi
      previous="$argument"
    done
    if [ "$item_type" = "cert" ]; then
      : >"$FAKE_CERTIFICATE_STATE"
    elif [ "$item_type" = "priv" ]; then
      if [ "\${FAKE_PRIVATE_IMPORT_STATUS:-0}" -ne 0 ]; then
        exit "$FAKE_PRIVATE_IMPORT_STATUS"
      fi
      : >"$FAKE_IDENTITY_STATE"
    fi
    ;;
  add-trusted-cert)
    ;;
  delete-identity)
    if [ ! -f "$FAKE_IDENTITY_STATE" ]; then
      exit 44
    fi
    rm -f "$FAKE_IDENTITY_STATE"
    rm -f "$FAKE_CERTIFICATE_STATE"
    ;;
  delete-certificate)
    rm -f "$FAKE_CERTIFICATE_STATE"
    ;;
  *)
    echo "unexpected security invocation: $*" >&2
    exit 97
    ;;
esac
`,
  );

  executable(
    join(fakeBinDir, "openssl"),
    `#!/bin/sh
set -eu
{
  printf 'openssl'
  for argument in "$@"; do
    printf '\\t%s' "$argument"
  done
  printf '\\n'
} >>"$FAKE_OPENSSL_LOG"

case "\${1:-}" in
  genrsa)
    key_file=""
    previous=""
    for argument in "$@"; do
      if [ "$previous" = "-out" ]; then
        key_file="$argument"
      fi
      previous="$argument"
    done
    printf '%s\\n' "fake-private-key" >"$key_file"
    ;;
  req)
    key_file=""
    certificate_file=""
    previous=""
    for argument in "$@"; do
      if [ "$previous" = "-keyout" ]; then
        key_file="$argument"
      elif [ "$previous" = "-out" ]; then
        certificate_file="$argument"
      fi
      previous="$argument"
    done
    if [ -n "$key_file" ]; then
      printf '%s\\n' "fake-private-key" >"$key_file"
    fi
    printf '%s\\n' "fake-certificate" >"$certificate_file"
    ;;
  x509)
    if [ "\${FAKE_OPENSSL_X509_STATUS:-0}" -ne 0 ]; then
      exit "$FAKE_OPENSSL_X509_STATUS"
    fi
    for argument in "$@"; do
      if [ "$argument" = "-fingerprint" ]; then
        printf '%s\\n' "sha1 Fingerprint=01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67"
      fi
    done
    ;;
  *)
    echo "unexpected openssl invocation: $*" >&2
    exit 96
    ;;
esac
`,
  );

  executable(
    join(fakeBinDir, "cargo"),
    `#!/bin/sh
set -eu
{
  printf 'cargo'
  for argument in "$@"; do
    printf '\\t%s' "$argument"
  done
  printf '\\n'
} >>"$FAKE_CARGO_LOG"

helper="$CARGO_TARGET_DIR/debug/decocms-keychain-helper"
mkdir -p "$(dirname "$helper")"
cat >"$helper" <<'EOF'
#!/bin/sh
set -eu
if [ "$#" -ne 0 ]; then
  exit 91
fi
request=$(while IFS= read -r line; do printf '%s' "$line"; done)
case "$request" in
  '{"version":2,"operation":"probe"}')
    printf '%s\\n' '{"version":2,"status":"ok"}'
    ;;
  *)
    exit 92
    ;;
esac
EOF
chmod 700 "$helper"
`,
  );

  executable(
    join(fakeBinDir, "uname"),
    `#!/bin/sh
set -eu
{
  printf 'uname'
  for argument in "$@"; do
    printf '\\t%s' "$argument"
  done
  printf '\\n'
} >>"$FAKE_UNAME_LOG"
printf '%s\\n' Darwin
`,
  );

  return {
    root,
    runner,
    setup,
    app,
    otherBinary,
    codesignLog,
    securityLog,
    opensslLog,
    cargoLog,
    unameLog,
    executionLog,
    signatureState,
    certificateState,
    identityState,
    loginKeychain,
    configPath,
    helperPath: join(
      root,
      "Library/Application Support/com.decocms.studio/dev/decocms-keychain-helper",
    ),
  };
}

function run(
  fixture: Fixture,
  binary: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(fixture.runner, [binary, "argument with spaces"], {
    encoding: "utf8",
    env: fixtureEnvironment(fixture, extraEnv),
  });
}

function runSetup(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(fixture.setup, [], {
    encoding: "utf8",
    env: fixtureEnvironment(fixture, extraEnv),
  });
}

function fixtureEnvironment(
  fixture: Fixture,
  extraEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${join(fixture.root, "fake-bin")}:/usr/bin:/bin`,
    TMPDIR: join(fixture.root, "tmp"),
    HOME: fixture.root,
    DECOCMS_OPENSSL_BIN: join(fixture.root, "fake-bin", "openssl"),
    FAKE_CODESIGN_LOG: fixture.codesignLog,
    FAKE_SECURITY_LOG: fixture.securityLog,
    FAKE_OPENSSL_LOG: fixture.opensslLog,
    FAKE_CARGO_LOG: fixture.cargoLog,
    FAKE_UNAME_LOG: fixture.unameLog,
    FAKE_EXECUTION_LOG: fixture.executionLog,
    FAKE_SIGNATURE_STATE: fixture.signatureState,
    FAKE_CERTIFICATE_STATE: fixture.certificateState,
    FAKE_IDENTITY_STATE: fixture.identityState,
    FAKE_LOGIN_KEYCHAIN: fixture.loginKeychain,
    ...extraEnv,
  };
}

function commandCalls(logPath: string): string[][] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t").slice(1));
}

function codesignCalls(fixture: Fixture): string[][] {
  return commandCalls(fixture.codesignLog);
}

function executionCount(fixture: Fixture): number {
  if (!existsSync(fixture.executionLog)) {
    return 0;
  }
  return readFileSync(fixture.executionLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean).length;
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("native dev signing runner", () => {
  test("passes non-app Cargo binaries through without touching codesign", () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.otherBinary, {
      FAKE_SIGN_STATUS: "71",
      FAKE_VERIFY_STATUS: "72",
    });

    expect(result.status).toBe(0);
    expect(executionCount(fixture)).toBe(1);
    expect(codesignCalls(fixture)).toEqual([]);
    expect(existsSync(fixture.securityLog)).toBe(false);
  });

  test("fails closed when no signing identity is configured", () => {
    const fixture = createFixture();
    rmSync(fixture.configPath);
    const result = run(fixture, fixture.app);

    expect(result.status).not.toBe(0);
    expect(executionCount(fixture)).toBe(0);
    expect(codesignCalls(fixture)).toEqual([]);
  });

  test("rejects malformed hashes and unexpected certificate names", () => {
    for (const config of [
      `not-a-certificate-hash\n${IDENTITY_NAME}\n`,
      `${IDENTITY_HASH}\nother-dev-certificate\n`,
    ]) {
      const fixture = createFixture();
      writeFileSync(fixture.configPath, config);
      const result = run(fixture, fixture.app);

      expect(result.status).not.toBe(0);
      expect(executionCount(fixture)).toBe(0);
      expect(codesignCalls(fixture)).toEqual([]);
    }
  });

  test("pins the app signature to its identifier and self-signed certificate", () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.app);
    const calls = codesignCalls(fixture);
    const signCall = calls.find((call) => call.includes("--force"));
    const requirementVerification = calls.find((call) =>
      call.includes("--test-requirement"),
    );

    expect(result.status).toBe(0);
    expect(signCall).toBeDefined();
    expect(signCall).toContain("--sign");
    expect(signCall).toContain(IDENTITY_HASH);
    expect(signCall).toContain("--identifier");
    expect(signCall).toContain(APP_IDENTIFIER);
    expect(signCall).toContain("--requirements");
    expect(signCall).toContain(`=${DESIGNATED_REQUIREMENT}`);
    expect(requirementVerification).toContain(`=${TEST_REQUIREMENT}`);
    expect(calls.flat()).not.toContain("TeamIdentifier");
    expect(executionCount(fixture)).toBe(1);
  });

  test("does not launch the app when signing fails", () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.app, { FAKE_SIGN_STATUS: "73" });

    expect(result.status).toBe(73);
    expect(executionCount(fixture)).toBe(0);
  });

  test("does not launch the app when signature verification fails", () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.app, { FAKE_VERIFY_STATUS: "74" });

    expect(result.status).toBe(74);
    expect(executionCount(fixture)).toBe(0);
  });

  test("does not launch the app when its designated requirement is wrong", () => {
    const fixture = createFixture();
    const result = run(fixture, fixture.app, {
      FAKE_REQUIREMENT_VERIFY_STATUS: "75",
    });

    expect(result.status).toBe(75);
    expect(executionCount(fixture)).toBe(0);
  });

  test("does not mutate an already-valid app signature", () => {
    const fixture = createFixture();
    writeFileSync(
      fixture.signatureState,
      `Authority=${IDENTITY_NAME}
Identifier=${APP_IDENTIFIER}
${DESIGNATED_REQUIREMENT}
`,
    );

    const result = run(fixture, fixture.app);
    const calls = codesignCalls(fixture);

    expect(result.status).toBe(0);
    expect(calls.some((call) => call.includes("--force"))).toBe(false);
    expect(calls.some((call) => call.includes("--test-requirement"))).toBe(
      true,
    );
    expect(executionCount(fixture)).toBe(1);
  });
});

describe("native dev signing setup", () => {
  test("reuses the exact existing identity without creating or importing it", () => {
    const fixture = createFixture();
    rmSync(fixture.configPath);
    writeFileSync(fixture.identityState, "");

    const result = runSetup(fixture);
    const securityCalls = commandCalls(fixture.securityLog);
    const opensslCalls = commandCalls(fixture.opensslLog);

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.configPath, "utf8")).toBe(
      `${IDENTITY_HASH}\n${IDENTITY_NAME}\n`,
    );
    expect(securityCalls.some((call) => call[0] === "import")).toBe(false);
    expect(securityCalls.some((call) => call[0] === "add-trusted-cert")).toBe(
      false,
    );
    expect(opensslCalls.some((call) => call[0] === "req")).toBe(false);
    expect(opensslCalls.some((call) => call[0] === "x509")).toBe(true);
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "Apple Development",
    );
  });

  test("creates, imports, and trusts the self-signed identity when absent", () => {
    const fixture = createFixture();
    rmSync(fixture.configPath);

    const result = runSetup(fixture);
    const securityCalls = commandCalls(fixture.securityLog);
    const opensslCalls = commandCalls(fixture.opensslLog);
    const importCalls = securityCalls.filter((call) => call[0] === "import");

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.configPath, "utf8")).toBe(
      `${IDENTITY_HASH}\n${IDENTITY_NAME}\n`,
    );
    expect(opensslCalls.some((call) => call[0] === "genrsa")).toBe(true);
    expect(opensslCalls.some((call) => call[0] === "req")).toBe(true);
    expect(importCalls).toHaveLength(2);
    expect(importCalls.some((call) => call.includes("cert"))).toBe(true);
    expect(importCalls.some((call) => call.includes("priv"))).toBe(true);
    expect(securityCalls.some((call) => call[0] === "add-trusted-cert")).toBe(
      true,
    );
    expect(existsSync(fixture.identityState)).toBe(true);
    expect(existsSync(fixture.helperPath)).toBe(true);
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "Apple Development",
    );
  });

  test("installs one fixed helper and reuses it on later setup runs", () => {
    const fixture = createFixture();
    rmSync(fixture.configPath);
    writeFileSync(fixture.identityState, "");

    const first = runSetup(fixture);
    expect(first.status).toBe(0);
    expect(readFileSync(fixture.helperPath, "utf8")).toContain(
      '"operation":"probe"',
    );
    expect(commandCalls(fixture.cargoLog)).toHaveLength(1);
    expect(
      spawnSync("stat", ["-f", "%Lp", fixture.helperPath], {
        encoding: "utf8",
      }).stdout.trim(),
    ).toBe("700");

    const firstContents = readFileSync(fixture.helperPath);
    const second = runSetup(fixture);
    expect(second.status).toBe(0);
    expect(commandCalls(fixture.cargoLog)).toHaveLength(1);
    expect(readFileSync(fixture.helperPath)).toEqual(firstContents);
  });

  test("replaces an installed helper when its protocol version is stale", () => {
    const fixture = createFixture();
    rmSync(fixture.configPath);
    writeFileSync(fixture.identityState, "");
    mkdirSync(dirname(fixture.helperPath), { recursive: true });
    executable(
      fixture.helperPath,
      `#!/bin/sh
while IFS= read -r _line; do :; done
printf '%s\\n' '{"version":0,"status":"ok"}'
`,
    );
    chmodSync(fixture.helperPath, 0o700);

    const result = runSetup(fixture);

    expect(result.status).toBe(0);
    expect(commandCalls(fixture.cargoLog)).toHaveLength(1);
    expect(readFileSync(fixture.helperPath, "utf8")).toContain(
      '{"version":2,"status":"ok"}',
    );
  });

  test("fails closed when signing or requirement verification fails", () => {
    const failureEnvironments: Array<Record<string, string>> = [
      { FAKE_SIGN_STATUS: "81" },
      { FAKE_REQUIREMENT_VERIFY_STATUS: "82" },
    ];
    for (const extraEnv of failureEnvironments) {
      const fixture = createFixture();
      rmSync(fixture.configPath);
      writeFileSync(fixture.identityState, "");

      const result = runSetup(fixture, extraEnv);

      expect(result.status).not.toBe(0);
      expect(existsSync(fixture.configPath)).toBe(false);
      expect(existsSync(fixture.identityState)).toBe(true);
    }
  });

  test("rolls back only an identity created by a failed setup", () => {
    const fixture = createFixture();
    rmSync(fixture.configPath);

    const result = runSetup(fixture, { FAKE_SIGN_STATUS: "83" });
    const securityCalls = commandCalls(fixture.securityLog);
    const rollbackCall = securityCalls.find(
      (call) => call[0] === "delete-identity",
    );

    expect(result.status).toBe(83);
    expect(existsSync(fixture.configPath)).toBe(false);
    expect(existsSync(fixture.identityState)).toBe(false);
    expect(rollbackCall).toContain("-Z");
    expect(rollbackCall).toContain(IDENTITY_HASH);
  });

  test("does not trust, import over, or delete an invalid same-name certificate", () => {
    const fixture = createFixture();
    rmSync(fixture.configPath);
    writeFileSync(fixture.certificateState, "");

    const result = runSetup(fixture);
    const securityCalls = commandCalls(fixture.securityLog);

    expect(result.status).not.toBe(0);
    expect(existsSync(fixture.certificateState)).toBe(true);
    expect(existsSync(fixture.identityState)).toBe(false);
    expect(existsSync(fixture.configPath)).toBe(false);
    expect(securityCalls.some((call) => call[0] === "add-trusted-cert")).toBe(
      false,
    );
    expect(securityCalls.some((call) => call[0] === "import")).toBe(false);
    expect(
      securityCalls.some(
        (call) =>
          call[0] === "delete-identity" || call[0] === "delete-certificate",
      ),
    ).toBe(false);
  });

  test("removes a certificate-only partial import when private-key import fails", () => {
    const fixture = createFixture();
    rmSync(fixture.configPath);

    const result = runSetup(fixture, { FAKE_PRIVATE_IMPORT_STATUS: "84" });
    const securityCalls = commandCalls(fixture.securityLog);

    expect(result.status).toBe(84);
    expect(existsSync(fixture.certificateState)).toBe(false);
    expect(existsSync(fixture.identityState)).toBe(false);
    expect(existsSync(fixture.configPath)).toBe(false);
    expect(securityCalls.some((call) => call[0] === "delete-identity")).toBe(
      true,
    );
    expect(securityCalls.some((call) => call[0] === "delete-certificate")).toBe(
      true,
    );
  });
});
