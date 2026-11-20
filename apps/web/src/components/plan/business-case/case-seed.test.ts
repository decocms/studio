import { describe, expect, it } from "bun:test";
import {
  BUSINESS_CASE_CARD_KEYS,
  BUSINESS_CASE_LIMITS,
} from "@decocms/shared/business-case";
import { readCaseSeed, seedTitle, writeCaseSeed } from "./case-seed.ts";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  };
}

const PATH = "plans/cases/thread-1.json";

describe("case seed", () => {
  it("draws the goal and the request with every card empty", () => {
    const storage = memoryStorage();
    writeCaseSeed(storage, PATH, {
      objective: "  Vender mais no celular ",
      request: "quero mexer na busca\nprincipalmente no celular",
    });
    const value = readCaseSeed(storage, PATH);
    expect(value?.title).toBe("quero mexer na busca");
    expect(value?.objective).toBe("Vender mais no celular");
    expect(value?.request.text).toBe(
      "quero mexer na busca\nprincipalmente no celular",
    );
    expect(value?.status).toBe("framing");
    expect(Object.values(value?.cards ?? {}).map((c) => c.state)).toEqual(
      Array(BUSINESS_CASE_CARD_KEYS.length).fill("empty"),
    );
  });

  it("titles the case with the guided intro's title when there is one", () => {
    const storage = memoryStorage();
    writeCaseSeed(storage, PATH, {
      objective: null,
      request: "quero mexer na busca",
      title: " Sugerir termos quando a busca não acha nada ",
    });
    expect(readCaseSeed(storage, PATH)?.title).toBe(
      "Sugerir termos quando a busca não acha nada",
    );
    writeCaseSeed(storage, PATH, {
      objective: null,
      request: "quero mexer na busca",
      title: "  ",
    });
    expect(readCaseSeed(storage, PATH)?.title).toBe("quero mexer na busca");
  });

  it("keeps an empty goal as null and is per path", () => {
    const storage = memoryStorage();
    writeCaseSeed(storage, PATH, { objective: "  ", request: "frete" });
    expect(readCaseSeed(storage, PATH)?.objective).toBeNull();
    expect(readCaseSeed(storage, "plans/cases/other.json")).toBeNull();
  });

  it("ignores a seed that is not JSON or not a seed", () => {
    const storage = memoryStorage();
    storage.setItem(`studio:plan-case-seed:${PATH}`, "{not json");
    expect(readCaseSeed(storage, PATH)).toBeNull();
    storage.setItem(
      `studio:plan-case-seed:${PATH}`,
      JSON.stringify({ title: "", request: "x", objective: null }),
    );
    expect(readCaseSeed(storage, PATH)).toBeNull();
  });

  it("cuts long requests to the card limits", () => {
    const long = "a".repeat(BUSINESS_CASE_LIMITS.text + 50);
    expect(seedTitle(long)).toHaveLength(BUSINESS_CASE_LIMITS.title);
    const storage = memoryStorage();
    writeCaseSeed(storage, PATH, { objective: null, request: long });
    expect(readCaseSeed(storage, PATH)?.request.text).toHaveLength(
      BUSINESS_CASE_LIMITS.text,
    );
  });

  it("survives a storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(() =>
      writeCaseSeed(broken, PATH, { objective: null, request: "x" }),
    ).not.toThrow();
    expect(readCaseSeed(broken, PATH)).toBeNull();
  });
});
