// Pass 4: the enemy attack.
//
// Player turn: move (up to 5), rotate (Q/E), stage an attack, End turn.
// Enemy turn: the hollow advances, then — if in range — rolls a d10 to pick an
// attack card (slid halfway out, still face-down so only its telegraph + range
// show). A 3-second countdown beeps each second; during it the player may step
// one square (click the token, then a highlighted square) or Dodge two squares
// for 1 stamina (foot icon on the dock). The card then flips and resolves: if
// the player is on a struck square they take damage (and any knockback /
// stamina hit). Reach 0 HP and you die.

import {
  chebyshev,
  Dir,
  dirFromDelta,
  inBounds,
  sameCoord,
  squaresForOffsets,
  step,
  turnLeft,
  turnRight,
  type Coord,
} from "./grid";
import { STRAIGHT_SWORD, type Attack, type Weapon } from "./weapons";
import { HOLLOW_AXEMAN, type EnemyCard, type EnemyTemplate } from "./enemies";
import { beep, blare, resumeAudio } from "./audio";

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
const MAX_HP = 5;
const ENEMY_MOVES_PER_TURN = 3;
const ENEMY_STEP_MS = 280;
const FLASH_MS = 260;
const COUNTDOWN_SECONDS = 3;
const ENGAGE_RANGE = 2; // enemy only attacks within this distance
const STEP_SQUARES = 1; // free reposition during countdown
const DODGE_SQUARES = 2;
const DODGE_COST = 1;

interface PlayerToken {
  pos: Coord;
  facing: Dir;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  weapon: Weapon;
}

interface EnemyToken {
  pos: Coord;
  facing: Dir;
  hp: number;
  maxHp: number;
  template: EnemyTemplate;
}

// player: free movement turn. enemyMove: hollow walking. countdown: reaction
// window. dead: player defeated.
type Phase = "player" | "enemyMove" | "countdown" | "dead";

interface State {
  player: PlayerToken;
  enemy: EnemyToken | null;
  phase: Phase;
  movesLeft: number;
  attacksUsed: number;
  selected: boolean;
  busy: boolean; // true during attack animations; locks input
  stagedAttack: Attack | null;
  // Enemy attack in progress:
  enemyCardIndex: number | null; // selected card, slid out
  cardFlipped: boolean;
  countdownNum: number; // seconds shown; 0 = none
  dodgeArmed: boolean; // next countdown click is a dodge
  repositioned: boolean; // player already moved this countdown
  log: string[];
}

const state: State = {
  player: {
    pos: { x: 4, y: 7 },
    facing: Dir.N,
    hp: MAX_HP,
    maxHp: MAX_HP,
    stamina: MAX_STAMINA,
    maxStamina: MAX_STAMINA,
    weapon: STRAIGHT_SWORD,
  },
  enemy: {
    pos: { x: 4, y: 1 },
    facing: Dir.S,
    hp: HOLLOW_AXEMAN.maxHp,
    maxHp: HOLLOW_AXEMAN.maxHp,
    template: HOLLOW_AXEMAN,
  },
  phase: "player",
  movesLeft: MOVES_PER_TURN,
  attacksUsed: 0,
  selected: false,
  busy: false,
  stagedAttack: null,
  enemyCardIndex: null,
  cardFlipped: false,
  countdownNum: 0,
  dodgeArmed: false,
  repositioned: false,
  log: ["The Ashen One stands ready. A hollow axeman lurks across the hall."],
};

const boardEl = document.getElementById("board")!;
const logEl = document.getElementById("log")!;
const weaponEl = document.getElementById("weapon")!;
const staminaEl = document.getElementById("stamina")!;
const turnFlashEl = document.getElementById("turn-flash")!;
const enemyDeckEl = document.getElementById("enemy-deck")!;
const countdownEl = document.getElementById("countdown")!;
const dodgeBtn = document.getElementById("dodge") as HTMLButtonElement;
const turnLeftBtn = document.getElementById("turn-left") as HTMLButtonElement;
const turnRightBtn = document.getElementById("turn-right") as HTMLButtonElement;
const endBtn = document.getElementById("end-turn") as HTMLButtonElement;

const cellEls = new Map<string, HTMLElement>();
const key = (c: Coord) => `${c.x},${c.y}`;

