"use client";

import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Download01, ZoomIn, ZoomOut } from "@untitledui/icons";
import { useRef, useState } from "react";

interface ImageLightboxProps {
  src: string;
  alt?: string;
  children: React.ReactNode;
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;

/**
 * Clamp pan so the image edge never goes past the container edge.
 * maxPan = (scaledSize - containerSize) / 2  (in screen pixels).
 * When zoom=1, maxPan=0 so no panning is possible.
 */
function clampPan(
  rawX: number,
  rawY: number,
  currentZoom: number,
  imgEl: HTMLImageElement | null,
): { x: number; y: number } {
  if (!imgEl || currentZoom <= ZOOM_MIN) return { x: 0, y: 0 };
  const w = imgEl.offsetWidth;
  const h = imgEl.offsetHeight;
  const maxX = ((currentZoom - 1) * w) / 2;
  const maxY = ((currentZoom - 1) * h) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, rawX)),
    y: Math.max(-maxY, Math.min(maxY, rawY)),
  };
}

export function ImageLightbox({
  src,
  alt = "Image",
  children,
}: ImageLightboxProps) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);

  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = src;
    a.download = alt.replace(/[^a-zA-Z0-9-_ ]/g, "") || "image";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleOpen = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setOpen(true);
  };

  const zoomTo = (newZoom: number) => {
    const clamped = Math.min(Math.max(newZoom, ZOOM_MIN), ZOOM_MAX);
    if (clamped === ZOOM_MIN) {
      setPan({ x: 0, y: 0 });
    } else {
      // Re-clamp existing pan for the new zoom level
      setPan((prev) => clampPan(prev.x, prev.y, clamped, imgRef.current));
    }
    setZoom(clamped);
  };

  const zoomInFn = () => zoomTo(zoom + ZOOM_STEP);
  const zoomOutFn = () => zoomTo(zoom - ZOOM_STEP);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (zoom <= ZOOM_MIN) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startPanX: pan.x,
      startPanY: pan.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag?.active) return;
    const rawX = drag.startPanX + (e.clientX - drag.startX);
    const rawY = drag.startPanY + (e.clientY - drag.startY);
    setPan(clampPan(rawX, rawY, zoom, imgRef.current));
  };

  const handlePointerUp = () => {
    if (dragRef.current) {
      dragRef.current.active = false;
    }
  };

  const isZoomed = zoom > ZOOM_MIN;

  const btnClass =
    "flex items-center justify-center size-8 rounded-lg bg-black/60 text-white hover:bg-black/80 backdrop-blur-sm transition-colors";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        className="cursor-zoom-in text-left"
        onClick={handleOpen}
      >
        {children}
      </button>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex items-center justify-center p-8 focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200"
          onClick={() => setOpen(false)}
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <div
            className="relative overflow-hidden rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              ref={imgRef}
              src={src}
              alt={alt}
              className="max-w-[min(800px,85vw)] max-h-[80vh] object-contain select-none"
              style={{
                transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
                // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
                transition: dragRef.current?.active
                  ? "none"
                  : "transform 200ms ease-out",
                cursor: isZoomed ? "grab" : "default",
              }}
              draggable={false}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />

            {/* Bottom-left: zoom controls */}
            <div className="absolute bottom-3 left-3 flex items-center gap-1.5">
              <button
                type="button"
                onClick={zoomOutFn}
                disabled={zoom <= ZOOM_MIN}
                className={btnClass}
                aria-label="Zoom out"
              >
                <ZoomOut size={16} />
              </button>
              <button
                type="button"
                onClick={zoomInFn}
                disabled={zoom >= ZOOM_MAX}
                className={btnClass}
                aria-label="Zoom in"
              >
                <ZoomIn size={16} />
              </button>
            </div>

            {/* Bottom-right: download */}
            <button
              type="button"
              onClick={handleDownload}
              className={cn("absolute bottom-3 right-3", btnClass)}
              aria-label="Download image"
            >
              <Download01 size={16} />
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
