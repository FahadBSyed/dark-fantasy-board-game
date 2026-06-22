// Pass 3: stamina and attacks.
// - Player turn: select the token, move (up to 5 squares), rotate with the
//   buttons or Q / E (45° steps), and attack from the weapon card below the
//   board. Attacking spends stamina; stamina regenerates each turn.
// - Attacks flash their targeted squares; a struck enemy flashes and loses
//   health, and is removed from the board at 0 HP.
// - Enemy turn: the hollow walks up to 3 squares toward the player.

import {
  chebyshev,
  Dir,
  dirFromDelta,
  inBounds,
  sameCoord,
  squaresForOffsets,
  turnLeft,
  turnRight,
  type Coord,
} from "./grid";
import { STRAIGHT_SWORD, type Attack, type Weapon } from "./weapons";

const SVG_NS = "http://www.w3.org/2000/svg";

type TokenKind = "player" | "enemy";

// A circular body with a triangular pointer showing facing. Authored pointing
// North (up); rotated by facing * 45° (8 compass steps).
function makeTokenSvg(facing: Dir, kind: TokenKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.classList.add("token-svg", kind);

  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", `rotate(${facing * 45} 20 20)`);

  const body = document.createElementNS(SVG_NS, "circle");
  body.setAttribute("cx", "20");
  body.setAttribute("cy", "21");
  body.setAttribute("r", "11");
  body.classList.add("token-body");

  const pointer = document.createElementNS(SVG_NS, "polygon");
  pointer.setAttribute("points", "20,2 13,15 27,15");
  pointer.classList.add("token-pointer");

  g.appendChild(body);
  g.appendChild(pointer);
  svg.appendChild(g);
  return svg;
}

const WIDTH = 10;
const HEIGHT = 10;
const MOVES_PER_TURN = 5;
const MAX_STAMINA = 5;
const STAMINA_REGEN = 2;
const ENEMY_MOVES_PER_TURN = 3;
const ENEMY_STEP_MS = 280;
const FLASH_MS = 260;

interface PlayerToken {
  pos: Coord;
  facing: Dir;
  stamina: number;
  maxStamina: number;
  weapon: Weapon;
}

interface EnemyToken {
  pos: Coord;
  facing: Dir;
  hp: number;
  maxHp: number;
}

type Turn = "player" | "enemy";

interface State {
  player: PlayerToken;
  enemy: EnemyToken | null;
  turn: Turn;
  movesLeft: number;
  attacksUsed: number; // attacks taken so far this player turn
  selected: boolean;
  busy: boolean; // true during attack animations; locks input
  stagedAttack: Attack | null; // attack committed this turn, resolves on End turn
  log: string[];
}

const state: State = {
  player: {
    pos: { x: 4, y: 7 },
    facing: Dir.N,
    stamina: MAX_STAMINA,
    maxStamina: MAX_STAMINA,
    weapon: STRAIGHT_SWORD,
  },
  enemy: { pos: { x: 4, y: 1 }, facing: Dir.S, hp: 3, maxHp: 3 },
  turn: "player",
  movesLeft: MOVES_PER_TURN,
  attacksUsed: 0,
  selected: false,
  busy: false,
  stagedAttack: null,
  log: ["The Ashen One stands ready. A hollow lurks across the hall."],
};

const boardEl = document.getElementById("board")!;
const vitalsEl = document.getElementById("vitals")!;
const logEl = document.getElementById("log")!;
const weaponEl = document.getElementById("weapon")!;
const staminaEl = document.getElementById("stamina")!;

// Coordinate ("x,y") -> cell element, rebuilt on every render so the attack
// flash sequence can target specific squares without a full re-render.
const cellEls = new Map<string, HTMLElement>();

const key = (c: Coord) => `${c.x},${c.y}`;

function log(msg: string): void {
  state.log.unshift(msg);
  state.log = state.log.slice(0, 30);
}

