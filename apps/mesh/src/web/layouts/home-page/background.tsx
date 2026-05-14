/**
 * Faded decorative-tile background for the home page. Pure SVG, repeated
 * as a CSS background-image so it tiles seamlessly at any viewport size.
 * The motifs are loose stylized takes on the Figma reference; the muted
 * stroke + low opacity keep the page surface itself readable.
 */

const PATTERN = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns='http://www.w3.org/2000/svg' width='360' height='360' viewBox='0 0 360 360'>
  <g fill='none' stroke='%231a1a1a' stroke-width='2' opacity='0.07'>
    <!-- tile 1: chevron stack -->
    <g transform='translate(20,20)'>
      <rect x='0' y='0' width='80' height='80' rx='10'/>
      <path d='M20 30 L40 50 L60 30 M20 50 L40 70 L60 50' stroke-linecap='round' stroke-linejoin='round'/>
    </g>
    <!-- tile 2: flower / 4-petal -->
    <g transform='translate(140,20)'>
      <rect x='0' y='0' width='80' height='80' rx='10'/>
      <path d='M40 18 C50 28, 50 38, 40 40 C30 38, 30 28, 40 18 Z'/>
      <path d='M40 62 C30 52, 30 42, 40 40 C50 42, 50 52, 40 62 Z'/>
      <path d='M18 40 C28 30, 38 30, 40 40 C38 50, 28 50, 18 40 Z'/>
      <path d='M62 40 C52 30, 42 30, 40 40 C42 50, 52 50, 62 40 Z'/>
    </g>
    <!-- tile 3: bars -->
    <g transform='translate(260,20)'>
      <rect x='0' y='0' width='80' height='80' rx='10'/>
      <rect x='15' y='20' width='8' height='40'/>
      <rect x='28' y='28' width='8' height='32'/>
      <rect x='41' y='14' width='8' height='46'/>
      <rect x='54' y='24' width='8' height='36'/>
    </g>
    <!-- tile 4: gear -->
    <g transform='translate(20,140)'>
      <rect x='0' y='0' width='80' height='80' rx='10'/>
      <circle cx='40' cy='40' r='14'/>
      <path d='M40 18 L40 26 M40 54 L40 62 M18 40 L26 40 M54 40 L62 40 M25 25 L30 30 M50 50 L55 55 M50 30 L55 25 M25 55 L30 50'/>
    </g>
    <!-- tile 5: empty / box -->
    <g transform='translate(140,140)'>
      <rect x='0' y='0' width='80' height='80' rx='10'/>
      <path d='M40 14 C56 14, 66 24, 66 40 C66 56, 56 66, 40 66 C24 66, 14 56, 14 40' stroke-dasharray='3 4'/>
    </g>
    <!-- tile 6: leaf -->
    <g transform='translate(260,140)'>
      <rect x='0' y='0' width='80' height='80' rx='10'/>
      <path d='M22 58 C22 30, 36 18, 60 22 C56 46, 44 58, 22 58 Z'/>
      <path d='M22 58 L48 32'/>
    </g>
    <!-- tile 7: chevron solo -->
    <g transform='translate(20,260)'>
      <rect x='0' y='0' width='80' height='80' rx='10'/>
      <path d='M22 38 L40 52 L58 38' stroke-linecap='round' stroke-linejoin='round'/>
    </g>
    <!-- tile 8: petal solo -->
    <g transform='translate(140,260)'>
      <rect x='0' y='0' width='80' height='80' rx='10'/>
      <path d='M40 20 C56 32, 56 48, 40 60 C24 48, 24 32, 40 20 Z'/>
    </g>
    <!-- tile 9: medallion -->
    <g transform='translate(260,260)'>
      <rect x='0' y='0' width='80' height='80' rx='10'/>
      <circle cx='40' cy='40' r='18'/>
      <circle cx='40' cy='40' r='8'/>
    </g>
  </g>
</svg>
`)}`;

export function HomeBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: `url("${PATTERN}")`,
        backgroundRepeat: "repeat",
        backgroundSize: "360px 360px",
      }}
    />
  );
}