function log(msg: string): void {
  state.log.unshift(msg);
  state.log = state.log.slice(0, 30);
}

// Squares the player may move to right now — depends on the phase.
function reachable(): Set<string> {
  const out = new Set<string>();
  const { player, enemy } = state;
  const free = (c: Coord) =>
    inBounds(c, WIDTH, HEIGHT) &&
    !sameCoord(c, player.pos) &&
    !(enemy && sameCoord(c, enemy.pos));

  if (state.phase === "player" && !state.busy && state.selected) {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const c = { x, y };
        if (free(c) && chebyshev(player.pos, c) <= state.movesLeft) out.add(key(c));
      }
    }
  } else if (state.phase === "countdown" && !state.busy && !state.repositioned) {
    const dist = state.dodgeArmed ? DODGE_SQUARES : STEP_SQUARES;
    if (!state.dodgeArmed || player.stamina >= DODGE_COST) {
      // Straight-line cells exactly `dist` away in any of the 8 directions.
      for (let d = 0; d < 8; d++) {
        const s = step(d as Dir);
        const c = { x: player.pos.x + s.x * dist, y: player.pos.y + s.y * dist };
        const mid = { x: player.pos.x + s.x, y: player.pos.y + s.y };
        if (free(c) && (dist === 1 || free(mid))) out.add(key(c));
      }
    }
  }
  return out;
}

function render(): void {
  const reach = reachable();
  const preview = new Set(
    (state.phase === "player" && state.stagedAttack
      ? targetSquares(state.stagedAttack).filter((c) => inBounds(c, WIDTH, HEIGHT))
      : []
    ).map(key)
  );

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

      if (preview.has(key(here))) cell.classList.add("target-preview");

      if (isPlayer) {
        cell.classList.add("player");
        if (state.selected) cell.classList.add("selected");
        cell.appendChild(makeTokenSvg(state.player.facing, "player"));
        cell.appendChild(hpBadge(state.player.hp, "player-hp"));
        cell.addEventListener("click", onPlayerClick);
      } else if (isEnemy && state.enemy) {
        cell.appendChild(makeTokenSvg(state.enemy.facing, "enemy"));
        cell.appendChild(hpBadge(state.enemy.hp, "enemy-hp"));
      } else if (reach.has(key(here))) {
        cell.classList.add(state.dodgeArmed ? "dodge-reach" : "reach");
        cell.addEventListener("click", () => moveTo(here));
      }

      boardEl.appendChild(cell);
    }
  }

  renderEnemyDeck();
  renderWeapon();
  renderHud();
}

function hpBadge(hp: number, cls: string): HTMLElement {
  const badge = document.createElement("span");
  badge.className = `hp-badge ${cls}`;
  badge.textContent = String(hp);
  return badge;
}

function renderHud(): void {
  staminaEl.textContent = String(state.player.stamina);
  staminaEl.classList.toggle("empty", state.player.stamina <= 0);

  logEl.replaceChildren(
    ...state.log.map((line) => {
      const d = document.createElement("div");
      d.textContent = line;
      return d;
    })
  );

  updateInteractivity();
}

function renderCountdown(): void {
  if (state.countdownNum > 0) {
    countdownEl.textContent = String(state.countdownNum);
    countdownEl.classList.remove("show");
    void countdownEl.offsetWidth; // restart the pulse each second
    countdownEl.classList.add("show");
  } else {
    countdownEl.classList.remove("show");
  }
}

// Enable dock buttons appropriate to the phase; lock scrolling off-turn.
function updateInteractivity(): void {
  const playerActive = state.phase === "player" && !state.busy;
  turnLeftBtn.disabled = !playerActive;
  turnRightBtn.disabled = !playerActive;
  endBtn.disabled = !playerActive;
  dodgeBtn.disabled = !(
    state.phase === "countdown" &&
    !state.busy &&
    !state.repositioned &&
    state.player.stamina >= DODGE_COST
  );
  dodgeBtn.classList.toggle("armed", state.dodgeArmed);
  document.body.classList.toggle("locked-scroll", state.phase !== "player");
}

// --- Enemy deck (skeuomorphic cards above the grid) ---

