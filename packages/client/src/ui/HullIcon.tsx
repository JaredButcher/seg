import { getHull, type HullId } from '@seg/shared';

/**
 * A hull's side profile, drawn from the same polygon the simulation will use for collision
 * and active-sonar returns (planning/09 §11 — one asset, four jobs).
 *
 * Every icon shares one viewBox rather than fitting each hull to the box. Fitting would make
 * a 73 m boat and a 170 m boat the same size on screen, throwing away the thing the player
 * most needs to see in a list. Here the Light is visibly a third of the Heavy, which is true.
 */
const SHARED_VIEWBOX = '-92 -17 184 31';

interface HullIconProps {
  hull: HullId;
  /** Rendered width in px; height follows the shared aspect ratio. */
  width?: number;
  className?: string;
}

export function HullIcon({ hull, width = 120, className }: HullIconProps) {
  const { silhouette, name } = getHull(hull);
  const points = silhouette.map(([x, y]) => `${String(x)},${String(y)}`).join(' ');

  return (
    <svg
      className={className === undefined ? 'hull-icon' : `hull-icon ${className}`}
      viewBox={SHARED_VIEWBOX}
      width={width}
      height={Math.round((width * 31) / 184)}
      role="img"
      aria-label={`${name} hull silhouette`}
    >
      <polygon points={points} />
    </svg>
  );
}
