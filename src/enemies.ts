// Enemy templates and their attack decks.
//
// Each attack card carries a telegraph and range (shown on the card back while
// face-down) plus a pattern, damage, and optional effects (shown on the front
// once flipped). Patterns are authored as ASCII diagrams facing North.

import { parsePattern, type Offset } from "./grid";

export interface EnemyCard {
  name: string;
  telegraph: string; // printed on the back
  range: number; // printed on the back
  diagram: string; // authored facing North; drives the pattern
  diagonalDiagram?: string; // illustration only: the same attack facing NE
  pattern: Offset[];
  damage: number;
  staminaDamage?: number; // stamina lost on hit
  knockback?: number; // squares the player is shoved away on hit
  // A second swing (the card's fold-out segment). It resolves in a follow-up
  // reaction wave when followUpOn is satisfied by the d10 that picked the card.
  followUp?: EnemyCard;
  followUpOn?: "oddRoll";
}

export interface EnemyTemplate {
  name: string;
  maxHp: number;
  deck: EnemyCard[]; // up to 10 cards
}

function card(c: Omit<EnemyCard, "pattern">): EnemyCard {
  return { ...c, pattern: parsePattern(c.diagram) };
}

const AXE_CUT = card({
  name: "Axe Cut",
  telegraph: "axe from your left",
  range: 1,
  diagram: `
XXX
-^-`,
  diagonalDiagram: `
-XX
-^X
---`,
  damage: 2,
  // On an odd d10, the hollow follows the cut with a backswing from the right.
  followUpOn: "oddRoll",
  followUp: card({
    name: "Axe Return",
    telegraph: "axe from your right",
    range: 1,
    diagram: `
XXX
-^-`,
    diagonalDiagram: `
-XX
-^X
---`,
    damage: 2,
  }),
});

const AXE_SLAM = card({
  name: "Axe Slam",
  telegraph: "overhead",
  range: 2,
  diagram: `
-X-
-X-
-^-`,
  damage: 2,
});

const KICK = card({
  name: "Kick",
  telegraph: "knee up",
  range: 1,
  diagram: `
-X-
-^-`,
  damage: 1,
  staminaDamage: 2,
  knockback: 1,
});

export const HOLLOW_AXEMAN: EnemyTemplate = {
  name: "Hollow Axeman",
  maxHp: 3,
  deck: [AXE_CUT, AXE_SLAM, KICK],
};
