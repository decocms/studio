// Step 2: extend Bun's expect with jest-dom matchers and register RTL cleanup.
// Must run AFTER test-setup.ts so happy-dom is already active.
import { afterEach, expect } from "bun:test";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);

afterEach(() => {
  cleanup();
});
