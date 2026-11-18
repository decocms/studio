import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(
  new URL(
    "./image/skills/business-case/business-case-math.mjs",
    import.meta.url,
  ),
);

/** Runs the CLI the way the skill does and parses its JSON. */
function run(args: string[]) {
  const res = Bun.spawnSync(["bun", CLI, ...args]);
  const stdout = res.stdout.toString();
  return {
    code: res.exitCode,
    stderr: res.stderr.toString(),
    json: res.exitCode === 0 ? JSON.parse(stdout) : null,
  };
}

describe("business-case money", () => {
  it("multiplies base × delta × value", () => {
    const { code, json } = run([
      "money",
      "--base",
      "470000",
      "--delta-pp",
      "1.5",
      "--value",
      "123",
    ]);
    expect(code).toBe(0);
    expect(json).toMatchObject({
      delta_pp: 1.5,
      monthly_value: 867_150,
      ceiling_monthly: null,
      notes: [],
    });
  });

  it("caps the promise at 3 pp", () => {
    const { json } = run([
      "money",
      "--base",
      "1000",
      "--delta-pp",
      "10",
      "--value",
      "10",
    ]);
    expect(json.delta_pp).toBe(3);
    expect(json.monthly_value).toBe(300);
    expect(json.notes).toHaveLength(1);
  });

  it("caps the promise at the measured gap and shows the gap as a ceiling", () => {
    const { json } = run([
      "money",
      "--base",
      "1000",
      "--delta-pp",
      "2",
      "--value",
      "10",
      "--gap-pp",
      "1",
    ]);
    expect(json).toMatchObject({
      delta_pp: 1,
      monthly_value: 100,
      ceiling_monthly: 100,
    });
  });

  it("raises a tiny promise to the 0.3 pp floor", () => {
    const { json } = run([
      "money",
      "--base",
      "1000",
      "--delta-pp",
      "0.05",
      "--value",
      "10",
    ]);
    expect(json.delta_pp).toBe(0.3);
  });

  it("exits non-zero on missing or non-positive input", () => {
    expect(
      run(["money", "--base", "0", "--delta-pp", "1", "--value", "1"]).code,
    ).not.toBe(0);
    const missing = run(["money", "--base", "100", "--value", "1"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("delta-pp");
  });
});

describe("business-case ab-test", () => {
  it("sizes a two-proportion test and runs whole weeks, at least two", () => {
    // 33% → 34.2% (1.2 pp), two-sided α 5%, power 80%.
    const { code, json } = run([
      "ab-test",
      "--baseline",
      "0.33",
      "--effect-pp",
      "1.2",
      "--weekly",
      "109000",
    ]);
    expect(code).toBe(0);
    expect(json.n_per_group).toBeGreaterThan(24_000);
    expect(json.n_per_group).toBeLessThan(25_000);
    expect(json).toMatchObject({ mde_pp: 1.2, weeks: 2, measurable: true });
  });

  it("never chases less than 3% relative", () => {
    const { json } = run([
      "ab-test",
      "--baseline",
      "0.5",
      "--effect-pp",
      "0.1",
      "--weekly",
      "1000000",
    ]);
    expect(json.mde_pp).toBe(1.5);
  });

  it("flags a test that would take more than 8 weeks", () => {
    const { json } = run([
      "ab-test",
      "--baseline",
      "0.02",
      "--effect-pp",
      "0.3",
      "--weekly",
      "500",
    ]);
    expect(json.measurable).toBe(false);
  });

  it("only counts people who see the change", () => {
    const base = [
      "ab-test",
      "--baseline",
      "0.1",
      "--effect-pp",
      "1",
      "--weekly",
      "2000",
    ];
    const all = run(base).json;
    const half = run([...base, "--exposure", "0.5"]).json;
    expect(half.weekly_eligible).toBe(1000);
    expect(half.weeks).toBeGreaterThan(all.weeks);
  });

  it("exits non-zero on a baseline outside (0, 1) or an unknown command", () => {
    expect(
      run(["ab-test", "--baseline", "33", "--effect-pp", "1", "--weekly", "10"])
        .code,
    ).not.toBe(0);
    expect(run(["nope"]).code).not.toBe(0);
  });
});
