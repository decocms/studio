import type { EnrichedTenantConfig, RuntimeName, TenantConfig } from "../types";

function derivePathPrefix(runtime: RuntimeName | undefined): string {
  if (runtime === "bun") return "export PATH=/opt/bun/bin:$PATH && ";
  if (runtime === "deno") return "export PATH=/opt/deno/bin:$PATH && ";
  return "";
}

function deriveRuntimePathDirs(
  runtime: RuntimeName | undefined,
): readonly string[] {
  if (runtime === "bun") return ["/opt/bun/bin"];
  if (runtime === "deno") return ["/opt/deno/bin"];
  return [];
}

/**
 * Adorn a TenantConfig with derived in-memory fields. These fields are
 * never persisted to disk — recomputed on every read so the disk file
 * stays a pure user-intent surface.
 */
export function enrich(config: TenantConfig): EnrichedTenantConfig {
  return Object.freeze({
    ...config,
    runtimePathPrefix: derivePathPrefix(config.application?.runtime),
    runtimePathDirs: deriveRuntimePathDirs(config.application?.runtime),
  });
}
