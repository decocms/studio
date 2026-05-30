import { getIdleStatus } from "../activity";
import { jsonResponse } from "./body-parser";

export function makeIdleHandler(): () => Response {
  return () => jsonResponse(getIdleStatus());
}
