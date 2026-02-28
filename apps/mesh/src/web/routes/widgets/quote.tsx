import { useWidget } from "./use-widget.ts";

type QuoteArgs = { text?: string; author?: string };

export default function Quote() {
  const { args } = useWidget<QuoteArgs>();

  if (!args) return null;

  const { text = "", author = "Unknown" } = args;

  return (
    <div className="p-4 font-sans">
      <blockquote className="border-l-4 border-primary pl-4">
        <p className="text-sm italic text-foreground leading-relaxed">
          "{text}"
        </p>
        {author && (
          <footer className="mt-2 text-xs text-muted-foreground">
            — {author}
          </footer>
        )}
      </blockquote>
    </div>
  );
}