// Squares the selected player can reach with its remaining moves (king-move
// distance), excluding its own cell, the enemy's cell, and off-board cells.
function reachable(): Set<string> {
  const out = new Set<string>();
  if (state.turn !== "player" || state.busy || !state.selected) return out;
  const { pos } = state.player;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const c = { x, y };
      if (sameCoord(c, pos)) continue;
      if (state.enemy && sameCoord(c, state.enemy.pos)) continue;
      if (chebyshev(pos, c) <= state.movesLeft) out.add(key(c));
    }
  }
  return out;
}

function render(): void {
  const reach = reachable();
  const previewSquares = state.stagedAttack
    ? targetSquares(state.stagedAttack).filter((c) => inBounds(c, WIDTH, HEIGHT))
    : [];
  const preview = new Set(previewSquares.map(key));

  boardEl.style.gridTemplateColumns = `repeat(${WIDTH}, 46px)`;
  boardEl.replaceChildren();
  cellEls.clear();

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const here = { x, y };
      const cell = document.createElement("div");
      cell.className = "cell" + ((x + y) % 2 ? " dark" : "");
      cellEls.set(key(here), cell);

      const isPlayer = sameCoord(here, state.player.pos);
      const isEnemy = state.enemy != null && sameCoord(here, state.enemy.pos);
      const isReach = reach.has(key(here));

      if (preview.has(key(here))) cell.classList.add("target-preview");

      if (isPlayer) {
        cell.classList.add("player");
        if (state.selected) cell.classList.add("selected");
        cell.appendChild(makeTokenSvg(state.player.facing, "player"));
        cell.addEventListener("click", () => {
          if (state.turn !== "player" || state.busy) return;
          state.selected = !state.selected;
          render();
        });
      } else if (isEnemy && state.enemy) {
        cell.appendChild(makeTokenSvg(state.enemy.facing, "enemy"));
        const badge = document.createElement("span");
        badge.className = "hp-badge";
        badge.textContent = String(state.enemy.hp);
        cell.appendChild(badge);
      } else if (isReach) {
        cell.classList.add("reach");
        cell.addEventListener("click", () => moveTo(here));
      }

      boardEl.appendChild(cell);
    }
  }

  renderHud();
  renderWeapon();
}

function renderHud(): void {
  const yours = state.turn === "player";
  vitalsEl.innerHTML = `<div class="turn-state ${yours ? "you" : "enemy"}">${
    yours ? "Your turn" : "Enemy turn"
  }</div>`;

  staminaEl.textContent = String(state.player.stamina);
  staminaEl.classList.toggle("empty", state.player.stamina <= 0);

  logEl.replaceChildren(
    ...state.log.map((line) => {
      const d = document.createElement("div");
      d.textContent = line;
      return d;
    })
  );
}

// Render the weapon as a skeuomorphic card below the board, with its attacks
// as selectable options on the card face.
function renderWeapon(): void {
  const weapon = state.player.weapon;
  weaponEl.replaceChildren();

  const card = document.createElement("div");
  card.className = "weapon-card";

  const corner = document.createElement("div");
  corner.className = "weapon-corner";
  corner.textContent = "⚔";
  card.appendChild(corner);

  const title = document.createElement("div");
  title.className = "weapon-card-title";
  title.textContent = weapon.name;
  card.appendChild(title);

  card.appendChild(makeSwordArt());

  const attacks = document.createElement("div");
  attacks.className = "weapon-card-attacks";

  for (const atk of weapon.attacks) {
    const affordable = state.player.stamina >= atk.staminaCost;
    const hasUses = state.attacksUsed < atk.usesPerTurn;
    const usable = state.turn === "player" && !state.busy && affordable && hasUses;
    const staged = state.stagedAttack === atk;

    const opt = document.createElement("div");
    opt.className =
      "attack-option" + (usable ? "" : " disabled") + (staged ? " staged" : "");

    opt.appendChild(makeDiagram(atk.diagram));

    const text = document.createElement("div");
    text.className = "attack-text";

    const name = document.createElement("div");
    name.className = "attack-name";
    name.textContent = atk.name;
    text.appendChild(name);

    const stats = document.createElement("div");
    stats.className = "attack-stats";
    const repeat = atk.usesPerTurn > 1 ? ` · ×${atk.usesPerTurn}/turn` : "";
    stats.textContent = `${atk.damage} dmg · ${atk.staminaCost} stam${repeat}`;
    text.appendChild(stats);

    opt.appendChild(text);

    // Clicking stages (or un-stages) the attack; it resolves on End turn.
    if (usable || staged) {
      opt.addEventListener("click", () => toggleStage(atk));
    }

    attacks.appendChild(opt);
  }

  card.appendChild(attacks);
  weaponEl.appendChild(card);
}

