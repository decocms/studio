/**
 * Numbers on the canvas, in the reader's language: money compact ("R$ 379 mil"),
 * metrics with their unit.
 */

import type { BusinessCaseMetric } from "@decocms/shared/business-case";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";

export function useCaseFormat() {
  const t = useT();
  const [{ language }] = usePreferences();
  const money = new Intl.NumberFormat(language, {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat(language, {
    notation: "compact",
    maximumFractionDigits: 1,
  });

  const days = (count: number) =>
    t(count === 1 ? "plan.case.days.one" : "plan.case.days.other", {
      count: number.format(count),
    });

  const metric = ({ value, unit }: BusinessCaseMetric) => {
    switch (unit) {
      case "percent":
        return `${number.format(value)}%`;
      case "seconds":
        return `${number.format(value)} s`;
      case "days":
        return days(value);
      case "brl":
        return money.format(value);
      case "count":
        return compact.format(value);
    }
  };

  return {
    money: (value: number) => money.format(value),
    number: (value: number) => number.format(value),
    compact: (value: number) => compact.format(value),
    days,
    metric,
  };
}
