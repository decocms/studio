/** Intermediate numeric strings the user can be mid-typing: "", "-", "+", ".", "0.", "1e-", "1e+5". */
const PARTIAL_NUMBER = /^[+-]?\d*\.?\d*(?:[eE][+-]?\d*)?$/;

/** Same, but no decimal point or exponent — matches JSON Schema's "integer". */
const PARTIAL_INTEGER = /^[+-]?\d*$/;

/**
 * Whether `value` is a valid in-progress (or complete) typed string for a
 * number input. `isInteger` rejects "1.5" / "1e5" so an `integer` schema
 * field can never produce a non-integer value.
 */
export function isPartialNumericInput(value: string, isInteger: boolean) {
  return (isInteger ? PARTIAL_INTEGER : PARTIAL_NUMBER).test(value);
}
