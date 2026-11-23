import { setupComponentTest } from "../../../../test/setup"; // happy-dom + jest-dom matchers
setupComponentTest();
import { afterEach, describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { getFastModel } from "@decocms/shared/sdk";
import {
  CLAUDE_OPUS,
  CLAUDE_SONNET,
} from "@decocms/shared/sdk/lib/claude-lineup";
import {
  canonicalModelId,
  defaultShortlistFor,
  groupByTier,
  ModelTierSection,
  pickBrowseModels,
  readShortlist,
} from "./decopilot";
import type { AiProviderModel } from "../../../hooks/collections/use-ai-providers";

function makeModel(overrides: Partial<AiProviderModel> = {}): AiProviderModel {
  return {
    providerId: "anthropic",
    modelId: "anthropic/claude-sonnet-5",
    title: "Anthropic: Claude Sonnet 5",
    description: null,
    logo: null,
    capabilities: ["text"],
    limits: null,
    costs: null,
    ...overrides,
  };
}

describe("ModelTierSection", () => {
  it("renders nothing for an empty tier", () => {
    const { container } = render(
      <ModelTierSection
        label="Smarter"
        models={[]}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders each model as a focusable, keyboard-operable button", () => {
    const model = makeModel();
    const { getByRole } = render(
      <ModelTierSection
        label="Smarter"
        models={[model]}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );
    // A real <button> — not a div with onClick — is what makes the row
    // reachable via Tab and activatable via Enter/Space for keyboard users.
    const row = getByRole("button", { name: /Claude Sonnet 5/ });
    expect(row).toHaveAttribute("type", "button");
  });

  it("calls onSelect with the clicked model", () => {
    const onSelect = mock((_m: AiProviderModel) => {});
    const model = makeModel();
    const { getByRole } = render(
      <ModelTierSection
        label="Smarter"
        models={[model]}
        onSelect={onSelect}
        onHover={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: /Claude Sonnet 5/ }));
    expect(onSelect).toHaveBeenCalledWith(model);
  });

  it("calls onHover when the row receives keyboard focus, not just a mouse hover", () => {
    const onHover = mock((_m: AiProviderModel) => {});
    const model = makeModel();
    const { getByRole } = render(
      <ModelTierSection
        label="Smarter"
        models={[model]}
        onSelect={() => {}}
        onHover={onHover}
      />,
    );
    // Keyboard users tabbing through rows never trigger onMouseEnter, so the
    // details panel would otherwise stay blank until Enter is pressed.
    fireEvent.focus(getByRole("button", { name: /Claude Sonnet 5/ }));
    expect(onHover).toHaveBeenCalledWith(model);
  });
});

describe("pickBrowseModels", () => {
  const shortlisted = makeModel({ modelId: "anthropic/claude-sonnet-5" });
  const other = makeModel({
    modelId: "openai/gpt-5.3-codex",
    title: "OpenAI: GPT-5.3 Codex",
  });
  const shortlistSet = new Set([shortlisted.modelId]);

  it("shows only the shortlist when there is no search term", () => {
    expect(pickBrowseModels([shortlisted, other], shortlistSet, "")).toEqual([
      shortlisted,
    ]);
  });

  it("searches the full catalog even when the match isn't shortlisted", () => {
    expect(
      pickBrowseModels([shortlisted, other], shortlistSet, "gpt-5.3"),
    ).toEqual([shortlisted, other]);
  });

  it("falls back to the full catalog when the shortlist is empty", () => {
    expect(pickBrowseModels([shortlisted, other], new Set(), "")).toEqual([
      shortlisted,
      other,
    ]);
  });
});

const fastDefault = getFastModel("openrouter") ?? "";

function catalogModel(modelId: string, title: string): AiProviderModel {
  return makeModel({ modelId, title });
}

// Listed out of order so the grouping, not the input, decides what leads.
const catalog = [
  catalogModel("meta-llama/llama-4-maverick", "Meta: Llama 4 Maverick"),
  catalogModel("anthropic/claude-sonnet-4.6", "Anthropic: Claude Sonnet 4.6"),
  catalogModel("anthropic/claude-haiku-4.5", "Anthropic: Claude Haiku 4.5"),
  catalogModel("openai/gpt-5.3-codex", "OpenAI: GPT-5.3 Codex"),
  catalogModel(CLAUDE_SONNET.openrouter, "Anthropic: Claude Sonnet Current"),
  catalogModel("google/gemini-2.5-flash", "Google: Gemini 2.5 Flash"),
  catalogModel("anthropic/claude-opus-4.8", "Anthropic: Claude Opus 4.8"),
  catalogModel(fastDefault, "Fast default"),
  catalogModel(CLAUDE_OPUS.openrouter, "Anthropic: Claude Opus Current"),
  catalogModel(
    `${CLAUDE_OPUS.openrouter}:extended`,
    "Anthropic: Claude Opus Current (extended)",
  ),
];

const ids = (models: AiProviderModel[]) => models.map((m) => m.modelId);

describe("groupByTier", () => {
  it("reads a fast default from the shared preference list", () => {
    expect(fastDefault).not.toBe("");
  });

  it("puts the current Claude lineup at the head of Smarter, older Claude after it", () => {
    expect(ids(groupByTier(catalog).smarter)).toEqual([
      CLAUDE_OPUS.openrouter,
      `${CLAUDE_OPUS.openrouter}:extended`,
      CLAUDE_SONNET.openrouter,
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-5.3-codex",
    ]);
  });

  it("puts the shared fast default at the head of Faster", () => {
    expect(ids(groupByTier(catalog).faster)).toEqual([
      fastDefault,
      "anthropic/claude-haiku-4.5",
    ]);
  });

  it("keeps every model in exactly one group", () => {
    const groups = groupByTier(catalog);
    expect(ids(groups.cheaper)).toEqual(["google/gemini-2.5-flash"]);
    expect(ids(groups.other)).toEqual(["meta-llama/llama-4-maverick"]);
    const grouped = Object.values(groups).flatMap(ids);
    expect(grouped.toSorted()).toEqual(ids(catalog).toSorted());
  });
});

describe("default shortlist", () => {
  it("holds the current lineup, the fast default and the older Claude models", () => {
    const shortlist = defaultShortlistFor([]);
    for (const modelId of [
      CLAUDE_OPUS.openrouter,
      CLAUDE_SONNET.openrouter,
      fastDefault,
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
    ]) {
      expect(shortlist.has(modelId)).toBe(true);
    }
  });

  it("browses an OpenRouter catalog with the current lineup first", () => {
    const browsed = pickBrowseModels(catalog, defaultShortlistFor(catalog), "");
    expect(ids(groupByTier(browsed).smarter)).toEqual([
      CLAUDE_OPUS.openrouter,
      CLAUDE_SONNET.openrouter,
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-5.3-codex",
    ]);
  });

  it("adds nothing for a catalog already in the OpenRouter form", () => {
    expect([...defaultShortlistFor(catalog)]).toEqual([
      ...defaultShortlistFor([]),
    ]);
  });
});

describe("stored shortlist", () => {
  const keyId = "aik_example";
  const storageKey = `studio:model-shortlist:${keyId}`;

  afterEach(() => {
    localStorage.removeItem(storageKey);
  });

  it("reads nothing when the user never changed the shortlist", () => {
    expect(readShortlist(keyId)).toBeNull();
  });

  it("returns a stored shortlist as stored, without adding the defaults", () => {
    const stored = ["anthropic/claude-opus-4.8", "openai/gpt-5.3-codex"];
    localStorage.setItem(storageKey, JSON.stringify(stored));
    const shortlist = readShortlist(keyId) ?? new Set<string>();
    expect([...shortlist]).toEqual(stored);
    expect(ids(pickBrowseModels(catalog, shortlist, "")).toSorted()).toEqual(
      stored.toSorted(),
    );
  });

  it("still finds a model outside a stored shortlist by search", () => {
    localStorage.setItem(storageKey, JSON.stringify(["openai/gpt-5.3-codex"]));
    const shortlist = readShortlist(keyId) ?? new Set<string>();
    expect(pickBrowseModels(catalog, shortlist, "opus")).toEqual(catalog);
  });

  it("matches a stored shortlist by exact id, never by the id's other forms", () => {
    localStorage.setItem(storageKey, JSON.stringify([CLAUDE_OPUS.openrouter]));
    const shortlist = readShortlist(keyId) ?? new Set<string>();
    expect(shortlist.has(CLAUDE_OPUS.anthropic)).toBe(false);
    expect(shortlist.has(CLAUDE_OPUS.copilot)).toBe(false);
  });

  it("reads nothing when the stored value is unreadable", () => {
    localStorage.setItem(storageKey, "{not json");
    expect(readShortlist(keyId)).toBeNull();
  });
});

// Ids as each direct catalog spells them: no vendor prefix, and "-" or "." between version numbers.
const directCatalogs = {
  anthropic: [
    catalogModel(CLAUDE_OPUS.anthropic, "Claude Opus Current"),
    catalogModel(CLAUDE_SONNET.anthropic, "Claude Sonnet Current"),
    catalogModel("claude-opus-4-8", "Claude Opus 4.8"),
    catalogModel("claude-sonnet-4-6", "Claude Sonnet 4.6"),
    catalogModel("claude-haiku-4-5-20251001", "Claude Haiku 4.5"),
    catalogModel("claude-opus-4-1-20250805", "Claude Opus 4.1"),
    catalogModel("claude-sonnet-5", "Claude Sonnet 5"),
  ],
  copilot: [
    catalogModel(CLAUDE_OPUS.copilot, "Claude Opus Current"),
    catalogModel(CLAUDE_SONNET.copilot, "Claude Sonnet Current"),
    catalogModel("claude-opus-4.8", "Claude Opus 4.8"),
    catalogModel("claude-haiku-4.5", "Claude Haiku 4.5"),
    catalogModel("gpt-5.3-codex", "GPT-5.3 Codex"),
    catalogModel("gpt-5.1", "GPT-5.1"),
  ],
  google: [
    catalogModel("gemini-2.5-pro", "Gemini 2.5 Pro"),
    catalogModel("gemini-3-pro-preview", "Gemini 3 Pro Preview"),
    catalogModel("gemini-3-flash-preview", "Gemini 3 Flash Preview"),
    catalogModel("gemini-2.5-flash", "Gemini 2.5 Flash"),
    catalogModel("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"),
    catalogModel("gemma-3-27b-it", "Gemma 3 27B"),
  ],
};

function tiersOf(models: AiProviderModel[]) {
  const groups = groupByTier(models);
  return {
    smarter: ids(groups.smarter),
    faster: ids(groups.faster),
    cheaper: ids(groups.cheaper),
    other: ids(groups.other),
  };
}

describe("canonicalModelId", () => {
  it("gives every id form of a lineup model the same key", () => {
    for (const lineup of [CLAUDE_OPUS, CLAUDE_SONNET]) {
      const keys = new Set(Object.values(lineup).map(canonicalModelId));
      expect(keys.size).toBe(1);
    }
  });

  it("drops the vendor path and reads '.' and '-' alike", () => {
    expect(canonicalModelId("openai/gpt-5.3-codex")).toBe("gpt-5-3-codex");
    expect(canonicalModelId("gpt-5.3-codex")).toBe("gpt-5-3-codex");
    expect(canonicalModelId("gateway/openai/gpt-5.3-codex")).toBe(
      "gpt-5-3-codex",
    );
  });
});

describe("direct-provider catalogs", () => {
  it("groups direct Anthropic ids like their OpenRouter forms", () => {
    expect(tiersOf(directCatalogs.anthropic)).toEqual({
      smarter: [
        CLAUDE_OPUS.anthropic,
        CLAUDE_SONNET.anthropic,
        "claude-opus-4-8",
        "claude-sonnet-4-6",
      ],
      faster: ["claude-haiku-4-5-20251001"],
      cheaper: [],
      other: ["claude-opus-4-1-20250805", "claude-sonnet-5"],
    });
  });

  it("groups Copilot-form ids like their OpenRouter forms", () => {
    expect(tiersOf(directCatalogs.copilot)).toEqual({
      smarter: [
        CLAUDE_OPUS.copilot,
        CLAUDE_SONNET.copilot,
        "claude-opus-4.8",
        "gpt-5.3-codex",
      ],
      faster: ["claude-haiku-4.5"],
      cheaper: [],
      other: ["gpt-5.1"],
    });
  });

  it("groups direct Google ids like their OpenRouter forms", () => {
    expect(tiersOf(directCatalogs.google)).toEqual({
      smarter: ["gemini-2.5-pro", "gemini-3-pro-preview"],
      faster: ["gemini-3-flash-preview"],
      cheaper: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
      other: ["gemma-3-27b-it"],
    });
  });

  it("shortlists a direct catalog's own ids by default", () => {
    const shortlisted = (models: AiProviderModel[]) =>
      ids(pickBrowseModels(models, defaultShortlistFor(models), ""));
    expect(shortlisted(directCatalogs.anthropic)).toEqual([
      CLAUDE_OPUS.anthropic,
      CLAUDE_SONNET.anthropic,
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]);
    expect(shortlisted(directCatalogs.copilot)).toEqual([
      CLAUDE_OPUS.copilot,
      CLAUDE_SONNET.copilot,
      "claude-opus-4.8",
      "claude-haiku-4.5",
      "gpt-5.3-codex",
    ]);
    expect(shortlisted(directCatalogs.google)).toEqual([
      "gemini-2.5-pro",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
  });
});

describe("ids a tier rule must not claim", () => {
  const tierOf = (modelId: string, capabilities = ["text"]) => {
    const groups = groupByTier([
      makeModel({
        modelId,
        title: modelId,
        capabilities: capabilities as AiProviderModel["capabilities"],
      }),
    ]);
    return Object.entries(groups).find(([, models]) => models.length > 0)?.[0];
  };

  it("leaves an id that only starts like a rule in Other", () => {
    for (const modelId of [
      `${CLAUDE_OPUS.anthropic}0514`,
      "claude-opus-4-80",
      "gemini-3-production",
      "gpt-oss-120bx",
      "mistral-smallest",
    ]) {
      expect(tierOf(modelId)).toBe("other");
    }
  });

  it("leaves an id that only contains a rule in Other", () => {
    for (const modelId of [
      `anthropic.${CLAUDE_OPUS.anthropic}-v1:0`,
      `tuned-${CLAUDE_SONNET.copilot}`,
      "my-gemini-2.5-flash",
      "text-embedding-3-large",
    ]) {
      expect(tierOf(modelId)).toBe("other");
    }
  });

  it("leaves a neighbouring version or sibling model in Other", () => {
    for (const modelId of [
      "claude-opus-4-1-20250805",
      "claude-opus-4-20250514",
      "claude-sonnet-5",
      "gemini-2.5-pro-preview",
      "gemini-3.1-pro-preview",
      "gpt-5.1-codex-max",
      "gpt-oss-20b",
    ]) {
      expect(tierOf(modelId)).toBe("other");
    }
  });

  it("leaves an image generator in Other next to its chat sibling", () => {
    const image = ["text", "image"];
    expect(tierOf("google/gemini-3-pro-preview")).toBe("smarter");
    expect(tierOf("google/gemini-3-pro-image", image)).toBe("other");
    expect(tierOf("google/gemini-3-pro-image-preview", image)).toBe("other");
    expect(tierOf("google/gemini-2.5-flash")).toBe("cheaper");
    expect(tierOf("google/gemini-2.5-flash-image", image)).toBe("other");
    expect(tierOf("gemini-2.5-flash-image", image)).toBe("other");
  });
});

describe("OpenRouter catalog", () => {
  // Real ids from the public catalog, each with the group it had before the canonical rule.
  const expected: Array<[string, string]> = [
    ["anthropic/claude-opus-4.8:batch", "smarter"],
    ["anthropic/claude-sonnet-4.6", "smarter"],
    ["cohere/command-a-plus", "smarter"],
    ["cohere/command-r-plus-08-2024", "smarter"],
    ["google/gemini-2.5-pro", "smarter"],
    ["openai/gpt-5.3-codex", "smarter"],
    ["anthropic/claude-haiku-4.5", "faster"],
    ["google/gemini-3-flash-preview:batch", "faster"],
    ["mistralai/codestral-2508", "faster"],
    ["mistralai/mistral-large-4-0", "faster"],
    ["mistralai/mistral-medium-3-5", "faster"],
    ["mistralai/mistral-medium-3.1", "faster"],
    ["openai/gpt-5.1-codex-mini", "faster"],
    ["qwen/qwen3.5-flash-02-23", "faster"],
    ["cohere/command-r-08-2024", "cheaper"],
    ["cohere/command-r7b-12-2024", "cheaper"],
    ["deepseek/deepseek-v3.1-terminus", "cheaper"],
    ["deepseek/deepseek-v3.2-exp", "cheaper"],
    ["google/gemini-2.5-flash-lite", "cheaper"],
    ["google/gemma-4-31b-it:free", "cheaper"],
    ["mistralai/mistral-small-3.2-24b-instruct", "cheaper"],
    ["mistralai/pixtral-large-2502", "cheaper"],
    ["openai/gpt-oss-120b:batch", "cheaper"],
    ["anthropic/claude-opus-4.7", "other"],
    ["anthropic/claude-sonnet-5", "other"],
    ["deepseek/deepseek-v4-flash", "other"],
    ["google/gemini-2.5-pro-preview", "other"],
    ["google/gemini-3.1-pro-preview", "other"],
    ["mistralai/mistral-nemo", "other"],
    ["openai/gpt-5.1-codex-max", "other"],
    ["openai/gpt-oss-20b", "other"],
    ["x-ai/grok-4.3", "other"],
  ];

  it("keeps every id in the group it had", () => {
    const groups = groupByTier(
      expected.map(([modelId]) => catalogModel(modelId, modelId)),
    );
    const actual = Object.entries(groups).flatMap(([tier, models]) =>
      models.map((m): [string, string] => [m.modelId, tier]),
    );
    expect(actual.toSorted()).toEqual(expected.toSorted());
  });
});
