import { cn } from "@deco/ui/lib/utils.js";
import { CSSProperties, useEffect, useState } from "react";

/**
 * Typewriter title component for animated task titles
 * Displays text with a typewriter animation effect, then truncates with ellipsis if needed
 */
export function TypewriterTitle({
  text,
  className = "",
  speed = 30,
}: {
  text: string;
  className?: string;
  speed?: number;
}) {
  const [animationComplete, setAnimationComplete] = useState(false);

  // Calculate animation duration based on text length and speed
  const animationDuration = (text.length / speed) * 1000;
  const steps = text.length;
  // Use ch units (character width) for accurate character-based width
  const maxWidth = `${text.length}ch`;

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    setAnimationComplete(false);
    const timer = setTimeout(() => {
      setAnimationComplete(true);
    }, animationDuration);
    return () => clearTimeout(timer);
  }, [text, animationDuration]);

  return (
    <span
      className={cn(className, "block overflow-hidden inline-flex")}
      key={text}
      style={
        {
          "--typewriter-duration": `${animationDuration}ms`,
          "--typewriter-steps": steps,
          "--typewriter-max-width": maxWidth,
        } as CSSProperties
      }
    >
      <span className={cn("typewriter-text", animationComplete && "truncate")}>
        {text}
      </span>
      <style>{`
        .typewriter-text {
          display: inline-block;
          width: 0;
          max-width: 100%;
          overflow: hidden;
          white-space: nowrap;
          animation: typewriter var(--typewriter-duration) steps(var(--typewriter-steps)) forwards;
        }

        @keyframes typewriter {
          to {
            width: min(var(--typewriter-max-width), 100%);
          }
        }
      `}</style>
    </span>
  );
}
