import { Fragment, type ReactNode, useId, useState } from "react";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Input,
} from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useContentDiscardListener } from "@/components/sections-editor/content-sync";
import {
  type SaveGuard,
  useDebouncedSaveBlock,
} from "@/components/sections-editor/use-save-block";
import { SiteDraftViewHeader } from "@/components/site-draft-bar/view-header";
import { useT } from "@/i18n/use-t.ts";
import { SaveStatus } from "./blog/save-status";
import {
  applyCmsSettingsEdits,
  CMS_SETTINGS_BLOCK_KEY,
  type CmsSettingsEdits,
  type CmsSettingsFieldId,
  type CmsSettingsFieldState,
  isCollectorUrl,
  isUnchangedCmsSettingsEdit,
  percentToRate,
  rateToPercent,
  readCmsSettingsField,
} from "./cms-settings";
import { HeldBlockView } from "./held-block-view";

type Props = {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /** The `CMS` block, or a stand-in holding only its type when absent. */
  block: Record<string, unknown>;
  saveGuard: SaveGuard;
  /** The block's generic form, for what this page shows read-only. */
  onOpenForm: () => void;
};

/**
 * The site's Settings as a page of their own: telemetry and analytics, one
 * card each, a row per field. Only the fields changed here are written
 * (the rest of the block, defaults included, stays as saved), and a field
 * set with variants shows read-only with the way to the block's form.
 */
export function CmsSettingsPage(props: Props) {
  // A discard of the block (Review & Publish) drops what was changed here,
  // typed text included: the page shows the draft's values again.
  const [discards, setDiscards] = useState(0);
  useContentDiscardListener(props.orgSlug, props.virtualMcpId, (keys) => {
    if (keys.has(CMS_SETTINGS_BLOCK_KEY)) setDiscards((n) => n + 1);
  });
  return (
    <HeldBlockView
      orgSlug={props.orgSlug}
      virtualMcpId={props.virtualMcpId}
      branch={props.branch}
      blockKey={CMS_SETTINGS_BLOCK_KEY}
      // Absent means "not created yet", never "deleted".
      present={undefined}
    >
      <Fragment key={discards}>
        <CmsSettingsPageForm {...props} />
      </Fragment>
    </HeldBlockView>
  );
}

