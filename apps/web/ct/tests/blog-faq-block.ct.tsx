import { expect, test } from "@playwright/experimental-ct-react";
import type { Locator, Page } from "@playwright/test";
import { BlogFaqHarness } from "../harness/blog-faq-harness";

test.use({ viewport: { width: 900, height: 900 } });

const SHOTS = process.env.FAQ_SCREENSHOTS;

const rt = (name: string) => `blog/sections/blocks/${name}.tsx`;
const FAQ = rt("FAQ");

/** A `/live/_meta` exposing the blog app's blocks an FAQ is tested against. */
function blogMeta() {
  const names = [
    "FAQ",
    "Paragraph",
    "List",
    "BlockImage",
    "Divider",
    "Table",
    "Heading",
    "Callout",
  ];
  const sections: Record<string, { $ref: string }> = {};
  const definitions: Record<string, unknown> = {};
  for (const name of names) {
    sections[rt(name)] = { $ref: `#/definitions/${name}` };
    definitions[name] = {
      type: "object",
      properties: { __resolveType: { type: "string", enum: [rt(name)] } },
    };
  }
  return { manifest: { blocks: { sections } }, schema: { definitions } };
}

async function docValue(
  component: Locator,
): Promise<Array<Record<string, unknown>>> {
  const text = await component.getByTestId("doc-value").textContent();
  return JSON.parse(text ?? "[]");
}

/** Drag by hand: dnd-kit's pointer sensor only activates after real movement. */
async function dragOnto(page: Page, handle: Locator, target: Locator) {
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("drag endpoints are not on screen");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 12 });
  await page.mouse.up();
}

const answered = [
  {
    __resolveType: FAQ,
    items: [
      {
        title: "Qual o prazo de entrega?",
        body: [
          { __resolveType: rt("Divider") },
          { __resolveType: rt("Heading"), text: "Capitais", level: "3" },
        ],
      },
    ],
  },
  { __resolveType: rt("Heading"), text: "Depois do FAQ", level: "2" },
];

test("a question is added and stored as inline HTML", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <BlogFaqHarness meta={blogMeta()} initial={[{ __resolveType: FAQ }]} />,
  );

  await component.getByRole("button", { name: "Add question" }).click();
  const question = component.locator('[contenteditable="true"]').first();
  await question.click();
  await page.keyboard.type("Qual o prazo?");
  await expect
    .poll(async () => (await docValue(component))[0]?.items)
    .toEqual([{ title: "Qual o prazo?", body: [] }]);

  await question.click({ clickCount: 3 });
  await page.getByRole("button", { name: "Bold" }).click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/question-marks.png` });

  await expect
    .poll(async () => (await docValue(component))[0]?.items)
    .toEqual([{ title: "<strong>Qual o prazo?</strong>", body: [] }]);
});

test("an answer's pickers offer only the blocks an answer is made of", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <BlogFaqHarness
      meta={blogMeta()}
      initial={[{ __resolveType: FAQ, items: [{ title: "Trocas?" }] }]}
    />,
  );

  await component.getByRole("button", { name: "Add block" }).first().click();
  const options = page.getByRole("option");
  await expect(options).toHaveText([
    /^Divider/,
    /^Image/,
    /^List/,
    /^Paragraph/,
    /^Table/,
  ]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/answer-picker.png` });

  await options.filter({ hasText: /^Divider/ }).click();
  await expect
    .poll(async () => (await docValue(component))[0]?.items)
    .toEqual([{ title: "Trocas?", body: [{ __resolveType: rt("Divider") }] }]);
});

test("the post's own picker still offers every block", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <BlogFaqHarness meta={blogMeta()} initial={[{ __resolveType: FAQ }]} />,
  );

  await component.getByRole("button", { name: "Add block" }).last().click();
  await expect(page.getByRole("option")).toHaveCount(8);
});

test("a block the answer's picker does not offer stays editable when stored", async ({
  mount,
}) => {
  const component = await mount(
    <BlogFaqHarness meta={blogMeta()} initial={answered} />,
  );

  await expect(component.getByText("Capitais", { exact: true })).toBeVisible();
});

