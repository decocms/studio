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
  | "fcfg"
  | "chan"
  | "uph";

export function generatePrefixedId(prefix: IdPrefixes) {
  return `${prefix}_${nanoid()}`;
}
