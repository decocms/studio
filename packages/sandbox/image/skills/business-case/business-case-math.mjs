/**
 * business-case-math — the arithmetic of a business case, so the model never
 * multiplies in its head.
 *
 *   bun business-case-math.mjs money --base <n> --delta-pp <x> --value <v> [--gap-pp <g>]
 *   bun business-case-math.mjs ab-test --baseline <0..1> --effect-pp <x> --weekly <n>
 *       [--exposure <0..1>] [--direction up|down]
 *
 * Prints one JSON object on stdout. Exits non-zero with a message when an
 * input is missing or out of range.
 *
 * The rules match the store diagnosis this skill sits next to: a promise is a
 * small named gain over a named base (0.3–3 pp, never more than the gap), the
 * full gap is only a ceiling, and an A/B test runs whole weeks, at least 2,
 * and is not measurable past 8.
 */

export const MIN_DELTA_PP = 0.3;
export const MAX_DELTA_PP = 3;

const Z_ALPHA = 1.959964; // two-sided, α = 5%
const Z_POWER = 0.841621; // power 80%
/** Below this relative effect a test never ends. */
export const MIN_RELATIVE_EFFECT = 0.03;
export const MIN_WEEKS = 2;
export const MAX_WEEKS = 8;

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Monthly value of closing `deltaPp` of a step, and the ceiling of closing
 * the whole gap. `base` is people (or events) at the step per month; `value`
 * is what one more conversion at that step is worth.
 */
export function money({ base, deltaPp, value, gapPp }) {
  const problems = [];
  const positive = (v) => Number.isFinite(v) && v > 0;
  if (!positive(base)) problems.push("base must be a number > 0");
  if (!positive(value)) problems.push("value must be a number > 0");
  if (!positive(deltaPp)) problems.push("delta-pp must be a number > 0");
  if (gapPp !== undefined && !positive(gapPp)) {
    problems.push("gap-pp must be a number > 0 when given");
  }
  if (problems.length > 0) return { ok: false, problems };

  const cap = Math.min(MAX_DELTA_PP, gapPp ?? MAX_DELTA_PP);
  const floor = Math.min(MIN_DELTA_PP, cap);
  const used = Math.min(Math.max(deltaPp, floor), cap);
  const notes = [];
  if (used !== deltaPp) {
    notes.push(
      `delta-pp ${deltaPp} moved to ${used}: a promise stays between ${floor} and ${cap} pp` +
        (gapPp !== undefined ? ` (the gap is ${gapPp} pp)` : ""),
    );
  }
  return {
    ok: true,
    base,
    delta_pp: used,
    value,
    monthly_value: round2(base * (used / 100) * value),
    ceiling_monthly:
      gapPp === undefined ? null : round2(base * (gapPp / 100) * value),
    notes,
  };
}

/** People per group to detect p1 → p2. Infinity when there is no difference. */
export function sampleSizePerGroup(p1, p2) {
  const d = Math.abs(p2 - p1);
  if (!(d > 0) || p1 <= 0 || p1 >= 1 || p2 <= 0 || p2 >= 1) {
    return Number.POSITIVE_INFINITY;
  }
  const pBar = (p1 + p2) / 2;
  const a = Z_ALPHA * Math.sqrt(2 * pBar * (1 - pBar));
  const b = Z_POWER * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil(((a + b) * (a + b)) / (d * d));
}

/** The smallest absolute effect `perGroup` people per group can detect. */
export function detectableEffect(p1, perGroup) {
  if (!(perGroup > 0) || p1 <= 0 || p1 >= 1) return null;
  let lo = 1e-5;
  let hi = Math.min(1 - p1, p1) - 1e-6;
  if (sampleSizePerGroup(p1, p1 + hi) > perGroup) return null;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (sampleSizePerGroup(p1, p1 + mid) <= perGroup) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Sample size and duration of a 50/50 test on a step whose current rate is
 * `baseline`, chasing `effectPp`, with `weekly` people reaching the step and
 * `exposure` of them seeing the change.
 */
export function abTest({
  baseline,
  effectPp,
  weekly,
  exposure = 1,
  direction = "up",
}) {
  const problems = [];
  if (!(Number.isFinite(baseline) && baseline > 0 && baseline < 1)) {
    problems.push("baseline must be a rate between 0 and 1 (e.g. 0.33)");
  }
  if (!(Number.isFinite(effectPp) && effectPp > 0)) {
    problems.push("effect-pp must be a number > 0");
  }
  if (!(Number.isFinite(weekly) && weekly > 0)) {
    problems.push("weekly must be a number > 0");
  }
  if (!(Number.isFinite(exposure) && exposure > 0 && exposure <= 1)) {
    problems.push("exposure must be in (0, 1]");
  }
  if (direction !== "up" && direction !== "down") {
    problems.push("direction must be up or down");
  }
  if (problems.length > 0) return { ok: false, problems };

  const mde = Math.max(effectPp / 100, baseline * MIN_RELATIVE_EFFECT);
  const target = direction === "down" ? baseline - mde : baseline + mde;
  const perGroup = sampleSizePerGroup(baseline, target);
  const eligible = weekly * exposure;
  const rawWeeks = Number.isFinite(perGroup)
    ? (2 * perGroup) / eligible
    : Infinity;
  const weeks = Number.isFinite(rawWeeks)
    ? Math.max(MIN_WEEKS, Math.ceil(rawWeeks))
    : null;
  const in4 = detectableEffect(baseline, (eligible * 4) / 2);
  return {
    ok: true,
    baseline,
    mde_pp: round2(mde * 100),
    target_rate: target,
    n_per_group: Number.isFinite(perGroup) ? perGroup : null,
    weekly_eligible: Math.round(eligible),
    weeks,
    measurable: weeks !== null && weeks <= MAX_WEEKS,
    mde_4_weeks_pp: in4 === null ? null : round2(in4 * 100),
    method: "two-proportion z-test, two-sided, α 5%, power 80%, 50/50 split",
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    out[key.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

const num = (v) => (v === undefined ? undefined : Number(v));

function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  let result;
  if (command === "money") {
    result = money({
      base: num(args.base),
      deltaPp: num(args["delta-pp"]),
      value: num(args.value),
      gapPp: num(args["gap-pp"]),
    });
  } else if (command === "ab-test") {
    result = abTest({
      baseline: num(args.baseline),
      effectPp: num(args["effect-pp"]),
      weekly: num(args.weekly),
      exposure: args.exposure === undefined ? 1 : num(args.exposure),
      direction: args.direction ?? "up",
    });
  } else {
    console.error(
      "Usage:\n" +
        "  business-case-math money --base <n> --delta-pp <x> --value <v> [--gap-pp <g>]\n" +
        "  business-case-math ab-test --baseline <0..1> --effect-pp <x> --weekly <n> [--exposure <0..1>] [--direction up|down]",
    );
    process.exit(1);
  }
  if (!result.ok) {
    console.error(`business-case-math: ${result.problems.join("; ")}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) main(process.argv.slice(2));
