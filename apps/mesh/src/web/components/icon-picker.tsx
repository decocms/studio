/**
 * Icon Picker
 *
 * Allows users to pick an icon + color from @untitledui/icons, upload an image,
 * or remove the current icon. Stores the selection as an icon:// URL string.
 */

import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Edit05, SearchMd, Shuffle01, Upload01 } from "@untitledui/icons";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  AGENT_ICON_COLORS,
  AgentAvatar,
  buildIconString,
  buildImageIconString,
  getIconColor,
  getIconComponent,
  getIconNames,
  humanizeIconName,
  parseIconString,
  type AgentAvatarSize,
} from "./agent-icon";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IconPickerProps {
  value: string | null | undefined;
  onChange: (icon: string | null) => void;
  name: string;
  size?: AgentAvatarSize;
  className?: string;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type PickerTab = "icons" | "upload";

// ---------------------------------------------------------------------------
// IconPicker
// ---------------------------------------------------------------------------

export function IconPicker({
  value,
  onChange,
  name,
  size = "lg",
  className,
}: IconPickerProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PickerTab>("icons");
  const [search, setSearch] = useState("");
  const [selectedColor, setSelectedColor] = useState(() => {
    const parsed = parseIconString(value);
    if (parsed.type === "icon") return parsed.color;
    if (parsed.type === "url" && parsed.color) return parsed.color;
    return "blue";
  });

  const handleSelectIcon = (iconName: string) => {
    onChange(buildIconString(iconName, selectedColor));
  };

  const handleColorChange = (color: string) => {
    setSelectedColor(color);
    const parsed = parseIconString(value);
    if (parsed.type === "icon") {
      onChange(buildIconString(parsed.name, color));
    } else if (parsed.type === "url") {
      // Persist color with image URL
      onChange(buildImageIconString(parsed.url, color));
    }
  };

  const handleUpload = (dataUrl: string) => {
    // Encode the current selected color into the image URL
    onChange(buildImageIconString(dataUrl, selectedColor));
    setOpen(false);
  };

  const handleRandomIcon = () => {
    const names = getIconNames();
    const randomName = names[Math.floor(Math.random() * names.length)]!;
    onChange(buildIconString(randomName, selectedColor));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("relative group cursor-pointer rounded-2xl", className)}
        >
          <AgentAvatar icon={value} name={name} size={size} />
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-2xl overflow-hidden">
            <Edit05 size={16} className="text-white" />
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col">
          {/* Preview */}
          <div className="flex items-center justify-center py-4">
            <AgentAvatar icon={value} name={name} size="xl" />
          </div>

          {/* Tab bar */}
          <div className="flex items-center border-b border-border px-3">
            <button
              type="button"
              onClick={() => setTab("icons")}
              className={cn(
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === "icons"
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              Icons
            </button>
            <button
              type="button"
              onClick={() => setTab("upload")}
              className={cn(
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === "upload"
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              Upload
            </button>
            <div className="flex-1" />
          </div>

          {/* Tab content */}
          {tab === "icons" ? (
            <IconsTab
              search={search}
              onSearchChange={setSearch}
              selectedColor={selectedColor}
              onColorChange={handleColorChange}
              onSelectIcon={handleSelectIcon}
              onRandom={handleRandomIcon}
              currentIconName={
                parseIconString(value).type === "icon"
                  ? (parseIconString(value) as { name: string }).name
                  : null
              }
            />
          ) : (
            <UploadTab onUpload={handleUpload} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Icons Tab
// ---------------------------------------------------------------------------

function ColorPickerDropdown({
  selectedColor,
  onColorChange,
}: {
  selectedColor: string;
  onColorChange: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const color = getIconColor(selectedColor);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "h-6 w-6 rounded-full shrink-0 ring-2 ring-offset-2 ring-offset-background transition-all cursor-pointer hover:scale-110",
            color.dot,
            "ring-foreground/20",
          )}
          title="Change color"
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        sideOffset={8}
        className="w-auto p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="grid grid-cols-4 gap-1">
          {AGENT_ICON_COLORS.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => {
                onColorChange(c.name);
                setOpen(false);
              }}
              className={cn(
                "h-5 w-5 rounded-full transition-all shrink-0 cursor-pointer",
                c.dot,
                selectedColor === c.name
                  ? "ring-2 ring-offset-1 ring-offset-background ring-foreground/30 scale-110"
                  : "hover:scale-110",
              )}
              title={c.name}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function IconsTab({
  search,
  onSearchChange,
  selectedColor,
  onColorChange,
  onSelectIcon,
  onRandom,
  currentIconName,
}: {
  search: string;
  onSearchChange: (s: string) => void;
  selectedColor: string;
  onColorChange: (color: string) => void;
  onSelectIcon: (name: string) => void;
  onRandom: () => void;
  currentIconName: string | null;
}) {
  const allNames = getIconNames();
  const color = getIconColor(selectedColor);

  const filteredNames = search.trim()
    ? allNames.filter((name) => {
        const humanized = humanizeIconName(name);
        const searchLower = search.toLowerCase();
        return (
          humanized.includes(searchLower) ||
          name.toLowerCase().includes(searchLower)
        );
      })
    : allNames;

  return (
    <div className="flex flex-col">
      {/* Search + controls */}
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="relative flex-1">
          <SearchMd
            size={14}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter..."
            className="h-8 text-xs pl-7"
          />
        </div>
        <button
          type="button"
          onClick={onRandom}
          className="h-8 w-8 flex items-center justify-center rounded-md border border-border hover:bg-accent transition-colors shrink-0"
          title="Random icon"
        >
          <Shuffle01 size={14} className="text-muted-foreground" />
        </button>
        <ColorPickerDropdown
          selectedColor={selectedColor}
          onColorChange={onColorChange}
        />
      </div>

      {/* Icon grid */}
      <ScrollArea className="h-56">
        <div className="grid grid-cols-9 gap-0.5 px-2 pb-2">
          {filteredNames.map((iconName) => {
            const IconComp = getIconComponent(iconName);
            if (!IconComp) return null;

            return (
              <button
                key={iconName}
                type="button"
                onClick={() => onSelectIcon(iconName)}
                className={cn(
                  "h-8 w-8 flex items-center justify-center rounded-md transition-colors cursor-pointer",
                  currentIconName === iconName
                    ? cn(color.bg, color.text)
                    : cn(color.text, "hover:bg-accent"),
                )}
                title={iconName}
              >
                <IconComp size={18} />
              </button>
            );
          })}
        </div>
        {filteredNames.length === 0 && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            No icons found
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload Tab
// ---------------------------------------------------------------------------

function UploadTab({ onUpload }: { onUpload: (dataUrl: string) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be smaller than 2MB");
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => {
      toast.error("Failed to read image file");
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.onloadend = () => {
      if (reader.readyState === FileReader.DONE && reader.result) {
        onUpload(reader.result as string);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.readAsDataURL(file);
  };

  const [pasteUrl, setPasteUrl] = useState("");

  const handleApplyUrl = () => {
    const trimmed = pasteUrl.trim();
    if (trimmed) {
      onUpload(trimmed);
      setPasteUrl("");
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4">
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept="image/*"
        onChange={handleFileChange}
      />

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="h-24 rounded-lg border-2 border-dashed border-border hover:border-foreground/50 hover:bg-accent/50 transition-colors flex flex-col items-center justify-center gap-2 text-muted-foreground hover:text-foreground"
      >
        <Upload01 size={20} />
        <span className="text-xs">Click to upload an image (max 2MB)</span>
      </button>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">or</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      <div className="flex items-center gap-1.5">
        <Input
          value={pasteUrl}
          onChange={(e) => setPasteUrl(e.target.value)}
          placeholder="Paste image URL..."
          className="h-8 text-xs flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleApplyUrl();
            }
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs shrink-0"
          onClick={handleApplyUrl}
          disabled={!pasteUrl.trim()}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}