function CmsSettingsPageForm({
  orgSlug,
  virtualMcpId,
  branch,
  block,
  saveGuard,
  onOpenForm,
}: Props) {
  const t = useT();
  const { save, isPending } = useDebouncedSaveBlock(
    { orgSlug, virtualMcpId, branch },
    { guard: saveGuard, holdsCopy: true },
  );
  // What was changed here, field by field: the only fields a save writes.
  const [edits, setEdits] = useState<CmsSettingsEdits>({});

  const stateOf = (id: CmsSettingsFieldId): CmsSettingsFieldState => {
    const saved = readCmsSettingsField(block, id);
    if (saved.kind === "locked" || !Object.hasOwn(edits, id)) return saved;
    const edited = edits[id];
    return edited === undefined
      ? readCmsSettingsField({}, id)
      : {
          kind: "value",
          value: edited as boolean | number | string,
          isDefault: false,
        };
  };
  // The block as the page opened it: a field it left out and set back to
  // its default is left out again, not written.
  const [opened] = useState(block);
  const edit = (id: CmsSettingsFieldId, input: unknown) => {
    const was = readCmsSettingsField(opened, id);
    const value =
      was.kind === "value" && was.isDefault && input === was.value
        ? undefined
        : input;
    const next = { ...edits, [id]: value };
    // Back to what is saved (off and on again): nothing to write for it.
    if (isUnchangedCmsSettingsEdit(block, id, value)) delete next[id];
    setEdits(next);
    // No edit left: a save waiting to go out is dropped, none is made.
    save(
      CMS_SETTINGS_BLOCK_KEY,
      Object.keys(next).length > 0
        ? applyCmsSettingsEdits(block, next)
        : () => null,
    );
  };
  // A switch that is off (or set with variants: on for some) turns off what
  // depends on it only when it is plainly off.
  const isOff = (id: CmsSettingsFieldId) => {
    const state = stateOf(id);
    return state.kind === "value" && state.value === false;
  };
  const telemetryOff = isOff("telemetry.enabled");
  const analyticsOff = isOff("analytics.enabled");

  /** A field's row: its control, or read-only when set with variants. */
  const field = (
    id: CmsSettingsFieldId,
    render: (state: FieldValue, rowProps: RowProps) => ReactNode,
    disabled = false,
  ) => {
    const state = stateOf(id);
    const rowProps: RowProps = {
      label: t(`sandbox.cmsSettingsPage.${id}.label`),
      help: t(`sandbox.cmsSettingsPage.${id}.help`),
      disabled,
    };
    if (state.kind === "locked") {
      return (
        <SettingsCardItem
          key={id}
          title={
            <span className="flex items-center gap-2">
              {rowProps.label}
              <Badge variant="muted" size="sm">
                {t("sandbox.cmsSettingsPage.variants")}
              </Badge>
            </span>
          }
          description={t(
            state.reason === "variants"
              ? "sandbox.cmsSettingsPage.locked.variants"
              : "sandbox.cmsSettingsPage.locked.other",
          )}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenForm}
            >
              {t("sandbox.cmsSettingsPage.openForm")}
            </Button>
          }
        />
      );
    }
    return render(state, rowProps);
  };

  return (
    <div className="flex h-full flex-col" data-testid="cms-settings-page">
      {/* The sidebar's Settings row names the view, as on Experiments. */}
      <SiteDraftViewHeader
        intro={t("sandbox.cmsSettingsPage.intro")}
        actions={<SaveStatus isPending={isPending} isError={false} />}
      />
      <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <div className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-6">
          <SettingsSection
            title={t("sandbox.cmsSettingsPage.telemetry.title")}
            description={t("sandbox.cmsSettingsPage.telemetry.description")}
          >
            <SettingsCard>
              {field("telemetry.enabled", (state, row) => (
                <SwitchRow
                  key="telemetry.enabled"
                  {...row}
                  checked={state.value === true}
                  onChange={(v) => edit("telemetry.enabled", v)}
                />
              ))}
              {field(
                "telemetry.metrics",
                (state, row) => (
                  <SwitchRow
                    key="telemetry.metrics"
                    {...row}
                    checked={state.value === true}
                    onChange={(v) => edit("telemetry.metrics", v)}
                  />
                ),
                telemetryOff,
              )}
              {RATE_FIELDS.map((id) =>
                field(
                  id,
                  (state, row) => (
                    <RateRow
                      key={id}
                      {...row}
                      rate={state.value as number}
                      onChange={(rate) => edit(id, rate)}
                    />
                  ),
                  telemetryOff,
                ),
              )}
            </SettingsCard>
          </SettingsSection>
          <SettingsSection
            title={t("sandbox.cmsSettingsPage.analytics.title")}
            description={t("sandbox.cmsSettingsPage.analytics.description")}
          >
            <SettingsCard>
              {field("analytics.enabled", (state, row) => (
                <SwitchRow
                  key="analytics.enabled"
                  {...row}
                  checked={state.value === true}
                  onChange={(v) => edit("analytics.enabled", v)}
                />
              ))}
              {field(
                "analytics.collector",
                (state, row) => (
                  <CollectorRow
                    key="analytics.collector"
                    {...row}
                    value={state.value as string}
                    // Empty: the default collector, so the field is removed.
                    onChange={(url) =>
                      edit("analytics.collector", url === "" ? undefined : url)
                    }
                  />
                ),
                analyticsOff,
              )}
            </SettingsCard>
          </SettingsSection>
        </div>
      </ScrollArea>
    </div>
  );
}

const RATE_FIELDS = [
  "telemetry.errorSampleRate",
  "telemetry.traceSampleRate",
] as const;

type FieldValue = Extract<CmsSettingsFieldState, { kind: "value" }>;

