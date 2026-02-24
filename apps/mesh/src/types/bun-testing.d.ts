// Extend Bun's test Matchers with @testing-library/jest-dom matchers
// so toBeInTheDocument(), toHaveTextContent(), etc. are properly typed.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
import type { expect } from "bun:test";

export {};

declare module "bun:test" {
  interface Matchers<T = unknown>
    extends TestingLibraryMatchers<
      ReturnType<typeof expect.stringContaining>,
      T
    > {}
}
