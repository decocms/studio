// Icon shim for the ported Signal Deck. The landing rendered Material Symbols
// font glyphs by name; here the same `<Icon name size class>` call sites map to
// @untitledui/icons SVG components (already a web app dependency) so the deck doesn't
// pull in a webfont.
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BarChart01,
  BarChartSquare01,
  BellRinging01,
  CheckCircle,
  CheckDone01,
  Eye,
  FileCheck02,
  Flag01,
  InfoCircle,
  LineChartUp01,
  Link01,
  Lock01,
  LogOut01,
  Package,
  SearchLg,
  Share01,
  Shield01,
  ShoppingCart01,
  Stars01,
  TrendDown01,
  TrendUp01,
  XCircle,
  Zap,
} from "@untitledui/icons";
import type { ComponentType } from "react";

const ICONS: Record<
  string,
  ComponentType<{ size?: number; className?: string }>
> = {
  share: Share01,
  arrow_forward: ArrowRight,
  arrow_upward: ArrowUp,
  arrow_downward: ArrowDown,
  info: InfoCircle,
  warning: AlertTriangle,
  flag: Flag01,
  lock: Lock01,
  link: Link01,
  logout: LogOut01,
  leaderboard: BarChart01,
  checklist: CheckDone01,
  notifications_active: BellRinging01,
  package_2: Package,
  check_circle: CheckCircle,
  cancel: XCircle,
  error: AlertCircle,
  trending_up: TrendUp01,
  trending_down: TrendDown01,
  bolt: Zap,
  search: SearchLg,
  shopping_cart: ShoppingCart01,
  monitoring: LineChartUp01,
  accessibility_new: Eye,
  shield: Shield01,
  article: FileCheck02,
  smart_toy: Stars01,
  bar_chart: BarChartSquare01,
};

const SIZE_PX = {
  xs: 12,
  small: 14,
  medium: 16,
  large: 18,
  xl: 20,
  xxl: 32,
  "40": 40,
  immense: 80,
} as const;

interface IconProps {
  name: string;
  size?: keyof typeof SIZE_PX;
  class?: string;
}

export default function Icon({
  name,
  size = "medium",
  class: className = "",
}: IconProps) {
  const Cmp = ICONS[name];
  if (!Cmp) return null;
  return <Cmp size={SIZE_PX[size]} className={className} />;
}
