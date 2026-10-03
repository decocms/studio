import type { ConformanceContext } from "../context";

/** One black-box check of a content-protocol endpoint. */
export interface ConformanceCase {
  /** A stable id, such as `apply/atomic`. */
  id: string;
  title: string;
  run(ctx: ConformanceContext): Promise<void>;
}
