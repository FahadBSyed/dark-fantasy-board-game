// Pass 1: a 10x10 grid with a single player token.
// - Click the token to select it.
// - Click a highlighted square to move (up to 5 squares per turn).
// - Rotate the token with the buttons or Q / E.
// - End the turn to restore the full move allowance.

import {
  chebyshev,
  Dir,
  DIR_NAME,
  inBounds,
  turnLeft,
  turnRight,
  type Coord,
} from "./grid";

const SVG_NS = "http://www.w3.org/2000/svg";

// Player token: a circular body with a triangular pointer showing facing.
// Authored pointing North (up); rotated by facing * 45° (8 compass steps).
function makeTokenSvg(facing: Dir): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.classList.add("token-svg");

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

interface State {
  pos: Coord;
  facing: Dir;
  movesLeft: number;
  selected: boolean;
  log: string[];
}

const state: State = {
  pos: { x: 4, y: 5 },
  facing: Dir.N,
  movesLeft: MOVES_PER_TURN,
  selected: false,
  log: ["The Ashen One stands ready."],
};

const boardEl = document.getElementById("board")!;
const vitalsEl = document.getElementById("vitals")!;
const logEl = document.getElementById("log")!;

function log(msg: string): void {
  state.log.unshift(msg);
  state.log = state.log.slice(0, 30);
}

// Squares the selected token can reach with its remaining moves (king-move
// distance), excluding its own cell and anything off the board.
function reachable(): Set<string> {
  const out = new Set<string>();
  if (!state.selected) return out;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const c = { x, y };
      if (x === state.pos.x && y === state.pos.y) continue;
      if (chebyshev(state.pos, c) <= state.movesLeft) out.add(`${x},${y}`);
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

      const isPlayer = x === state.pos.x && y === state.pos.y;
      const isReach = reach.has(`${x},${y}`);

      if (isPlayer) {
        cell.classList.add("player");
        if (state.selected) cell.classList.add("selected");
        cell.appendChild(makeTokenSvg(state.facing));
        cell.addEventListener("click", () => {
          state.selected = !state.selected;
          render();
        });
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
  vitalsEl.innerHTML = `
    <div><span class="key">Moves left</span> · <span class="val">${state.movesLeft}</span> / ${MOVES_PER_TURN}</div>
    <div><span class="key">Facing</span> · <span class="val">${DIR_NAME[state.facing]}</span></div>
    <div><span class="key">Position</span> · <span class="val">${state.pos.x}, ${state.pos.y}</span></div>
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
  if (!state.selected) return;
  if (!inBounds(dest, WIDTH, HEIGHT)) return;
  const cost = chebyshev(state.pos, dest);
  if (cost === 0 || cost > state.movesLeft) return;
  state.pos = dest;
  state.movesLeft -= cost;
  log(`Moved to ${dest.x}, ${dest.y} (−${cost}).`);
  if (state.movesLeft === 0) {
    state.selected = false;
    log("Out of moves. End your turn.");
  }
  render();
}

function rotate(left: boolean): void {
  state.facing = left ? turnLeft(state.facing) : turnRight(state.facing);
  render();
}

function endTurn(): void {
  state.movesLeft = MOVES_PER_TURN;
  state.selected = false;
  log("— New turn —");
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
