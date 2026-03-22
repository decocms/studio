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
  | "aik";

export function generatePrefixedId(prefix: IdPrefixes) {
  return `${prefix}_${nanoid()}`;
}

export function generateConnectionId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20)
    .replace(/_+$/g, "");

  const suffix = nanoid();
  return slug ? `conn_${slug}_${suffix}` : `conn_${suffix}`;
}
