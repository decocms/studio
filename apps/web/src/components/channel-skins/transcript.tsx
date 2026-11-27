/**
 * A call's transcript: how far into the call on the left, the speaker in
 * their colour, what they said. Ours (tokens), not a borrowed look: a call
 * is read here like a document. In the order it was said.
 *
 * What was said by one person in a row sits under one name (a run), and a long
 * pause starts a new one; each line keeps its own time, so a moment can still
 * be told ("at 12:40"). Lines are capped at a readable measure — a monologue
 * on a wide screen is not a wall.
 */
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { clock } from "./format.ts";
import { Avatar, Body, nameColor, Skinned, who } from "./parts.tsx";
import type { SkinProps } from "./types.ts";

/** A pause this long between the same speaker's lines starts a new run. */
const PAUSE_MS = 120_000;

export function Transcript({
  messages,
  renderText,
  header,
  highlight,
}: SkinProps) {
  const t = useT();
  const said = [...messages].sort(
    (a, b) => (a.offsetMs ?? 0) - (b.offsetMs ?? 0),
  );
  return (
    <Skinned skin="transcript" className="px-4 py-3 @2xl:px-6">
      {header}
      {said.map((m, i) => {
        const prev = said[i - 1];
        const first =
          !prev ||
          who(prev) !== who(m) ||
          (m.offsetMs ?? 0) - (prev.offsetMs ?? 0) > PAUSE_MS;
        return (
          <div
            key={m.id}
            data-message-id={m.id}
            className={cn(
              "-mx-2 flex gap-3 rounded-lg px-2 py-0.5 transition-colors duration-700",
              first ? "mt-4 first:mt-0" : null,
              highlight === m.id ? "bg-[var(--sk-hover)]" : null,
            )}
          >
            <span className="sk-muted tnum w-12 shrink-0 pt-px text-right text-xs leading-6">
              {m.offsetMs == null ? "" : clock(m.offsetMs)}
            </span>
            <div className="min-w-0 max-w-[68ch] flex-1 leading-6">
              {first ? (
                <div className="flex items-center gap-2">
                  {m.author?.photo ? (
                    <Avatar
                      name={m.author.name}
                      src={m.author.photo}
                      className="size-5 shrink-0"
                    />
                  ) : null}
                  <span
                    className="truncate font-medium"
                    style={{ color: nameColor(m) }}
                  >
                    {m.author?.name ?? t("channelSkins.unidentified")}
                  </span>
                  {m.author?.tag ? (
                    <span className="sk-muted text-xs">{m.author.tag}</span>
                  ) : null}
                </div>
              ) : null}
              <Body m={m} renderText={renderText} />
            </div>
          </div>
        );
      })}
    </Skinned>
  );
}
