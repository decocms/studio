import { useState } from "react";
import { useWidget } from "./use-widget.ts";

type ImageArgs = { src?: string; alt?: string; caption?: string };

export default function Image() {
  const { args } = useWidget<ImageArgs>();
  const [error, setError] = useState(false);

  if (!args) return null;

  const { src = "", alt = "", caption } = args;

  if (!src || error) {
    return (
      <div className="p-4 font-sans">
        <div className="bg-muted rounded-lg flex items-center justify-center h-32 text-muted-foreground text-sm">
          {error ? "Failed to load image" : "No image URL"}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 font-sans">
      <img
        src={src}
        alt={alt}
        onError={() => setError(true)}
        className="w-full rounded-lg object-contain max-h-64"
      />
      {caption && (
        <p className="text-xs text-muted-foreground text-center mt-2">
          {caption}
        </p>
      )}
    </div>
  );
}
