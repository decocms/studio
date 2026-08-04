/**
 * Pick which file-config bucket a drop/browse upload should target, shared
 * by ImageField and FileField.
 *   - a locked (site-slug-matched) config always wins
 *   - 1 config: that one
 *   - 2+ configs: the last-used (from localStorage), if it's still present
 *   - 0 configs, or 2+ without a prior selection: null → caller opens the
 *     picker dialog so the user can configure / pick a bucket explicitly
 */
export function resolveTargetConfigId(
  configs: Array<{ id: string }>,
  lockedConfigId: string | null | undefined,
  lastSelectedConfigId: string | null,
): string | null {
  if (lockedConfigId) return lockedConfigId;
  if (configs.length === 1) return configs[0]!.id;
  if (configs.length === 0) return null;
  return configs.some((c) => c.id === lastSelectedConfigId)
    ? lastSelectedConfigId
    : null;
}
