import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@deco/ui/components/form.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { track } from "@/lib/posthog-client";
import { authClient } from "@/lib/auth-client";
import { useOrgAuthClient } from "@/hooks/use-org-auth-client";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useOrganizationRoles } from "@/hooks/use-organization-roles";
import { useT } from "@/i18n/use-t.ts";

interface InviteMemberDialogProps {
  trigger: React.ReactNode;
}

// NOTE: email schema error message is not displayed to users (never rendered)
// — form validation uses FormMessage which pulls from form errors, not schema messages
const emailSchema = z.string().email("Invalid email address");

type InviteMemberFormData = {
  emailsText: string;
  role: string;
};

// Parse emails from text input (comma or newline separated)
function parseEmails(text: string): string[] {
  if (!text.trim()) return [];

  // Split by comma, semicolon, or newline
  const emails = text
    .split(/[,;\n]/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);

  // Remove duplicates
  return Array.from(new Set(emails));
}

export function InviteMemberDialog({ trigger }: InviteMemberDialogProps) {
  const [open, setOpen] = useState(false);
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const queryClient = useQueryClient();

  // Get the active organization from session
  const { data: session } = authClient.useSession();
  const currentUserEmail = session?.user?.email;

  // Get available roles
  const { roles: availableRoles, isLoading: isLoadingRoles } =
    useOrganizationRoles();

  // Filter out owner role from invite options
  const inviteableRoles = availableRoles.filter((r) => r.role !== "owner");

  const form = useForm<InviteMemberFormData>({
    mode: "onChange",
    defaultValues: {
      emailsText: "",
      role: "user",
    },
  });

  const emailsText = form.watch("emailsText");
  const selectedRole = form.watch("role");

  // Parse and validate emails
  const parsedEmails = parseEmails(emailsText);
  const validEmails = parsedEmails.filter((email) => {
    const isValidFormat = emailSchema.safeParse(email).success;
    const isNotSelf =
      !currentUserEmail || email !== currentUserEmail.toLowerCase();
    return isValidFormat && isNotSelf;
  });

  const t = useT();

  const inviteMutation = useMutation({
    mutationFn: async ({
      emails,
      role,
    }: {
      emails: string[];
      role: string;
    }) => {
      if (!role) {
        throw new Error(t("common.inviteMemberDialog.errorSelectRole"));
      }

      // Invite each valid email with the selected role
      const results = await Promise.allSettled(
        emails.map(async (email) => {
          const result = await orgAuth.organization.inviteMember({
            email,
            role: role as "admin" | "owner",
          });

          if (result.error) {
            throw new Error(result.error.message);
          }

          return result.data;
        }),
      );

      // Check for failures
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        throw new Error(
          t("common.inviteMemberDialog.errorFailedInvite", {
            count: failures.length,
          }),
        );
      }

      return results;
    },
    onSuccess: (_, { emails, role }) => {
      track("member_invited", {
        count: emails.length,
        role,
      });
      queryClient.invalidateQueries({ queryKey: KEYS.members(locator) });
      queryClient.invalidateQueries({ queryKey: KEYS.invitations(locator) });
      toast.success(
        emails.length === 1
          ? t("common.inviteMemberDialog.successSingle")
          : t("common.inviteMemberDialog.successMultiple", {
              count: emails.length,
            }),
      );
      form.reset({
        emailsText: "",
        role: "user",
      });
      setOpen(false);
    },
    onError: (error, { emails, role }) => {
      track("member_invite_failed", {
        count: emails.length,
        role,
        error: error instanceof Error ? error.message : String(error),
      });
      toast.error(
        error instanceof Error
          ? error.message
          : t("common.inviteMemberDialog.errorGeneric"),
      );
    },
  });

  const handleSubmit = (data: InviteMemberFormData) => {
    if (validEmails.length === 0) {
      toast.error(t("common.inviteMemberDialog.errorNoValidEmail"));
      return;
    }
    if (!data.role) {
      toast.error(t("common.inviteMemberDialog.errorSelectRole"));
      return;
    }
    inviteMutation.mutate({ emails: validEmails, role: data.role });
  };

  const isFormValid = validEmails.length > 0 && !!selectedRole;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("common.inviteMemberDialog.title")}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="emailsText"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t("common.inviteMemberDialog.emailLabel")}
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      disabled={inviteMutation.isPending}
                      placeholder={t(
                        "common.inviteMemberDialog.emailPlaceholder",
                      )}
                      className="min-h-[120px] resize-none"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={inviteMutation.isPending || isLoadingRoles}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue
                          placeholder={t(
                            "common.inviteMemberDialog.roleSelectPlaceholder",
                          )}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {inviteableRoles.map((role) => {
                          // Build description parts for custom roles
                          const parts: string[] = [];

                          if (!role.isBuiltin) {
                            // Static permissions
                            if (role.allowsAllStaticPermissions) {
                              parts.push(
                                t(
                                  "common.inviteMemberDialog.permFullOrgAccess",
                                ),
                              );
                            } else if (
                              role.staticPermissionCount &&
                              role.staticPermissionCount > 0
                            ) {
                              parts.push(
                                t("common.inviteMemberDialog.permOrgPerms", {
                                  count: role.staticPermissionCount,
                                }),
                              );
                            }

                            // Connection permissions
                            if (role.allowsAllConnections) {
                              parts.push(
                                t(
                                  "common.inviteMemberDialog.permAllConnections",
                                ),
                              );
                            } else if (
                              role.connectionCount &&
                              role.connectionCount > 0
                            ) {
                              parts.push(
                                t("common.inviteMemberDialog.permConnections", {
                                  count: role.connectionCount,
                                }),
                              );
                            }

                            // Tool permissions
                            if (
                              role.connectionCount !== 0 ||
                              role.allowsAllConnections
                            ) {
                              if (role.allowsAllTools) {
                                parts.push(
                                  t("common.inviteMemberDialog.permAllTools"),
                                );
                              } else if (role.toolCount && role.toolCount > 0) {
                                parts.push(
                                  t("common.inviteMemberDialog.permTools", {
                                    count: role.toolCount,
                                  }),
                                );
                              }
                            }
                          }

                          return (
                            <SelectItem key={role.role} value={role.role}>
                              <div className="flex flex-col">
                                <span>{role.label}</span>
                                {!role.isBuiltin && parts.length > 0 && (
                                  <span className="text-xs text-muted-foreground">
                                    {parts.join(", ")}
                                  </span>
                                )}
                              </div>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  form.reset({
                    emailsText: "",
                    role: "user",
                  });
                  setOpen(false);
                }}
                type="button"
                disabled={inviteMutation.isPending}
              >
                {t("common.inviteMemberDialog.cancelButton")}
              </Button>
              <Button
                type="submit"
                disabled={inviteMutation.isPending || !isFormValid}
              >
                {inviteMutation.isPending
                  ? t("common.inviteMemberDialog.invitingButton")
                  : t("common.inviteMemberDialog.inviteButton", {
                      count: validEmails.length || 0,
                    })}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
