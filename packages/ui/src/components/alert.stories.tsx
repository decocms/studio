import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  InfoCircle,
} from "@untitledui/icons";
import { Alert, AlertDescription, AlertTitle } from "./alert.tsx";

const meta = {
  title: "Components/Alert",
  component: Alert,
  args: {
    variant: "default",
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "destructive", "warning", "success", "info"],
    },
  },
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Alert {...args} className="w-96">
      <InfoCircle />
      <div>
        <AlertTitle>Connection created</AlertTitle>
        <AlertDescription>
          Your Slack workspace is now available to all projects in this
          organization.
        </AlertDescription>
      </div>
    </Alert>
  ),
};

export const Variants: Story = {
  render: () => (
    <div className="flex w-96 flex-col gap-3">
      <Alert>
        <InfoCircle />
        <div>
          <AlertTitle>Heads up</AlertTitle>
          <AlertDescription>
            You can invite up to 25 members on the current plan.
          </AlertDescription>
        </div>
      </Alert>
      <Alert variant="info">
        <InfoCircle />
        <div>
          <AlertTitle>Scheduled maintenance</AlertTitle>
          <AlertDescription>
            The API will be briefly unavailable on Sunday at 02:00 UTC.
          </AlertDescription>
        </div>
      </Alert>
      <Alert variant="success">
        <CheckCircle />
        <div>
          <AlertTitle>Deployment succeeded</AlertTitle>
          <AlertDescription>
            Version 2.14.0 is now live in production.
          </AlertDescription>
        </div>
      </Alert>
      <Alert variant="warning">
        <AlertTriangle />
        <div>
          <AlertTitle>Token expiring soon</AlertTitle>
          <AlertDescription>
            The GitHub connection token expires in 3 days. Rotate it to avoid
            interruptions.
          </AlertDescription>
        </div>
      </Alert>
      <Alert variant="destructive">
        <AlertCircle />
        <div>
          <AlertTitle>Payment failed</AlertTitle>
          <AlertDescription>
            We could not charge your card ending in 4242. Update your billing
            details to keep your subscription active.
          </AlertDescription>
        </div>
      </Alert>
    </div>
  ),
};

export const TitleOnly: Story = {
  render: () => (
    <Alert variant="success" className="w-96">
      <CheckCircle />
      <AlertTitle>Settings saved</AlertTitle>
    </Alert>
  ),
};
