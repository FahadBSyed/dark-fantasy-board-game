// Pass 2: a 10x10 grid with a player token and one enemy, taking alternating
// turns.
// - Player turn: click the token to select, click a highlighted square to move
//   (up to 5 squares), rotate with the buttons or Q / E, then End turn.
// - Enemy turn: the enemy walks up to 3 squares in a straight line toward the
//   player, then control returns to the player.

import {
  chebyshev,
  Dir,
  DIR_NAME,
  dirFromDelta,
  inBounds,
  sameCoord,
  turnLeft,
  turnRight,
  type Coord,
} from "./grid";

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
const ENEMY_MOVES_PER_TURN = 3;
const ENEMY_STEP_MS = 280;

interface Token {
  pos: Coord;
  facing: Dir;
}

type Turn = "player" | "enemy";

interface State {
  player: Token;
  enemy: Token;
  turn: Turn;
  movesLeft: number;
  selected: boolean;
  log: string[];
}

const state: State = {
  player: { pos: { x: 4, y: 7 }, facing: Dir.N },
  enemy: { pos: { x: 4, y: 1 }, facing: Dir.S },
  turn: "player",
  movesLeft: MOVES_PER_TURN,
  selected: false,
  log: ["The Ashen One stands ready. A hollow lurks across the hall."],
};

const boardEl = document.getElementById("board")!;
const vitalsEl = document.getElementById("vitals")!;
const logEl = document.getElementById("log")!;

function log(msg: string): void {
  state.log.unshift(msg);
  state.log = state.log.slice(0, 30);
}

// Squares the selected player can reach with its remaining moves (king-move
// distance), excluding its own cell, the enemy's cell, and off-board cells.
function reachable(): Set<string> {
  const out = new Set<string>();
  if (state.turn !== "player" || !state.selected) return out;
  const { pos } = state.player;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const c = { x, y };
      if (sameCoord(c, pos) || sameCoord(c, state.enemy.pos)) continue;
      if (chebyshev(pos, c) <= state.movesLeft) out.add(`${x},${y}`);
    }
  }
  return out;
}

function render(): void {
  const reach = reachable();

  boardEl.style.gridTemplateColumns = `repeat(${WIDTH}, 46px)`;
  boardEl.replaceChildren();

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const cell = document.createElement("div");
      cell.className = "cell" + ((x + y) % 2 ? " dark" : "");

      const isPlayer = sameCoord({ x, y }, state.player.pos);
      const isEnemy = sameCoord({ x, y }, state.enemy.pos);
      const isReach = reach.has(`${x},${y}`);

      if (isPlayer) {
        cell.classList.add("player");
        if (state.selected) cell.classList.add("selected");
        cell.appendChild(makeTokenSvg(state.player.facing, "player"));
        cell.addEventListener("click", () => {
          if (state.turn !== "player") return;
          state.selected = !state.selected;
          render();
        });
      } else if (isEnemy) {
        cell.appendChild(makeTokenSvg(state.enemy.facing, "enemy"));
      } else if (isReach) {
        cell.classList.add("reach");
        cell.addEventListener("click", () => moveTo({ x, y }));
      }

      boardEl.appendChild(cell);
    }
  }

  renderHud();
}

function renderHud(): void {
  const turnLabel = state.turn === "player" ? "Your turn" : "Enemy turn";
  vitalsEl.innerHTML = `
    <div><span class="key">Turn</span> · <span class="val">${turnLabel}</span></div>
    <div><span class="key">Moves left</span> · <span class="val">${state.movesLeft}</span> / ${MOVES_PER_TURN}</div>
    <div><span class="key">Facing</span> · <span class="val">${DIR_NAME[state.player.facing]}</span></div>
    <div><span class="key">Position</span> · <span class="val">${state.player.pos.x}, ${state.player.pos.y}</span></div>
  `;
  logEl.replaceChildren(
    ...state.log.map((line) => {
      const d = document.createElement("div");
      d.textContent = line;
      return d;
    })
  );
}

function moveTo(dest: Coord): void {
  if (state.turn !== "player" || !state.selected) return;
  if (!inBounds(dest, WIDTH, HEIGHT)) return;
  if (sameCoord(dest, state.enemy.pos)) return;
  const cost = chebyshev(state.player.pos, dest);
  if (cost === 0 || cost > state.movesLeft) return;
  state.player.pos = dest;
  state.movesLeft -= cost;
  log(`Moved to ${dest.x}, ${dest.y} (−${cost}).`);
  if (state.movesLeft === 0) {
    state.selected = false;
    log("Out of moves. End your turn.");
  }
  render();
}

function rotate(left: boolean): void {
  if (state.turn !== "player") return;
  state.player.facing = left
    ? turnLeft(state.player.facing)
    : turnRight(state.player.facing);
  render();
}

function endTurn(): void {
  if (state.turn !== "player") return;
  state.selected = false;
  state.turn = "enemy";
  log("— Enemy turn —");
  render();
  setTimeout(() => enemyStep(0), ENEMY_STEP_MS);
}

// One step of the enemy's advance: face the player and move one square along
// the straight line toward them, stopping when adjacent, blocked, or out of
// moves.
function enemyStep(stepsTaken: number): void {
  const { enemy, player } = state;
  const dx = player.pos.x - enemy.pos.x;
  const dy = player.pos.y - enemy.pos.y;

  // Always look at the player, even if we can't move.
  const facing = dirFromDelta(dx, dy);
  if (facing !== null) enemy.facing = facing;

  const adjacent = chebyshev(enemy.pos, player.pos) <= 1;
  if (stepsTaken >= ENEMY_MOVES_PER_TURN || adjacent || facing === null) {
    render();
    endEnemyTurn();
    return;
  }

  const next = { x: enemy.pos.x + Math.sign(dx), y: enemy.pos.y + Math.sign(dy) };
  enemy.pos = next;
  log(`The hollow advances to ${next.x}, ${next.y}.`);
  render();
  setTimeout(() => enemyStep(stepsTaken + 1), ENEMY_STEP_MS);
}

function endEnemyTurn(): void {
  state.turn = "player";
  state.movesLeft = MOVES_PER_TURN;
  log("— Your turn —");
  render();
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
