import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@deco/ui/components/command.tsx";
import { User01 } from "@untitledui/icons";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { getInitials } from "@/lib/get-initials";
import { useT } from "@/i18n/use-t";
import { SUPER_AGENT_ASSIGNEE_ID, type Member } from "./config";

export function AssigneePickerContent({
  members,
  onSelect,
}: {
  members: Member[];
  onSelect: (userId: string | null) => void;
}) {
  const t = useT();
  return (
    <Command>
      <CommandInput
        placeholder={t("taskBoard.taskDialog.assignToPlaceholder")}
        className="h-9"
      />
      <CommandList>
        <CommandEmpty>{t("taskBoard.taskDialog.noMembersFound")}</CommandEmpty>
        <CommandGroup>
          <CommandItem
            value="Super Agent"
            onSelect={() => onSelect(SUPER_AGENT_ASSIGNEE_ID)}
            className="gap-2"
          >
            <SuperAgentIcon size={16} />
            <span className="truncate">Super Agent</span>
          </CommandItem>
          <CommandItem
            value={t("taskBoard.taskDialog.unassignedLabel")}
            onSelect={() => onSelect(null)}
            className="gap-2"
          >
            <User01 size={16} className="text-muted-foreground" />
            <span className="truncate">
              {t("taskBoard.taskDialog.unassignedLabel")}
            </span>
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading={t("taskBoard.taskDialog.membersGroupHeading")}>
          {members.map((m) => (
            <CommandItem
              key={m.userId}
              value={m.user?.name ?? m.userId}
              onSelect={() => onSelect(m.userId)}
              className="gap-2"
            >
              <Avatar
                url={m.user?.image ?? undefined}
                fallback={getInitials(m.user?.name)}
                shape="circle"
                size="2xs"
              />
              <span className="truncate">{m.user?.name ?? m.userId}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
