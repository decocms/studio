// Test runtime setup: registers happy-dom globals and the
// @testing-library/jest-dom custom matchers for Bun's test runner.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { expect } from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";

GlobalRegistrator.register();
expect.extend(matchers as Parameters<typeof expect.extend>[0]);
