/** The three fields of the `@format location` matcher value. */
export interface LocationValue {
  city: string;
  regionCode: string;
  country: string;
}

/**
 * Detect the Location matcher shape from a schema's property keys. deco drops
 * object-level `@format location`, so a union branch (or object) whose fields
 * are exactly {city, regionCode, country} is our signal to render LocationField.
 */
export function isLocationShape(
  properties: Record<string, unknown> | undefined,
): boolean {
  if (!properties) return false;
  const keys = Object.keys(properties).sort();
  return (
    keys.length === 3 &&
    keys[0] === "city" &&
    keys[1] === "country" &&
    keys[2] === "regionCode"
  );
}

/** Coerce an unknown form value into a well-shaped LocationValue (empty strings for missing). */
export function readLocationValue(value: unknown): LocationValue {
  const obj =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    city: typeof obj.city === "string" ? obj.city : "",
    regionCode: typeof obj.regionCode === "string" ? obj.regionCode : "",
    country: typeof obj.country === "string" ? obj.country : "",
  };
}

/**
 * Merge a partial update over the current value and drop empty fields, so the
 * stored object only carries keys the matcher should compare against.
 */
export function mergeLocationValue(
  current: LocationValue,
  next: Partial<LocationValue>,
): Record<string, string> {
  const merged = { ...current, ...next };
  const clean: Record<string, string> = {};
  for (const key of ["city", "regionCode", "country"] as const) {
    if (merged[key]) clean[key] = merged[key];
  }
  return clean;
}
