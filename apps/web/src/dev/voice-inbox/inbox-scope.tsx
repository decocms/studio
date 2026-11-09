import { ChevronDown, User01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { useT } from "@/i18n/use-t";
import type { Branding } from "./scenario-data";

export function OrganizationMark({
  name,
  branding,
}: {
  name: string;
  branding?: Branding;
}) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-background p-2">
      {branding?.icon ? (
        <img
          src={branding.icon}
          alt=""
          className="size-full object-contain dark:invert"
        />
      ) : (
        <span className="text-xs font-medium">{name.slice(0, 2)}</span>
      )}
    </span>
  );
}

export function InboxScope({
  organization,
  branding,
  scope,
  onScopeChange,
}: {
  organization: string;
  branding?: Branding;
  scope: "user" | "organization";
  onScopeChange: (scope: "user" | "organization") => void;
}) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-10 min-w-0 shrink-0 gap-2 px-2"
          aria-label={t("voiceInbox.chooseScope")}
        >
          {scope === "organization" ? (
            <OrganizationMark name={organization} branding={branding} />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-xl bg-muted">
              <User01 />
            </span>
          )}
          <span className="max-w-32 truncate text-sm font-medium">
            {scope === "user" ? t("voiceInbox.myInbox") : organization}
          </span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>{t("voiceInbox.chooseScope")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={scope}
          onValueChange={(value) => {
            if (value === "user" || value === "organization")
              onScopeChange(value);
          }}
        >
          <DropdownMenuRadioItem value="user" className="gap-3 py-3">
            <User01 className="size-5" />
            <span>
              <span className="block">{t("voiceInbox.myInbox")}</span>
              <span className="text-xs text-muted-foreground">
                {t("voiceInbox.allPrioritized")}
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="organization" className="gap-3 py-3">
            <OrganizationMark name={organization} branding={branding} />
            <span>
              <span className="block">{organization}</span>
              <span className="text-xs text-muted-foreground">
                {t("voiceInbox.onlyOrganization")}
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t("voiceInbox.singleOrganizationMock")}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