test("answer blocks reorder by drag without moving the post's rows", async ({
  mount,
  page,
}) => {
  const component = await mount(
    <BlogFaqHarness meta={blogMeta()} initial={answered} />,
  );
  // Handles in document order: the FAQ row, its two answer blocks, the heading after it.
  const handles = component.getByRole("button", { name: "Drag to reorder" });
  await expect(handles).toHaveCount(4);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/faq-with-answer.png` });

  await dragOnto(page, handles.nth(2), handles.nth(1));

  await expect
    .poll(async () => {
      const [faq, after] = await docValue(component);
      const items = faq?.items as Array<{
        body: Array<{ __resolveType: string }>;
      }>;
      return {
        outer: [faq?.__resolveType, after?.__resolveType],
        answer: items[0]?.body.map((block) => block.__resolveType),
      };
    })
    .toEqual({
      outer: [FAQ, rt("Heading")],
      answer: [rt("Heading"), rt("Divider")],
    });
});

test("hovering an answer block reveals its own handle, not its sibling's", async ({
  mount,
}) => {
  const component = await mount(
    <BlogFaqHarness meta={blogMeta()} initial={answered} />,
  );
  const handles = component.getByRole("button", { name: "Drag to reorder" });

  await component.getByText("Capitais", { exact: true }).hover();

  await expect(handles.nth(2)).toHaveCSS("opacity", "1");
  await expect(handles.nth(1)).toHaveCSS("opacity", "0");
  await expect(handles.nth(0)).toHaveCSS("opacity", "1");
  await expect(handles.nth(3)).toHaveCSS("opacity", "0");
});

test("a row collapses and opens again with its answer", async ({ mount }) => {
  const component = await mount(
    <BlogFaqHarness meta={blogMeta()} initial={answered} />,
  );
  const toggle = component.getByRole("button", {
    name: "Show or hide the answer",
  });
  const answer = component.getByText("Capitais", { exact: true });

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(answer).toBeHidden();

  await toggle.click();
  await expect(answer).toBeVisible();
});

test("the anchor id drops whitespace wherever it is typed", async ({
  mount,
}) => {
  const component = await mount(
    <BlogFaqHarness meta={blogMeta()} initial={[{ __resolveType: FAQ }]} />,
  );
  const anchor = component.getByLabel("Anchor id");

  await anchor.fill(" minha faq 1 ");

  await expect(anchor).toHaveValue("minhafaq1");
  await expect
    .poll(async () => (await docValue(component))[0]?.faqId)
    .toBe("minhafaq1");
});

test("items stored as a JSON string are read, and become an array on the first edit", async ({
  mount,
}) => {
  const component = await mount(
    <BlogFaqHarness
      meta={blogMeta()}
      initial={[{ __resolveType: FAQ, items: '[{"title":"Troca?"}]' }]}
    />,
  );

  await expect(component.getByText("Troca?", { exact: true })).toBeVisible();
  await component.getByRole("button", { name: "Add question" }).click();

  await expect
    .poll(async () => (await docValue(component))[0]?.items)
    .toEqual([
      { title: "Troca?", body: [] },
      { title: "", body: [] },
    ]);
});

test("removing a question keeps the text of the ones after it", async ({
  mount,
}) => {
  const component = await mount(
    <BlogFaqHarness
      meta={blogMeta()}
      initial={[
        {
          __resolveType: FAQ,
          items: [{ title: "Primeira?" }, { title: "Segunda?" }],
        },
      ]}
    />,
  );

  await component.getByText("Primeira?", { exact: true }).hover();
  await component
    .getByRole("button", { name: "Remove question" })
    .first()
    .click();

  await expect(component.getByText("Primeira?", { exact: true })).toHaveCount(
    0,
  );
  await expect(component.getByText("Segunda?", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await docValue(component))[0]?.items)
    .toEqual([{ title: "Segunda?", body: [] }]);
});
