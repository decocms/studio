import { cn } from "@deco/ui/lib/utils.ts";
import { ChevronRight } from "@untitledui/icons";

const FEATURED_ICONS = [
  { src: "/connections/github.png", name: "GitHub" },
  { src: "/connections/gmail.png", name: "Gmail" },
  { src: "/connections/linear.png", name: "Linear" },
  { src: "/connections/shopify.png", name: "Shopify" },
  { src: "/connections/firecrawl.png", name: "Firecrawl" },
  { src: "/connections/perplexity.png", name: "Perplexity" },
];

function FeaturedIcons() {
  return (
    <div className="flex items-center -space-x-1">
      {FEATURED_ICONS.map((icon) => (
        <img
          key={icon.name}
          src={icon.src}
          alt={icon.name}
          className="size-5 rounded-sm ring-2 ring-muted object-cover bg-white"
        />
      ))}
    </div>
  );
}

interface ConnectionsBannerProps {
  onClick: () => void;
}

export function ConnectionsBanner({ onClick }: ConnectionsBannerProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative z-10 flex items-center gap-3 w-full px-4 py-3",
        "rounded-b-2xl",
        "cursor-pointer",
      )}
    >
      <p className="flex-1 text-xs text-muted-foreground truncate text-left">
        Connect tools and get more done
      </p>

      <FeaturedIcons />

      <ChevronRight
        size={14}
        className="shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground transition-colors"
      />
    </button>
  );
}
