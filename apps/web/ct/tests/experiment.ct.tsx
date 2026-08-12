import { expect, test } from "@playwright/experimental-ct-react";
import { ExperimentHarness } from "../harness/experiment-harness";

const FLAG = "experiment-pipeline-check";

test("renders the assigned variant key", async ({ mount }) => {
  const component = await mount(
    <ExperimentHarness flag={FLAG} flags={{ [FLAG]: "test" }} />,
  );

  await expect(component).toHaveText("test");
});

test("reads unassigned when the flag is absent", async ({ mount }) => {
  const component = await mount(
    <ExperimentHarness flag={FLAG} flags={{ "other-flag": true }} />,
  );

  await expect(component).toHaveText("(unassigned)");
});

test("reads unassigned for a boolean (non-multivariate) flag", async ({
  mount,
}) => {
  const component = await mount(
    <ExperimentHarness flag={FLAG} flags={{ [FLAG]: true }} />,
  );

  await expect(component).toHaveText("(unassigned)");
});
