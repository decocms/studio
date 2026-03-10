import { Span } from "@opentelemetry/api";
import type { TimingVariables } from "hono/timing";
import type { MeshContext } from "../core/mesh-context";

// Define Hono variables type
type Variables = TimingVariables & {
  meshContext: MeshContext;
  rootSpan: Span;
};

export type Env = { Variables: Variables };
