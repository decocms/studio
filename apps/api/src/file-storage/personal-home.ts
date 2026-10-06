/**
 * `home/users/<id>/` belongs to one member: their personal memory and notes,
 * loaded only into their own chats. Only that member may read or change it,
 * admins included. Everything else in the org filesystem stays open to every
 * member (see the ACL note in routes/org-fs.ts).
 */

import { normalizeFsPath } from "./org-fs-path";

const HOME_VOLUME = "home";
const USERS_DIR = "users";

/** Owner id of a path inside `home/users/<id>/`; `""` for the `users` folder itself; null elsewhere. */
function personalOwner(volume: string, path: string): string | null {
  if (volume !== HOME_VOLUME) return null;
  const [top, owner] = normalizeFsPath(path).split("/");
  return top === USERS_DIR ? (owner ?? "") : null;
}

export function canReadPersonal(
  volume: string,
  path: string,
  userId: string,
): boolean {
  const owner = personalOwner(volume, path);
  return !owner || owner === userId;
}

/** Deleting or moving the `users` folder would take every member's folder with it. */
export function canWritePersonal(
  volume: string,
  path: string,
  userId: string,
): boolean {
  const owner = personalOwner(volume, path);
  return owner === null || owner === userId;
}
