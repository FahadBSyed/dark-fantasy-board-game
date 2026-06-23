// Player armaments — weapons and shields. Patterns are authored as ASCII
// diagrams facing North ('X' = struck square, 'O' = guarded square, '^' = the
// wielder). This file is the tuning surface for the player's kit.

import { parsePattern, type Offset } from "./grid";

export interface Attack {
  name: string;
  diagram: string;
  diagonalDiagram?: string;
  pattern: Offset[];
  damage: number;
  staminaCost: number;
  stun?: boolean; // hitting forces a stun roll on the target
  comboOnStun?: Attack; // bonus follow-up if this attack stuns
}

export interface Weapon {
  name: string;
  weight: number; // equip-load units
  light: Attack;
  heavy: Attack;
  backstab: number; // damage when striking a foe from directly behind
}

export interface Shield {
  name: string;
  weight: number;
  diagram: string; // guarded squares, facing North
  diagonalDiagram?: string;
  pattern: Offset[];
  // Parry matching rule for the spoken/typed attack tags:
  // "exactAll" = all tags, in order; "any2" = at least 2 tags, any order.
  parry: "exactAll" | "any2";
}

function attack(a: Omit<Attack, "pattern">): Attack {
  return { ...a, pattern: parsePattern(a.diagram) };
}

function shield(s: Omit<Shield, "pattern">): Shield {
  return { ...s, pattern: parsePattern(s.diagram) };
}

// --- Weapons ---

export const THIEFS_KNIFE: Weapon = {
  name: "Thief's Knife",
  weight: 1,
  backstab: 8,
  light: attack({
    name: "Stab",
    damage: 1,
    staminaCost: 1,
    diagram: `
-X-
-^-`,
    diagonalDiagram: `
-X
^-`,
  }),
  heavy: attack({
    name: "Rake",
    damage: 2,
    staminaCost: 2,
    stun: true,
    diagram: `
XXX
-^-`,
    diagonalDiagram: `
XX
^X`,
  }),
};

export const STRAIGHT_SWORD: Weapon = {
  name: "Straight Sword",
  weight: 2,
  backstab: 4,
  light: attack({
    name: "Slash",
    damage: 2,
    staminaCost: 2,
    stun: true,
    diagram: `
XXX
-^-`,
    diagonalDiagram: `
-XX
-^X`,
    // On a stun, the swordsman follows through with a thrust.
    comboOnStun: attack({
      name: "Follow Thrust",
      damage: 2,
      staminaCost: 2,
      diagram: `
X
^`,
      diagonalDiagram: `
-X
^`,
    }),
  }),
  heavy: attack({
    name: "Lunge",
    damage: 3,
    staminaCost: 3,
    stun: true,
    diagram: `
-X-
-X-
-^-`,
    diagonalDiagram: `
--X
-X-
^--`,
  }),
};

// --- Shields ---

export const BUCKLER: Shield = shield({
  name: "Buckler",
  weight: 1,
  parry: "any2",
  diagram: `
O
^`,
  diagonalDiagram: `
-O
^`,
});

export const KITE_SHIELD: Shield = shield({
  name: "Kite Shield",
  weight: 2,
  parry: "exactAll",
  diagram: `
OO-
O^-`,
  diagonalDiagram: `
OO
^O`,
});

export const WEAPONS: Weapon[] = [THIEFS_KNIFE, STRAIGHT_SWORD];
export const SHIELDS: Shield[] = [BUCKLER, KITE_SHIELD];
