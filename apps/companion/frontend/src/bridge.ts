// Typed wrappers over the Native SDK bridge (`window.zero.invoke`). The Zig
// host registers the `deco.*` commands; see src/main.zig.

interface ZeroApi {
  invoke<T = unknown>(command: string, payload?: unknown): Promise<T>;
  on?(name: string, cb: (detail: unknown) => void): () => void;
}

function zero(): ZeroApi | null {
  return (window as unknown as { zero?: ZeroApi }).zero ?? null;
}

export function bridgeAvailable(): boolean {
  return zero() !== null;
}

export interface Status {
  loggedIn: boolean;
  studioUrl: string;
}

export interface ProvisionResult {
  count: number;
  orgs: string[];
}

export async function getStatus(): Promise<Status> {
  const z = zero();
  if (!z) throw new Error("Native bridge not available");
  return z.invoke<Status>("deco.status", {});
}

export async function provision(): Promise<ProvisionResult> {
  const z = zero();
  if (!z) throw new Error("Native bridge not available");
  return z.invoke<ProvisionResult>("deco.provision", {});
}
