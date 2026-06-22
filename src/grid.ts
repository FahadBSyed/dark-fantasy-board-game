// Grid geometry and orientation.
//
// We use 8 compass directions indexed clockwise from North. Patterns (attacks,
// blocks) are authored relative to "facing North" as a set of (direction,
// distance) cells. To orient a pattern for an entity facing some direction we
// simply add the facing's index to each cell's direction (mod 8). Because we
// work in compass-cell space rather than Euclidean vectors, this rotates
// patterns in exact 45° steps with no rounding — so a swing is always the same
// fair shape no matter which way you face.

export interface Coord {
  x: number;
  y: number;
}

// Clockwise from North. Index doubles as the rotation amount in 45° steps.
export const enum Dir {
  N = 0,
  NE = 1,
  E = 2,
  SE = 3,
  S = 4,
  SW = 5,
  W = 6,
  NW = 7,
}

export const DIR_COUNT = 8;

// Unit step for each compass direction. Screen coords: +x right, +y down,
// so North is -y.
const STEP: ReadonlyArray<Coord> = [
  { x: 0, y: -1 }, // N
  { x: 1, y: -1 }, // NE
  { x: 1, y: 0 }, // E
  { x: 1, y: 1 }, // SE
  { x: 0, y: 1 }, // S
  { x: -1, y: 1 }, // SW
  { x: -1, y: 0 }, // W
  { x: -1, y: -1 }, // NW
];

export const DIR_NAME: ReadonlyArray<string> = [
  "N",
  "NE",
  "E",
  "SE",
  "S",
  "SW",
  "W",
  "NW",
];

// Glyph pointing in each facing, for the board.
export const DIR_GLYPH: ReadonlyArray<string> = [
  "▲",
  "◥",
  "▶",
  "◢",
  "▼",
  "◣",
  "◀",
  "◤",
];

export function step(dir: Dir): Coord {
  return STEP[dir];
}

export function rotateDir(dir: Dir, by: Dir): Dir {
  return (((dir + by) % DIR_COUNT) + DIR_COUNT) % DIR_COUNT;
}

export function turnLeft(dir: Dir): Dir {
  return rotateDir(dir, Dir.NW); // -45°
}

export function turnRight(dir: Dir): Dir {
  return rotateDir(dir, Dir.NE); // +45°
}

// A single cell of a pattern, authored relative to facing North.
export interface PatternCell {
  dir: Dir;
  dist: number;
}

export type Pattern = ReadonlyArray<PatternCell>;

// Orient a pattern to a facing, then resolve to absolute grid coords from an
// origin. Cells that fall outside the grid bounds are still returned; callers
// decide whether off-board cells matter.
export function squaresFor(
  pattern: Pattern,
  origin: Coord,
  facing: Dir
): Coord[] {
  return pattern.map((cell) => {
    const d = rotateDir(cell.dir, facing);
    const s = STEP[d];
    return { x: origin.x + s.x * cell.dist, y: origin.y + s.y * cell.dist };
  });
}

// An attack/block square expressed as a raw grid offset from the attacker,
// authored relative to facing North. Used for multi-cell patterns (e.g. a
// 5-wide slash) that don't lie on a single compass ray.
export interface Offset {
  dx: number;
  dy: number;
}

export type OffsetPattern = ReadonlyArray<Offset>;

// Parse an ASCII attack diagram into offsets. 'X' (or 'x') marks a targeted
// square, '^' marks the attacker; every other character is empty space. The
// diagram is read assuming the attacker faces North.
//
//   XXXXX
//   --^--
//
// yields the five squares one row ahead, spanning two left to two right.
export function parsePattern(diagram: string): Offset[] {
  const rows = diagram.replace(/^\n+|\n+$/g, "").split("\n");
  let ox = 0;
  let oy = 0;
  rows.forEach((row, y) => {
    const i = row.indexOf("^");
    if (i >= 0) {
      ox = i;
      oy = y;
    }
  });
  const out: Offset[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x].toLowerCase();
      if (ch === "x") out.push({ dx: x - ox, dy: y - oy });
    }
  });
  return out;
}

// Orient an offset pattern to any of the 8 facings and resolve to absolute
// grid coords. Each cell is read in the attacker's own basis: dx is "strafe"
// (rightward in the North-facing diagram) and -dy is "forward" (up in the
// diagram). We rebuild that basis from the facing — forward = the facing's
// unit step, right = the step 90° clockwise — so the pattern stays integer and
// keeps its footprint. On cardinals this is an exact rotation; on diagonals it
// shears the pattern out along the diagonal (a 5-wide line becomes a 5-long
// diagonal line), which is the intended behaviour.
export function squaresForOffsets(
  pattern: OffsetPattern,
  origin: Coord,
  facing: Dir
): Coord[] {
  const fwd = STEP[facing];
  const right = STEP[rotateDir(facing, Dir.E)]; // 90° clockwise from forward
  return pattern.map(({ dx, dy }) => {
    const s = dx; // strafe
    const f = -dy; // forward
    return {
      x: origin.x + s * right.x + f * fwd.x,
      y: origin.y + s * right.y + f * fwd.y,
    };
  });
}

// The compass direction matching a step delta (each component -1, 0, or 1).
// Returns null only when the delta is (0, 0).
export function dirFromDelta(dx: number, dy: number): Dir | null {
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (sx === 0 && sy === 0) return null;
  for (let d = 0; d < DIR_COUNT; d++) {
    if (STEP[d].x === sx && STEP[d].y === sy) return d as Dir;
  }
  return null;
}

export function inBounds(c: Coord, width: number, height: number): boolean {
  return c.x >= 0 && c.y >= 0 && c.x < width && c.y < height;
}

export function sameCoord(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y;
}

// Chebyshev (king-move) distance — the number of steps between two cells on a
// grid where diagonal moves are allowed.
export function chebyshev(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function clampToBounds(
  c: Coord,
  width: number,
  height: number
): Coord {
  return {
    x: Math.max(0, Math.min(width - 1, c.x)),
    y: Math.max(0, Math.min(height - 1, c.y)),
  };
}
