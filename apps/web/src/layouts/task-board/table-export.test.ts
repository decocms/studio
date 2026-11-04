import { describe, expect, it } from "bun:test";
import { sheetName, tableSheet } from "./table-export";

describe("sheetName", () => {
  it("drops characters Excel refuses and caps the length at 31", () => {
    expect(sheetName("Top orgs [3 months]: a/b")).toBe(
      "Top orgs  3 months   a b",
    );
    expect(sheetName("x".repeat(40))).toHaveLength(31);
  });

  it("falls back when nothing usable is left", () => {
    expect(sheetName("[]")).toBe("Sheet1");
  });
});

describe("tableSheet", () => {
  it("puts a bold header first and keeps numbers, text and empties as they are", () => {
    expect(
      tableSheet(
        ["Org", "USD"],
        [
          ["acme", 1.5],
          ["beta", null],
        ],
      ),
    ).toEqual([
      [
        { value: "Org", fontWeight: "bold" },
        { value: "USD", fontWeight: "bold" },
      ],
      ["acme", 1.5],
      ["beta", null],
    ]);
  });

  it("turns ISO timestamps into dates so Excel sorts them as dates", () => {
    const [, row] = tableSheet(["Last turn"], [["2026-10-30T14:10:37.000Z"]]);
    expect(row?.[0]).toEqual(new Date("2026-10-30T14:10:37.000Z"));
  });

  it("writes only the header for an empty table", () => {
    expect(tableSheet(["Org"], [])).toHaveLength(1);
  });
});
