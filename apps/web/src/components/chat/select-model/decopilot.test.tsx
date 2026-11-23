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
  groupByTier,
  initialShortlist,
  ModelTierSection,
  pickBrowseModels,
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

describe("initialShortlist", () => {
  const keyId = "aik_example";
  const storageKey = `studio:model-shortlist:${keyId}`;

  afterEach(() => {
    localStorage.removeItem(storageKey);
  });

  it("defaults to the current lineup, the fast default and the older Claude models", () => {
    const shortlist = initialShortlist(keyId);
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

  it("browses the default shortlist with the current lineup first", () => {
    const browsed = pickBrowseModels(catalog, initialShortlist(undefined), "");
    expect(ids(groupByTier(browsed).smarter)).toEqual([
      CLAUDE_OPUS.openrouter,
      CLAUDE_SONNET.openrouter,
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-4.6",
      "openai/gpt-5.3-codex",
    ]);
  });

  it("returns a stored shortlist as stored, without adding the defaults", () => {
    const stored = ["anthropic/claude-opus-4.8", "openai/gpt-5.3-codex"];
    localStorage.setItem(storageKey, JSON.stringify(stored));
    expect([...initialShortlist(keyId)]).toEqual(stored);
    expect(
      ids(pickBrowseModels(catalog, initialShortlist(keyId), "")).toSorted(),
    ).toEqual(stored.toSorted());
  });

  it("still finds a model outside a stored shortlist by search", () => {
    localStorage.setItem(storageKey, JSON.stringify(["openai/gpt-5.3-codex"]));
    expect(pickBrowseModels(catalog, initialShortlist(keyId), "opus")).toEqual(
      catalog,
    );
  });

  it("falls back to the defaults when the stored value is unreadable", () => {
    localStorage.setItem(storageKey, "{not json");
    expect(initialShortlist(keyId).has(CLAUDE_OPUS.openrouter)).toBe(true);
  });
});