function renderEnemyDeck(): void {
  enemyDeckEl.replaceChildren();
  if (!state.enemy) return;

  state.enemy.template.deck.forEach((card, i) => {
    const selected = state.enemyCardIndex === i;
    const flipped = selected && state.cardFlipped;

    const el = document.createElement("div");
    el.className =
      "enemy-card" + (selected ? " selected" : "") + (flipped ? " flipped" : "");

    const inner = document.createElement("div");
    inner.className = "card-inner";

    inner.appendChild(makeCardBack(card));
    inner.appendChild(makeCardFront(card));

    el.appendChild(inner);
    enemyDeckEl.appendChild(el);
  });
}

function makeCardBack(card: EnemyCard): HTMLElement {
  const back = document.createElement("div");
  back.className = "card-face card-back";

  const tele = document.createElement("div");
  tele.className = "card-telegraph";
  tele.textContent = `“${card.telegraph}”`;

  const range = document.createElement("div");
  range.className = "card-range";
  range.textContent = `range ${card.range}`;

  back.append(tele, range);
  return back;
}

function makeCardFront(card: EnemyCard): HTMLElement {
  const front = document.createElement("div");
  front.className = "card-face card-front";

  const name = document.createElement("div");
  name.className = "card-name";
  name.textContent = card.name;

  const pair = document.createElement("div");
  pair.className = "diagram-pair";
  pair.appendChild(makeDiagram(card.diagram, Dir.N, true));
  if (card.diagonalDiagram) {
    const arrow = document.createElement("span");
    arrow.className = "diagram-arrow";
    arrow.textContent = "↻";
    pair.appendChild(arrow);
    pair.appendChild(makeDiagram(card.diagonalDiagram, Dir.NE, true));
  }

  const dmg = document.createElement("div");
  dmg.className = "card-dmg";
  const extra = card.knockback ? " · knockback" : "";
  const sta = card.staminaDamage ? ` · −${card.staminaDamage} stam` : "";
  dmg.textContent = `${card.damage} dmg${sta}${extra}`;

  front.append(name, pair, dmg);
  return front;
}

// --- Weapon card ---

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
    const usable =
      state.phase === "player" && !state.busy && affordable && hasUses;
    const staged = state.stagedAttack === atk;

    const opt = document.createElement("div");
    opt.className =
      "attack-option" + (usable ? "" : " disabled") + (staged ? " staged" : "");

    const head = document.createElement("div");
    head.className = "attack-text";

    const name = document.createElement("div");
    name.className = "attack-name";
    name.textContent = atk.name;
    head.appendChild(name);

    const stats = document.createElement("div");
    stats.className = "attack-stats";
    const repeat = atk.usesPerTurn > 1 ? ` · ×${atk.usesPerTurn}/turn` : "";
    stats.textContent = `${atk.damage} dmg · ${atk.staminaCost} stam${repeat}`;
    head.appendChild(stats);
    opt.appendChild(head);

    const pair = document.createElement("div");
    pair.className = "diagram-pair";
    pair.appendChild(makeDiagram(atk.diagram, Dir.N, false));
    if (atk.diagonalDiagram) {
      const arrow = document.createElement("span");
      arrow.className = "diagram-arrow";
      arrow.textContent = "↻";
      pair.appendChild(arrow);
      pair.appendChild(makeDiagram(atk.diagonalDiagram, Dir.NE, false));
    }
    opt.appendChild(pair);

    if (usable || staged) {
      opt.addEventListener("click", () => toggleStage(atk));
    }
    attacks.appendChild(opt);
  }

  card.appendChild(attacks);
  weaponEl.appendChild(card);
}

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

// A small visual of an attack diagram. The attacker ('^') is a triangle
// pointing in `facing`; `enemy` tints it red instead of green.
function makeDiagram(diagram: string, facing: Dir, enemy: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "diagram";
  const rows = diagram.replace(/^\n+|\n+$/g, "").split("\n");
  const w = Math.max(...rows.map((r) => r.length));
  wrap.style.gridTemplateColumns = `repeat(${w}, 12px)`;
  for (const r of rows) {
    for (let x = 0; x < w; x++) {
      const ch = (r[x] ?? "").toLowerCase();
      const dot = document.createElement("span");
      dot.className = "dot" + (ch === "x" ? " hit" : ch === "^" ? " self" : "");
      if (ch === "^") dot.appendChild(makeSelfMarker(facing, enemy));
      wrap.appendChild(dot);
    }
  }
  return wrap;
}

