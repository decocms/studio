const LAZY_SUFFIXES = [
  "website/sections/Rendering/Lazy.tsx",
  "website/sections/Rendering/SingleDeferred.tsx",
];

export function isLazyResolveType(rt: string): boolean {
  return LAZY_SUFFIXES.some((suffix) => rt.endsWith(suffix));
}
