import type { Meta, StoryObj } from "@storybook/react-vite";
import { File02, Globe02, LayoutAlt01, Stars01 } from "@untitledui/icons";
import { Matrix } from "../foundations/kit.tsx";
import { Button } from "./button.tsx";
import { Card, CardHeader, CardTitle } from "./card.tsx";
import { ListRow } from "./list-row.tsx";

const meta = {
  title: "Molecules/ListRow",
  component: ListRow,
  args: {
    lead: <Stars01 />,
    title: "Black Friday creative review",
    meta: "Meeting · 14:00 · prep ready",
    trailing: (
      <Button size="sm" variant="ghost">
        Prep
      </Button>
    ),
  },
  argTypes: {
    variant: { control: "inline-radio", options: ["default", "divided"] },
    lead: { control: false },
    trailing: { control: false },
  },
} satisfies Meta<typeof ListRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => (
    <div className="w-[25rem]">
      <ListRow {...args} />
    </div>
  ),
};

export const Variants: Story = {
  parameters: { controls: { disable: true }, layout: "padded" },
  render: (args) => (
    <Matrix
      columns={["Default · in a card", "Divided · in a list"]}
      rows={[
        {
          label: "Row",
          cells: (["default", "divided"] as const).map((variant) => (
            <div key={variant} className="w-[25rem]">
              <ListRow {...args} variant={variant} />
              <ListRow
                {...args}
                variant={variant}
                title="Checkout freezes on iOS 17"
                meta="Execute · agent working · step 3 of 5"
              />
            </div>
          )),
        },
      ]}
    />
  ),
};

const CONNECTIONS = [
  { name: "Storefront", calls: "4,120", share: "38.2%" },
  { name: "Analytics", calls: "2,310", share: "21.4%" },
  { name: "CMS", calls: "1,980", share: "18.3%" },
];

/** A list in a card: rows open their detail, values sit on the right. */
export const List: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <Card className="w-[26rem]">
      <CardHeader>
        <CardTitle>Top connections</CardTitle>
      </CardHeader>
      <div className="-mx-2">
        {CONNECTIONS.map((row) => (
          <ListRow
            key={row.name}
            variant="divided"
            asChild
            lead={<Globe02 />}
            title={row.name}
            trailing={
              <span className="tnum flex gap-3 text-sm">
                <span>{row.calls}</span>
                <span className="text-muted-foreground w-12 text-right">
                  {row.share}
                </span>
              </span>
            }
          >
            <a href="#connection" />
          </ListRow>
        ))}
      </div>
    </Card>
  ),
};

/** A list with a current item, like the sections of a page in an editor. */
export const Selectable: Story = {
  parameters: { controls: { disable: true } },
  render: () => (
    <div className="flex w-72 flex-col gap-0.5">
      {["Hero", "Product shelf", "Footer"].map((name, index) => (
        <ListRow
          key={name}
          asChild
          selected={index === 1}
          lead={<LayoutAlt01 />}
          title={name}
        >
          <button type="button" />
        </ListRow>
      ))}
    </div>
  ),
};

export const States: Story = {
  parameters: {
    controls: { disable: true },
    layout: "padded",
    pseudo: { hover: [".is-hover"], focusVisible: [".is-focus"] },
  },
  render: () => (
    <Matrix
      columns={["Default", "Hover", "Focus", "Selected"]}
      rows={(["default", "divided"] as const).map((variant) => ({
        label: variant,
        cells: ["", "is-hover", "is-focus", "selected"].map((state) => (
          <div key={state} className="w-56">
            <ListRow
              asChild
              variant={variant}
              selected={state === "selected"}
              className={state === "selected" ? "" : state}
              lead={<File02 />}
              title="Q3 brief.pdf"
              meta="Updated 2h ago"
            >
              <button type="button" />
            </ListRow>
          </div>
        )),
      }))}
    />
  ),
};
