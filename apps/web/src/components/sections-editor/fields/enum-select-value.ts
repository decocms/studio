/** Radix Select reserves `""` for clearing; map real empty-string enums to this. */
export const ENUM_EMPTY_SELECT_VALUE = "__enum_empty__";

/**
 * Sentinel for the "None" option offered on optional enums. Selecting it clears
 * the field back to `undefined`. Distinct from {@link ENUM_EMPTY_SELECT_VALUE},
 * which represents an enum whose allowed value is the empty string `""`.
 */
export const ENUM_CLEAR_SELECT_VALUE = "__enum_clear__";

export function enumOptionToSelectValue(opt: unknown): string {
  if (opt === "") return ENUM_EMPTY_SELECT_VALUE;
  return String(opt);
}

export function selectValueToEnumOption(
  value: string,
  options: unknown[],
): unknown {
  if (value === ENUM_EMPTY_SELECT_VALUE) return "";
  const match = options.find((opt) => enumOptionToSelectValue(opt) === value);
  return match !== undefined ? match : value;
}

/**
 * Maps a Select value to the form value written back. The clear option becomes
 * `undefined` (unset the field); every other value delegates to
 * {@link selectValueToEnumOption}.
 */
export function selectValueToFormValue(
  value: string,
  options: unknown[],
): unknown {
  if (value === ENUM_CLEAR_SELECT_VALUE) return undefined;
  return selectValueToEnumOption(value, options);
}

export function formValueToSelectValue(
  value: unknown,
  options: unknown[],
): string | undefined {
  if (value === undefined || value === null) {
    return options.some((opt) => opt === "")
      ? ENUM_EMPTY_SELECT_VALUE
      : undefined;
  }
  return enumOptionToSelectValue(value);
}

export function enumOptionLabel(opt: unknown): string {
  return opt === "" ? "" : String(opt);
}
