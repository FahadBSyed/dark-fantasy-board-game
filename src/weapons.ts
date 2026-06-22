// Player weapon cards and their attacks.
//
// Attacks are authored as ASCII diagrams (see parsePattern) assuming the
// attacker faces North: 'X' is a targeted square, '^' is the attacker.
// This file is a tuning surface — adjust damage, stamina, and patterns here.

import { parsePattern, type Offset } from "./grid";

export interface Attack {
  name: string;
  diagram: string; // authored facing North; drives the actual pattern
  diagonalDiagram?: string; // illustration only: the same attack facing NE
  pattern: Offset[];
  damage: number;
  staminaCost: number;
  // How many times this attack may be used in a single player turn. Defaults
  // to 1 (the standard one-attack-per-turn rule); repeatable attacks raise it.
  usesPerTurn: number;
}

export interface Weapon {
  name: string;
  attacks: Attack[];
}

export interface Shield {
  name: string;
  diagram: string; // guarded squares, facing North
  diagonalDiagram?: string; // illustration facing NE
  pattern: Offset[];
}

function attack(
  name: string,
  diagram: string,
  damage: number,
  staminaCost: number,
  usesPerTurn = 1,
  diagonalDiagram?: string
): Attack {
  return {
    name,
    diagram,
    diagonalDiagram,
    pattern: parsePattern(diagram),
    damage,
    staminaCost,
    usesPerTurn,
  };
}

const SLASH = `
xxx
-^-
---`;

// How the same Slash lands when the attacker faces north-east (illustrative).
const SLASH_DIAGONAL = `
-x---
--x--
-^-x-`;

export const STRAIGHT_SWORD: Weapon = {
  name: "Straight Sword",
  attacks: [attack("Slash", SLASH, 2, 2, 1, SLASH_DIAGONAL)],
};

// Guard arc: the three squares directly ahead. An attacker standing in this
// arc is blocked — its damage hits stamina first, overflow to health.
const GUARD = `
XXX
-^-`;

const GUARD_DIAGONAL = `
-X---
--X--
-^-X-`;

export const KITE_SHIELD: Shield = {
  name: "Kite Shield",
  diagram: GUARD,
  diagonalDiagram: GUARD_DIAGONAL,
  pattern: parsePattern(GUARD),
};