// Decorative upright sword for the weapon card face.
function makeSwordArt(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 120");
  svg.classList.add("weapon-art");

  const blade = document.createElementNS(SVG_NS, "polygon");
  blade.setAttribute("points", "32,6 38,18 38,72 26,72 26,18");
  blade.setAttribute("class", "sword-blade");

  const guard = document.createElementNS(SVG_NS, "rect");
  guard.setAttribute("x", "14");
  guard.setAttribute("y", "72");
  guard.setAttribute("width", "36");
  guard.setAttribute("height", "8");
  guard.setAttribute("rx", "3");
  guard.setAttribute("class", "sword-guard");

  const grip = document.createElementNS(SVG_NS, "rect");
  grip.setAttribute("x", "29");
  grip.setAttribute("y", "80");
  grip.setAttribute("width", "6");
  grip.setAttribute("height", "26");
  grip.setAttribute("class", "sword-grip");

  const pommel = document.createElementNS(SVG_NS, "circle");
  pommel.setAttribute("cx", "32");
  pommel.setAttribute("cy", "110");
  pommel.setAttribute("r", "5");
  pommel.setAttribute("class", "sword-guard");

  svg.append(blade, guard, grip, pommel);
  return svg;
}

// A small visual of the attack's authored diagram.
function makeDiagram(diagram: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "diagram";
  const rows = diagram.replace(/^\n+|\n+$/g, "").split("\n");
  const w = Math.max(...rows.map((r) => r.length));
  wrap.style.gridTemplateColumns = `repeat(${w}, 12px)`;
  for (const r of rows) {
    for (let x = 0; x < w; x++) {
      const ch = (r[x] ?? "").toLowerCase();
      const dot = document.createElement("span");
      dot.className =
        "dot" + (ch === "x" ? " hit" : ch === "^" ? " self" : "");
      wrap.appendChild(dot);
    }
  }
  return wrap;
}

function targetSquares(atk: Attack): Coord[] {
  return squaresForOffsets(atk.pattern, state.player.pos, state.player.facing);
}

function moveTo(dest: Coord): void {
  if (state.turn !== "player" || state.busy || !state.selected) return;
  if (!inBounds(dest, WIDTH, HEIGHT)) return;
  if (state.enemy && sameCoord(dest, state.enemy.pos)) return;
  const cost = chebyshev(state.player.pos, dest);
  if (cost === 0 || cost > state.movesLeft) return;
  state.player.pos = dest;
  state.movesLeft -= cost;
  log(`Moved to ${dest.x}, ${dest.y} (−${cost}).`);
  if (state.movesLeft === 0) {
    state.selected = false;
    log("Out of moves.");
  }
  render();
}

function rotate(left: boolean): void {
  if (state.turn !== "player" || state.busy) return;
  state.player.facing = left
    ? turnLeft(state.player.facing)
    : turnRight(state.player.facing);
  render();
}

// Stage (or un-stage) an attack for this turn. It resolves when the player
// ends their turn, using their position and facing at that moment.
function toggleStage(atk: Attack): void {
  if (state.turn !== "player" || state.busy) return;
  state.stagedAttack = state.stagedAttack === atk ? null : atk;
  render();
}

