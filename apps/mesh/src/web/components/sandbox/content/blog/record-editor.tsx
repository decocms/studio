import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { ImageField } from "@/web/components/sections-editor/fields/image-field";
import { buildBlogBlock, getBlogPayload, type BlogKind } from "./blog-data";
import { str } from "./blocks/primitives";
import { useSaveBlogBlock } from "./use-blog-mutations";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";

type RecordKind = Extract<BlogKind, "authors" | "categories">;

interface FieldDef {
  key: string;
  label: string;
  widget: "text" | "textarea" | "image";
  placeholder?: string;
}

const FIELDS: Record<RecordKind, FieldDef[]> = {
  authors: [
    { key: "name", label: "Name", widget: "text" },
    {
      key: "email",
      label: "Email",
      widget: "text",
      placeholder: "author@example.com",
    },
    { key: "jobTitle", label: "Job title", widget: "text" },
    { key: "company", label: "Company", widget: "text" },
    { key: "avatar", label: "Avatar", widget: "image" },
  ],
  categories: [
    { key: "name", label: "Name", widget: "text" },
    { key: "slug", label: "Slug", widget: "text", placeholder: "my-category" },
  ],
};

const TITLE: Record<RecordKind, string> = {
  authors: "Author",
  categories: "Category",
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
  const save = useSaveBlogBlock({ orgSlug, virtualMcpId, branch });
  const initial = getBlogPayload(block, kind);

  const [payload, setPayload] = useAutosave(initial, (next) => {
    save.mutate({ blockKey, data: buildBlogBlock(blockKey, kind, next) });
  });

  const setField = (key: string, value: unknown) =>
    setPayload({ ...payload, [key]: value });

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-6">
        <span className="text-sm font-medium">{TITLE[kind]}</span>
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
                    title: field.label,
                  }}
                  value={payload[field.key]}
                  onChange={(v) => setField(field.key, v)}
                  path={field.key}
                  label={field.label}
                />
              ) : (
                <>
                  <Label htmlFor={field.key}>{field.label}</Label>
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
                      placeholder={field.placeholder}
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
