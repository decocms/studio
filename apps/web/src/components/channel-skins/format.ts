/**
 * How the skins write a time and a day, in the viewer's language. The
 * channels hub kept these as module state set once at boot; Studio switches
 * language live, so a skin reads them through `useSkinFormat()` on render.
 */
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";

export type SkinFormat = ReturnType<typeof skinFormat>;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const sameYear = (d: Date) => d.getFullYear() === new Date().getFullYear();

function skinFormat(locale: string, today: string, yesterday: string) {
  const dateFmt = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const time = (iso: string) => timeFmt.format(new Date(iso));
  const relativeDay = (iso: string) => {
    const at = new Date(iso).getTime();
    const t = startOfToday();
    return at >= t ? today : at >= t - 86_400_000 ? yesterday : null;
  };
  return {
    locale,
    today,
    yesterday,
    time,
    /** The plain date, "27 Oct 2026". */
    date: (iso: string) => dateFmt.format(new Date(iso)),
    /** "Today", "Yesterday" or "27 Oct 2026". */
    day: (iso: string) => relativeDay(iso) ?? dateFmt.format(new Date(iso)),
    /** Slack's divider: "Today", "Yesterday", "Tuesday, 27 January" (the year only when it isn't this one). */
    longDay: (iso: string) => {
      const rel = relativeDay(iso);
      if (rel) return rel;
      const d = new Date(iso);
      const s = d.toLocaleDateString(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        ...(sameYear(d) ? {} : { year: "numeric" }),
      });
      return s.charAt(0).toUpperCase() + s.slice(1);
    },
    /** Slack's time beside a name: "17h42", "16h" in Portuguese; the locale's own clock otherwise. */
    hourMin: (iso: string) => {
      if (!locale.startsWith("pt")) return time(iso);
      const d = new Date(iso);
      const m = d.getMinutes();
      return `${d.getHours()}h${m ? String(m).padStart(2, "0") : ""}`;
    },
    /** Google Chat's stamp: "10:57" today, "Yesterday 16:04", "Mon 10:57" this week, "23 Nov 10:57" before. */
    chatStamp: (iso: string) => {
      const d = new Date(iso);
      const t = startOfToday();
      const at = time(iso);
      if (d.getTime() >= t) return at;
      if (d.getTime() >= t - 86_400_000) return `${yesterday} ${at}`;
      if (d.getTime() >= t - 6 * 86_400_000)
        return `${d.toLocaleDateString(locale, { weekday: "short" })} ${at}`;
      return `${d.toLocaleDateString(locale, {
        day: "numeric",
        month: "short",
        ...(sameYear(d) ? {} : { year: "numeric" }),
      })} ${at}`;
    },
  };
}

export function useSkinFormat(): SkinFormat {
  const t = useT();
  const [{ language }] = usePreferences();
  return skinFormat(
    language,
    t("channelSkins.today"),
    t("channelSkins.yesterday"),
  );
}

/** 83_000 → "1:23"; 3_723_000 → "1:02:03". */
export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}
