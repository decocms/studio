import { createContext, type ReactNode, useContext } from "react";

/**
 * Per-field "required prop" signal for {@link FieldLabel}.
 *
 * Only object *properties* the schema marks as required flow through here — the
 * signal is provided at the object-property map in `schema-form.tsx` and reset
 * at array-item boundaries (`array-field.tsx`). This is deliberately narrower
 * than the `FieldProps.required` boolean: array items pass `required: true` as a
 * "clearing would leave a null hole" hack (it hides `EnumField`'s clear option),
 * which is NOT a "the user must fill this" requirement and must not render a
 * required marker. Reading through context keeps every widget's `FieldLabel`
 * marker-aware without threading two props through ~19 call sites.
 */
export interface RequiredFieldState {
  /** The schema marks this object property as required. */
  required: boolean;
  /** Required and currently empty — render the error affordance. */
  invalid: boolean;
}

const RequiredFieldContext = createContext<RequiredFieldState>({
  required: false,
  invalid: false,
});

export function useRequiredField(): RequiredFieldState {
  return useContext(RequiredFieldContext);
}

export function RequiredFieldProvider({
  required,
  invalid,
  children,
}: RequiredFieldState & { children: ReactNode }) {
  return (
    <RequiredFieldContext.Provider value={{ required, invalid }}>
      {children}
    </RequiredFieldContext.Provider>
  );
}

/**
 * Whether a required field's value counts as "not filled in" for the error
 * affordance. Conservative on purpose — only clearly-absent values flag, so a
 * valid `0`/`false` never reads as missing:
 * - `null` / `undefined` → empty
 * - a string that is empty or whitespace-only → empty
 * - an empty array → empty
 * - an object with no own keys → empty
 */
export function isEmptyFieldValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}
