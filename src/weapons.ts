// Player weapon cards and their attacks.
//
// Attacks are authored as ASCII diagrams (see parsePattern) assuming the
// attacker faces North: 'X' is a targeted square, '^' is the attacker.
// This file is a tuning surface — adjust damage, stamina, and patterns here.

import { parsePattern, type Offset } from "./grid";

export interface Attack {
  name: string;
  diagram: string;
  pattern: Offset[];
  damage: number;
  staminaCost: number;
}

export interface Weapon {
  name: string;
  attacks: Attack[];
}

function attack(
  name: string,
  diagram: string,
  damage: number,
  staminaCost: number
): Attack {
  return { name, diagram, pattern: parsePattern(diagram), damage, staminaCost };
}

const SLASH = `
XXXXX
--^--`;

export const STRAIGHT_SWORD: Weapon = {
  name: "Straight Sword",
  attacks: [attack("Slash", SLASH, 2, 2)],
};
