import { jsonResponse } from "./body-parser";

export function makeScriptsHandler(getScripts: () => string[]) {
  return async (): Promise<Response> => {
    return jsonResponse({ scripts: getScripts() });
  };
}