interface RowProps {
  label: string;
  help: string;
  /** Off while the switch it depends on is off. */
  disabled: boolean;
}

/** A row's ids: its control, and the help and error that describe it. */
function useRowIds() {
  const id = useId();
  return { control: id, help: `${id}-help`, error: `${id}-error` };
}
type RowIds = ReturnType<typeof useRowIds>;

/** What a row's control is described by: its help, and its error when shown. */
function describedBy(ids: RowIds, error: string | null | undefined) {
  return error ? `${ids.help} ${ids.error}` : ids.help;
}

function FieldRow({
  ids,
  label,
  help,
  disabled,
  error,
  control,
}: RowProps & {
  ids: RowIds;
  error?: string | null;
  control: ReactNode;
}) {
  return (
    <SettingsCardItem
      className={cn(disabled && "opacity-60")}
      title={<Label htmlFor={ids.control}>{label}</Label>}
      description={<span id={ids.help}>{help}</span>}
      action={control}
    >
      {error && (
        <p
          id={ids.error}
          role="alert"
          className="mt-1 text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </SettingsCardItem>
  );
}

function SwitchRow({
  checked,
  onChange,
  ...row
}: RowProps & { checked: boolean; onChange: (checked: boolean) => void }) {
  const ids = useRowIds();
  return (
    <FieldRow
      {...row}
      ids={ids}
      control={
        <Switch
          id={ids.control}
          aria-describedby={describedBy(ids, null)}
          checked={checked}
          disabled={row.disabled}
          onCheckedChange={onChange}
        />
      }
    />
  );
}

/**
 * A sample rate as a percentage: 0.05 shows as 5, and what is typed is
 * stored as a rate (5 → 0.05) once it is a number from 0 to 100.
 */
function RateRow({
  rate,
  onChange,
  ...row
}: RowProps & { rate: number; onChange: (rate: number) => void }) {
  const t = useT();
  const ids = useRowIds();
  // What is typed, until the field is left (a half-typed "0." stays).
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? String(rateToPercent(rate));
  // Emptied to type a new number: not an error, and leaving it empty
  // brings the saved percentage back.
  const invalid =
    text !== null && text.trim() !== "" && percentToRate(text) === null;
  const error = invalid ? t("sandbox.cmsSettingsPage.invalidRate") : null;
  return (
    <FieldRow
      {...row}
      ids={ids}
      error={error}
      control={
        <InputGroup size="sm" className="w-28">
          <InputGroupInput
            id={ids.control}
            aria-describedby={describedBy(ids, error)}
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.1}
            value={shown}
            disabled={row.disabled}
            aria-invalid={invalid || undefined}
            className="text-right tabular-nums"
            onChange={(e) => {
              const next = e.target.value;
              setText(next);
              const parsed = percentToRate(next);
              if (parsed !== null && parsed !== rate) onChange(parsed);
            }}
            onBlur={() => {
              if (!invalid) setText(null);
            }}
          />
          <InputGroupAddon className="pr-2 text-muted-foreground">
            %
          </InputGroupAddon>
        </InputGroup>
      }
    />
  );
}

function CollectorRow({
  value,
  onChange,
  ...row
}: RowProps & { value: string; onChange: (url: string) => void }) {
  const t = useT();
  const ids = useRowIds();
  // What is typed: saved once it is empty or a full address.
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? value;
  const invalid = !isCollectorUrl(shown);
  const error = invalid ? t("sandbox.cmsSettingsPage.invalidUrl") : null;
  return (
    <FieldRow
      {...row}
      ids={ids}
      error={error}
      control={
        <Input
          id={ids.control}
          aria-describedby={describedBy(ids, error)}
          type="url"
          size="sm"
          className="w-64"
          value={shown}
          disabled={row.disabled}
          aria-invalid={invalid || undefined}
          placeholder={t(
            "sandbox.cmsSettingsPage.analytics.collector.placeholder",
          )}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            if (isCollectorUrl(next) && next.trim() !== value) {
              onChange(next.trim());
            }
          }}
        />
      }
    />
  );
}
