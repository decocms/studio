import { MAX_OFFERED_PHOTOS } from "../blog-campaign";

/**
 * The campaign's photographs, breadth first, capped at what the tool accepts.
 *
 * Flattening product by product overruns the cap on any well-stocked campaign
 * and spends the whole allowance on its first few items. Taking one from each
 * before a second from any means the references describe the range the post is
 * actually about.
 */
export function referencePhotos(
  products: readonly { images?: readonly string[] }[],
): string[] {
  const picked: string[] = [];
  for (let round = 0; picked.length < MAX_OFFERED_PHOTOS; round += 1) {
    const before = picked.length;
    for (const product of products) {
      const url = product.images?.[round];
      if (!url) continue;
      picked.push(url);
      if (picked.length >= MAX_OFFERED_PHOTOS) return picked;
    }
    if (picked.length === before) break;
  }
  return picked;
}
