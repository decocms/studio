import { describe, expect, test } from "bun:test";
import { BRAZIL_STATES } from "./brazil-states";
import { BRAZIL_COUNTRY_CODE, COUNTRIES } from "./countries";
import {
  isLocationShape,
  mergeLocationValue,
  readLocationValue,
} from "./location-value";

describe("readLocationValue", () => {
  test("returns empty strings for non-object input", () => {
    expect(readLocationValue(null)).toEqual({
      city: "",
      regionCode: "",
      country: "",
    });
    expect(readLocationValue("BR")).toEqual({
      city: "",
      regionCode: "",
      country: "",
    });
    expect(readLocationValue(["BR"])).toEqual({
      city: "",
      regionCode: "",
      country: "",
    });
  });

  test("reads known string fields and ignores extras", () => {
    expect(
      readLocationValue({
        city: "Sao Paulo",
        regionCode: "SP",
        country: "BR",
        coordinates: "-23,-46,2000",
      }),
    ).toEqual({ city: "Sao Paulo", regionCode: "SP", country: "BR" });
  });

  test("ignores non-string field values", () => {
    expect(readLocationValue({ country: 55, city: null })).toEqual({
      city: "",
      regionCode: "",
      country: "",
    });
  });
});

describe("mergeLocationValue", () => {
  const base = { city: "Sao Paulo", regionCode: "SP", country: "BR" };

  test("drops empty fields so the matcher only sees set keys", () => {
    expect(mergeLocationValue(base, { regionCode: "", city: "" })).toEqual({
      country: "BR",
    });
  });

  test("overlays the update over the current value", () => {
    expect(mergeLocationValue(base, { country: "US" })).toEqual({
      city: "Sao Paulo",
      regionCode: "SP",
      country: "US",
    });
  });

  test("returns an empty object when nothing is set", () => {
    expect(
      mergeLocationValue(
        { city: "", regionCode: "", country: "" },
        { country: "" },
      ),
    ).toEqual({});
  });
});

describe("isLocationShape", () => {
  test("matches exactly {city, regionCode, country} in any key order", () => {
    expect(isLocationShape({ city: {}, regionCode: {}, country: {} })).toBe(
      true,
    );
    expect(isLocationShape({ country: {}, city: {}, regionCode: {} })).toBe(
      true,
    );
  });

  test("rejects the Map branch and merged/partial shapes", () => {
    expect(isLocationShape({ coordinates: {} })).toBe(false);
    expect(
      isLocationShape({
        city: {},
        regionCode: {},
        country: {},
        coordinates: {},
      }),
    ).toBe(false);
    expect(isLocationShape({ city: {}, country: {} })).toBe(false);
    expect(isLocationShape(undefined)).toBe(false);
  });
});

describe("COUNTRIES dataset", () => {
  test("includes Brazil under the code Cloudflare emits", () => {
    expect(COUNTRIES.some((c) => c.code === BRAZIL_COUNTRY_CODE)).toBe(true);
    expect(BRAZIL_COUNTRY_CODE).toBe("BR");
  });

  test("codes are unique, two-char cf-ipcountry values", () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      // ISO alpha-2 (letters) plus Cloudflare specials like "T1" (letter+digit).
      expect(code).toMatch(/^[A-Z][A-Z0-9]$/);
    }
  });

  test("includes Cloudflare special codes XX (unknown) and T1 (Tor)", () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(codes).toContain("XX");
    expect(codes).toContain("T1");
  });

  test("every country has a non-empty name", () => {
    for (const c of COUNTRIES) {
      expect(c.name.length).toBeGreaterThan(0);
    }
  });
});

describe("BRAZIL_STATES dataset", () => {
  test("has all 27 federative units with unique codes", () => {
    expect(BRAZIL_STATES).toHaveLength(27);
    const codes = BRAZIL_STATES.map((s) => s.code);
    expect(new Set(codes).size).toBe(27);
    expect(codes).toContain("SP");
    expect(codes).toContain("DF");
  });

  test("region codes match cf-region-code shape (2-letter, no prefix)", () => {
    for (const s of BRAZIL_STATES) {
      expect(s.code).toMatch(/^[A-Z]{2}$/);
    }
  });

  test("every state carries renderable path geometry", () => {
    for (const s of BRAZIL_STATES) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.d.startsWith("M ")).toBe(true);
      expect(s.gTransform).toMatch(/^matrix\(/);
    }
  });
});

describe("mergeLocationValue – drops every empty field", () => {
  test("clearing all fields yields an empty object", () => {
    expect(
      mergeLocationValue(
        { city: "Sao Paulo", regionCode: "SP", country: "BR" },
        { city: "", regionCode: "", country: "" },
      ),
    ).toEqual({});
  });
});
