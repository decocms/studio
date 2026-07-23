export type InterpolationVars = Record<string, string | number>;

/**
 * Replace `{name}` placeholders in a translation template. Unknown
 * placeholders are left intact so a missing var is visible, not "undefined".
 */
export function interpolate(
  template: string,
  vars?: InterpolationVars,
): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}
