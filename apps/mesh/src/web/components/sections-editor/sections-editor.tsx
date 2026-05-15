import { useState } from "react";
import { Loading01 } from "@untitledui/icons";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { toast } from "sonner";
import { useDecofile } from "./use-decofile";
import { useLiveMeta } from "./use-live-meta";
import { useSaveBlock } from "./use-save-block";
import { PageList, extractPages } from "./page-list";
import { SectionList } from "./section-list";
import { SchemaForm } from "./schema-form";
import { SaveBar } from "./save-bar";
import { resolveSchema } from "./resolve-schema";

interface SectionData {
  __resolveType: string;
  [key: string]: unknown;
}

/**
 * Side panel for editing deco.cx page sections.
 * Renders page/section navigation and a schema-driven form.
 * Meant to be embedded alongside the preview iframe.
 */
export function SectionsEditor({
  previewUrl,
  orgSlug,
  virtualMcpId,
  branch,
  onNavigate,
}: {
  previewUrl: string;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  /** Called with the page path when a page is selected, so the parent can navigate the iframe. */
  onNavigate?: (path: string) => void;
}) {
  const { data: decofile, isLoading: decofileLoading } =
    useDecofile(previewUrl);
  const { data: meta, isLoading: metaLoading } = useLiveMeta(previewUrl);

  const [selectedPageKey, setSelectedPageKey] = useState<string | null>(null);
  const [selectedSectionIndex, setSelectedSectionIndex] = useState<
    number | null
  >(null);
  const [formValue, setFormValue] = useState<Record<string, unknown> | null>(
    null,
  );
  const [originalValue, setOriginalValue] = useState<string>("");

  const saveBlock = useSaveBlock({ previewUrl, orgSlug, virtualMcpId, branch });

  if (decofileLoading || metaLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <Loading01 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!decofile || !meta) {
    return (
      <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
        Could not load site data.
      </div>
    );
  }

  const pages = extractPages(decofile);

  const selectedPage =
    selectedPageKey && decofile[selectedPageKey]
      ? (decofile[selectedPageKey] as { sections?: SectionData[] })
      : null;
  const sections: SectionData[] = selectedPage?.sections ?? [];

  const selectedSection =
    selectedSectionIndex !== null
      ? (sections[selectedSectionIndex] ?? null)
      : null;

  const resolvedSchema =
    selectedSection && meta
      ? resolveSchema(selectedSection.__resolveType, meta)
      : null;

  const isNamedBlock =
    selectedSection && !selectedSection.__resolveType.includes("/");
  const namedBlockData =
    isNamedBlock && selectedSection
      ? (decofile[selectedSection.__resolveType] as
          | Record<string, unknown>
          | undefined)
      : null;
  const namedBlockResolveType = namedBlockData?.__resolveType as
    | string
    | undefined;
  const namedBlockSchema =
    namedBlockResolveType && meta
      ? resolveSchema(namedBlockResolveType, meta)
      : null;

  const activeSchema = isNamedBlock ? namedBlockSchema : resolvedSchema;

  const handleSelectSection = (index: number) => {
    setSelectedSectionIndex(index);
    const section = sections[index];
    if (!section) return;

    const isNamed = !section.__resolveType.includes("/");
    const data = isNamed
      ? ((decofile[section.__resolveType] as Record<string, unknown>) ?? {})
      : section;

    setFormValue({ ...(data as Record<string, unknown>) });
    setOriginalValue(JSON.stringify(data));
  };

  const handleSelectPage = (key: string) => {
    setSelectedPageKey(key);
    setSelectedSectionIndex(null);
    setFormValue(null);
    setOriginalValue("");

    // Navigate the preview iframe to the page's path
    const page = pages.find((p) => p.key === key);
    if (page && onNavigate) {
      onNavigate(page.path);
    }
  };

  const dirty =
    formValue !== null && JSON.stringify(formValue) !== originalValue;

  const handleSave = () => {
    if (!formValue || selectedSectionIndex === null || !selectedSection) return;

    if (isNamedBlock) {
      saveBlock.mutate(
        { blockKey: selectedSection.__resolveType, data: formValue },
        {
          onSuccess: () => {
            setOriginalValue(JSON.stringify(formValue));
            toast.success("Block saved");
          },
          onError: (err) => toast.error(`Save failed: ${err.message}`),
        },
      );
    } else {
      if (!selectedPageKey) return;
      const pageData = {
        ...(decofile[selectedPageKey] as Record<string, unknown>),
      };
      const updatedSections = [...sections];
      updatedSections[selectedSectionIndex] = formValue as SectionData;
      pageData.sections = updatedSections;

      saveBlock.mutate(
        { blockKey: selectedPageKey, data: pageData },
        {
          onSuccess: () => {
            setOriginalValue(JSON.stringify(formValue));
            toast.success("Section saved");
          },
          onError: (err) => toast.error(`Save failed: ${err.message}`),
        },
      );
    }
  };

  const handleDiscard = () => {
    if (originalValue) {
      setFormValue(JSON.parse(originalValue));
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Pages */}
      <div className="px-3 py-2 border-b">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Pages
        </h3>
      </div>
      <ScrollArea className="max-h-40">
        <div className="p-2">
          <PageList
            pages={pages}
            selectedKey={selectedPageKey}
            onSelect={handleSelectPage}
          />
        </div>
      </ScrollArea>

      {/* Sections */}
      {selectedPageKey && (
        <>
          <div className="px-3 py-2 border-t border-b">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Sections
            </h3>
          </div>
          <ScrollArea className="max-h-40">
            <div className="p-2">
              <SectionList
                sections={sections}
                selectedIndex={selectedSectionIndex}
                onSelect={handleSelectSection}
              />
            </div>
          </ScrollArea>
        </>
      )}

      {/* Form */}
      <div className="flex-1 flex flex-col min-h-0 border-t">
        {activeSchema && formValue ? (
          <>
            <ScrollArea className="flex-1">
              <div className="p-4">
                <h2 className="text-sm font-semibold mb-4">
                  {activeSchema.title ??
                    selectedSection?.__resolveType ??
                    "Section"}
                </h2>
                <SchemaForm
                  schema={activeSchema}
                  value={formValue}
                  onChange={(val) =>
                    setFormValue(val as Record<string, unknown>)
                  }
                  basePath=""
                />
              </div>
            </ScrollArea>
            <SaveBar
              dirty={dirty}
              saving={saveBlock.isPending}
              onSave={handleSave}
              onDiscard={handleDiscard}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            {selectedPageKey
              ? "Select a section to edit"
              : "Select a page to get started"}
          </div>
        )}
      </div>
    </div>
  );
}