function makeSelfMarker(facing: Dir, enemy: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.classList.add("self-marker");
  if (enemy) svg.classList.add("enemy");
  const tri = document.createElementNS(SVG_NS, "polygon");
  tri.setAttribute("points", "6,1 10.5,11 1.5,11");
  tri.setAttribute("transform", `rotate(${facing * 45} 6 6)`);
  svg.appendChild(tri);
  return svg;
}

function targetSquares(atk: Attack): Coord[] {
  return squaresForOffsets(atk.pattern, state.player.pos, state.player.facing);
}

// --- Player input ---

function onPlayerClick(): void {
  if (state.busy) return;
  if (state.phase === "player") {
    state.selected = !state.selected;
    render();
  } else if (state.phase === "countdown") {
    state.selected = true;
    render();
  }
}

function moveTo(dest: Coord): void {
  if (state.busy || !inBounds(dest, WIDTH, HEIGHT)) return;
  if (state.enemy && sameCoord(dest, state.enemy.pos)) return;

  if (state.phase === "player") {
    if (!state.selected) return;
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
  } else if (state.phase === "countdown" && !state.repositioned) {
    if (state.dodgeArmed) {
      if (state.player.stamina < DODGE_COST) return;
      state.player.stamina -= DODGE_COST;
      log(`Dodged to ${dest.x}, ${dest.y} (−${DODGE_COST} stamina).`);
    } else {
      log(`Stepped to ${dest.x}, ${dest.y}.`);
    }
    state.player.pos = dest;
    state.repositioned = true;
    state.dodgeArmed = false;
    state.selected = false;
    render();
  }
}

function rotate(left: boolean): void {
  if (state.phase !== "player" || state.busy) return;
  state.player.facing = left
    ? turnLeft(state.player.facing)
    : turnRight(state.player.facing);
  render();
}

function toggleStage(atk: Attack): void {
  if (state.phase !== "player" || state.busy) return;
  state.stagedAttack = state.stagedAttack === atk ? null : atk;
  render();
}

function armDodge(): void {
  if (state.phase !== "countdown" || state.busy || state.repositioned) return;
  if (state.player.stamina < DODGE_COST) return;
  resumeAudio();
  state.dodgeArmed = !state.dodgeArmed;
  state.selected = true;
  render();
}

// --- Player attack resolution (staged on End turn) ---

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

// --- Turn flow ---

function startPlayerTurn(): void {
  state.phase = "player";
  state.movesLeft = MOVES_PER_TURN;
  state.attacksUsed = 0;
  state.enemyCardIndex = null;
  state.cardFlipped = false;
  state.countdownNum = 0;
  state.player.stamina = Math.min(
    state.player.maxStamina,
    state.player.stamina + STAMINA_REGEN
  );
  log("— Your turn —");
  flashTurn("Your turn");
  renderCountdown();
  render();
}

function endTurn(): void {
  if (state.phase !== "player" || state.busy) return;
  resumeAudio();
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

function beginEnemyPhase(): void {
  if (!state.enemy) {
    startPlayerTurn();
    return;
  }
  state.phase = "enemyMove";
  log("— Enemy turn —");
  flashTurn("Enemy turn");
  render();
  setTimeout(() => enemyStep(0), ENEMY_STEP_MS);
}

// One step of the enemy's advance toward the player.
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
    beginEnemyAttack();
    return;
  }

  enemy.pos = { x: enemy.pos.x + Math.sign(dx), y: enemy.pos.y + Math.sign(dy) };
  log(`The hollow advances to ${enemy.pos.x}, ${enemy.pos.y}.`);
  render();
  setTimeout(() => enemyStep(stepsTaken + 1), ENEMY_STEP_MS);
}

// Roll a d10, pick a card, slide it out, and start the countdown.
function beginEnemyAttack(): void {
  const enemy = state.enemy;
  if (!enemy) {
    startPlayerTurn();
    return;
  }
  if (chebyshev(enemy.pos, state.player.pos) > ENGAGE_RANGE) {
    log("The hollow stalks closer, out of reach.");
    startPlayerTurn();
    return;
  }

  const deck = enemy.template.deck;
  const roll = 1 + Math.floor(Math.random() * 10);
  const idx = (roll - 1) % deck.length; // wrap when the roll exceeds the deck
  state.enemyCardIndex = idx;
  state.cardFlipped = false;
  state.dodgeArmed = false;
  state.repositioned = false;
  state.selected = true; // pre-select so the player can reposition fast
  state.phase = "countdown";
  log(`d10 → ${roll}: the hollow readies its ${idx + 1}${ordinal(idx + 1)} card.`);
  render();
  startCountdown();
}

