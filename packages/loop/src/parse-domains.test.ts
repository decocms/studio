import { describe, expect, it } from "bun:test";
import { parseDomains } from "./parse-domains";

describe("parseDomains", () => {
  it("parses a standard row", () => {
    const md = "| [i18n](./i18n/DOMAIN.md) | `apps/web/src/**` | @alice |";
    expect(parseDomains(md)).toEqual([{ name: "i18n", owner: "alice" }]);
  });

  it("owner @ prefix is optional", () => {
    const md = "| [x](./x/DOMAIN.md) | `p/**` | bob |";
    expect(parseDomains(md)).toEqual([{ name: "x", owner: "bob" }]);
  });

  it("pipes inside the paths cell do not shift the owner column", () => {
    const md = "| [x](./x/DOMAIN.md) | `a/**|b/**` | @carol |";
    expect(parseDomains(md)).toEqual([{ name: "x", owner: "carol" }]);
  });

  it("ignores header, separator, prose, and malformed rows", () => {
    const md = [
      "# Domains",
      "| Domain | Paths | Owner |",
      "| ------ | ----- | ----- |",
      "| [ok](./ok/DOMAIN.md) | `p/**` | @dan |",
      "| [broken](./broken/DOMAIN.md) | missing owner cell",
      "not a table row at all",
    ].join("\n");
    expect(parseDomains(md)).toEqual([{ name: "ok", owner: "dan" }]);
  });

  it("skips domain names unsafe as path/branch components", () => {
    const md = "| [../evil](./e/DOMAIN.md) | `p/**` | @eve |";
    expect(parseDomains(md)).toEqual([]);
  });

  it("returns empty for an empty index", () => {
    expect(parseDomains("")).toEqual([]);
  });
});
