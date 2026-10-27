import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Matrix } from "../foundations/kit.tsx";
import { Label } from "./label.tsx";
import { TagsInput } from "./tags-input.tsx";

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const meta = {
  title: "Atoms/TagsInput",
  component: TagsInput,
  args: { placeholder: "Add a keyword" },
} satisfies Meta<typeof TagsInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => (
    <div className="w-96">
      <TagsInput {...args} defaultValue={["checkout", "black friday"]} />
    </div>
  ),
};

/** Invite by email. Paste a comma- or line-separated list to add many. */
export const Emails: Story = {
  render: () => <EmailsDemo />,
};

function EmailsDemo() {
  const [emails, setEmails] = useState(["ana@acme.com", "bruno@acme"]);
  return (
    <div className="grid w-96 gap-2">
      <Label htmlFor="invite">Invite by email</Label>
      <TagsInput
        id="invite"
        value={emails}
        onValueChange={setEmails}
        validate={isEmail}
        placeholder="name@company.com"
      />
      <p className="text-meta">
        {emails.filter((e) => !isEmail(e)).length} address needs fixing
      </p>
    </div>
  );
}

export const States: Story = {
  parameters: { controls: { disable: true }, layout: "padded" },
  render: () => (
    <Matrix
      columns={["Empty", "With tags", "Invalid tag", "Disabled"]}
      rows={[
        {
          label: "TagsInput",
          cells: [
            <div key="empty" className="w-56">
              <TagsInput placeholder="Add a keyword" />
            </div>,
            <div key="tags" className="w-56">
              <TagsInput defaultValue={["seo", "checkout"]} />
            </div>,
            <div key="invalid" className="w-56">
              <TagsInput defaultValue={["ana@acme"]} validate={isEmail} />
            </div>,
            <div key="disabled" className="w-56">
              <TagsInput defaultValue={["seo"]} disabled />
            </div>,
          ],
        },
      ]}
    />
  ),
};
