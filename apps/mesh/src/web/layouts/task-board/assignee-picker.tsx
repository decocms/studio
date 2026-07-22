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
import { SuperAgentIcon } from "@/web/components/super-agent-icon";
import { getInitials } from "@/web/lib/get-initials";
import { SUPER_AGENT_ASSIGNEE_ID, type Member } from "./config";

export function AssigneePickerContent({
  members,
  onSelect,
}: {
  members: Member[];
  onSelect: (userId: string | null) => void;
}) {
  return (
    <Command>
      <CommandInput placeholder="Assign to…" className="h-9" />
      <CommandList>
        <CommandEmpty>No members found.</CommandEmpty>
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
            value="Unassigned"
            onSelect={() => onSelect(null)}
            className="gap-2"
          >
            <User01 size={16} className="text-muted-foreground" />
            <span className="truncate">Unassigned</span>
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Members">
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
