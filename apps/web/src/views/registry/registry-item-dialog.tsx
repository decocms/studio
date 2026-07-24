import { useRef, useState } from "react";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Loading01,
  RefreshCcw01,
  X,
} from "@untitledui/icons";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { ImageUpload } from "./image-upload.tsx";
import { ToolsEditor } from "./tools-editor.tsx";
import { useImageUpload } from "@/hooks/registry/use-image-upload";
import { useDiscoverTools } from "@/hooks/registry/use-discover-tools";
import type {
  RegistryCreateInput,
  RegistryItem,
  RegistryToolMeta,
  RegistryUpdateInput,
} from "@/lib/registry/types";
import {
  getStudioMcpMetadata,
  withStudioMcpMetadata,
} from "@decocms/shared/registry/metadata";

type SubmitPayload =
  | RegistryCreateInput
  | { id: string; data: RegistryUpdateInput };

interface RegistryItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item?: RegistryItem | null;
  draft?: Partial<RegistryCreateInput> | null;
  availableTags?: string[];
  availableCategories?: string[];
  isSubmitting?: boolean;
  onSubmit: (payload: SubmitPayload) => Promise<void>;
}

const REMOTE_TYPES = new Set(["http", "sse", "stdio"]);
const ID_PATTERN = /^[a-z0-9]+(?:[/-][a-z0-9._-]+)*$/;
const DEFAULT_TAGS = [
  "internal",
  "automation",
  "support",
  "sales",
  "ops",
  "ai",
];
const DEFAULT_CATEGORIES = [
  "productivity",
  "communication",
  "customer-support",
  "development",
  "data",
  "operations",
];

const STEP_LABEL_KEYS = [
  "registry.registryItemDialog.essentials",
  "registry.registryItemDialog.details",
  "registry.registryItemDialog.advanced",
] as const;
type WizardStep = 1 | 2 | 3;

const AI_BUTTON_CLASS =
  "h-7 text-xs border-success/30 text-success shadow-[0_0_8px_color-mix(in_oklch,var(--success)_30%,transparent)] hover:shadow-[0_0_14px_color-mix(in_oklch,var(--success)_50%,transparent)] hover:border-success/50 transition-all";

