/**
 * `home/users/<id>/` belongs to one member: their personal memory and notes,
 * loaded only into their own chats. Only that member may change it; they and
 * org admins may read it. Everything else in the org filesystem stays open to
 * every member (see the ACL note in routes/org-fs.ts).
 */

import { normalizeFsPath } from "./org-fs-path";

const HOME_VOLUME = "home";
const USERS_DIR = "users";

export interface Caller {
  userId: string;
  isAdmin: boolean;
}

/** Owner id of a path inside `home/users/<id>/`; `""` for the `users` folder itself; null elsewhere. */
function personalOwner(volume: string, path: string): string | null {
  if (volume !== HOME_VOLUME) return null;
  const [top, owner] = normalizeFsPath(path).split("/");
  return top === USERS_DIR ? (owner ?? "") : null;
}

export function canReadPersonal(
  volume: string,
  path: string,
  caller: Caller,
): boolean {
  const owner = personalOwner(volume, path);
  return !owner || owner === caller.userId || caller.isAdmin;
}

/** Deleting or moving the `users` folder would take every member's folder with it. */
export function canWritePersonal(
  volume: string,
  path: string,
  caller: Caller,
): boolean {
  const owner = personalOwner(volume, path);
  return owner === null || owner === caller.userId;
}
