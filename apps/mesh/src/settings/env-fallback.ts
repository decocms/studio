/**
 * Read an env var by its new STUDIO_* name, falling back to the deprecated
 * MESH_* name so existing deploys keep working. Warns once per legacy name.
 */

const warned = new Set<string>();

export function envWithFallback(
  env: Record<string, string | undefined>,
  newName: string,
  deprecatedName: string,
): string | undefined {
  const value = env[newName];
  if (value !== undefined && value !== "") return value;

  const legacy = env[deprecatedName];
  if (legacy === undefined || legacy === "") return undefined;
  if (!warned.has(deprecatedName)) {
    warned.add(deprecatedName);
    console.warn(
      `Environment variable ${deprecatedName} is deprecated — rename it to ${newName}.`,
    );
  }
  return legacy;
}
