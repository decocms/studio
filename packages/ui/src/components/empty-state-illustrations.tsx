/**
 * Lightweight SVG illustrations for empty states.
 * Simple, abstract geometric illustrations in muted monochrome using currentColor.
 * Each illustration is roughly 120x120 SVG.
 */

const svgProps = {
  width: 120,
  height: 120,
  viewBox: "0 0 120 120",
  fill: "none",
  xmlns: "http://www.w3.org/2000/svg",
  "aria-hidden": true as const,
};

const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function AgentsIllustration({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <rect
        x="40"
        y="30"
        width="40"
        height="44"
        rx="8"
        {...stroke}
        opacity={0.6}
      />
      <circle cx="52" cy="48" r="4" {...stroke} opacity={0.5} />
      <circle cx="68" cy="48" r="4" {...stroke} opacity={0.5} />
      <path d="M50 60 Q60 68 70 60" {...stroke} opacity={0.4} />
      <line x1="60" y1="74" x2="60" y2="90" {...stroke} opacity={0.3} />
      <line x1="44" y1="86" x2="76" y2="86" {...stroke} opacity={0.3} />
      <circle cx="30" cy="36" r="3" {...stroke} opacity={0.25} />
      <line x1="33" y1="36" x2="40" y2="40" {...stroke} opacity={0.2} />
      <circle cx="90" cy="36" r="3" {...stroke} opacity={0.25} />
      <line x1="87" y1="36" x2="80" y2="40" {...stroke} opacity={0.2} />
    </svg>
  );
}

export function ConnectionsIllustration({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <circle cx="36" cy="60" r="14" {...stroke} opacity={0.5} />
      <circle cx="84" cy="60" r="14" {...stroke} opacity={0.5} />
      <line
        x1="50"
        y1="60"
        x2="70"
        y2="60"
        {...stroke}
        opacity={0.4}
        strokeDasharray="4 3"
      />
      <circle cx="36" cy="60" r="5" fill="currentColor" opacity={0.15} />
      <circle cx="84" cy="60" r="5" fill="currentColor" opacity={0.15} />
      <path d="M56 56 L60 60 L56 64" {...stroke} opacity={0.3} />
      <path d="M64 56 L60 60 L64 64" {...stroke} opacity={0.3} />
    </svg>
  );
}

export function TasksIllustration({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <rect
        x="30"
        y="28"
        width="60"
        height="64"
        rx="6"
        {...stroke}
        opacity={0.4}
      />
      <line x1="42" y1="44" x2="78" y2="44" {...stroke} opacity={0.3} />
      <line x1="42" y1="56" x2="78" y2="56" {...stroke} opacity={0.3} />
      <line x1="42" y1="68" x2="66" y2="68" {...stroke} opacity={0.3} />
      <rect
        x="34"
        y="40"
        width="6"
        height="6"
        rx="1"
        {...stroke}
        opacity={0.4}
      />
      <rect
        x="34"
        y="52"
        width="6"
        height="6"
        rx="1"
        {...stroke}
        opacity={0.4}
      />
      <rect
        x="34"
        y="64"
        width="6"
        height="6"
        rx="1"
        {...stroke}
        opacity={0.4}
      />
      <path d="M35 43 L36.5 44.5 L39 42" {...stroke} opacity={0.5} />
    </svg>
  );
}

export function PagesIllustration({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <rect
        x="28"
        y="26"
        width="64"
        height="68"
        rx="6"
        {...stroke}
        opacity={0.4}
      />
      <rect
        x="34"
        y="36"
        width="52"
        height="10"
        rx="2"
        {...stroke}
        opacity={0.25}
      />
      <rect
        x="34"
        y="52"
        width="24"
        height="24"
        rx="2"
        {...stroke}
        opacity={0.25}
      />
      <rect
        x="62"
        y="52"
        width="24"
        height="10"
        rx="2"
        {...stroke}
        opacity={0.2}
      />
      <rect
        x="62"
        y="66"
        width="24"
        height="10"
        rx="2"
        {...stroke}
        opacity={0.2}
      />
    </svg>
  );
}

