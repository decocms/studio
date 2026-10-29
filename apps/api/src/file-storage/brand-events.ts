import { BRAND_UPDATED_EVENT } from "@decocms/shared/brand";
import { sseHub } from "@/event-bus/sse-hub";

/** A brand folder or a file in it on the home volume, its cards aside: they have an event of their own. */
const BRAND_PATH = /^brands\/([^/]+)(?:\/(?!cards(?:\/|$)).*)?$/;

/** The brands a write to these paths touched, each once. */
export function brandsWrittenTo(
  volume: string,
  paths: readonly string[],
): string[] {
  if (volume !== "home") return [];
  const brands = new Set<string>();
  for (const path of paths) {
    const brand = BRAND_PATH.exec(path.replace(/^\/+/, ""))?.[1];
    if (brand) brands.add(brand);
  }
  return [...brands];
}

/** Push a brand's change to every SSE listener on its org. */
export function emitBrandUpdated(orgId: string, brand: string): void {
  sseHub.emit(orgId, {
    id: crypto.randomUUID(),
    type: BRAND_UPDATED_EVENT,
    source: "org-fs",
    subject: brand,
    data: { brand },
    time: new Date().toISOString(),
  });
}
