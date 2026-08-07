import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { StepIndicator } from "./step-indicator.tsx";

const meta = {
  title: "Components/StepIndicator",
  component: StepIndicator,
  args: {
    steps: [
      { id: "details", label: "Details" },
      { id: "permissions", label: "Permissions" },
      { id: "review", label: "Review" },
    ],
    currentStep: 1,
  },
} satisfies Meta<typeof StepIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const FirstStep: Story = {
  args: { currentStep: 0 },
};

export const LastStepCompleted: Story = {
  args: {
    steps: [
      { id: "details", label: "Details" },
      { id: "permissions", label: "Permissions" },
      { id: "review", label: "Review" },
    ],
    currentStep: 3,
  },
};

function InteractiveDemo() {
  const [currentStep, setCurrentStep] = useState(2);
  return (
    <StepIndicator
      steps={[
        { id: "connection", label: "Connection" },
        { id: "credentials", label: "Credentials" },
        { id: "tools", label: "Tools" },
        { id: "review", label: "Review" },
      ]}
      currentStep={currentStep}
      visited={new Set([0, 1, 2])}
      onStepClick={setCurrentStep}
    />
  );
}

export const Interactive: Story = {
  render: () => <InteractiveDemo />,
};
