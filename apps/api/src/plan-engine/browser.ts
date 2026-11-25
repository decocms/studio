import type { UxDevice } from "./types.ts";

/**
 * User-agent de celular de verdade. Sem ele muita loja serve o layout de desktop
 * espremido, e o print "do celular" mente.
 */
export const USER_AGENTS: Record<UxDevice, string> = {
  mobile:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  desktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};
