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
  knockback?: number; // squares the player is shoved away on hit (push)
  stun?: boolean; // hitting forces a stun roll on the player
  jump?: number; // squares the attacker leaps toward the player before striking
  reface?: boolean; // attacker turns to face the player before striking
  tags?: string[]; // tags the player must call to parry this attack
  // A second swing (the card's fold-out segment). It resolves in a follow-up
  // reaction wave when followUpOn is satisfied by the d10 that picked the card.
  followUp?: EnemyCard;
  followUpOn?: "oddRoll";
}

export interface EnemyTemplate {
  name: string;
  maxHp: number; // ❤ health
  moveSpeed: number; // 👟 squares per turn
  stunResist: number; // ★ a stun roll under this stuns it
  soul: number; // ◆ souls dropped
  backstabImmune?: boolean;
  deck: EnemyCard[]; // up to 10 cards
}

function card(c: Omit<EnemyCard, "pattern">): EnemyCard {
  return { ...c, pattern: parsePattern(c.diagram) };
}

const KNEE_UP = card({
  name: "Knee Up",
  telegraph: "knee up",
  range: 1,
  tags: ["quick", "kick", "snap"],
  damage: 1,
  staminaDamage: 2,
  knockback: 1, // push 1
  diagram: `
X
^`,
  diagonalDiagram: `
-X
^`,
});

const FROM_RIGHT = card({
  name: "Axe — From Your Right",
  telegraph: "from your right",
  range: 1,
  tags: ["axe", "med", "cut"],
  damage: 2,
  diagram: `
XXX
-^-`,
  diagonalDiagram: `
XX
^X`,
});

const FROM_LEFT = card({
  name: "Axe — From Your Left",
  telegraph: "from your left",
  range: 1,
  tags: ["axe", "med", "cut"],
  damage: 2,
  diagram: `
XXX
-^-`,
  diagonalDiagram: `
XX
^X`,
  // On an odd roll, the hollow turns into a stunning shoulder bash.
  followUpOn: "oddRoll",
  followUp: card({
    name: "Shoulder Twist",
    telegraph: "shoulder twist",
    range: 2,
    tags: ["quick", "bash", "snap"],
    damage: 2,
    staminaDamage: 1,
    stun: true,
    reface: true, // turns to face the player before the bash
    diagram: `
X
^`,
    diagonalDiagram: `
-X
^-`,
  }),
});

const OVERHEAD = card({
  name: "Overhead",
  telegraph: "overhead",
  range: 2,
  tags: ["heave", "med", "chop"],
  damage: 2,
  diagram: `
X
X
^`,
  diagonalDiagram: `
--X
-X-
^`,
});

const BENT_KNEES = card({
  name: "Bent Knees",
  telegraph: "bent knees",
  range: 2,
  tags: ["jump", "slam", "slow"],
  damage: 3,
  jump: 1, // leaps a square toward the player at the start of the attack
  diagram: `
-XX
-X-
-^-`,
  diagonalDiagram: `
--X
-XX
^`,
});

export const HOLLOW_AXEMAN: EnemyTemplate = {
  name: "Hollow Axeman",
  maxHp: 4,
  moveSpeed: 2,
  stunResist: 8,
  soul: 1,
  deck: [KNEE_UP, FROM_RIGHT, FROM_LEFT, OVERHEAD, BENT_KNEES],
};
