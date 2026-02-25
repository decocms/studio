import { useProjectBash } from "@/web/hooks/use-project-bash";
import { useGitPanel } from "@/web/hooks/use-git-panel";
import { useGitChangeCount } from "@/web/components/git-panel";
import { Button } from "@deco/ui/components/button.tsx";
import { Save01 } from "@untitledui/icons";

export function SaveChangesButton() {
  const { client, connectionId, connectionUrl } = useProjectBash();
  const [isOpen, setOpen] = useGitPanel();
  const changeCount = useGitChangeCount(client, connectionId, connectionUrl);

  if (!client) return null;

  return (
    <Button
      size="sm"
      variant={isOpen ? "default" : "outline"}
      onClick={() => setOpen(!isOpen)}
      className="h-7 gap-1.5 relative shadow-sm"
    >
      <Save01 size={14} />
      <span>{changeCount > 0 ? `${changeCount} changes` : "Save"}</span>
      {changeCount > 0 && !isOpen && (
        <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-yellow-500 border-2 border-background" />
      )}
    </Button>
  );
}