function ordinal(n: number): string {
  return n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
}

function startCountdown(): void {
  let n = COUNTDOWN_SECONDS;
  state.countdownNum = n;
  renderCountdown();
  beep();

  const tick = () => {
    n -= 1;
    if (n > 0) {
      state.countdownNum = n;
      renderCountdown();
      beep();
      setTimeout(tick, 1000);
    } else {
      state.countdownNum = 0;
      renderCountdown();
      blare();
      resolveEnemyAttack();
    }
  };
  setTimeout(tick, 1000);
}

function resolveEnemyAttack(): void {
  const enemy = state.enemy;
  const idx = state.enemyCardIndex;
  if (!enemy || idx === null) {
    startPlayerTurn();
    return;
  }
  const card = enemy.template.deck[idx];

  state.busy = true;
  state.cardFlipped = true;
  state.selected = false;
  state.dodgeArmed = false;
  render(); // flip the card face-up

  const targets = squaresForOffsets(card.pattern, enemy.pos, enemy.facing).filter(
    (c) => inBounds(c, WIDTH, HEIGHT)
  );
  for (const t of targets) cellEls.get(key(t))?.classList.add("flash-target");

  setTimeout(() => {
    for (const t of targets) cellEls.get(key(t))?.classList.remove("flash-target");
    const hit = targets.some((t) => sameCoord(t, state.player.pos));

    if (hit) {
      const el = cellEls.get(key(state.player.pos));
      el?.classList.add("flash-hit");
      setTimeout(() => {
        el?.classList.remove("flash-hit");
        applyEnemyHit(card);
        finishEnemyAttack();
      }, FLASH_MS);
    } else {
      log(`You evade the ${card.name}.`);
      finishEnemyAttack();
    }
  }, FLASH_MS);
}

function applyEnemyHit(card: EnemyCard): void {
  const { player, enemy } = state;
  player.hp -= card.damage;
  let msg = `${card.name} lands — ${card.damage} damage.`;

  if (card.staminaDamage) {
    player.stamina = Math.max(0, player.stamina - card.staminaDamage);
    msg += ` (−${card.staminaDamage} stamina)`;
  }
  if (card.knockback && enemy) {
    const dx = Math.sign(player.pos.x - enemy.pos.x);
    const dy = Math.sign(player.pos.y - enemy.pos.y);
    for (let i = 0; i < card.knockback; i++) {
      const next = { x: player.pos.x + dx, y: player.pos.y + dy };
      if (!inBounds(next, WIDTH, HEIGHT) || sameCoord(next, enemy.pos)) break;
      player.pos = next;
    }
    msg += " You are knocked back.";
  }
  log(msg);
}

function finishEnemyAttack(): void {
  state.enemyCardIndex = null;
  state.cardFlipped = false;
  state.busy = false;
  state.countdownNum = 0;
  renderCountdown();

  if (state.player.hp <= 0) {
    state.phase = "dead";
    log("You have died.");
    flashTurn("YOU DIED");
    render();
    return;
  }
  startPlayerTurn();
}

function flashTurn(text: string): void {
  turnFlashEl.textContent = text;
  turnFlashEl.classList.toggle("died", text === "YOU DIED");
  turnFlashEl.classList.remove("show");
  void turnFlashEl.offsetWidth; // restart the CSS animation
  turnFlashEl.classList.add("show");
}

// --- Wiring ---

turnLeftBtn.addEventListener("click", () => rotate(true));
turnRightBtn.addEventListener("click", () => rotate(false));
endBtn.addEventListener("click", endTurn);
dodgeBtn.addEventListener("click", armDodge);

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "q") rotate(true);
  else if (k === "e") rotate(false);
  else if (k === "enter") endTurn();
  else if (k === " " || k === "f") armDodge();
  else return;
  e.preventDefault();
});

render();
flashTurn("Your turn");
