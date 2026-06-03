import { Span } from "@opentelemetry/api";
import type { TimingVariables } from "hono/timing";
import type { StudioContext } from "../core/studio-context";

// Define Hono variables type
type Variables = TimingVariables & {
  meshContext: StudioContext;
  rootSpan: Span;
};

export type Env = { Variables: Variables };
