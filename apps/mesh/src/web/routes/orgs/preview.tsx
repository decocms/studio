import { PreviewChat, PreviewView } from "@/web/views/deco-redesign/preview";

export default function PreviewRoute() {
  return (
    <div className="flex-1 min-h-0 pb-1 pr-1 pl-0 pt-0">
      <div className="h-full p-0.5 pt-0.25">
        <div className="relative flex h-full overflow-hidden bg-background card-shadow rounded-[0.75rem]">
          {/* Preview is the main panel; chat opens beside it */}
          <div className="min-w-0 flex-1">
            <PreviewView />
          </div>
          <PreviewChat />
        </div>
      </div>
    </div>
  );
}
