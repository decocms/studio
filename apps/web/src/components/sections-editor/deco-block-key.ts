export {
  assertSafeDecoBlockKey,
  blockKeyToFileStem,
  decoBlockFilePath,
  decoBlockKeyFromFileStem,
} from "@decocms/shared/decofile";
import { decoBlockFilePath } from "@decocms/shared/decofile";

/** Path shape used by the sandbox file explorer deep-link (`openPath`). */
export function decoBlockFileViewPath(blockKey: string): string {
  return `/${decoBlockFilePath(blockKey)}`;
}
