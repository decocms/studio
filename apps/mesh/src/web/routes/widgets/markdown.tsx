import { useWidget } from "./use-widget.ts";

type MarkdownArgs = { content?: string; title?: string };

/** Very lightweight markdown renderer supporting headers, bold, italic, code, and lists */
function renderMarkdown(md: string): string {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      /^### (.+)$/gm,
      '<h3 class="text-sm font-semibold text-foreground mt-3 mb-1">$1</h3>',
    )
    .replace(
      /^## (.+)$/gm,
      '<h2 class="text-base font-semibold text-foreground mt-4 mb-1">$1</h2>',
    )
    .replace(
      /^# (.+)$/gm,
      '<h1 class="text-lg font-bold text-foreground mt-4 mb-2">$1</h1>',
    )
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em class="italic">$1</em>')
    .replace(
      /`(.+?)`/g,
      '<code class="bg-muted px-1 py-0.5 rounded text-xs font-mono">$1</code>',
    )
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-sm">$1</li>')
    .replace(
      /^(\d+)\. (.+)$/gm,
      '<li class="ml-4 list-decimal text-sm">$2</li>',
    )
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, "<br/>");
}

export default function Markdown() {
  const { args } = useWidget<MarkdownArgs>();

  if (!args) return null;

  const { content = "", title } = args;

  return (
    <div className="p-4 font-sans">
      {title && (
        <div className="text-sm font-semibold text-foreground mb-3">
          {title}
        </div>
      )}
      <div
        className="text-sm text-foreground leading-relaxed prose-sm max-w-none"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: controlled markdown rendering
        dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
      />
    </div>
  );
}
