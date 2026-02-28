import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { useWidget } from "./use-widget.ts";

type AvatarArgs = {
  name?: string;
  imageUrl?: string;
  status?: "online" | "offline" | "busy" | "away";
};

const STATUS_COLOR = {
  online: "bg-green-500",
  offline: "bg-gray-400",
  busy: "bg-red-500",
  away: "bg-yellow-500",
} as const;

function initials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export default function Avatar() {
  const { args } = useWidget<AvatarArgs>();
  const [imgError, setImgError] = useState(false);

  if (!args) return null;

  const { name = "User", imageUrl, status } = args;
  const showImg = imageUrl && !imgError;

  return (
    <div className="p-4 font-sans flex items-center gap-3">
      <div className="relative shrink-0">
        <div className="size-10 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
          {showImg ? (
            <img
              src={imageUrl}
              alt={name}
              onError={() => setImgError(true)}
              className="size-full object-cover"
            />
          ) : (
            <span className="text-sm font-semibold text-primary">
              {initials(name)}
            </span>
          )}
        </div>
        {status && (
          <span
            className={cn(
              "absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-background",
              STATUS_COLOR[status],
            )}
          />
        )}
      </div>
      <div>
        <div className="text-sm font-medium text-foreground">{name}</div>
        {status && (
          <div className="text-xs text-muted-foreground capitalize">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
