export function DancingCapybara() {
  return (
    <div className="flex flex-col items-center gap-6 select-none">
      <style>{`
        @keyframes capybara-bounce {
          0%, 100% { transform: translateY(0) rotate(-2deg); }
          25% { transform: translateY(-18px) rotate(2deg); }
          50% { transform: translateY(-8px) rotate(-1deg); }
          75% { transform: translateY(-22px) rotate(3deg); }
        }
        @keyframes leg-left {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(25deg); }
        }
        @keyframes leg-right {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(-25deg); }
        }
        @keyframes ear-wiggle {
          0%, 100% { transform: rotate(0deg); }
          33% { transform: rotate(-12deg); }
          66% { transform: rotate(12deg); }
        }
        @keyframes note-float-1 {
          0% { transform: translate(0, 0) rotate(0deg); opacity: 0; }
          20% { opacity: 1; }
          100% { transform: translate(-40px, -60px) rotate(-20deg); opacity: 0; }
        }
        @keyframes note-float-2 {
          0% { transform: translate(0, 0) rotate(0deg); opacity: 0; }
          20% { opacity: 1; }
          100% { transform: translate(50px, -70px) rotate(15deg); opacity: 0; }
        }
        @keyframes note-float-3 {
          0% { transform: translate(0, 0) rotate(0deg); opacity: 0; }
          20% { opacity: 1; }
          100% { transform: translate(30px, -50px) rotate(25deg); opacity: 0; }
        }
        @keyframes shadow-pulse {
          0%, 100% { transform: scaleX(1); opacity: 0.25; }
          50% { transform: scaleX(0.7); opacity: 0.12; }
        }
        @keyframes sparkle {
          0%, 100% { opacity: 0; transform: scale(0.5); }
          50% { opacity: 1; transform: scale(1.2); }
        }
        .capybara-body {
          animation: capybara-bounce 0.7s ease-in-out infinite;
          transform-origin: bottom center;
        }
        .capy-leg-fl { animation: leg-left 0.35s ease-in-out infinite; transform-origin: top center; }
        .capy-leg-bl { animation: leg-right 0.35s ease-in-out infinite; transform-origin: top center; }
        .capy-leg-fr { animation: leg-right 0.35s ease-in-out infinite; transform-origin: top center; }
        .capy-leg-br { animation: leg-left 0.35s ease-in-out infinite; transform-origin: top center; }
        .capy-ear-l { animation: ear-wiggle 0.7s ease-in-out infinite; transform-origin: bottom center; }
        .capy-ear-r { animation: ear-wiggle 0.7s ease-in-out infinite 0.12s; transform-origin: bottom center; }
        .capy-shadow { animation: shadow-pulse 0.7s ease-in-out infinite; transform-origin: center; }
        .note-1 { animation: note-float-1 1.4s ease-out infinite 0s; }
        .note-2 { animation: note-float-2 1.4s ease-out infinite 0.45s; }
        .note-3 { animation: note-float-3 1.4s ease-out infinite 0.9s; }
        .sparkle-1 { animation: sparkle 1.1s ease-in-out infinite 0.2s; }
        .sparkle-2 { animation: sparkle 1.1s ease-in-out infinite 0.7s; }
        .sparkle-3 { animation: sparkle 0.9s ease-in-out infinite 0.4s; }
      `}</style>

      <div className="relative" style={{ width: 200, height: 200 }}>
        {/* Music notes */}
        <div className="note-1 absolute text-2xl" style={{ left: 20, top: 60 }}>
          ♪
        </div>
        <div className="note-2 absolute text-xl" style={{ right: 18, top: 55 }}>
          ♫
        </div>
        <div className="note-3 absolute text-lg" style={{ right: 45, top: 40 }}>
          ♩
        </div>

        {/* Sparkles */}
        <div
          className="sparkle-1 absolute text-yellow-400 text-lg"
          style={{ left: 10, top: 20 }}
        >
          ✦
        </div>
        <div
          className="sparkle-2 absolute text-lime-400 text-sm"
          style={{ right: 12, top: 15 }}
        >
          ✦
        </div>
        <div
          className="sparkle-3 absolute text-purple-400 text-xs"
          style={{ left: 55, top: 10 }}
        >
          ✦
        </div>

        {/* Capybara SVG */}
        <div
          className="capybara-body absolute"
          style={{ left: 30, top: 20, width: 140, height: 150 }}
        >
          <svg
            viewBox="0 0 140 150"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{ width: "100%", height: "100%" }}
          >
            {/* Shadow */}
            <ellipse
              className="capy-shadow"
              cx="70"
              cy="147"
              rx="42"
              ry="7"
              fill="#8B6914"
              opacity="0.25"
            />

            {/* Back legs */}
            <g
              className="capy-leg-bl"
              style={{ transformOrigin: "95px 112px" }}
            >
              <rect
                x="90"
                y="112"
                width="16"
                height="26"
                rx="8"
                fill="#8B6418"
              />
            </g>
            <g
              className="capy-leg-br"
              style={{ transformOrigin: "108px 112px" }}
            >
              <rect
                x="103"
                y="112"
                width="16"
                height="26"
                rx="8"
                fill="#7A5816"
              />
            </g>

            {/* Front legs */}
            <g
              className="capy-leg-fl"
              style={{ transformOrigin: "28px 112px" }}
            >
              <rect
                x="23"
                y="112"
                width="16"
                height="26"
                rx="8"
                fill="#8B6418"
              />
            </g>
            <g
              className="capy-leg-fr"
              style={{ transformOrigin: "42px 112px" }}
            >
              <rect
                x="37"
                y="112"
                width="16"
                height="26"
                rx="8"
                fill="#7A5816"
              />
            </g>

            {/* Body */}
            <rect
              x="15"
              y="72"
              width="110"
              height="50"
              rx="26"
              fill="#A0742A"
            />

            {/* Belly patch */}
            <ellipse
              cx="70"
              cy="97"
              rx="38"
              ry="18"
              fill="#C49A40"
              opacity="0.5"
            />

            {/* Tail */}
            <ellipse
              cx="122"
              cy="88"
              rx="10"
              ry="7"
              fill="#8B6418"
              transform="rotate(-15 122 88)"
            />

            {/* Neck */}
            <rect x="38" y="52" width="36" height="28" rx="12" fill="#A0742A" />

            {/* Head */}
            <rect x="22" y="28" width="70" height="48" rx="20" fill="#A0742A" />

            {/* Left ear */}
            <g className="capy-ear-l" style={{ transformOrigin: "36px 32px" }}>
              <ellipse cx="36" cy="26" rx="9" ry="12" fill="#8B6418" />
              <ellipse cx="36" cy="26" rx="5" ry="7" fill="#C49A40" />
            </g>

            {/* Right ear */}
            <g className="capy-ear-r" style={{ transformOrigin: "78px 32px" }}>
              <ellipse cx="78" cy="26" rx="9" ry="12" fill="#8B6418" />
              <ellipse cx="78" cy="26" rx="5" ry="7" fill="#C49A40" />
            </g>

            {/* Eye whites */}
            <ellipse cx="42" cy="44" rx="7" ry="7.5" fill="white" />
            <ellipse cx="70" cy="44" rx="7" ry="7.5" fill="white" />

            {/* Pupils */}
            <ellipse cx="43" cy="45" rx="4" ry="4.5" fill="#2D1A00" />
            <ellipse cx="71" cy="45" rx="4" ry="4.5" fill="#2D1A00" />

            {/* Eye shine */}
            <circle cx="45" cy="43" r="1.5" fill="white" />
            <circle cx="73" cy="43" r="1.5" fill="white" />

            {/* Nose */}
            <rect x="42" y="57" width="28" height="10" rx="5" fill="#7A5816" />
            <ellipse cx="50" cy="62" rx="4" ry="3" fill="#5A3E10" />
            <ellipse cx="62" cy="62" rx="4" ry="3" fill="#5A3E10" />

            {/* Smile */}
            <path
              d="M48 70 Q56 77 66 70"
              stroke="#5A3E10"
              strokeWidth="2.5"
              strokeLinecap="round"
              fill="none"
            />

            {/* Cheek blush */}
            <ellipse
              cx="30"
              cy="55"
              rx="7"
              ry="4"
              fill="#E07070"
              opacity="0.35"
            />
            <ellipse
              cx="82"
              cy="55"
              rx="7"
              ry="4"
              fill="#E07070"
              opacity="0.35"
            />
          </svg>
        </div>
      </div>

      <div className="flex flex-col items-center gap-2 text-center">
        <p className="text-xl font-semibold text-foreground tracking-tight">
          No AI provider yet!
        </p>
        <p className="text-sm text-muted-foreground max-w-xs">
          This capybara is dancing to distract you while you add one in{" "}
          <strong>Settings → AI Providers</strong>.
        </p>
      </div>
    </div>
  );
}
