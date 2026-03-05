import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useConnectionActions } from "@decocms/mesh-sdk";
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

const tokenSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

type TokenFormData = z.infer<typeof tokenSchema>;

interface SlotAuthTokenProps {
  connectionId: string;
  onAuthed: () => void;
}

export function SlotAuthToken({ connectionId, onAuthed }: SlotAuthTokenProps) {
  const actions = useConnectionActions();

  const form = useForm<TokenFormData>({
    resolver: zodResolver(tokenSchema),
    defaultValues: { token: "" },
  });

  const handleSubmit = async (data: TokenFormData) => {
    await actions.update.mutateAsync({
      id: connectionId,
      data: { connection_token: data.token },
    });
    // Trigger tool re-discovery
    await actions.update.mutateAsync({ id: connectionId, data: {} });
    onAuthed();
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-3">
        <FormField
          control={form.control}
          name="token"
          render={({ field }) => (
            <FormItem>
              <FormLabel>API Token</FormLabel>
              <FormControl>
                <Input type="password" placeholder="sk-..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button
          type="submit"
          disabled={actions.update.isPending}
          className="w-full"
        >
          {actions.update.isPending ? "Saving..." : "Save token"}
        </Button>
      </form>
    </Form>
  );
}
