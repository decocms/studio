import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { CampaignDraftSchema, ReviewSchema } from "./campaign-suggest";
import { PostSchema } from "./post-draft";
import { CatalogueProductSchema, CatalogueTargetSchema } from "./site-tools";
import { boundedText } from "./schema";

/**
 * A size constraint on a model's output is not a cap, it is a rejection.
 *
 * zod throws the whole object away for one overlong field, and because that
 * field is almost always something the prompt told the model to copy verbatim
 * from a tool result, every retry throws it away again for the same reason —
 * `retryGenerateObject` only retries this error class, so all three attempts
 * are spent on an outcome that cannot change. One storefront product
 * description past a guessed number has cost a whole catalogue chunk, four
 * separate times.
 *
 * The rule has been written in prose above these schemas before and broken
 * anyway, so it is asserted here instead. Bound model output with
 * {@link boundedText}, which clamps, or leave it unbounded and cap what is KEPT
 * after the parse. Caps that reject belong on `inputSchema`, where the sender
 * can be told what it did wrong.
 */
const MODEL_OUTPUT_SCHEMAS = {
  CatalogueProductSchema,
  CatalogueTargetSchema,
  CampaignDraftSchema,
  ReviewSchema,
  PostSchema,
} satisfies Record<string, z.ZodType>;

/** The JSON Schema keywords that make a provider's response unparseable. */
const REJECTING = ["maxLength", "minLength", "maxItems", "minItems"];

/**
 * The schema as the AI SDK hands it to a provider.
 *
 * Same options as `zod4Schema` in `@ai-sdk/provider-utils`, which is not a
 * direct dependency here.
 */
function asProviderSees(schema: z.ZodType): string {
  return JSON.stringify(
    z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
  );
}

/**
 * The same schema as an MCP client listing the tool sees it.
 *
 * Several of these double as a tool's `outputSchema`, which is serialized in
 * output mode — and a `transform` is unrepresentable there, so bounding one of
 * these with the obvious `z.string().transform(clamp)` takes down `tools/list`
 * for every client. That is a whole-surface outage caused by a blog schema, and
 * nothing about it is visible from the generation side.
 */
function asMcpClientSees(schema: z.ZodType): string {
  return JSON.stringify(
    z.toJSONSchema(schema, { target: "draft-7", io: "output" }),
  );
}

describe("model-output schemas carry no size constraint", () => {
  for (const [name, schema] of Object.entries(MODEL_OUTPUT_SCHEMAS)) {
    test(`${name} carries no size constraint`, () => {
      const emitted = asProviderSees(schema);
      const found = REJECTING.filter((keyword) => emitted.includes(keyword));
      expect(found).toEqual([]);
    });

    test(`${name} still serializes for a tool listing`, () => {
      expect(() => asMcpClientSees(schema)).not.toThrow();
    });
  }
});

describe("boundedText", () => {
  const Schema = z.object({ description: boundedText(2_048) });

  test("shows the model a plain string, with nothing to reject against", () => {
    expect(asProviderSees(Schema)).not.toContain("maxLength");
  });

  test("clamps a value longer than the bound instead of refusing it", () => {
    const read = Schema.safeParse({ description: "palavra ".repeat(2_000) });
    expect(read.success).toBe(true);
    expect(read.data?.description.length).toBeLessThanOrEqual(2_048);
  });

  test("leaves a value inside the bound exactly as written", () => {
    expect(Schema.parse({ description: "Uma mochila." }).description).toBe(
      "Uma mochila.",
    );
  });
});

/**
 * The failure that prompted all of this: a product description copied out of a
 * storefront, several thousand characters of marketing HTML, rejected the whole
 * catalogue chunk. Ids and image URLs in the same object must survive whole —
 * a clamped URL is broken rather than shortened.
 */
describe("a catalogue entry as a storefront actually reports one", () => {
  const longDescription = `<strong>Mochila</strong> ${"resistente e espaçosa. ".repeat(500)}`;
  const longImageUrl = `https://cdn.example.com/arquivos/ids/${"1".repeat(400)}/foto.jpg?v=638905407050530000`;

  test("survives a description no cap anticipated", () => {
    const read = CatalogueProductSchema.safeParse({
      id: "150298",
      name: "Mochila Escolar",
      category: "Escolar",
      price: "349.9",
      slug: "mochila-escolar",
      images: [longImageUrl],
      description: longDescription,
    });
    expect(read.success).toBe(true);
    expect(read.data?.description.length).toBeLessThanOrEqual(2_048);
  });

  test("keeps the image address character for character", () => {
    const read = CatalogueProductSchema.safeParse({
      id: "150298",
      name: "Mochila Escolar",
      category: "Escolar",
      price: "349.9",
      slug: "mochila-escolar",
      images: [longImageUrl],
      description: "",
    });
    expect(read.data?.images[0]).toBe(longImageUrl);
  });
});
