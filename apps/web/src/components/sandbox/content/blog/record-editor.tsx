import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { ImageField } from "@/components/sections-editor/fields/image-field";
import { buildBlogBlock, getBlogPayload, type BlogKind } from "./blog-data";
import { str } from "./blocks/primitives";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";

type RecordKind = Extract<BlogKind, "authors">;

interface FieldDef {
  key: string;
  labelKey: TranslationKey;
  widget: "text" | "textarea" | "image" | "select";
  placeholderKey?: TranslationKey;
  /** Choices for the "select" widget; the first one is the display default. */
  options?: Array<{ value: string; labelKey: TranslationKey }>;
}

const FIELDS: Record<RecordKind, FieldDef[]> = {
  authors: [
    { key: "name", labelKey: "sandbox.recordEditor.fieldName", widget: "text" },
    {
      key: "type",
      labelKey: "sandbox.recordEditor.fieldType",
      widget: "select",
      options: [
        { value: "Person", labelKey: "sandbox.recordEditor.optionPerson" },
        {
          value: "Organization",
          labelKey: "sandbox.recordEditor.optionOrganization",
        },
      ],
    },
    {
      key: "email",
      labelKey: "sandbox.recordEditor.fieldEmail",
      widget: "text",
      placeholderKey: "sandbox.recordEditor.placeholderEmail",
    },
    {
      key: "jobTitle",
      labelKey: "sandbox.recordEditor.fieldJobTitle",
      widget: "text",
    },
    {
      key: "company",
      labelKey: "sandbox.recordEditor.fieldCompany",
      widget: "text",
    },
    {
      key: "avatar",
      labelKey: "sandbox.recordEditor.fieldAvatar",
      widget: "image",
    },
  ],
};

const TITLE: Record<RecordKind, TranslationKey> = {
  authors: "sandbox.recordEditor.titleAuthor",
};

export function RecordEditor({
  orgSlug,
  virtualMcpId,
  branch,
  kind,
  blockKey,
  block,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  kind: RecordKind;
  blockKey: string;
  block: Record<string, unknown> | undefined;
}) {
  const t = useT();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const initial = getBlogPayload(block, kind);

  const [payload, setPayload] = useAutosave(initial, (next) => {
    save.mutate({ blockKey, data: buildBlogBlock(blockKey, kind, next) });
  });

  const setField = (key: string, value: unknown) =>
    setPayload({ ...payload, [key]: value });

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
        <span className="text-sm font-medium">{t(TITLE[kind])}</span>
        <SaveStatus isPending={save.isPending} isError={save.isError} />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-xl space-y-6">
          {FIELDS[kind].map((field) => (
            <div key={field.key} className="space-y-2">
              {field.widget === "image" ? (
                <ImageField
                  schema={{
                    type: "string",
                    format: "image-uri",
                    title: t(field.labelKey),
                  }}
                  value={payload[field.key]}
                  onChange={(v) => setField(field.key, v)}
                  path={field.key}
                  label={t(field.labelKey)}
                />
              ) : field.widget === "select" ? (
                <>
                  <Label htmlFor={field.key}>{t(field.labelKey)}</Label>
                  <Select
                    value={str(payload[field.key]) || field.options?.[0]?.value}
                    onValueChange={(v) => setField(field.key, v)}
                  >
                    <SelectTrigger id={field.key} className="h-10 w-full">
                      <SelectValue placeholder={t(field.labelKey)} />
                    </SelectTrigger>
                    <SelectContent>
                      {(field.options ?? []).map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {t(option.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <>
                  <Label htmlFor={field.key}>{t(field.labelKey)}</Label>
                  {field.widget === "textarea" ? (
                    <Textarea
                      id={field.key}
                      value={str(payload[field.key])}
                      onChange={(e) => setField(field.key, e.target.value)}
                      rows={3}
                    />
                  ) : (
                    <Input
                      id={field.key}
                      value={str(payload[field.key])}
                      placeholder={
                        field.placeholderKey
                          ? t(field.placeholderKey)
                          : undefined
                      }
                      onChange={(e) => setField(field.key, e.target.value)}
                      className="h-10"
                    />
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
