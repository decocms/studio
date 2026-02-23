import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  useConnectionActions,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { authClient } from "@/web/lib/auth-client";
import { extractConnectionData } from "@/web/utils/extract-connection-data";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import type { RegistryItem } from "@/web/components/store/types";

const installSchema = z.object({
  title: z.string().min(1, "Name is required"),
});

type InstallFormData = z.infer<typeof installSchema>;

interface SlotInstallFormProps {
  registryItem: RegistryItem;
  onInstalled: (connectionId: string) => void;
}

export function SlotInstallForm({
  registryItem,
  onInstalled,
}: SlotInstallFormProps) {
  const { org } = useProjectContext();
  const { data: session } = authClient.useSession();
  const actions = useConnectionActions();

  const connectionData = extractConnectionData(
    registryItem,
    org.id,
    session?.user?.id ?? "system",
  );

  const form = useForm<InstallFormData>({
    resolver: zodResolver(installSchema),
    defaultValues: { title: connectionData.title ?? "" },
  });

  const handleSubmit = async (data: InstallFormData) => {
    const payload: ConnectionEntity = {
      ...(connectionData as ConnectionEntity),
      title: data.title,
    };
    const created = await actions.create.mutateAsync(payload);
    onInstalled(created.id);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-3">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Connection name</FormLabel>
              <FormControl>
                <Input placeholder="e.g. OpenAI" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="submit"
          disabled={actions.create.isPending}
          className="w-full"
        >
          {actions.create.isPending ? "Installing..." : "Install"}
        </Button>
      </form>
    </Form>
  );
}
