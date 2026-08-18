import { describe, expect, test } from "bun:test";
import {
  ENUM_CLEAR_SELECT_VALUE,
  ENUM_EMPTY_SELECT_VALUE,
  enumOptionLabel,
  enumOptionToSelectValue,
  formValueToSelectValue,
  selectValueToEnumOption,
  selectValueToFormValue,
} from "./enum-select-value";

describe("enumOptionToSelectValue", () => {
  test("maps empty string enum to sentinel", () => {
    expect(enumOptionToSelectValue("")).toBe(ENUM_EMPTY_SELECT_VALUE);
  });

  test("stringifies other values", () => {
    expect(enumOptionToSelectValue("website")).toBe("website");
    expect(enumOptionToSelectValue(0)).toBe("0");
  });
});

describe("selectValueToEnumOption", () => {
  test("maps sentinel back to empty string", () => {
    expect(selectValueToEnumOption(ENUM_EMPTY_SELECT_VALUE, ["", "a"])).toBe(
      "",
    );
  });

  test("returns original enum value", () => {
    expect(selectValueToEnumOption("article", ["website", "article"])).toBe(
      "article",
    );
  });
});

describe("formValueToSelectValue", () => {
  test("uses undefined when unset and no empty enum option", () => {
    expect(formValueToSelectValue(undefined, ["website", "article"])).toBe(
      undefined,
    );
  });

  test("uses sentinel when unset and empty enum is allowed", () => {
    expect(formValueToSelectValue(null, ["", "custom"])).toBe(
      ENUM_EMPTY_SELECT_VALUE,
    );
  });
});

describe("selectValueToFormValue", () => {
  test("clear sentinel maps to undefined (unset the field)", () => {
    expect(
      selectValueToFormValue(ENUM_CLEAR_SELECT_VALUE, ["a", "b"]),
    ).toBeUndefined();
  });

  test("empty-string enum still round-trips as empty, not cleared", () => {
    expect(selectValueToFormValue(ENUM_EMPTY_SELECT_VALUE, ["", "a"])).toBe("");
  });

  test("normal value delegates to selectValueToEnumOption", () => {
    expect(selectValueToFormValue("article", ["website", "article"])).toBe(
      "article",
    );
  });
});

describe("enumOptionLabel", () => {
  test("keeps empty option label blank like admin", () => {
    expect(enumOptionLabel("")).toBe("");
    expect(enumOptionLabel("website")).toBe("website");
  });
});
