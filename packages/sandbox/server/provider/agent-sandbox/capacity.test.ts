import { describe, expect, test } from "bun:test";
import { hasUnschedulablePod } from "./capacity";

describe("hasUnschedulablePod", () => {
  // The exact verdict that failed eight tasks: the scheduler could not place the
  // pod, so the sandbox never became ready and the run died after 180s.
  test("true for a pod the scheduler refused to place", () => {
    expect(
      hasUnschedulablePod({
        items: [
          {
            status: {
              phase: "Pending",
              conditions: [
                {
                  type: "PodScheduled",
                  status: "False",
                  reason: "Unschedulable",
                },
              ],
            },
          },
        ],
      }),
    ).toBe(true);
  });

  // A Pending pod that HAS a node (pulling its image, running an init container)
  // is not a capacity problem — counting it would park runs the cluster could
  // have taken.
  test("false for a Pending pod that was already scheduled", () => {
    expect(
      hasUnschedulablePod({
        items: [
          {
            status: {
              phase: "Pending",
              conditions: [{ type: "PodScheduled", status: "True" }],
            },
          },
        ],
      }),
    ).toBe(false);
  });

  test("false for a running namespace and for an empty list", () => {
    expect(hasUnschedulablePod({ items: [{ status: { phase: "Running" } }] })).toBe(
      false,
    );
    expect(hasUnschedulablePod({ items: [] })).toBe(false);
    expect(hasUnschedulablePod({})).toBe(false);
  });
});
