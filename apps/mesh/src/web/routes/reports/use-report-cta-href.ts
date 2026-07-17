import { onboardingUrl } from "./onboarding";

export function useReportCtaHref(domain: string): string {
  return onboardingUrl(`https://${domain}/`);
}
