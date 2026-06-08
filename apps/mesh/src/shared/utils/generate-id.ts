import { nanoid } from "nanoid";

type IdPrefixes =
  | "conn"
  | "audit"
  | "log"
  | "vir"
  | "virc"
  | "agg"
  | "dtok"
  | "thrd"
  | "obs"
  | "msg"
  | "tag"
  | "mtag"
  | "proj"
  | "ppc"
  | "pc"
  | "dash"
  | "aik"
  | "sec"
  | "vpc"
  | "tile"
  | "fcfg";

export function generatePrefixedId(prefix: IdPrefixes) {
  return `${prefix}_${nanoid()}`;
}
