"use client";

import { Image01 } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";
import type { GenerateImageData } from "../../use-filter-parts.ts";
import { ImageLightbox } from "../../../image-lightbox.tsx";

interface GenerateImagePartProps {
  part: ToolUIPart;
  imageData?: GenerateImageData;
}

export function GenerateImagePart({ part, imageData }: GenerateImagePartProps) {
  const state = getEffectiveState(part.state);
  const input = part.input as { prompt?: string } | undefined;
  const images = imageData?.images;

  if (state === "loading") {
    return (
      <ToolCallShell
        icon={<Image01 size={14} />}
        title="Generating image"
        summary={input?.prompt ? `"${input.prompt.slice(0, 80)}…"` : undefined}
        state="loading"
      />
    );
  }

  if (state === "error" || !images || images.length === 0) {
    return (
      <ToolCallShell
        icon={<Image01 size={14} />}
        title="Image generation"
        summary={state === "error" ? "Failed" : "No images generated"}
        state={state === "error" ? "error" : "idle"}
      />
    );
  }

  return (
    <div className="my-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Image01 size={14} className="text-pink-500" />
        <span className="text-xs font-medium">Generated image</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {images.map((img, i) => {
          const src = `data:${img.mediaType};base64,${img.base64}`;
          return (
            <ImageLightbox
              key={i}
              src={src}
              alt={input?.prompt ?? "Generated image"}
            >
              <img
                src={src}
                alt={input?.prompt ?? "Generated image"}
                className="max-w-sm max-h-80 object-contain rounded-lg border border-border hover:border-foreground/20 transition-colors"
              />
            </ImageLightbox>
          );
        })}
      </div>
    </div>
  );
}