function parseRemoteInput(value: string): string {
  return value.replace(/^https?:\/\//i, "").trim();
}

function normalizeRemoteUrl(rawInput: string): string {
  const input = rawInput.trim();
  if (!input) return "";
  if (/^https?:\/\//i.test(input)) {
    return input;
  }
  return `https://${input}`;
}

function normalizeOptionValue(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeOptions(values: string[]): string[] {
  return Array.from(
    new Set(
      values.map(normalizeOptionValue).filter((value) => value.length > 0),
    ),
  );
}

function normalizeIdentifierSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* ─── Step indicator ─── */
function StepIndicator({ current }: { current: WizardStep }) {
  const t = useT();
  return (
    <div className="flex items-center gap-1.5">
      {STEP_LABEL_KEYS.map((labelKey, idx) => {
        const stepNum = (idx + 1) as WizardStep;
        const isActive = stepNum === current;
        const isDone = stepNum < current;
        return (
          <div key={labelKey} className="flex items-center gap-1.5">
            {idx > 0 && (
              <div
                className={cn("w-4 h-px", isDone ? "bg-primary" : "bg-border")}
              />
            )}
            <div
              className={cn(
                "flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs transition-colors",
                isActive
                  ? "bg-primary/10 text-primary font-medium"
                  : isDone
                    ? "text-primary"
                    : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "size-5 rounded-full inline-flex items-center justify-center text-[10px] font-semibold shrink-0",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : isDone
                      ? "bg-primary/20 text-primary"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {stepNum}
              </span>
              <span className="hidden sm:inline">{t(labelKey)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Tag Selector ─── */
function TagSelector({
  id,
  labelKey,
  values,
  availableOptions,
  placeholderKey,
  onChange,
}: {
  id: string;
  labelKey: TranslationKey;
  values: string[];
  availableOptions: string[];
  placeholderKey: TranslationKey;
  onChange: (values: string[]) => void;
}) {
  const t = useT();
  const [input, setInput] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const normalizedAvailable = normalizeOptions(availableOptions);
  const selectedValues = normalizeOptions(values);
  const selectedSet = new Set(selectedValues);
  const currentToken = normalizeOptionValue(input);
  const filteredSuggestions = normalizedAvailable
    .filter((option) => !selectedSet.has(option))
    .filter((option) => (currentToken ? option.includes(currentToken) : true))
    .slice(0, 8);

  const addToken = (rawValue: string) => {
    const normalized = normalizeOptionValue(rawValue);
    if (!normalized || selectedSet.has(normalized)) return;
    onChange([...selectedValues, normalized]);
  };

  const removeToken = (value: string) => {
    onChange(selectedValues.filter((item) => item !== value));
  };

  const commitInputTokens = () => {
    const tokens = input
      .split(/[,\n;]/)
      .map(normalizeOptionValue)
      .filter(Boolean);
    if (tokens.length === 0) return;
    const next = [...selectedValues];
    for (const token of tokens) {
      if (!next.includes(token)) {
        next.push(token);
      }
    }
    onChange(next);
    setInput("");
  };

  const createFromQuery = currentToken;

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{t(labelKey)}</Label>
      <div className="relative">
        <div
          className="min-h-9 w-full rounded-xl border border-input bg-background px-2.5 py-1.5 text-sm focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]"
          onClick={() => {
            const element = document.getElementById(id);
            if (element instanceof HTMLInputElement) {
              element.focus();
            }
          }}
        >
          <div className="flex flex-wrap items-center gap-1">
            {selectedValues.map((value) => (
              <Badge
                key={`${id}-${value}`}
                variant="secondary"
                className="gap-1"
              >
                {value}
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    removeToken(value);
                  }}
                >
                  <X size={12} />
                </button>
              </Badge>
            ))}
            <input
              id={id}
              className="flex-1 min-w-[120px] bg-transparent outline-none border-none text-sm"
              placeholder={selectedValues.length ? "" : t(placeholderKey)}
              value={input}
              onFocus={() => setIsFocused(true)}
              onBlur={() => {
                setIsFocused(false);
                commitInputTokens();
              }}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === ",") {
                  event.preventDefault();
                  commitInputTokens();
                  return;
                }
                if (
                  event.key === "Backspace" &&
                  !input &&
                  selectedValues.length
                ) {
                  removeToken(selectedValues[selectedValues.length - 1] ?? "");
                }
              }}
            />
          </div>
        </div>

        {isFocused && (
          <div className="absolute z-50 mt-1 w-full rounded-xl border border-border bg-background shadow-lg max-h-56 overflow-y-auto">
            {filteredSuggestions.length > 0 ? (
              filteredSuggestions.map((option) => (
                <button
                  key={`${id}-suggestion-${option}`}
                  type="button"
                  className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-muted"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    addToken(option);
                    setInput("");
                  }}
                >
                  {option}
                </button>
              ))
            ) : createFromQuery ? (
              <button
                type="button"
                className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-muted"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  addToken(createFromQuery);
                  setInput("");
                }}
              >
                {t("registry.registryItemDialog.createTag", {
                  value: createFromQuery,
                })}
              </button>
            ) : (
              <div className="px-2.5 py-1.5 text-sm text-muted-foreground">
                {t("registry.registryItemDialog.typeToSearchOrCreate")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Category Select ─── */
function CategorySelect({
  id,
  value,
  availableOptions,
  onChange,
}: {
  id: string;
  value: string;
  availableOptions: string[];
  onChange: (value: string) => void;
}) {
  const t = useT();
  const [input, setInput] = useState(value);
  const [isFocused, setIsFocused] = useState(false);

  // Sync internal input when value changes externally (e.g. AI suggestion)
  const prevValue = useRef(value);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (prevValue.current !== value) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    prevValue.current = value;
    setInput(value);
  }
  const options = normalizeOptions([
    ...DEFAULT_CATEGORIES,
    ...availableOptions,
    value,
  ]).filter(Boolean);

  const currentToken = normalizeOptionValue(input);
  const filteredSuggestions = options
    .filter((option) => (currentToken ? option.includes(currentToken) : true))
    .slice(0, 8);

  const commitValue = (rawValue: string) => {
    const normalized = normalizeOptionValue(rawValue);
    onChange(normalized);
    setInput(normalized);
    setIsFocused(false);
  };

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{t("registry.registryItemDialog.category")}</Label>
      <div className="relative">
        <Input
          id={id}
          className="h-9 text-sm"
          placeholder={t("registry.registryItemDialog.selectOrCreateCategory")}
          value={input}
          onFocus={() => {
            setInput(value);
            setIsFocused(true);
          }}
          onBlur={() => {
            commitValue(input);
          }}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitValue(input);
            }
          }}
        />
        {value && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange("");
              setInput("");
            }}
          >
            {t("registry.registryItemDialog.clear")}
          </button>
        )}

        {isFocused && (
          <div className="absolute z-50 mt-1 w-full rounded-xl border border-border bg-background shadow-lg max-h-56 overflow-y-auto">
            {filteredSuggestions.length > 0 ? (
              filteredSuggestions.map((option) => (
                <button
                  key={`${id}-${option}`}
                  type="button"
                  className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-muted"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commitValue(option)}
                >
                  {option}
                </button>
              ))
            ) : currentToken ? (
              <button
                type="button"
                className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-muted"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commitValue(currentToken)}
              >
                {t("registry.registryItemDialog.createCategory", {
                  value: currentToken,
                })}
              </button>
            ) : (
              <div className="px-2.5 py-1.5 text-sm text-muted-foreground">
                {t("registry.registryItemDialog.typeToSearchOrCreate")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Main Dialog ─── */
export function RegistryItemDialog({
  open,
  onOpenChange,
  item,
  draft,
  availableTags = [],
  availableCategories = [],
  isSubmitting = false,
  onSubmit,
}: RegistryItemDialogProps) {
  const t = useT();
  const { org } = useProjectContext();
  const { uploadImage, isUploading } = useImageUpload();
  const { discover, discoverStatus, discoverError, resetDiscover } =
    useDiscoverTools();
  const isEdit = Boolean(item);
  const itemMeta = getStudioMcpMetadata(item?._meta);
  const draftMeta = getStudioMcpMetadata(draft?._meta);

  const initialTitle = item?.title ?? draft?.title ?? "";
  const initialProvider =
    item?.id?.split("/")[0] ?? draft?.id?.split("/")[0] ?? "";
  const initialDescription = item?.description ?? draft?.description ?? "";
  const initialShortDescription =
    itemMeta?.short_description ?? draftMeta?.short_description ?? "";
  const initialOwner = itemMeta?.owner ?? draftMeta?.owner ?? "";
  const initialRepositoryUrl =
    item?.server?.repository?.url ?? draft?.server?.repository?.url ?? "";
  const initialReadme = itemMeta?.readme ?? draftMeta?.readme ?? "";
  const initialReadmeUrl = itemMeta?.readme_url ?? draftMeta?.readme_url ?? "";
  const initialRemoteHost = parseRemoteInput(
    item?.server?.remotes?.[0]?.url ?? draft?.server?.remotes?.[0]?.url ?? "",
  );
  const initialRemoteType =
    item?.server?.remotes?.[0]?.type ??
    draft?.server?.remotes?.[0]?.type ??
    "http";
  const initialTags = itemMeta?.tags ?? draftMeta?.tags ?? [];
  const initialCategory =
    itemMeta?.categories?.[0] ?? draftMeta?.categories?.[0] ?? "";
  const initialImageUrl =
    item?.server?.icons?.[0]?.src ?? draft?.server?.icons?.[0]?.src ?? "";
  const initialTools = itemMeta?.tools ?? draftMeta?.tools ?? [];
  const initialIsPublic = item?.is_public ?? draft?.is_public ?? false;
  const initialIsVerified = itemMeta?.verified ?? draftMeta?.verified ?? false;
  const initialIsOfficial = itemMeta?.official ?? draftMeta?.official ?? false;

  /* ── wizard step ── */
  const [step, setStep] = useState<WizardStep>(1);

  /* ── form state ── */
  const [title, setTitle] = useState(initialTitle);
  const [provider, setProvider] = useState(initialProvider);
  const [description, setDescription] = useState(initialDescription);
  const [shortDescription, setShortDescription] = useState(
    initialShortDescription,
  );
  const [owner, setOwner] = useState(initialOwner);
  const [repositoryUrl, setRepositoryUrl] = useState(initialRepositoryUrl);
  const [readme, setReadme] = useState(initialReadme);
  const [readmeUrl, setReadmeUrl] = useState(initialReadmeUrl);
  const [readmeMode, setReadmeMode] = useState<"link" | "content">(
    initialReadme ? "content" : "link",
  );
  const [remoteHost, setRemoteHost] = useState(initialRemoteHost);
  const [remoteType, setRemoteType] = useState(initialRemoteType);
  const [tags, setTags] = useState<string[]>(initialTags);
  const [category, setCategory] = useState(initialCategory);
  const [imageUrl, setImageUrl] = useState(initialImageUrl);
  const [tools, setTools] = useState<RegistryToolMeta[]>(initialTools);
  const [isPublic, setIsPublic] = useState(initialIsPublic);
  const [isVerified, setIsVerified] = useState(initialIsVerified);
  const [isOfficial, setIsOfficial] = useState(initialIsOfficial);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  /* ── helpers ── */
  const resetForm = () => {
    setStep(1);
    setTitle(initialTitle);
    setProvider(initialProvider);
    setDescription(initialDescription);
    setShortDescription(initialShortDescription);
    setOwner(initialOwner);
    setRepositoryUrl(initialRepositoryUrl);
    setReadme(initialReadme);
    setReadmeUrl(initialReadmeUrl);
    setReadmeMode(initialReadme ? "content" : "link");
    setRemoteHost(initialRemoteHost);
    setRemoteType(initialRemoteType);
    setTags(initialTags);
    setCategory(initialCategory);
    setImageUrl(initialImageUrl);
    setTools(initialTools);
    setIsPublic(initialIsPublic);
    setIsVerified(initialIsVerified);
    setIsOfficial(initialIsOfficial);
    setErrors({});
    resetDiscover();
    lastDiscoveredUrlRef.current = "";
    if (discoverTimerRef.current) {
      clearTimeout(discoverTimerRef.current);
      discoverTimerRef.current = null;
    }
  };

  const handleImageUpload = async (file: File) => {
    if (!file) return;
    const itemId = isEdit ? item?.id : `${provider}/${title}`.toLowerCase();
    const sanitizedId = normalizeIdentifierSegment(itemId || "temp");
    const extension = file.name.split(".").pop() || "png";
    const imagePath = `registry/${org.id}/${sanitizedId}/icon.${extension}`;
    const url = await uploadImage(file, imagePath);

    if (url) {
      setImageUrl(url);
      setErrors((prev) => ({ ...prev, imageUrl: undefined }));
    } else {
      setErrors((prev) => ({
        ...prev,
        imageUrl: t("registry.registryItemDialog.failedToUploadImage"),
      }));
    }
  };

  /* ── discover tools from step 1 ── */
  const discoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDiscoveredUrlRef = useRef<string>("");
  // Keep a ref to remoteType so the debounced callback always reads the latest value
  const remoteTypeRef = useRef(remoteType);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  remoteTypeRef.current = remoteType;

  const handleOpenChange = (next: boolean) => {
    // Clear any pending discover timer when the dialog closes
    if (!next && discoverTimerRef.current) {
      clearTimeout(discoverTimerRef.current);
      discoverTimerRef.current = null;
    }
    onOpenChange(next);
    if (!next) {
      resetForm();
    }
  };

  const handleDiscoverTools = async () => {
    const url = normalizeRemoteUrl(remoteHost);
    if (!url) return;
    if (discoverTimerRef.current) {
      clearTimeout(discoverTimerRef.current);
      discoverTimerRef.current = null;
    }
    lastDiscoveredUrlRef.current = url;
    const discovered = await discover(url, remoteTypeRef.current);
    if (discovered) {
      setTools(discovered);
    }
  };

  const scheduleAutoDiscover = (host: string) => {
    if (discoverTimerRef.current) {
      clearTimeout(discoverTimerRef.current);
    }
    const url = normalizeRemoteUrl(host);
    if (!url || url === lastDiscoveredUrlRef.current) return;
    // Only auto-discover if it looks like a valid URL (has a dot)
    if (!host.includes(".")) return;
    discoverTimerRef.current = setTimeout(async () => {
      lastDiscoveredUrlRef.current = url;
      const discovered = await discover(url, remoteTypeRef.current);
      if (discovered) {
        setTools(discovered);
      }
    }, 800);
  };

  /* ── per-step validation ── */
  const validateStep = (s: WizardStep): boolean => {
    const nextErrors: Record<string, string | undefined> = {};

    if (s === 1) {
      const normalizedProvider = normalizeIdentifierSegment(provider);
      const normalizedNameSegment = normalizeIdentifierSegment(title);
      const generatedId = `${normalizedProvider}/${normalizedNameSegment}`;

      if (!title.trim())
        nextErrors.title = t("registry.registryItemDialog.nameIsRequired");
      if (!isEdit) {
        if (!normalizedProvider)
          nextErrors.provider = t(
            "registry.registryItemDialog.providerIsRequired",
          );
        else if (!normalizedNameSegment)
          nextErrors.title = t(
            "registry.registryItemDialog.nameMustContainValidCharacters",
          );
        else if (!ID_PATTERN.test(generatedId))
          nextErrors.provider = t(
            "registry.registryItemDialog.useValidIdFormat",
          );
      }

      const normalizedRemoteUrl = normalizeRemoteUrl(remoteHost);
      const normalizedRemoteType = remoteType.trim().toLowerCase();
      if (normalizedRemoteType !== "stdio" && normalizedRemoteUrl) {
        try {
          const parsed = new URL(normalizedRemoteUrl);
          if (!["http:", "https:"].includes(parsed.protocol))
            nextErrors.remoteUrl = t(
              "registry.registryItemDialog.remoteUrlMustBeHttps",
            );
        } catch {
          nextErrors.remoteUrl = t(
            "registry.registryItemDialog.remoteUrlIsInvalid",
          );
        }
      }
      if (normalizedRemoteType && !REMOTE_TYPES.has(normalizedRemoteType))
        nextErrors.remoteType = t(
          "registry.registryItemDialog.remoteTypeMustBe",
        );

      if (imageUrl.trim()) {
        const isDataUrl = imageUrl.trim().startsWith("data:image/");
        if (!isDataUrl) {
          try {
            const parsed = new URL(imageUrl.trim());
            if (!["http:", "https:"].includes(parsed.protocol))
              nextErrors.imageUrl = t(
                "registry.registryItemDialog.imageUrlMustBeHttps",
              );
          } catch {
            nextErrors.imageUrl = t(
              "registry.registryItemDialog.imageUrlIsInvalid",
            );
          }
        }
      }
    }

    if (s === 2) {
      if (description.length > 1500)
        nextErrors.description = t(
          "registry.registryItemDialog.descriptionMaxLength",
        );
      if (shortDescription.trim().length > 160)
        nextErrors.shortDescription = t(
          "registry.registryItemDialog.shortDescriptionMaxLength",
        );
    }

    if (s === 3) {
      const parsedReadmeUrl = readmeUrl.trim();
      if (parsedReadmeUrl) {
        try {
          const parsed = new URL(parsedReadmeUrl);
          if (!["http:", "https:"].includes(parsed.protocol))
            nextErrors.readmeUrl = t(
              "registry.registryItemDialog.readmeUrlMustBeHttps",
            );
        } catch {
          nextErrors.readmeUrl = t(
            "registry.registryItemDialog.readmeUrlIsInvalid",
          );
        }
      }
      if (readme.trim().length > 50000)
        nextErrors.readme = t("registry.registryItemDialog.readmeMaxLength");
      const normalizedRepositoryUrl = repositoryUrl.trim();
      if (normalizedRepositoryUrl) {
        try {
          const parsed = new URL(normalizedRepositoryUrl);
          if (!["http:", "https:"].includes(parsed.protocol))
            nextErrors.repositoryUrl = t(
              "registry.registryItemDialog.repositoryUrlMustBeHttps",
            );
        } catch {
          nextErrors.repositoryUrl = t(
            "registry.registryItemDialog.repositoryUrlIsInvalid",
          );
        }
      }
    }

    setErrors(nextErrors);
    return Object.values(nextErrors).every((v) => v === undefined);
  };

  const handleNext = () => {
    if (!validateStep(step)) return;
    if (step === 1 && discoverTimerRef.current) {
      // Leaving step 1 cancels any pending auto-discover so it can't
      // overwrite tools the user edits by hand later, on step 3.
      clearTimeout(discoverTimerRef.current);
      discoverTimerRef.current = null;
    }
    if (step < 3) setStep((step + 1) as WizardStep);
  };

  const handleBack = () => {
    if (step > 1) setStep((step - 1) as WizardStep);
  };

  /* ── submit (step 3) ── */
  const handleSubmit = async () => {
    if (!validateStep(3)) return;

    const normalizedTitle = title.trim();
    const normalizedProvider = normalizeIdentifierSegment(provider);
    const normalizedNameSegment = normalizeIdentifierSegment(normalizedTitle);
    const generatedId = `${normalizedProvider}/${normalizedNameSegment}`;
    const normalizedRemoteUrl = normalizeRemoteUrl(remoteHost);
    const normalizedRemoteType = remoteType.trim().toLowerCase();
    const normalizedImageUrl = imageUrl.trim();
    const normalizedRepositoryUrl = repositoryUrl.trim();
    const parsedShortDescription = shortDescription.trim();
    const parsedReadme = readme.trim();
    const parsedReadmeUrl = readmeUrl.trim();
    const parsedTags = normalizeOptions(tags);
    const parsedCategories = category ? [normalizeOptionValue(category)] : [];
    const fallbackEditName = item ? (item.server?.name ?? item.id) : "";
    const normalizedName = (isEdit ? fallbackEditName : generatedId).trim();
    const parsedDescription = description.trim();
    const parsedOwner = owner.trim();

    const commonData = {
      title: normalizedTitle,
      description: parsedDescription.length > 0 ? parsedDescription : null,
      is_public: isPublic,
      _meta: withStudioMcpMetadata(undefined, {
        verified: isVerified,
        official: isOfficial,
        tags: parsedTags,
        categories: parsedCategories,
        short_description: parsedShortDescription || null,
        owner: parsedOwner || null,
        readme: parsedReadme || null,
        readme_url: parsedReadmeUrl || null,
        ...(tools.length > 0 ? { tools } : {}),
      }),
      server: {
        name: normalizedName,
        title: normalizedTitle,
        description: parsedDescription || undefined,
        icons: normalizedImageUrl ? [{ src: normalizedImageUrl }] : [],
        repository: normalizedRepositoryUrl
          ? { url: normalizedRepositoryUrl }
          : undefined,
        remotes: normalizedRemoteUrl
          ? [
              {
                type: normalizedRemoteType || "http",
                url: normalizedRemoteUrl,
              },
            ]
          : [],
      },
    };

    if (isEdit && item) {
      await onSubmit({ id: item.id, data: commonData });
      onOpenChange(false);
      return;
    }

    await onSubmit({ id: generatedId, ...commonData });
    onOpenChange(false);
    resetForm();
  };

  /* ═══════════════════════════════════════════════════════
   *  STEP CONTENT
   * ═══════════════════════════════════════════════════════ */

  const stepEssentials = (
    <div className="grid grid-cols-2 gap-3">
      {/* Provider + Name */}
      <div className="row-span-2 grid gap-3 content-start">
        <div className="grid gap-1.5">
          <Label htmlFor="registry-item-provider">
            {t("registry.registryItemDialog.provider")}
          </Label>
          <Input
            id="registry-item-provider"
            className="h-9 text-sm"
            placeholder="acme"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            disabled={isEdit}
          />
          {!isEdit && (
            <p className="text-xs text-muted-foreground">
              {t("registry.registryItemDialog.itemId")}{" "}
              <span className="font-mono">
                {`${normalizeIdentifierSegment(provider) || "provider"}/${normalizeIdentifierSegment(title) || "name"}`}
              </span>
            </p>
          )}
          {errors.provider && (
            <p className="text-xs text-destructive">{errors.provider}</p>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="registry-item-title">
            {t("registry.registryItemDialog.name")}
          </Label>
          <Input
            id="registry-item-title"
            className="h-9 text-sm"
            placeholder="Internal MCP"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          {errors.title && (
            <p className="text-xs text-destructive">{errors.title}</p>
          )}
        </div>
      </div>

      {/* Image */}
      <div className="row-span-2 content-start">
        <ImageUpload
          value={imageUrl}
          onChange={(url) => {
            setImageUrl(url);
            setErrors((prev) => ({ ...prev, imageUrl: undefined }));
          }}
          onFileUpload={handleImageUpload}
          error={errors.imageUrl}
          isUploading={isUploading}
        />
      </div>

      {/* Remote URL + Type */}
      <div className="col-span-2 grid gap-1.5">
        <Label htmlFor="registry-remote-url">
          {t("registry.registryItemDialog.remoteUrl")}
        </Label>
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center rounded-xl border border-input px-3">
            <span className="text-xs font-semibold text-muted-foreground mr-1">
              https://
            </span>
            <input
              id="registry-remote-url"
              className="flex-1 h-9 bg-transparent outline-none text-sm"
              placeholder="example.com/mcp"
              value={remoteHost}
              onChange={(event) => {
                const parsed = parseRemoteInput(event.target.value);
                setRemoteHost(parsed);
                scheduleAutoDiscover(parsed);
              }}
            />
          </div>
          <Select value={remoteType} onValueChange={setRemoteType}>
            <SelectTrigger
              id="registry-remote-type"
              className="w-[90px] h-9 shrink-0"
            >
              <SelectValue
                placeholder={t("registry.registryItemDialog.type")}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
              <SelectItem value="stdio">stdio</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {errors.remoteUrl && (
          <p className="text-xs text-destructive">{errors.remoteUrl}</p>
        )}
        {errors.remoteType && (
          <p className="text-xs text-destructive">{errors.remoteType}</p>
        )}
      </div>

      {/* Discover tools inline */}
      {remoteHost.trim() && (
        <div className="col-span-2 space-y-2">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(AI_BUTTON_CLASS, "gap-1.5")}
              onClick={handleDiscoverTools}
              disabled={discoverStatus === "loading"}
            >
              {discoverStatus === "loading" ? (
                <Loading01 size={12} className="animate-spin" />
              ) : (
                <RefreshCcw01 size={12} />
              )}
              {discoverStatus === "loading"
                ? t("registry.registryItemDialog.discoveringTools")
                : tools.length > 0
                  ? t("registry.registryItemDialog.rediscoverTools")
                  : t("registry.registryItemDialog.discoverToolsFromUrl")}
            </Button>
            {tools.length > 0 && discoverStatus !== "loading" && (
              <span className="text-xs text-muted-foreground">
                {t("registry.registryItemDialog.toolsLoaded", {
                  count: tools.length.toString(),
                })}
              </span>
            )}
          </div>

          {discoverStatus === "success" && tools.length > 0 && (
            <div className="rounded-lg border border-success/20 bg-success/10 px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-success">
                <CheckCircle size={14} className="shrink-0" />
                <span className="font-medium">
                  {t("registry.registryItemDialog.toolsDiscovered", {
                    count: tools.length.toString(),
                  })}
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {tools.slice(0, 8).map((tool) => (
                  <Badge
                    key={tool.name}
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0 font-mono"
                  >
                    {tool.name}
                  </Badge>
                ))}
                {tools.length > 8 && (
                  <span className="text-[10px] text-muted-foreground self-center">
                    {t("registry.registryItemDialog.andMore", {
                      count: (tools.length - 8).toString(),
                    })}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground">
                {t("registry.registryItemDialog.toolsWillEnrich")}
              </p>
            </div>
          )}

          {discoverStatus === "auth_required" && discoverError && (
            <div className="flex items-center gap-2 text-xs text-warning bg-warning/10 border border-warning/20 rounded-lg px-3 py-2">
              <AlertCircle size={14} className="shrink-0" />
              <span>
                {t("registry.registryItemDialog.authRequiredMessage")}
              </span>
            </div>
          )}

          {discoverStatus === "error" && discoverError && (
            <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
              <AlertCircle size={14} className="shrink-0" />
              <span>{discoverError}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const stepDetails = (
    <div className="grid gap-3">
      {/* Short Description */}
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="registry-item-short-description">
            {t("registry.registryItemDialog.shortDescription")}
          </Label>
          <span className="text-xs text-muted-foreground">
            {shortDescription.length}/160
          </span>
        </div>
        <Input
          id="registry-item-short-description"
          className="h-9 text-sm"
          placeholder={t(
            "registry.registryItemDialog.shortSummaryForStoreCard",
          )}
          value={shortDescription}
          maxLength={160}
          onChange={(event) => setShortDescription(event.target.value)}
        />
        {errors.shortDescription && (
          <p className="text-xs text-destructive">{errors.shortDescription}</p>
        )}
      </div>

      {/* Description */}
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="registry-item-description">
            {t("registry.registryItemDialog.description")}
          </Label>
          <span className="text-xs text-muted-foreground">
            {description.length}/1500
          </span>
        </div>
        <Textarea
          id="registry-item-description"
          className="text-sm max-h-28 overflow-y-auto resize-none"
          placeholder={t("registry.registryItemDialog.briefDescription")}
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        {errors.description && (
          <p className="text-xs text-destructive">{errors.description}</p>
        )}
      </div>

      <div className="border-t border-border" />

      {/* Category + Tags */}
      <div className="grid grid-cols-2 gap-3">
        <div className="grid content-start gap-2">
          <CategorySelect
            id="registry-category"
            value={category}
            availableOptions={availableCategories}
            onChange={setCategory}
          />
        </div>
        <div className="grid content-start gap-2">
          <TagSelector
            id="registry-tags"
            labelKey="registry.registryItemDialog.tags"
            values={tags}
            availableOptions={[...DEFAULT_TAGS, ...availableTags]}
            placeholderKey="registry.registryItemDialog.typeAndPressEnter"
            onChange={setTags}
          />
        </div>
      </div>

      {/* Public toggle */}
      <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
        <div className="grid gap-0.5">
          <Label htmlFor="registry-is-public" className="text-sm">
            {t("registry.registryItemDialog.public")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("registry.registryItemDialog.makeThisMcpVisible")}
          </p>
        </div>
        <Switch
          id="registry-is-public"
          checked={isPublic}
          onCheckedChange={setIsPublic}
        />
      </div>

      {/* Verified toggle */}
      <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
        <div className="grid gap-0.5">
          <Label htmlFor="registry-is-verified" className="text-sm">
            {t("registry.registryItemDialog.verified")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("registry.registryItemDialog.curatedAndApproved")}
          </p>
        </div>
        <Switch
          id="registry-is-verified"
          checked={isVerified}
          onCheckedChange={setIsVerified}
        />
      </div>

      {/* Official toggle */}
      <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
        <div className="grid gap-0.5">
          <Label htmlFor="registry-is-official" className="text-sm">
            {t("registry.registryItemDialog.official")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("registry.registryItemDialog.madeAndHostedByServiceProvider")}
          </p>
        </div>
        <Switch
          id="registry-is-official"
          checked={isOfficial}
          onCheckedChange={setIsOfficial}
        />
      </div>
    </div>
  );

  const stepAdvanced = (
    <div className="grid gap-3">
      {/* Owner + Repository */}
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="registry-item-owner">
            {t("registry.registryItemDialog.ownerOptional")}
          </Label>
          <Input
            id="registry-item-owner"
            className="h-9 text-sm"
            placeholder={t("registry.registryItemDialog.teamCompanyOrPerson")}
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="registry-item-repository-url">
            {t("registry.registryItemDialog.repositoryUrlOptional")}
          </Label>
          <Input
            id="registry-item-repository-url"
            className="h-9 text-sm"
            placeholder="https://github.com/org/repo"
            value={repositoryUrl}
            onChange={(event) => setRepositoryUrl(event.target.value)}
          />
          {errors.repositoryUrl && (
            <p className="text-xs text-destructive">{errors.repositoryUrl}</p>
          )}
        </div>
      </div>

      {/* README */}
      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <Label>{t("registry.registryItemDialog.readme")}</Label>
          <span className="text-xs text-muted-foreground">
            {readme.length}/50000
          </span>
        </div>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          {(["link", "content"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={cn(
                "px-2.5 py-1 text-xs rounded-md",
                readmeMode === mode
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground",
              )}
              onClick={() => setReadmeMode(mode)}
            >
              {mode === "link"
                ? t("registry.registryItemDialog.link")
                : t("registry.registryItemDialog.content")}
            </button>
          ))}
        </div>

        {readmeMode === "link" && (
          <div className="grid gap-1.5">
            <Input
              className="h-9 text-sm"
              placeholder="https://raw.githubusercontent.com/org/repo/main/README.md"
              value={readmeUrl}
              onChange={(event) => setReadmeUrl(event.target.value)}
            />
            {errors.readmeUrl && (
              <p className="text-xs text-destructive">{errors.readmeUrl}</p>
            )}
          </div>
        )}

        {readmeMode === "content" && (
          <div className="grid gap-1.5">
            <Textarea
              className="text-sm max-h-48 overflow-y-auto resize-none"
              placeholder="# README&#10;&#10;Describe your MCP here..."
              rows={6}
              value={readme}
              onChange={(event) => setReadme(event.target.value)}
            />
            {errors.readme && (
              <p className="text-xs text-destructive">{errors.readme}</p>
            )}
          </div>
        )}
      </div>

      {/* Tools */}
      <ToolsEditor
        tools={tools}
        onChange={setTools}
        remoteUrl={normalizeRemoteUrl(remoteHost) || undefined}
        remoteType={remoteType}
        externalDiscoverStatus={discoverStatus}
        externalDiscoverError={discoverError}
      />
    </div>
  );

  /* ═══════════════════════════════════════════════════════
   *  RENDER
   * ═══════════════════════════════════════════════════════ */
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[820px] max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="space-y-3">
          <DialogTitle>
            {isEdit
              ? t("registry.registryItemDialog.editMcpServer")
              : t("registry.registryItemDialog.addMcpServer")}
          </DialogTitle>
          <StepIndicator current={step} />
          <DialogDescription>
            {step === 1 && t("registry.registryItemDialog.step1Description")}
            {step === 2 && t("registry.registryItemDialog.step2Description")}
            {step === 3 && t("registry.registryItemDialog.step3Description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1 py-2">
          {step === 1 && stepEssentials}
          {step === 2 && stepDetails}
          {step === 3 && stepAdvanced}
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          <div>
            {step > 1 && (
              <Button variant="ghost" size="sm" onClick={handleBack}>
                <ArrowLeft size={14} />
                {t("registry.registryItemDialog.back")}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              {t("registry.registryItemDialog.cancel")}
            </Button>
            {step < 3 ? (
              <Button size="sm" onClick={handleNext}>
                {t("registry.registryItemDialog.next")}
                <ArrowRight size={14} />
              </Button>
            ) : (
              <Button size="sm" onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting
                  ? t("registry.registryItemDialog.saving")
                  : isEdit
                    ? t("registry.registryItemDialog.saveChanges")
                    : t("registry.registryItemDialog.create")}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
