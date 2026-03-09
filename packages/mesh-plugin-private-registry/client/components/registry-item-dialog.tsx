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
import { useProjectContext } from "@decocms/mesh-sdk";
import { ImageUpload } from "./image-upload.tsx";
import { ToolsEditor } from "./tools-editor.tsx";
import { useImageUpload } from "../hooks/use-image-upload";
import { useAIGenerate } from "../hooks/use-ai-generate";
import { useDiscoverTools } from "../hooks/use-discover-tools";
import type {
  RegistryCreateInput,
  RegistryItem,
  RegistryToolMeta,
  RegistryUpdateInput,
} from "../lib/types";

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
  defaultLLMConnectionId?: string;
  defaultLLMModelId?: string;
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

const STEP_LABELS = ["Essentials", "Details", "Advanced"] as const;
type WizardStep = 1 | 2 | 3;

const AI_BUTTON_CLASS =
  "h-7 text-xs border-green-500/30 text-green-600 dark:text-green-400 shadow-[0_0_8px_rgba(34,197,94,0.3)] hover:shadow-[0_0_14px_rgba(34,197,94,0.5)] hover:border-green-500/50 transition-all";

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
  return (
    <div className="flex items-center gap-1.5">
      {STEP_LABELS.map((label, idx) => {
        const stepNum = (idx + 1) as WizardStep;
        const isActive = stepNum === current;
        const isDone = stepNum < current;
        return (
          <div key={label} className="flex items-center gap-1.5">
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
              <span className="hidden sm:inline">{label}</span>
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
  label,
  values,
  availableOptions,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  values: string[];
  availableOptions: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}) {
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
      <Label htmlFor={id}>{label}</Label>
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
              placeholder={selectedValues.length ? "" : placeholder}
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
                Create &quot;{createFromQuery}&quot;
              </button>
            ) : (
              <div className="px-2.5 py-1.5 text-sm text-muted-foreground">
                Type to search or create.
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
  const [input, setInput] = useState(value);
  const [isFocused, setIsFocused] = useState(false);

  // Sync internal input when value changes externally (e.g. AI suggestion)
  const prevValue = useRef(value);
  if (prevValue.current !== value) {
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
      <Label htmlFor={id}>Category</Label>
      <div className="relative">
        <Input
          id={id}
          className="h-9 text-sm"
          placeholder="Select or create category"
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
            clear
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
                Create &quot;{currentToken}&quot;
              </button>
            ) : (
              <div className="px-2.5 py-1.5 text-sm text-muted-foreground">
                Type to search or create.
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
  defaultLLMConnectionId = "",
  defaultLLMModelId = "",
  isSubmitting = false,
  onSubmit,
}: RegistryItemDialogProps) {
  const { org } = useProjectContext();
  const { uploadImage, isUploading } = useImageUpload();
  const { generate, loadingType } = useAIGenerate();
  const { discover, discoverStatus, discoverError, resetDiscover } =
    useDiscoverTools();
  const isEdit = Boolean(item);
  const draftMeta = draft?._meta?.["mcp.mesh"];

  const initialTitle = item?.title ?? draft?.title ?? "";
  const initialProvider =
    item?.id?.split("/")[0] ?? draft?.id?.split("/")[0] ?? "";
  const initialDescription = item?.description ?? draft?.description ?? "";
  const initialShortDescription =
    item?._meta?.["mcp.mesh"]?.short_description ??
    draftMeta?.short_description ??
    "";
  const initialOwner =
    item?._meta?.["mcp.mesh"]?.owner ?? draftMeta?.owner ?? "";
  const initialRepositoryUrl =
    item?.server?.repository?.url ?? draft?.server?.repository?.url ?? "";
  const initialReadme =
    item?._meta?.["mcp.mesh"]?.readme ?? draftMeta?.readme ?? "";
  const initialReadmeUrl =
    item?._meta?.["mcp.mesh"]?.readme_url ?? draftMeta?.readme_url ?? "";
  const initialRemoteHost = parseRemoteInput(
    item?.server?.remotes?.[0]?.url ?? draft?.server?.remotes?.[0]?.url ?? "",
  );
  const initialRemoteType =
    item?.server?.remotes?.[0]?.type ??
    draft?.server?.remotes?.[0]?.type ??
    "http";
  const initialTags = item?._meta?.["mcp.mesh"]?.tags ?? draftMeta?.tags ?? [];
  const initialCategory =
    item?._meta?.["mcp.mesh"]?.categories?.[0] ??
    draftMeta?.categories?.[0] ??
    "";
  const initialImageUrl =
    item?.server?.icons?.[0]?.src ?? draft?.server?.icons?.[0]?.src ?? "";
  const initialTools =
    item?._meta?.["mcp.mesh"]?.tools ?? draftMeta?.tools ?? [];
  const initialIsPublic = item?.is_public ?? draft?.is_public ?? false;
  const initialIsVerified =
    item?._meta?.["mcp.mesh"]?.verified ?? draftMeta?.verified ?? false;
  const initialIsOfficial =
    item?._meta?.["mcp.mesh"]?.official ?? draftMeta?.official ?? false;

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
  const [readmeMode, setReadmeMode] = useState<"link" | "content" | "generate">(
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
  const hasAIConfigured = Boolean(defaultLLMConnectionId && defaultLLMModelId);

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
        imageUrl: "Failed to upload image. Please try again.",
      }));
    }
  };

  /* ── discover tools from step 1 ── */
  const discoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDiscoveredUrlRef = useRef<string>("");
  // Keep a ref to remoteType so the debounced callback always reads the latest value
  const remoteTypeRef = useRef(remoteType);
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

  /* ── AI helpers ── */
  const ensureAIConfig = () => {
    if (!hasAIConfigured) return null;
    return {
      llmConnectionId: defaultLLMConnectionId,
      modelId: defaultLLMModelId,
    };
  };

  const buildAIContext = () => ({
    name: title.trim(),
    provider: provider.trim(),
    url: normalizeRemoteUrl(remoteHost),
    owner: owner.trim(),
    repositoryUrl: repositoryUrl.trim(),
    description: description.trim(),
    shortDescription: shortDescription.trim(),
    tags,
    categories: category ? [category] : [],
    availableTags: [...DEFAULT_TAGS, ...availableTags],
    availableCategories: [...DEFAULT_CATEGORIES, ...availableCategories],
    tools,
  });

  const handleGenerateDescription = async () => {
    const config = ensureAIConfig();
    if (!config) return;
    const output = await generate({
      ...config,
      type: "description",
      context: buildAIContext(),
    });
    if (output.result) setDescription(output.result.slice(0, 1500));
  };

  const handleGenerateShortDescription = async () => {
    const config = ensureAIConfig();
    if (!config) return;
    const output = await generate({
      ...config,
      type: "short_description",
      context: buildAIContext(),
    });
    if (output.result) setShortDescription(output.result.slice(0, 160));
  };

  const handleSuggestTags = async () => {
    const config = ensureAIConfig();
    if (!config) return;
    const output = await generate({
      ...config,
      type: "tags",
      context: buildAIContext(),
    });
    if (output.items?.length) setTags(normalizeOptions(output.items));
  };

  const handleSuggestCategory = async () => {
    const config = ensureAIConfig();
    if (!config) return;
    const output = await generate({
      ...config,
      type: "categories",
      context: buildAIContext(),
    });
    if (output.items?.[0]) setCategory(normalizeOptionValue(output.items[0]));
  };

  const handleGenerateReadme = async () => {
    const config = ensureAIConfig();
    if (!config) return;
    const output = await generate({
      ...config,
      type: "readme",
      context: buildAIContext(),
    });
    if (output.result) {
      setReadme(output.result.slice(0, 50000));
      setReadmeMode("content");
    }
  };

  /* ── per-step validation ── */
  const validateStep = (s: WizardStep): boolean => {
    const nextErrors: Record<string, string | undefined> = {};

    if (s === 1) {
      const normalizedProvider = normalizeIdentifierSegment(provider);
      const normalizedNameSegment = normalizeIdentifierSegment(title);
      const generatedId = `${normalizedProvider}/${normalizedNameSegment}`;

      if (!title.trim()) nextErrors.title = "Name is required.";
      if (!isEdit) {
        if (!normalizedProvider) nextErrors.provider = "Provider is required.";
        else if (!normalizedNameSegment)
          nextErrors.title = "Name must contain valid characters.";
        else if (!ID_PATTERN.test(generatedId))
          nextErrors.provider =
            "Use lowercase letters/numbers and separators '/' or '-'.";
      }

      const normalizedRemoteUrl = normalizeRemoteUrl(remoteHost);
      const normalizedRemoteType = remoteType.trim().toLowerCase();
      if (normalizedRemoteType !== "stdio" && normalizedRemoteUrl) {
        try {
          const parsed = new URL(normalizedRemoteUrl);
          if (!["http:", "https:"].includes(parsed.protocol))
            nextErrors.remoteUrl = "Remote URL must be http(s).";
        } catch {
          nextErrors.remoteUrl = "Remote URL is invalid.";
        }
      }
      if (normalizedRemoteType && !REMOTE_TYPES.has(normalizedRemoteType))
        nextErrors.remoteType = "Remote type must be: http, sse or stdio.";

      if (imageUrl.trim()) {
        const isDataUrl = imageUrl.trim().startsWith("data:image/");
        if (!isDataUrl) {
          try {
            const parsed = new URL(imageUrl.trim());
            if (!["http:", "https:"].includes(parsed.protocol))
              nextErrors.imageUrl = "Image URL must be http(s).";
          } catch {
            nextErrors.imageUrl = "Image URL is invalid.";
          }
        }
      }
    }

    if (s === 2) {
      if (description.length > 1500)
        nextErrors.description = "Description must be 1500 characters or less.";
      if (shortDescription.trim().length > 160)
        nextErrors.shortDescription =
          "Short description must be 160 characters or less.";
    }

    if (s === 3) {
      const parsedReadmeUrl = readmeUrl.trim();
      if (parsedReadmeUrl) {
        try {
          const parsed = new URL(parsedReadmeUrl);
          if (!["http:", "https:"].includes(parsed.protocol))
            nextErrors.readmeUrl = "README URL must be http(s).";
        } catch {
          nextErrors.readmeUrl = "README URL is invalid.";
        }
      }
      if (readme.trim().length > 50000)
        nextErrors.readme = "README must be 50 000 characters or less.";
      const normalizedRepositoryUrl = repositoryUrl.trim();
      if (normalizedRepositoryUrl) {
        try {
          const parsed = new URL(normalizedRepositoryUrl);
          if (!["http:", "https:"].includes(parsed.protocol))
            nextErrors.repositoryUrl = "Repository URL must be http(s).";
        } catch {
          nextErrors.repositoryUrl = "Repository URL is invalid.";
        }
      }
    }

    setErrors(nextErrors);
    return Object.values(nextErrors).every((v) => v === undefined);
  };

  const handleNext = () => {
    if (!validateStep(step)) return;
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
      _meta: {
        "mcp.mesh": {
          verified: isVerified,
          official: isOfficial,
          tags: parsedTags,
          categories: parsedCategories,
          short_description: parsedShortDescription || null,
          owner: parsedOwner || null,
          readme: parsedReadme || null,
          readme_url: parsedReadmeUrl || null,
          ...(tools.length > 0 ? { tools } : {}),
        },
      },
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
          <Label htmlFor="registry-item-provider">Provider</Label>
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
              Item ID:{" "}
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
          <Label htmlFor="registry-item-title">Name</Label>
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
        <Label htmlFor="registry-remote-url">Remote URL</Label>
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
              <SelectValue placeholder="Type" />
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
                ? "Discovering tools..."
                : tools.length > 0
                  ? "Re-discover tools"
                  : "Discover tools from URL"}
            </Button>
            {tools.length > 0 && discoverStatus !== "loading" && (
              <span className="text-xs text-muted-foreground">
                {tools.length} tool{tools.length !== 1 ? "s" : ""} loaded
              </span>
            )}
          </div>

          {discoverStatus === "success" && tools.length > 0 && (
            <div className="rounded-lg border border-green-500/20 bg-green-50 dark:bg-green-950/20 px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400">
                <CheckCircle size={14} className="shrink-0" />
                <span className="font-medium">
                  {tools.length} tool{tools.length !== 1 ? "s" : ""} discovered
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
                    +{tools.length - 8} more
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground">
                These tools will enrich AI-generated descriptions, tags and
                categories in the next step.
              </p>
            </div>
          )}

          {discoverStatus === "auth_required" && discoverError && (
            <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 border border-amber-500/20 rounded-lg px-3 py-2">
              <AlertCircle size={14} className="shrink-0" />
              <span>
                This server requires authentication. The connection is valid but
                tools cannot be listed without credentials.
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
            Short Description
          </Label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {shortDescription.length}/160
            </span>
            {hasAIConfigured && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={AI_BUTTON_CLASS}
                disabled={loadingType === "short_description"}
                onClick={handleGenerateShortDescription}
              >
                {loadingType === "short_description"
                  ? "Generating..."
                  : "AI Generate"}
              </Button>
            )}
          </div>
        </div>
        <Input
          id="registry-item-short-description"
          className="h-9 text-sm"
          placeholder="Short summary for the store card"
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
          <Label htmlFor="registry-item-description">Description</Label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {description.length}/1500
            </span>
            {hasAIConfigured && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={AI_BUTTON_CLASS}
                disabled={loadingType === "description"}
                onClick={handleGenerateDescription}
              >
                {loadingType === "description"
                  ? "Generating..."
                  : "AI Generate"}
              </Button>
            )}
          </div>
        </div>
        <Textarea
          id="registry-item-description"
          className="text-sm max-h-28 overflow-y-auto resize-none"
          placeholder="Brief description of this MCP server"
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
          {hasAIConfigured && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(AI_BUTTON_CLASS, "justify-self-start")}
              disabled={loadingType === "categories"}
              onClick={handleSuggestCategory}
            >
              {loadingType === "categories" ? "Suggesting..." : "AI Suggest"}
            </Button>
          )}
        </div>
        <div className="grid content-start gap-2">
          <TagSelector
            id="registry-tags"
            label="Tags"
            values={tags}
            availableOptions={[...DEFAULT_TAGS, ...availableTags]}
            placeholder="Type and press Enter or comma"
            onChange={setTags}
          />
          {hasAIConfigured && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(AI_BUTTON_CLASS, "justify-self-start")}
              disabled={loadingType === "tags"}
              onClick={handleSuggestTags}
            >
              {loadingType === "tags" ? "Suggesting..." : "AI Suggest"}
            </Button>
          )}
        </div>
      </div>

      {/* Public toggle */}
      <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3">
        <div className="grid gap-0.5">
          <Label htmlFor="registry-is-public" className="text-sm">
            Public
          </Label>
          <p className="text-xs text-muted-foreground">
            Make this MCP visible in the public store URL.
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
            Verified
          </Label>
          <p className="text-xs text-muted-foreground">
            Curated and approved by deco.
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
            Official
          </Label>
          <p className="text-xs text-muted-foreground">
            Made and hosted by the service provider.
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
          <Label htmlFor="registry-item-owner">Owner (optional)</Label>
          <Input
            id="registry-item-owner"
            className="h-9 text-sm"
            placeholder="Team, company, or responsible person"
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="registry-item-repository-url">
            Repository URL (optional)
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
          <Label>README</Label>
          <span className="text-xs text-muted-foreground">
            {readme.length}/50000
          </span>
        </div>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          {(hasAIConfigured
            ? (["link", "content", "generate"] as const)
            : (["link", "content"] as const)
          ).map((mode) => (
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
                ? "Link"
                : mode === "content"
                  ? "Content"
                  : "Generate"}
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

        {hasAIConfigured && readmeMode === "generate" && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border p-3">
            <p className="text-xs text-muted-foreground">
              Generates a README using name, description, tools, category and
              tags as context.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={AI_BUTTON_CLASS}
              disabled={loadingType === "readme"}
              onClick={handleGenerateReadme}
            >
              {loadingType === "readme" ? "Generating..." : "Generate with AI"}
            </Button>
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
            {isEdit ? "Edit MCP Server" : "Add MCP Server"}
          </DialogTitle>
          <StepIndicator current={step} />
          <DialogDescription>
            {step === 1 &&
              "Set up the identity, connection and discover available tools."}
            {step === 2 &&
              "Add descriptions, categories and tags to help discovery."}
            {step === 3 && "Configure optional metadata, README and tools."}
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
                Back
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
              Cancel
            </Button>
            {step < 3 ? (
              <Button size="sm" onClick={handleNext}>
                Next
                <ArrowRight size={14} />
              </Button>
            ) : (
              <Button size="sm" onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting
                  ? "Saving..."
                  : isEdit
                    ? "Save changes"
                    : "Create"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
