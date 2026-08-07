import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./accordion.tsx";

const meta = {
  title: "Components/Accordion",
  component: Accordion,
  args: {
    type: "single",
    collapsible: true,
  },
} satisfies Meta<typeof Accordion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Accordion type="single" collapsible className="w-96">
      <AccordionItem value="connections">
        <AccordionTrigger>What is a connection?</AccordionTrigger>
        <AccordionContent>
          A connection links an MCP server to your workspace so its tools become
          available to your agents and teammates.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="permissions">
        <AccordionTrigger>How do permissions work?</AccordionTrigger>
        <AccordionContent>
          Each member gets a role per project. Roles control which tools they
          can run and which connections they can manage.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="billing">
        <AccordionTrigger>How is usage billed?</AccordionTrigger>
        <AccordionContent>
          Usage is metered per tool call and aggregated monthly on your
          organization invoice.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
};

export const Multiple: Story = {
  render: () => (
    <Accordion
      type="multiple"
      defaultValue={["general", "notifications"]}
      className="w-96"
    >
      <AccordionItem value="general">
        <AccordionTrigger>General</AccordionTrigger>
        <AccordionContent>
          Organization name, slug, and default project visibility.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="notifications">
        <AccordionTrigger>Notifications</AccordionTrigger>
        <AccordionContent>
          Choose where alerts about failed tool calls are delivered.
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="danger">
        <AccordionTrigger>Danger zone</AccordionTrigger>
        <AccordionContent>
          Delete this organization and all of its projects. This cannot be
          undone.
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
};
