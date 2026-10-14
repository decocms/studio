import type { SandboxProviderKind } from "../types";

const KEY = "sandboxProvider";

/** Mark an error with the provider that raised it, so a failure is attributed. */
export function tagSandboxProvider<E>(err: E, kind: SandboxProviderKind): E {
  if (err instanceof Error) Object.assign(err, { [KEY]: kind });
  return err;
}

/** The tag on `err` or on any error in its `cause` chain. */
export function sandboxProviderOfError(
  err: unknown,
): SandboxProviderKind | undefined {
  for (let e = err, depth = 0; e instanceof Error && depth < 5; depth++) {
    const kind = (e as Error & { [KEY]?: unknown })[KEY];
    if (kind === "kubernetes" || kind === "freestyle") return kind;
    e = e.cause;
  }
  return undefined;
}
