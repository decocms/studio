/// <reference types="google.maps" />
import { useRef, useState } from "react";
import { usePublicConfig } from "@/hooks/use-public-config";
import type { FieldProps } from "./field-props";
import { FieldLabel } from "./field-label";

const DEFAULT_CENTER = { lat: -21.9, lng: -41.42 };
const DEFAULT_RADIUS = 100000;

type MapsNs = typeof google.maps;

let mapsLoadPromise: Promise<MapsNs> | null = null;

// The Maps JS API key comes from the server's runtime config (/api/config,
// sourced from the GOOGLE_MAPS_API_KEY env var) — read at request time so it's
// configurable per environment. It's a client-side token by design: the Maps
// JS API loads in the browser and always ships its key in the request URL, so
// it can't be hidden and is NOT a secret. Security relies on the key's
// HTTP-referrer + API restrictions in Google Cloud, not on secrecy.
function loadGoogleMaps(apiKey: string): Promise<MapsNs> {
  if (mapsLoadPromise) return mapsLoadPromise;
  mapsLoadPromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Google Maps requires a browser environment"));
      return;
    }
    const w = window as unknown as { google?: { maps?: MapsNs } };
    if (w.google?.maps) {
      resolve(w.google.maps);
      return;
    }
    const onReady = () => {
      const ns = (window as unknown as { google?: { maps?: MapsNs } }).google
        ?.maps;
      if (ns) resolve(ns);
      else reject(new Error("Google Maps script loaded without google.maps"));
    };
    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-google-maps-loader]",
    );
    if (existing) {
      existing.addEventListener("load", onReady);
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load Google Maps")),
      );
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&v=weekly&libraries=maps`;
    script.async = true;
    script.defer = true;
    script.dataset.googleMapsLoader = "true";
    script.addEventListener("load", onReady);
    script.addEventListener("error", () =>
      reject(new Error("Failed to load Google Maps")),
    );
    document.head.appendChild(script);
  });
  return mapsLoadPromise;
}

function parseValue(
  v: unknown,
): { lat: number; lng: number; radius: number } | null {
  if (typeof v !== "string" || !v) return null;
  const parts = v.split(",").map(Number);
  const [lat, lng, radius] = parts;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat: lat as number,
    lng: lng as number,
    radius: Number.isFinite(radius) ? (radius as number) : DEFAULT_RADIUS,
  };
}

export function MapField({
  schema,
  value,
  onChange,
  path,
  label,
  sandbox,
}: FieldProps) {
  const apiKey = usePublicConfig().googleMapsApiKey;

  const onChangeRef = useRef(onChange);
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- read only inside async map callbacks, never during render
  onChangeRef.current = onChange;

  // Pin the value at mount so live re-renders triggered by our own onChange
  // don't tear down and recreate the map (which would defocus the user's
  // in-progress drag).
  const initialRef = useRef(parseValue(value));
  const [error, setError] = useState<string | null>(null);

  // React re-runs a ref callback (running its cleanup, then re-invoking it) only
  // when the callback's identity changes. An inline callback gets a fresh
  // identity every render, so each re-render our own onChange triggers while the
  // user drags or resizes the circle would tear the map down and rebuild it —
  // reloading tiles and dropping the in-progress gesture, which reads as
  // flickering. Pin the first callback in a ref so the map is created exactly
  // once and only disposed on genuine unmount.
  const setNodeRef =
    useRef<(node: HTMLDivElement | null) => (() => void) | void>(null);

  const setNode = (node: HTMLDivElement | null) => {
    if (!node || !apiKey) return;
    const state: {
      disposed: boolean;
      circle: google.maps.Circle | null;
      listeners: google.maps.MapsEventListener[];
    } = { disposed: false, circle: null, listeners: [] };

    loadGoogleMaps(apiKey).then(
      (maps) => {
        if (state.disposed) return;
        const init = initialRef.current;
        const center = init ? { lat: init.lat, lng: init.lng } : DEFAULT_CENTER;
        const radius = init?.radius ?? DEFAULT_RADIUS;

        const map = new maps.Map(node, {
          center,
          zoom: radius ? Math.round(Math.log2(7680000 / radius)) + 1 : 4,
          draggable: true,
          streetViewControl: false,
          mapTypeControl: false,
        });

        const circle = new maps.Circle({
          strokeColor: "#2E6ED9",
          strokeOpacity: 0.8,
          strokeWeight: 2,
          fillColor: "#2E6ED9",
          fillOpacity: 0.35,
          editable: true,
          draggable: true,
          map,
          center,
          radius,
        });
        state.circle = circle;

        const emit = () => {
          const c = circle.getCenter();
          const r = circle.getRadius();
          if (!c) return;
          onChangeRef.current(`${c.lat()},${c.lng()},${r}`);
        };

        const pushListener = (l: google.maps.MapsEventListener | undefined) => {
          if (l) state.listeners.push(l);
        };

        pushListener(
          map.addListener("click", (event: google.maps.MapMouseEvent) => {
            if (!event.latLng) return;
            circle.setCenter({
              lat: event.latLng.lat(),
              lng: event.latLng.lng(),
            });
            if (!circle.getRadius()) circle.setRadius(DEFAULT_RADIUS);
            emit();
          }),
        );
        pushListener(circle.addListener("radius_changed", emit));
        pushListener(circle.addListener("dragend", emit));
      },
      (err: unknown) => {
        if (state.disposed) return;
        setError(err instanceof Error ? err.message : "Failed to load map");
      },
    );

    return () => {
      state.disposed = true;
      for (const l of state.listeners) {
        try {
          l?.remove();
        } catch {
          // Ignore — listener may already be detached if the maps script
          // tore down its internal registry first.
        }
      }
      state.listeners = [];
      if (state.circle) {
        try {
          state.circle.setMap(null);
        } catch {
          // Ignore — circle's map may already be gone.
        }
        state.circle = null;
      }
    };
  };

  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- one-time init pins a stable ref callback so the map isn't recreated each render
  if (!setNodeRef.current) setNodeRef.current = setNode;

  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor={path}
        label={label}
        description={schema.description}
        virtualMcpId={sandbox?.virtualMcpId}
      />
      {!apiKey ? (
        <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          The map picker is unavailable — set{" "}
          <code className="font-mono">GOOGLE_MAPS_API_KEY</code> on the server
          to enable it.
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : (
        <div
          // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- reading the pinned stable ref callback; intentionally identity-stable so the map isn't torn down on re-render
          ref={setNodeRef.current}
          id={path}
          className="h-72 w-full rounded-md border border-border/60"
        />
      )}
    </div>
  );
}
