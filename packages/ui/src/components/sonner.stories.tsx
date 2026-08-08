import type { Meta, StoryObj } from "@storybook/react-vite";
import { toast } from "sonner";
import { Button } from "./button.tsx";
import { Toaster } from "./sonner.tsx";

const meta = {
  title: "Components/Sonner",
  component: Toaster,
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Toaster />
      <Button
        variant="outline"
        onClick={() =>
          toast("Member invited", {
            description: "ana@acme.com will receive an email shortly.",
          })
        }
      >
        Default
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.success("Connection created successfully")}
      >
        Success
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.error("Failed to save settings. Try again.")}
      >
        Error
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.warning("Your API token expires in 3 days")}
      >
        Warning
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.info("A new version of Studio is available")}
      >
        Info
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast("Project archived", {
            action: {
              label: "Undo",
              onClick: () => toast.success("Project restored"),
            },
          })
        }
      >
        With action
      </Button>
      <Button
        variant="outline"
        onClick={() => {
          const id = toast.loading("Deploying to production...");
          setTimeout(() => {
            toast.success("Deployed version 2.14.0", { id });
          }, 2000);
        }}
      >
        Promise
      </Button>
    </div>
  ),
};
