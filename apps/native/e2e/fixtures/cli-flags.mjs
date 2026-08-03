/**
 * Return every value supplied for a CLI flag in either `--flag value` or
 * `--flag=value` form. Missing split-form values are retained as `undefined`
 * so callers can reject malformed and duplicate invocations explicitly.
 *
 * @param {string[]} args
 * @param {string} name
 * @returns {Array<string | undefined>}
 */
export function cliFlagValues(args, name) {
  const inlinePrefix = `${name}=`;
  const values = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === name) {
      values.push(args[index + 1]);
    } else if (argument.startsWith(inlinePrefix)) {
      values.push(argument.slice(inlinePrefix.length));
    }
  }
  return values;
}

/** @param {string[]} args @param {string} name */
export function hasCliFlag(args, name) {
  return cliFlagValues(args, name).length > 0;
}
