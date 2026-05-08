import { useState } from "react";

const GRID_CELLS = [
  { delay: 0 },
  { delay: 100 },
  { delay: 200 },
  { delay: 100 },
  { delay: 200 },
  { delay: 200 },
  { delay: 300 },
  { delay: 300 },
  { delay: 400 },
];

export function GridLoader() {
  const [cellColors] = useState(() => {
    const chart = `var(--chart-${Math.ceil(Math.random() * 5)})`;
    return GRID_CELLS.map(() =>
      Math.random() < 0.6
        ? "color-mix(in srgb, var(--muted-foreground) 25%, transparent)"
        : chart,
    );
  });
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "repeat(3, 3px)",
        gap: "1.5px",
        width: "fit-content",
      }}
    >
      {GRID_CELLS.map(({ delay }, i) => (
        <div
          key={i}
          className="rounded-[1px]"
          style={
            {
              width: 3,
              height: 3,
              "--cell-color": cellColors[i],
              animation: "grid-ripple 1s ease infinite",
              animationDelay: `${delay}ms`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
