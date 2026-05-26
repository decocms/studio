import type { MeshContext } from "@/core/mesh-context";

export async function hasAnyObject(
  ctx: MeshContext,
  prefix: string,
): Promise<boolean> {
  const storage = ctx.objectStorage;
  if (!storage) return false;
  try {
    const result = await storage.list({ prefix, maxKeys: 1 });
    return result.objects.length > 0;
  } catch {
    return false;
  }
}
