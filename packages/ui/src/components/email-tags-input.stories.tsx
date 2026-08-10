import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { EmailTagsInput } from "./email-tags-input.tsx";

const meta = {
  title: "Components/EmailTagsInput",
  component: EmailTagsInput,
  args: {
    emails: [],
    onEmailsChange: () => {},
  },
} satisfies Meta<typeof EmailTagsInput>;

export default meta;
type Story = StoryObj<typeof meta>;

function ControlledDemo({ initialEmails = [] }: { initialEmails?: string[] }) {
  const [emails, setEmails] = useState<string[]>(initialEmails);
  return (
    <div className="w-96">
      <EmailTagsInput
        emails={emails}
        onEmailsChange={setEmails}
        validation={{ currentUserEmail: "you@acme.com" }}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        Type an email and press Enter, or paste a comma-separated list. Adding
        you@acme.com shows the self-invite error.
      </p>
    </div>
  );
}

/** Invite teammates by email. Supports paste of comma/semicolon/newline separated lists. */
export const Default: Story = {
  render: () => <ControlledDemo />,
};

export const WithEmails: Story = {
  render: () => (
    <ControlledDemo
      initialEmails={["ana@acme.com", "joao@acme.com", "sofia@acme.com"]}
    />
  ),
};

export const Disabled: Story = {
  args: {
    emails: ["ana@acme.com", "joao@acme.com"],
    disabled: true,
  },
  render: (args) => (
    <div className="w-96">
      <EmailTagsInput {...args} />
    </div>
  ),
};
