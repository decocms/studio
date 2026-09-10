import { useId } from "react";
import "./splash-screen.css";

const LIME_LOGO_PATH =
  "M33.8913 86.3501C47.9742 86.3501 55.7568 80.0499 65.0218 60.4081C70.2102 49.6606 74.2868 38.9132 79.1046 28.5364L85.0342 30.3894C86.5166 30.76 87.6284 30.0188 86.8872 28.5364L79.4752 14.083C79.1046 12.9712 77.6222 12.9712 76.881 13.3418L59.0922 20.0126C57.6098 20.3832 57.6098 21.8656 59.0922 22.2362L64.2806 24.0892C59.8334 33.7248 54.645 48.5488 50.1978 57.8138C45.38 68.1907 43.1563 75.2321 34.6325 75.2321C26.1087 75.2321 24.9969 68.9319 28.7029 59.6668C32.7795 48.9194 39.4503 45.9546 46.8624 48.1782C49.086 45.2134 50.5684 40.7662 51.3096 36.6896C49.086 35.9484 46.4918 35.9484 44.2682 35.9484C32.0383 35.9484 19.8085 42.2486 14.6201 55.5902C9.06109 73.0085 14.9907 86.3501 33.8913 86.3501Z";

const LIQUID_SURFACE_PATH =
  "M-80 58C-75 53-65 53-60 58S-45 63-40 58S-25 53-20 58S-5 63 0 58S15 53 20 58S35 63 40 58S55 53 60 58S75 63 80 58S95 53 100 58S115 63 120 58S135 53 140 58S155 63 160 58S175 53 180 58S195 63 200 58";

const LIQUID_PATH = `${LIQUID_SURFACE_PATH}V180H-80Z`;

export function SplashScreen() {
  const clipId = `deco-liquid-${useId().replaceAll(":", "")}`;

  return (
    <div className="deco-splash">
      <div className="deco-splash__entrance" aria-hidden="true">
        <svg
          className="deco-splash__mark"
          viewBox="0 0 100 100"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <clipPath id={clipId}>
              <path d={LIME_LOGO_PATH} />
            </clipPath>
          </defs>

          <path className="deco-splash__air" d={LIME_LOGO_PATH} />

          <g clipPath={`url(#${clipId})`}>
            <g className="deco-splash__liquid-rise">
              <g className="deco-splash__wave-track">
                <path className="deco-splash__liquid" d={LIQUID_PATH} />
                <path
                  className="deco-splash__liquid-surface"
                  d={LIQUID_SURFACE_PATH}
                />
              </g>
            </g>
          </g>

          <path
            className="deco-splash__outline"
            d={LIME_LOGO_PATH}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </div>
  );
}