// Resolve a staged attack: spend stamina, flash the targeted squares, then (if
// the enemy is caught) flash the enemy and apply damage. Calls onDone once the
// animation finishes so the turn can continue.
function performAttack(atk: Attack, onDone: () => void): void {
  const targets = targetSquares(atk).filter((c) => inBounds(c, WIDTH, HEIGHT));
  state.player.stamina -= atk.staminaCost;
  state.attacksUsed += 1;
  state.busy = true;
  state.selected = false;
  log(`You strike — ${atk.name}. (−${atk.staminaCost} stamina)`);
  render();

  for (const t of targets) cellEls.get(key(t))?.classList.add("flash-target");

  setTimeout(() => {
    for (const t of targets) cellEls.get(key(t))?.classList.remove("flash-target");

    const enemy = state.enemy;
    const hit = enemy != null && targets.some((t) => sameCoord(t, enemy.pos));

    if (hit && enemy) {
      const el = cellEls.get(key(enemy.pos));
      el?.classList.add("flash-hit");
      setTimeout(() => {
        el?.classList.remove("flash-hit");
        enemy.hp -= atk.damage;
        if (enemy.hp <= 0) {
          log("The hollow is cut down.");
          state.enemy = null;
        } else {
          log(`The hollow takes ${atk.damage}. (${enemy.hp} HP left)`);
        }
        state.busy = false;
        render();
        onDone();
      }, FLASH_MS);
    } else {
      log("The blade meets only air.");
      state.busy = false;
      render();
      onDone();
    }
  }, FLASH_MS);
}

function startPlayerTurn(): void {
  state.turn = "player";
  state.movesLeft = MOVES_PER_TURN;
  state.attacksUsed = 0;
  state.player.stamina = Math.min(
    state.player.maxStamina,
    state.player.stamina + STAMINA_REGEN
  );
  log("— Your turn —");
  render();
}

function endTurn(): void {
  if (state.turn !== "player" || state.busy) return;
  state.selected = false;

  const atk = state.stagedAttack;
  state.stagedAttack = null;
  const canAttack =
    atk != null &&
    state.attacksUsed < atk.usesPerTurn &&
    state.player.stamina >= atk.staminaCost;

  if (atk && canAttack) {
    performAttack(atk, beginEnemyPhase);
  } else {
    beginEnemyPhase();
  }
}

// Hand control to the enemy (or, with no enemy left, straight to the next
// player turn).
function beginEnemyPhase(): void {
  if (!state.enemy) {
    startPlayerTurn();
    return;
  }
  state.turn = "enemy";
  log("— Enemy turn —");
  render();
  setTimeout(() => enemyStep(0), ENEMY_STEP_MS);
}

// One step of the enemy's advance: face the player and move one square along
// the straight line toward them, stopping when adjacent, blocked, or done.
function enemyStep(stepsTaken: number): void {
  const enemy = state.enemy;
  if (!enemy) {
    startPlayerTurn();
    return;
  }
  const player = state.player;
  const dx = player.pos.x - enemy.pos.x;
  const dy = player.pos.y - enemy.pos.y;

  const facing = dirFromDelta(dx, dy);
  if (facing !== null) enemy.facing = facing;

  const adjacent = chebyshev(enemy.pos, player.pos) <= 1;
  if (stepsTaken >= ENEMY_MOVES_PER_TURN || adjacent || facing === null) {
    render();
    startPlayerTurn();
    return;
  }

  enemy.pos = { x: enemy.pos.x + Math.sign(dx), y: enemy.pos.y + Math.sign(dy) };
  log(`The hollow advances to ${enemy.pos.x}, ${enemy.pos.y}.`);
  render();
  setTimeout(() => enemyStep(stepsTaken + 1), ENEMY_STEP_MS);
}

document.getElementById("turn-left")!.addEventListener("click", () => rotate(true));
document.getElementById("turn-right")!.addEventListener("click", () => rotate(false));
document.getElementById("end-turn")!.addEventListener("click", endTurn);

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "q") rotate(true);
  else if (k === "e") rotate(false);
  else if (k === "enter") endTurn();
  else return;
  e.preventDefault();
});

render();
