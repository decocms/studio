import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { Download01 } from "@untitledui/icons";
import { useState } from "react";

interface ImagePartProps {
  url: string;
  mediaType: string;
}

export function ImagePart({ url, mediaType }: ImagePartProps) {
  const [loaded, setLoaded] = useState(false);

  const handleDownload = () => {
    const ext = mediaType.split("/")[1]?.split(";")[0] ?? "png";
    const link = document.createElement("a");
    link.href = url;
    link.download = `image-${Date.now()}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="group/image relative inline-block max-w-[512px] w-full">
      <div
        className={cn(
          "relative overflow-hidden rounded-xl border border-border shadow-sm",
          !loaded && "bg-muted animate-pulse min-h-[200px]",
        )}
      >
        <img
          src={url}
          alt="Generated image"
          className={cn(
            "w-full h-auto object-contain transition-opacity duration-300",
            loaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoaded(true)}
        />
        {loaded && (
          <div className="absolute top-2 right-2 opacity-0 group-hover/image:opacity-100 transition-opacity">
            <Button
              variant="secondary"
              size="icon"
              className="size-8 rounded-lg shadow-md backdrop-blur-sm bg-background/80"
              onClick={handleDownload}
            >
              <Download01 size={14} />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