export function ExperimentsIllustration({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <rect
        x="28"
        y="34"
        width="28"
        height="52"
        rx="6"
        {...stroke}
        opacity={0.4}
      />
      <rect
        x="64"
        y="34"
        width="28"
        height="52"
        rx="6"
        {...stroke}
        opacity={0.4}
      />
      <text
        x="42"
        y="64"
        textAnchor="middle"
        fill="currentColor"
        fontSize="18"
        fontWeight="700"
        opacity={0.3}
      >
        A
      </text>
      <text
        x="78"
        y="64"
        textAnchor="middle"
        fill="currentColor"
        fontSize="18"
        fontWeight="700"
        opacity={0.3}
      >
        B
      </text>
      <line
        x1="56"
        y1="40"
        x2="64"
        y2="40"
        {...stroke}
        opacity={0.2}
        strokeDasharray="2 2"
      />
      <line
        x1="56"
        y1="60"
        x2="64"
        y2="60"
        {...stroke}
        opacity={0.2}
        strokeDasharray="2 2"
      />
      <line
        x1="56"
        y1="80"
        x2="64"
        y2="80"
        {...stroke}
        opacity={0.2}
        strokeDasharray="2 2"
      />
    </svg>
  );
}

export function WorkflowsIllustration({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <circle cx="60" cy="30" r="10" {...stroke} opacity={0.4} />
      <circle cx="36" cy="70" r="10" {...stroke} opacity={0.4} />
      <circle cx="84" cy="70" r="10" {...stroke} opacity={0.4} />
      <line x1="54" y1="38" x2="40" y2="62" {...stroke} opacity={0.3} />
      <line x1="66" y1="38" x2="80" y2="62" {...stroke} opacity={0.3} />
      <line
        x1="46"
        y1="70"
        x2="74"
        y2="70"
        {...stroke}
        opacity={0.25}
        strokeDasharray="4 3"
      />
      <circle cx="60" cy="30" r="4" fill="currentColor" opacity={0.12} />
      <circle cx="36" cy="70" r="4" fill="currentColor" opacity={0.12} />
      <circle cx="84" cy="70" r="4" fill="currentColor" opacity={0.12} />
    </svg>
  );
}

export function AdminsIllustration({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <rect
        x="24"
        y="28"
        width="32"
        height="26"
        rx="4"
        {...stroke}
        opacity={0.35}
      />
      <rect
        x="64"
        y="28"
        width="32"
        height="26"
        rx="4"
        {...stroke}
        opacity={0.35}
      />
      <rect
        x="24"
        y="62"
        width="32"
        height="26"
        rx="4"
        {...stroke}
        opacity={0.35}
      />
      <rect
        x="64"
        y="62"
        width="32"
        height="26"
        rx="4"
        {...stroke}
        opacity={0.35}
      />
      <line x1="30" y1="38" x2="50" y2="38" {...stroke} opacity={0.2} />
      <line x1="30" y1="44" x2="44" y2="44" {...stroke} opacity={0.15} />
      <line x1="70" y1="38" x2="90" y2="38" {...stroke} opacity={0.2} />
      <line x1="70" y1="44" x2="84" y2="44" {...stroke} opacity={0.15} />
      <line x1="30" y1="72" x2="50" y2="72" {...stroke} opacity={0.2} />
      <line x1="30" y1="78" x2="44" y2="78" {...stroke} opacity={0.15} />
      <line x1="70" y1="72" x2="90" y2="72" {...stroke} opacity={0.2} />
      <line x1="70" y1="78" x2="84" y2="78" {...stroke} opacity={0.15} />
    </svg>
  );
}

export function StoreIllustration({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <path
        d="M40 50 L40 82 Q40 86 44 86 L76 86 Q80 86 80 82 L80 50"
        {...stroke}
        opacity={0.4}
      />
      <path d="M36 50 L44 30 L76 30 L84 50 Z" {...stroke} opacity={0.35} />
      <path
        d="M36 50 Q42 58 48 50 Q54 58 60 50 Q66 58 72 50 Q78 58 84 50"
        {...stroke}
        opacity={0.3}
      />
      <path
        d="M55 60 L60 56 L65 60 L63 58 L63 66 L57 66 L57 58 Z"
        {...stroke}
        opacity={0.2}
      />
    </svg>
  );
}

export function GenericIllustration({ className }: { className?: string }) {
  return (
    <svg {...svgProps} className={className}>
      <path
        d="M30 46 L30 84 Q30 88 34 88 L86 88 Q90 88 90 84 L90 46"
        {...stroke}
        opacity={0.4}
      />
      <path
        d="M30 46 L30 38 Q30 34 34 34 L52 34 L58 28 L86 28 Q90 28 90 32 L90 46"
        {...stroke}
        opacity={0.35}
      />
      <line x1="56" y1="60" x2="64" y2="60" {...stroke} opacity={0.3} />
      <line x1="60" y1="56" x2="60" y2="64" {...stroke} opacity={0.3} />
    </svg>
  );
}
