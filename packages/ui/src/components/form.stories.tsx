import type { Meta, StoryObj } from "@storybook/react-vite";
import { useForm } from "react-hook-form";
import { Button } from "./button.tsx";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "./form.tsx";
import { Input } from "./input.tsx";
import { Switch } from "./switch.tsx";
import { Textarea } from "./textarea.tsx";

const meta = {
  title: "Components/Form",
  component: Form,
} satisfies Meta<typeof Form>;

export default meta;
// Form (FormProvider) has required props supplied inside each render function,
// so stories are typed without meta-derived args.
type Story = StoryObj;

interface ProfileValues {
  name: string;
  email: string;
  bio: string;
  notifications: boolean;
}

function ProfileFormDemo() {
  const form = useForm<ProfileValues>({
    defaultValues: {
      name: "Ana Souza",
      email: "ana@example.com",
      bio: "",
      notifications: true,
    },
  });

  return (
    <Form {...form}>
      <form className="grid w-96 gap-6" onSubmit={form.handleSubmit(() => {})}>
        <FormField
          control={form.control}
          name="name"
          rules={{ required: "Name is required." }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Your full name" {...field} />
              </FormControl>
              <FormDescription>
                Shown to other members of your organization.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          rules={{
            required: "Email is required.",
            pattern: {
              value: /^\S+@\S+$/,
              message: "Enter a valid email address.",
            },
          }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" placeholder="you@company.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="bio"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Bio</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="A short description about yourself."
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="notifications"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between gap-4">
              <div className="grid gap-1">
                <FormLabel>Email notifications</FormLabel>
                <FormDescription>
                  Receive updates about activity in your projects.
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
        <Button type="submit" className="justify-self-start">
          Save changes
        </Button>
      </form>
    </Form>
  );
}

export const Default: Story = {
  render: () => <ProfileFormDemo />,
};

function ValidationDemo() {
  const form = useForm<{ slug: string }>({
    defaultValues: { slug: "" },
    mode: "onChange",
  });

  return (
    <Form {...form}>
      <form className="grid w-96 gap-6" onSubmit={form.handleSubmit(() => {})}>
        <FormField
          control={form.control}
          name="slug"
          rules={{
            required: "A slug is required.",
            pattern: {
              value: /^[a-z0-9-]+$/,
              message:
                "Slugs can only contain lowercase letters, numbers, and dashes.",
            },
          }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Organization slug</FormLabel>
              <FormControl>
                <Input placeholder="acme-inc" {...field} />
              </FormControl>
              <FormDescription>
                Type an uppercase letter to see the error state.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="justify-self-start">
          Create organization
        </Button>
      </form>
    </Form>
  );
}

export const WithValidation: Story = {
  render: () => <ValidationDemo />,
};
