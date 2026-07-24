const LEGACY_PREFIXES = [
  ["mesh:", "studio:"],
  ["mesh-", "studio-"],
] as const;

/**
 * Copies legacy browser preferences into Studio's namespace once.
 *
 * Old keys are intentionally retained during the compatibility window so a
 * rollback to an older Studio release does not discard the user's settings.
 */
export function migrateLegacyStorageKeys(storage: Storage): void {
  const legacyKeys = Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  ).filter((key): key is string => key !== null);

  for (const legacyKey of legacyKeys) {
    const prefix = LEGACY_PREFIXES.find(([oldPrefix]) =>
      legacyKey.startsWith(oldPrefix),
    );
    if (!prefix) continue;

    const [oldPrefix, newPrefix] = prefix;
    const studioKey = `${newPrefix}${legacyKey.slice(oldPrefix.length)}`;
    if (storage.getItem(studioKey) !== null) continue;

    const value = storage.getItem(legacyKey);
    if (value !== null) storage.setItem(studioKey, value);
  }
}
