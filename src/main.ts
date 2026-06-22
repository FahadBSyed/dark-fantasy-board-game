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
  DIR_NAME,
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
  selected: boolean;
  busy: boolean; // true during attack animations; locks input
  preview: Coord[] | null; // squares to highlight while hovering an attack
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
  selected: false,
  busy: false,
  preview: null,
  log: ["The Ashen One stands ready. A hollow lurks across the hall."],
};

const boardEl = document.getElementById("board")!;
const vitalsEl = document.getElementById("vitals")!;
const logEl = document.getElementById("log")!;
const weaponEl = document.getElementById("weapon")!;

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
  const preview = new Set((state.preview ?? []).map(key));

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
  const turnLabel = state.turn === "player" ? "Your turn" : "Enemy turn";
  const enemyHp = state.enemy ? `${state.enemy.hp} / ${state.enemy.maxHp}` : "slain";
  vitalsEl.innerHTML = `
    <div><span class="key">Turn</span> · <span class="val">${turnLabel}</span></div>
    <div><span class="key">Moves left</span> · <span class="val">${state.movesLeft}</span> / ${MOVES_PER_TURN}</div>
    <div><span class="key">Stamina</span> · <span class="val">${state.player.stamina}</span> / ${state.player.maxStamina}</div>
    <div><span class="key">Facing</span> · <span class="val">${DIR_NAME[state.player.facing]}</span></div>
    <div><span class="key">Enemy HP</span> · <span class="val">${enemyHp}</span></div>
  `;
  logEl.replaceChildren(
    ...state.log.map((line) => {
      const d = document.createElement("div");
      d.textContent = line;
      return d;
    })
  );
}

// Render the weapon card with its attacks below the board.
function renderWeapon(): void {
  const weapon = state.player.weapon;
  weaponEl.replaceChildren();

  const title = document.createElement("div");
  title.className = "weapon-title";
  title.textContent = weapon.name;
  weaponEl.appendChild(title);

  const row = document.createElement("div");
  row.className = "attack-row";

  for (const atk of weapon.attacks) {
    const affordable = state.player.stamina >= atk.staminaCost;
    const usable = state.turn === "player" && !state.busy && affordable;

    const card = document.createElement("div");
    card.className = "attack-card" + (usable ? "" : " disabled");

    card.appendChild(makeDiagram(atk.diagram));

    const name = document.createElement("div");
    name.className = "attack-name";
    name.textContent = atk.name;
    card.appendChild(name);

    const stats = document.createElement("div");
    stats.className = "attack-stats";
    stats.textContent = `${atk.damage} dmg · ${atk.staminaCost} stam`;
    card.appendChild(stats);

    if (usable) {
      card.addEventListener("mouseenter", () => {
        state.preview = targetSquares(atk).filter((c) => inBounds(c, WIDTH, HEIGHT));
        render();
      });
      card.addEventListener("mouseleave", () => {
        state.preview = null;
        render();
      });
      card.addEventListener("click", () => performAttack(atk));
    }

    row.appendChild(card);
  }

  weaponEl.appendChild(row);
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

// Spend stamina, flash the targeted squares, then (if the enemy is caught)
// flash the enemy and apply damage.
function performAttack(atk: Attack): void {
  if (state.turn !== "player" || state.busy) return;
  if (state.player.stamina < atk.staminaCost) {
    log("Not enough stamina to attack.");
    return;
  }

  const targets = targetSquares(atk).filter((c) => inBounds(c, WIDTH, HEIGHT));
  state.player.stamina -= atk.staminaCost;
  state.busy = true;
  state.preview = null;
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
      }, FLASH_MS);
    } else {
      log("The blade meets only air.");
      state.busy = false;
      render();
    }
  }, FLASH_MS);
}

function startPlayerTurn(): void {
  state.turn = "player";
  state.movesLeft = MOVES_PER_TURN;
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
