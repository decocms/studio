import {
  Controller,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  isAppProtocol,
  type MobileAppConfig,
} from "@decocms/shared/mobile-app";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";

/** The optional install pages, under the protocol: field, label, placeholder. */
const INSTALL_FIELDS: Array<
  [keyof Omit<MobileAppConfig, "protocol">, TranslationKey, string]
> = [
  [
    "iosInstallUrl",
    "sandbox.cmsSettings.mobileApp.iosInstallUrlLabel",
    "https://testflight.apple.com/join/…",
  ],
  [
    "androidInstallUrl",
    "sandbox.cmsSettings.mobileApp.androidInstallUrlLabel",
    "https://appdistribution.firebase.dev/i/…",
  ],
];

/**
 * The "Mobile app (Eitri)" switch (`metadata.mobileApp`): on, the object is
 * present and its Eitri protocol and install pages show below; off, it is
 * null. One Controller owns them all, so they stay one value.
 */
export function MobileAppField<T extends FieldValues>({
  control,
}: {
  control: Control<T>;
}) {
  const t = useT();
  return (
    <Controller
      control={control}
      name={"metadata.mobileApp" as FieldPath<T>}
      render={({ field }) => {
        const value = field.value as MobileAppConfig | null | undefined;
        // An empty install page is left out, not stored as "".
        const set = (key: keyof MobileAppConfig, text: string) =>
          field.onChange({
            ...value,
            [key]: key === "protocol" || text ? text : undefined,
          });
        const protocolInvalid =
          !!value?.protocol && !isAppProtocol(value.protocol);
        return (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5 min-w-0">
                <Label
                  htmlFor="mobile-app"
                  className="font-normal text-foreground"
                >
                  {t("sandbox.cmsSettings.mobileApp.label")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("sandbox.cmsSettings.mobileApp.description")}
                </p>
              </div>
              <Switch
                id="mobile-app"
                className="shrink-0"
                checked={!!value}
                onCheckedChange={(checked) =>
                  field.onChange(checked ? { protocol: "" } : null)
                }
              />
            </div>
            {value ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="mobile-app-protocol">
                    {t("sandbox.cmsSettings.mobileApp.protocolLabel")}
                  </Label>
                  <Input
                    id="mobile-app-protocol"
                    placeholder="newbalance"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={value.protocol ?? ""}
                    aria-invalid={protocolInvalid || undefined}
                    onChange={(e) => set("protocol", e.target.value)}
                    onBlur={field.onBlur}
                  />
                  <p
                    className={cn(
                      "text-xs",
                      protocolInvalid
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {t(
                      protocolInvalid
                        ? "sandbox.cmsSettings.mobileApp.protocolInvalid"
                        : "sandbox.cmsSettings.mobileApp.protocolHint",
                    )}
                  </p>
                </div>
                {INSTALL_FIELDS.map(([key, label, placeholder]) => (
                  <div key={key} className="space-y-2">
                    <Label htmlFor={`mobile-app-${key}`}>{t(label)}</Label>
                    <Input
                      id={`mobile-app-${key}`}
                      type="url"
                      inputMode="url"
                      placeholder={placeholder}
                      value={value[key] ?? ""}
                      onChange={(e) => set(key, e.target.value)}
                      onBlur={field.onBlur}
                    />
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  {t("sandbox.cmsSettings.mobileApp.installHint")}
                </p>
              </>
            ) : null}
          </div>
        );
      }}
    />
  );
}
