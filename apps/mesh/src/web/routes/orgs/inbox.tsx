import { InboxView } from "@/web/views/deco-redesign/inbox";

export default function InboxRoute() {
  return (
    <div className="flex-1 min-h-0 pb-1 pr-1 pl-0 pt-0">
      <div className="h-full p-0.5 pt-0.25">
        <div className="relative flex flex-col h-full bg-background overflow-hidden card-shadow rounded-[0.75rem]">
          <InboxView />
        </div>
      </div>
    </div>
  );
}
