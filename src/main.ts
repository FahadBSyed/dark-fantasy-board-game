// Pass 5: multiple enemies sharing one deck.
//
// Up to several hollows, each with a number on its icon, share a single attack
// deck above the grid. On the enemy turn every hollow advances, then each one
// in range rolls a d10 to pick a card; that card slides out (still face-down)
// with a red numbered token per rolling enemy placed on it. One 3-second
// countdown then runs (step one square, or Dodge two for 1 stamina), after
// which all selected cards flip and resolve left-to-right against the player.

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
import {
  WEAPONS,
  SHIELDS,
  THIEFS_KNIFE,
  BUCKLER,
  type Attack,
  type Shield,
  type Weapon,
} from "./weapons";
import { HOLLOW_AXEMAN, type EnemyCard, type EnemyTemplate } from "./enemies";
import { beep, blare, resumeAudio } from "./audio";
import { rollDice } from "./dice";
import {
  listenForParry,
  matchTags,
  speechSupported,
  type ParryListener,
} from "./parry";

const SVG_NS = "http://www.w3.org/2000/svg";

type TokenKind = "player" | "enemy";

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
const MOVES_PER_TURN = 3; // free squares; further squares sprint at 1 stamina each
const MAX_STAMINA = 5;
const STAMINA_REGEN = 2;
const RECOVER_STAMINA = 2; // extra stamina from forgoing your action
const MAX_HP = 5;
const MAX_LOAD = 8; // equip load; under half (< 4) lets you dodge 2 squares
const PLAYER_STUN_RESIST = 4;
const ENEMY_STEP_MS = 240;
const CARD_SLIDE_MS = 360;
const CARD_FLIP_MS = 520; // matches the card-inner flip transition
const FLASH_MS = 260;
const ENGAGE_RANGE = 2; // a hollow must be within this to attack
const COUNTDOWN_SECONDS = 5;
const DODGE_COST = 2; // flat stamina cost to dodge, whether you move 1 or 2

interface PlayerToken {
  pos: Coord;
  facing: Dir;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  stunResist: number;
  stunned: boolean; // next turn: no attack and one fewer move
  weapon: Weapon;
  shield: Shield;
}

interface EnemyToken {
  id: number; // shown on the icon and on its deck tokens
  pos: Coord;
  facing: Dir;
  hp: number;
  maxHp: number;
  stunned: boolean; // skips its next attack and moves one fewer square
  template: EnemyTemplate;
}

// Which card an enemy rolled this turn.
interface Selection {
  enemyId: number;
  cardIndex: number;
  roll: number;
  placed: boolean; // token has been dragged onto its card
  followUp: boolean; // this pick triggered the card's fold-out second swing
}

// player: free turn. enemyMove: hollows walking. placing: drag tokens onto the
// rolled cards. countdown: reaction window. revealing: click cards to flip &
// resolve. resetting: click cards to flip back. dead: defeated.
type Phase =
  | "player"
  | "enemyMove"
  | "placing"
  | "countdown"
  | "revealing"
  | "comboRevealing" // fold out & resolve follow-up swings
  | "resetting"
  | "dead";

interface State {
  player: PlayerToken;
  enemies: EnemyToken[];
  phase: Phase;
  movesLeft: number;
  selected: boolean;
  busy: boolean;
  stagedAttack: Attack | null;
  stagedBlock: boolean; // raise guard this turn (instead of attacking)
  stagedRecover: boolean; // forgo attack/block to recover extra stamina
  blocking: boolean; // guard is up during the enemy resolution
  selections: Selection[]; // enemy card picks this turn
  flippedCards: Set<number>; // card indices currently face-up
  followUpsResolved: Set<number>; // card indices whose fold-out swing resolved
  swingLevel: number; // 0 = base swings, 1 = follow-up wave
  cardsSlid: boolean; // selected cards have slid forward
  draggingCardIndex: number | null; // card highlighted as the active drop target
  countdownNum: number;
  repositioned: boolean;
  // Stamina is a physical token economy: pile (player.stamina) + spend zone
  // (maxStamina - stamina) is conserved. A gate forces the player to drag
  // tokens before continuing.
  staminaGate: { dir: "spend" | "replenish"; remaining: number } | null;
  // Stamina spent during the enemy turn (dodge + block absorption + kick loss),
  // reserved against the pile and paid by dragging after the turn resolves.
  staminaOwed: number;
  // Combos committed by stunning a foe; they land during the enemy turn after
  // the other hollows have acted.
  pendingCombos: { enemyId: number; attack: Attack }[];
  // A declared parry during the reaction window.
  parry: {
    targetId: number;
    required: string[];
    rule: "exactAll" | "any2";
    success: boolean;
    transcript: string;
  } | null;
  log: string[];
}

function spawnEnemies(): EnemyToken[] {
  const spots: Coord[] = [
    { x: 2, y: 1 },
    { x: 4, y: 0 },
    { x: 6, y: 1 },
  ];
  return spots.map((pos, i) => ({
    id: i + 1,
    pos,
    facing: Dir.S,
    hp: HOLLOW_AXEMAN.maxHp,
    maxHp: HOLLOW_AXEMAN.maxHp,
    stunned: false,
    template: HOLLOW_AXEMAN,
  }));
}

const state: State = {
  player: {
    pos: { x: 4, y: 8 },
    facing: Dir.N,
    hp: MAX_HP,
    maxHp: MAX_HP,
    stamina: MAX_STAMINA,
    maxStamina: MAX_STAMINA,
    stunResist: PLAYER_STUN_RESIST,
    stunned: false,
    weapon: THIEFS_KNIFE, // overwritten by the loadout screen
    shield: BUCKLER,
  },
  enemies: spawnEnemies(),
  phase: "player",
  movesLeft: MOVES_PER_TURN,
  selected: false,
  busy: false,
  stagedAttack: null,
  stagedBlock: false,
  stagedRecover: false,
  blocking: false,
  selections: [],
  flippedCards: new Set(),
  followUpsResolved: new Set(),
  swingLevel: 0,
  cardsSlid: false,
  draggingCardIndex: null,
  countdownNum: 0,
  repositioned: false,
  staminaGate: null,
  staminaOwed: 0,
  pendingCombos: [],
  parry: null,
  log: ["The Ashen One stands ready. Three hollows stir across the hall."],
};

const boardEl = document.getElementById("board")!;
const logEl = document.getElementById("log")!;
const weaponEl = document.getElementById("weapon")!;
const staminaPileEl = document.getElementById("stamina-pile")!;
const staminaZoneEl = document.getElementById("stamina-zone")!;
const staminaPromptEl = document.getElementById("stamina-prompt")!;
const turnFlashEl = document.getElementById("turn-flash")!;
const enemyDeckEl = document.getElementById("enemy-deck")!;
const enemyStatsEl = document.getElementById("enemy-stats")!;
const pileEl = document.getElementById("token-pile")!;
const countdownEl = document.getElementById("countdown")!;
const turnLeftBtn = document.getElementById("turn-left") as HTMLButtonElement;
const turnRightBtn = document.getElementById("turn-right") as HTMLButtonElement;
const endBtn = document.getElementById("end-turn") as HTMLButtonElement;
const parryBtn = document.getElementById("parry") as HTMLButtonElement;
const parryPanelEl = document.getElementById("parry-panel")!;
let parryListener: ParryListener | null = null;

const cellEls = new Map<string, HTMLElement>();
const key = (c: Coord) => `${c.x},${c.y}`;

function log(msg: string): void {
  state.log.unshift(msg);
  state.log = state.log.slice(0, 40);
}

function deck(): EnemyCard[] {
  return state.enemies[0]?.template.deck ?? [];
}

function enemyAt(c: Coord): EnemyToken | undefined {
  return state.enemies.find((e) => sameCoord(e.pos, c));
}

function occupied(c: Coord, exceptId?: number): boolean {
  if (sameCoord(c, state.player.pos)) return true;
  return state.enemies.some((e) => e.id !== exceptId && sameCoord(e.pos, c));
}

// While reacting, the cells reachable by a path of unoccupied squares, mapped
// to the number of steps (= stamina cost) to get there. Limited to 2 squares
// and to what stamina allows; you can't move through an enemy.
function equipLoad(): number {
  return state.player.weapon.weight + state.player.shield.weight;
}

// Light loadout (under half the equip load) lets you dodge two squares.
function dodgeSquares(): number {
  return equipLoad() < MAX_LOAD / 2 ? 2 : 1;
}

function reactReach(): Map<string, number> {
  const out = new Map<string, number>();
  const maxSteps = staminaAvailable() >= DODGE_COST ? dodgeSquares() : 0;
  if (maxSteps <= 0) return out;

  const visited = new Set<string>([key(state.player.pos)]);
  let frontier: Coord[] = [state.player.pos];
  for (let stepN = 1; stepN <= maxSteps; stepN++) {
    const nextFrontier: Coord[] = [];
    for (const c of frontier) {
      for (let d = 0; d < 8; d++) {
        const s = step(d as Dir);
        const n = { x: c.x + s.x, y: c.y + s.y };
        const k = key(n);
        if (visited.has(k)) continue;
        if (!inBounds(n, WIDTH, HEIGHT) || occupied(n)) continue;
        visited.add(k);
        out.set(k, stepN);
        nextFrontier.push(n);
      }
    }
    frontier = nextFrontier;
  }
  return out;
}

// Squares the player may move to right now — depends on the phase.
function reachable(): Set<string> {
  const out = new Set<string>();
  const { player } = state;
  const free = (c: Coord) => inBounds(c, WIDTH, HEIGHT) && !occupied(c);

  if (state.phase === "player" && !state.busy && state.selected) {
    // Free squares plus sprint squares paid for out of stamina.
    const reach = state.movesLeft + staminaAvailable();
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const c = { x, y };
        if (free(c) && chebyshev(player.pos, c) <= reach) out.add(key(c));
      }
    }
  } else if (state.phase === "countdown" && !inputLocked() && !state.repositioned) {
    for (const k of reactReach().keys()) out.add(k);
  }
  return out;
}

function guardedSquares(): Coord[] {
  return squaresForOffsets(
    state.player.shield.pattern,
    state.player.pos,
    state.player.facing
  ).filter((c) => inBounds(c, WIDTH, HEIGHT));
}

function render(): void {
  const reach = reachable();
  const preview = new Set(
    (state.phase === "player" && state.stagedAttack
      ? targetSquares(state.stagedAttack).filter((c) => inBounds(c, WIDTH, HEIGHT))
      : []
    ).map(key)
  );
  // Guard arc, shown while staging a block or while the guard is up.
  const guardUp =
    (state.phase === "player" && state.stagedBlock) ||
    (state.phase === "countdown" && state.blocking);
  const guard = new Set((guardUp ? guardedSquares() : []).map(key));

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
      const enemy = enemyAt(here);

      if (preview.has(key(here))) cell.classList.add("target-preview");
      if (guard.has(key(here))) cell.classList.add("guard-preview");

      if (isPlayer) {
        cell.classList.add("player");
        if (state.selected) cell.classList.add("selected");
        cell.appendChild(makeTokenSvg(state.player.facing, "player"));
        cell.appendChild(hpBadge(state.player.hp, "player-hp"));
        if (canMoveNow()) cell.classList.add("grabbable");
        cell.addEventListener("pointerdown", startBoardDrag);
      } else if (enemy) {
        cell.appendChild(makeTokenSvg(enemy.facing, "enemy"));
        cell.appendChild(idBadge(enemy.id));
      } else if (reach.has(key(here))) {
        cell.classList.add("reach");
        cell.addEventListener("click", () => moveTo(here));
      }

      boardEl.appendChild(cell);
    }
  }

  renderEnemyStats();
  renderEnemyDeck();
  renderPile();
  renderStamina();
  renderWeapon();
  renderShield();
  renderRecover();
  renderParryPanel();
  renderHud();
}

// True when the player must finish a stamina drag (or an animation) first.
function inputLocked(): boolean {
  return state.busy || state.staminaGate != null;
}

// Stamina still free to spend this enemy turn (pile minus what's already owed).
function staminaAvailable(): number {
  return state.player.stamina - state.staminaOwed;
}

// --- Stamina pile + spend zone (drag tokens to spend / replenish) ---

function staminaTokenEl(): HTMLElement {
  const t = document.createElement("span");
  t.className = "stamina-token";
  return t;
}

function renderStamina(): void {
  const pile = state.player.stamina;
  const zone = state.player.maxStamina - pile;
  const gate = state.staminaGate;

  staminaPileEl.replaceChildren();
  for (let i = 0; i < pile; i++) staminaPileEl.appendChild(staminaTokenEl());
  staminaZoneEl.replaceChildren();
  for (let i = 0; i < zone; i++) staminaZoneEl.appendChild(staminaTokenEl());

  // The target pool glows and commits the whole gate in one click.
  const spendActive = gate?.dir === "spend";
  const replenishActive = gate?.dir === "replenish";
  staminaZoneEl.classList.toggle("drop-active", spendActive);
  staminaPileEl.classList.toggle("drop-active", replenishActive);
  staminaZoneEl.onclick = spendActive ? commitStaminaAll : null;
  staminaPileEl.onclick = replenishActive ? commitStaminaAll : null;

  staminaPromptEl.replaceChildren();
  if (gate) {
    const btn = document.createElement("button");
    btn.className = "stamina-commit";
    btn.textContent =
      gate.dir === "spend" ? `Spend ${gate.remaining} →` : `← Recover ${gate.remaining}`;
    btn.addEventListener("click", commitStaminaAll);
    staminaPromptEl.appendChild(btn);
  }
}

// Move the whole gated amount at once (one click), then continue.
function commitStaminaAll(): void {
  const gate = state.staminaGate;
  if (!gate) return;
  if (gate.dir === "spend") {
    state.player.stamina = Math.max(0, state.player.stamina - gate.remaining);
  } else {
    state.player.stamina = Math.min(
      state.player.maxStamina,
      state.player.stamina + gate.remaining
    );
  }
  state.staminaGate = null;
  const cb = gateOnDone;
  gateOnDone = null;
  render();
  cb?.();
}

let gateOnDone: (() => void) | null = null;

// Make the player drag `count` tokens (clamped to what's possible) before
// running onDone. Resolves immediately if nothing is owed.
function requireStamina(
  dir: "spend" | "replenish",
  count: number,
  onDone: () => void
): void {
  const room =
    dir === "spend"
      ? state.player.stamina
      : state.player.maxStamina - state.player.stamina;
  const n = Math.min(count, room);
  if (n <= 0) {
    onDone();
    return;
  }
  state.staminaGate = { dir, remaining: n };
  gateOnDone = onDone;
  render();
}

function hpBadge(hp: number, cls: string): HTMLElement {
  const badge = document.createElement("span");
  badge.className = `hp-badge ${cls}`;
  badge.textContent = String(hp);
  return badge;
}

function idBadge(id: number): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "id-badge";
  badge.textContent = String(id);
  return badge;
}

function renderHud(): void {
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
    void countdownEl.offsetWidth;
    countdownEl.classList.add("show");
  } else {
    countdownEl.classList.remove("show");
  }
}

function updateInteractivity(): void {
  const playerActive = state.phase === "player" && !inputLocked();
  turnLeftBtn.disabled = !playerActive;
  turnRightBtn.disabled = !playerActive;
  endBtn.disabled = !playerActive;
  parryBtn.disabled = !canParry();
  parryBtn.classList.toggle("armed", state.parry !== null);
  document.body.classList.toggle("locked-scroll", state.phase !== "player");
}

// --- Enemy stat & brain card (one shared card per enemy type) ---

const MAX_ENEMY_ID = 5;

// A single card with five columns (enemy IDs 1-5) and three rows: id, current
// health, and a reserved row for special rules / status effects.
function renderEnemyStats(): void {
  enemyStatsEl.replaceChildren();

  const card = document.createElement("div");
  card.className = "stat-card";

  const title = document.createElement("div");
  title.className = "stat-card-title";
  title.textContent = HOLLOW_AXEMAN.name;
  card.appendChild(title);

  // Base stat block (per type): health, move speed, stun threshold, souls.
  const t = HOLLOW_AXEMAN;
  const block = document.createElement("div");
  block.className = "stat-block";
  block.innerHTML = `
    <span title="health">❤ ${t.maxHp}</span>
    <span title="move speed">👟 ${t.moveSpeed}</span>
    <span title="stun threshold">★ &lt;${t.stunResist}</span>
    <span title="souls">◆ ${t.soul}</span>`;
  card.appendChild(block);

  const grid = document.createElement("div");
  grid.className = "stat-grid";
  grid.style.gridTemplateColumns = `auto repeat(${MAX_ENEMY_ID}, 44px)`;

  const byId = new Map(state.enemies.map((e) => [e.id, e]));

  const addRow = (label: string, cells: (string | number)[], cls: string) => {
    const lab = document.createElement("div");
    lab.className = "stat-label";
    lab.textContent = label;
    grid.appendChild(lab);
    for (let id = 1; id <= MAX_ENEMY_ID; id++) {
      const cell = document.createElement("div");
      const v = cells[id - 1];
      const empty = v === "-" || v === "" || v == null;
      cell.className = "stat-cell " + cls + (empty ? " empty" : "");
      cell.textContent = empty ? "–" : String(v);
      grid.appendChild(cell);
    }
  };

  const ids = Array.from({ length: MAX_ENEMY_ID }, (_, i) => i + 1);
  const hp = ids.map((id) => byId.get(id)?.hp ?? "-");
  const status = ids.map(() => "-");

  addRow("ID", ids, "stat-id");
  addRow("HP", hp, "stat-hp");
  addRow("✦", status, "stat-status");

  card.appendChild(grid);
  enemyStatsEl.appendChild(card);
}

// --- Enemy deck (one shared deck above the grid) ---

function renderEnemyDeck(): void {
  enemyDeckEl.replaceChildren();
  const cards = deck();
  if (cards.length === 0) return;

  cards.forEach((card, i) => {
    const picks = state.selections.filter((s) => s.cardIndex === i);
    const placedPicks = picks.filter((s) => s.placed);
    const hasUnplaced = picks.some((s) => !s.placed);
    const selected = picks.length > 0;
    const slid = selected && state.cardsSlid;
    const flipped = state.flippedCards.has(i);

    const awaiting = state.phase === "placing" && hasUnplaced;
    const dropTarget = state.draggingCardIndex === i;

    // A triggered follow-up shows a fold-out segment during the combo wave.
    const hasFollowUp = picks.some((s) => s.followUp) && !!card.followUp;
    const folded =
      hasFollowUp &&
      (state.phase === "comboRevealing" ||
        (state.phase === "countdown" && state.swingLevel === 1));
    const followUpDone = state.followUpsResolved.has(i);

    const flippable =
      (state.phase === "revealing" && selected && !flipped) ||
      (state.phase === "comboRevealing" && hasFollowUp && !followUpDone) ||
      (state.phase === "resetting" && selected && flipped);

    const el = document.createElement("div");
    el.className =
      "enemy-card" +
      (slid ? " slid" : "") +
      (flipped ? " flipped" : "") +
      (awaiting ? " awaiting" : "") +
      (dropTarget ? " drop-target" : "") +
      (flippable ? " flippable" : "");
    el.dataset.cardIndex = String(i);

    const inner = document.createElement("div");
    inner.className = "card-inner";
    inner.appendChild(makeCardBack(card));
    inner.appendChild(makeCardFront(card));
    el.appendChild(inner);

    // Fold-out follow-up segment: telegraph until resolved, then its diagram.
    if (folded && card.followUp) {
      el.appendChild(makeFold(card.followUp, followUpDone));
    }

    // Tokens already placed on this card.
    if (placedPicks.length) {
      const tokens = document.createElement("div");
      tokens.className = "card-tokens";
      for (const p of placedPicks) tokens.appendChild(tokenChip(p.enemyId));
      el.appendChild(tokens);
    }

    if (flippable) {
      el.addEventListener("click", () => {
        if (state.phase === "revealing") flipCard(i);
        else if (state.phase === "comboRevealing") resolveFollowUp(i);
        else unflipCard(i);
      });
    }

    enemyDeckEl.appendChild(el);
  });
}

// The fold-out segment for a triggered follow-up: its telegraph while pending,
// then its attack diagram once resolved.
function makeFold(followUp: EnemyCard, resolved: boolean): HTMLElement {
  const fold = document.createElement("div");
  fold.className = "card-fold" + (resolved ? " open" : "");
  if (resolved) {
    const name = document.createElement("div");
    name.className = "fold-name";
    name.textContent = followUp.name;
    fold.append(name, makeDiagram(followUp.diagram, Dir.N, true));
  } else {
    const tele = document.createElement("div");
    tele.className = "fold-telegraph";
    tele.textContent = `↩ “${followUp.telegraph}”`;
    fold.appendChild(tele);
  }
  return fold;
}

function tokenChip(id: number): HTMLElement {
  const t = document.createElement("span");
  t.className = "card-token";
  t.textContent = String(id);
  return t;
}

// --- Token pile + drag-and-drop placement ---

let drag: { sel: Selection; ghost: HTMLElement } | null = null;

function renderPile(): void {
  pileEl.replaceChildren();
  const unplaced =
    state.phase === "placing"
      ? state.selections.filter((s) => !s.placed && drag?.sel !== s)
      : [];

  if (state.phase !== "placing" || state.selections.every((s) => s.placed)) {
    pileEl.classList.remove("show");
    return;
  }
  pileEl.classList.add("show");

  const label = document.createElement("div");
  label.className = "pile-label";
  label.textContent = "Drag each token onto its glowing card";
  pileEl.appendChild(label);

  const heap = document.createElement("div");
  heap.className = "pile-heap";
  unplaced.forEach((sel, idx) => {
    const t = tokenChip(sel.enemyId);
    t.classList.add("pile-token");
    t.style.transform = `translateX(${idx * 6}px) rotate(${(idx % 2 ? 1 : -1) * 5}deg)`;
    t.addEventListener("pointerdown", (e) => startDrag(sel, e));
    heap.appendChild(t);
  });
  pileEl.appendChild(heap);
}

function startDrag(sel: Selection, e: PointerEvent): void {
  if (state.phase !== "placing" || sel.placed) return;
  e.preventDefault();
  const ghost = tokenChip(sel.enemyId);
  ghost.className = "card-token token-ghost";
  document.body.appendChild(ghost);
  drag = { sel, ghost };
  state.draggingCardIndex = sel.cardIndex; // glow the one correct card
  moveGhost(e);
  window.addEventListener("pointermove", moveGhost);
  window.addEventListener("pointerup", endDrag);
  render();
}

function moveGhost(e: PointerEvent): void {
  if (!drag) return;
  drag.ghost.style.left = `${e.clientX}px`;
  drag.ghost.style.top = `${e.clientY}px`;
}

function endDrag(e: PointerEvent): void {
  window.removeEventListener("pointermove", moveGhost);
  window.removeEventListener("pointerup", endDrag);
  if (!drag) return;

  // Snap only if released over the token's own (correct) card.
  const target = enemyDeckEl.querySelector<HTMLElement>(
    `.enemy-card[data-card-index="${drag.sel.cardIndex}"]`
  );
  const r = target?.getBoundingClientRect();
  const inside =
    r != null &&
    e.clientX >= r.left &&
    e.clientX <= r.right &&
    e.clientY >= r.top &&
    e.clientY <= r.bottom;

  if (inside) {
    drag.sel.placed = true;
    log(`Token #${drag.sel.enemyId} placed on card ${drag.sel.cardIndex + 1}.`);
  }

  drag.ghost.remove();
  drag = null;
  state.draggingCardIndex = null;
  render();

  if (state.selections.length && state.selections.every((s) => s.placed)) {
    onAllPlaced();
  }
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

  // Parry tags are printed on the back so they can be read (and called)
  // during the reaction, before the card is flipped.
  if (card.tags && card.tags.length) {
    const tags = document.createElement("div");
    tags.className = "card-tags";
    tags.textContent = card.tags.join(" · ");
    back.appendChild(tags);
  }
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
  const sta = card.staminaDamage ? ` · −${card.staminaDamage} stam` : "";
  const extra = card.knockback ? " · knockback" : "";
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

  for (const atk of [weapon.light, weapon.heavy]) {
    const affordable = state.player.stamina >= atk.staminaCost;
    const usable =
      state.phase === "player" && !inputLocked() && affordable && !state.player.stunned;
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
    const fx = atk.stun ? " · stun" : "";
    stats.textContent = `${atk.damage} dmg · ${atk.staminaCost} stam${fx}`;
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

function renderShield(): void {
  const shield = state.player.shield;

  const card = document.createElement("div");
  card.className = "weapon-card shield-card";

  const corner = document.createElement("div");
  corner.className = "weapon-corner";
  corner.textContent = "🛡";
  card.appendChild(corner);

  const title = document.createElement("div");
  title.className = "weapon-card-title";
  title.textContent = shield.name;
  card.appendChild(title);

  card.appendChild(makeShieldArt());

  const usable = state.phase === "player" && !state.busy;
  const staged = state.stagedBlock;

  const opt = document.createElement("div");
  opt.className =
    "attack-option" + (usable ? "" : " disabled") + (staged ? " staged" : "");

  const head = document.createElement("div");
  head.className = "attack-text";
  const name = document.createElement("div");
  name.className = "attack-name";
  name.textContent = "Raise Guard";
  head.appendChild(name);
  const stats = document.createElement("div");
  stats.className = "attack-stats";
  stats.textContent = "damage → stamina";
  head.appendChild(stats);
  opt.appendChild(head);

  const pair = document.createElement("div");
  pair.className = "diagram-pair";
  pair.appendChild(makeDiagram(shield.diagram, Dir.N, false));
  if (shield.diagonalDiagram) {
    const arrow = document.createElement("span");
    arrow.className = "diagram-arrow";
    arrow.textContent = "↻";
    pair.appendChild(arrow);
    pair.appendChild(makeDiagram(shield.diagonalDiagram, Dir.NE, false));
  }
  opt.appendChild(pair);

  if (usable || staged) opt.addEventListener("click", toggleBlock);

  const attacks = document.createElement("div");
  attacks.className = "weapon-card-attacks";
  attacks.appendChild(opt);
  card.appendChild(attacks);

  weaponEl.appendChild(card);
}

// A small card to forgo your action and recover extra stamina.
function renderRecover(): void {
  const card = document.createElement("div");
  card.className = "weapon-card recover-card";

  const corner = document.createElement("div");
  corner.className = "weapon-corner";
  corner.textContent = "✦";
  card.appendChild(corner);

  const title = document.createElement("div");
  title.className = "weapon-card-title";
  title.textContent = "Rest";
  card.appendChild(title);

  const usable = state.phase === "player" && !inputLocked();
  const staged = state.stagedRecover;

  const opt = document.createElement("div");
  opt.className =
    "attack-option" + (usable ? "" : " disabled") + (staged ? " staged" : "");

  const head = document.createElement("div");
  head.className = "attack-text";
  const name = document.createElement("div");
  name.className = "attack-name";
  name.textContent = "Recover";
  head.appendChild(name);
  const stats = document.createElement("div");
  stats.className = "attack-stats";
  stats.textContent = `+${RECOVER_STAMINA} stamina · no attack/block`;
  head.appendChild(stats);
  opt.appendChild(head);

  if (usable || staged) opt.addEventListener("click", toggleRecover);

  const wrap = document.createElement("div");
  wrap.className = "weapon-card-attacks";
  wrap.appendChild(opt);
  card.appendChild(wrap);

  weaponEl.appendChild(card);
}

function makeShieldArt(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 120");
  svg.classList.add("weapon-art");

  const body = document.createElementNS(SVG_NS, "path");
  body.setAttribute("d", "M32 12 L54 22 V60 Q54 92 32 106 Q10 92 10 60 V22 Z");
  body.setAttribute("class", "shield-body");

  const boss = document.createElementNS(SVG_NS, "circle");
  boss.setAttribute("cx", "32");
  boss.setAttribute("cy", "58");
  boss.setAttribute("r", "8");
  boss.setAttribute("class", "shield-boss");

  svg.append(body, boss);
  return svg;
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

// --- Player movement (click-and-drag the token) ---

function canMoveNow(): boolean {
  if (inputLocked()) return false;
  if (state.phase === "player") return state.movesLeft > 0;
  if (state.phase === "countdown") {
    // Parry and movement are mutually exclusive (parry is only the base wave).
    const parryLock = state.parry !== null && state.swingLevel === 0;
    return !parryLock && !state.repositioned && staminaAvailable() >= DODGE_COST;
  }
  return false;
}

let boardDrag: { ghost: HTMLElement } | null = null;

// Pick up the player token; reachable squares show while it's held.
function startBoardDrag(e: PointerEvent): void {
  if (!canMoveNow()) return;
  e.preventDefault();
  state.selected = true;
  const ghost = document.createElement("div");
  ghost.className = "token-drag-ghost";
  ghost.appendChild(makeTokenSvg(state.player.facing, "player"));
  document.body.appendChild(ghost);
  boardDrag = { ghost };
  moveBoardGhost(e);
  window.addEventListener("pointermove", moveBoardGhost);
  window.addEventListener("pointerup", endBoardDrag);
  render();
}

function moveBoardGhost(e: PointerEvent): void {
  if (!boardDrag) return;
  boardDrag.ghost.style.left = `${e.clientX}px`;
  boardDrag.ghost.style.top = `${e.clientY}px`;
}

function endBoardDrag(e: PointerEvent): void {
  window.removeEventListener("pointermove", moveBoardGhost);
  window.removeEventListener("pointerup", endBoardDrag);
  if (!boardDrag) return;
  boardDrag.ghost.remove();
  boardDrag = null;

  const dest = cellUnderPoint(e.clientX, e.clientY);
  if (dest && reachable().has(key(dest))) {
    moveTo(dest); // validates and clears selection
  } else {
    if (state.phase === "player") state.selected = false;
    render();
  }
}

function cellUnderPoint(x: number, y: number): Coord | null {
  for (const [k, el] of cellEls) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) {
      const [cx, cy] = k.split(",").map(Number);
      return { x: cx, y: cy };
    }
  }
  return null;
}

// Move to a validated destination (drag drop or a click on a reach cell).
function moveTo(dest: Coord): void {
  if (state.busy || !reachable().has(key(dest))) return;

  if (state.phase === "player") {
    const dist = chebyshev(state.player.pos, dest);
    const freeUsed = Math.min(dist, state.movesLeft);
    const sprint = dist - freeUsed; // extra squares paid 1 stamina each
    const applyMove = () => {
      state.player.pos = dest;
      state.movesLeft -= freeUsed;
      state.selected = false;
      log(
        `Moved to ${dest.x}, ${dest.y} (−${freeUsed} move${
          sprint ? `, sprint −${sprint} stamina` : ""
        }).`
      );
      render();
    };
    if (sprint > 0) requireStamina("spend", sprint, applyMove);
    else applyMove();
  } else if (state.phase === "countdown") {
    const steps = reactReach().get(key(dest)) ?? 0;
    if (steps <= 0) return;
    state.staminaOwed += DODGE_COST; // flat dodge cost, 1 or 2 squares
    state.player.pos = dest;
    state.repositioned = true;
    state.selected = false;
    const dropped = state.blocking ? " Guard dropped." : "";
    state.blocking = false; // moving cancels the block
    log(`Dodged to ${dest.x}, ${dest.y} (owe ${DODGE_COST} stamina).${dropped}`);
    render();
  }
}

function rotate(left: boolean): void {
  if (state.phase !== "player" || inputLocked()) return;
  state.player.facing = left
    ? turnLeft(state.player.facing)
    : turnRight(state.player.facing);
  render();
}

function toggleStage(atk: Attack): void {
  if (state.phase !== "player" || inputLocked() || state.player.stunned) return;
  state.stagedAttack = state.stagedAttack === atk ? null : atk;
  if (state.stagedAttack) {
    state.stagedBlock = false; // one action per turn
    state.stagedRecover = false;
  }
  render();
}

function toggleBlock(): void {
  if (state.phase !== "player" || inputLocked()) return;
  state.stagedBlock = !state.stagedBlock;
  if (state.stagedBlock) {
    state.stagedAttack = null;
    state.stagedRecover = false;
  }
  render();
}

function toggleRecover(): void {
  if (state.phase !== "player" || inputLocked()) return;
  state.stagedRecover = !state.stagedRecover;
  if (state.stagedRecover) {
    state.stagedAttack = null;
    state.stagedBlock = false;
  }
  render();
}

// --- Parry (reaction window) ---

// The earliest incoming attack (lowest enemy id) that carries parry tags.
function parryTarget(): { enemyId: number; tags: string[] } | null {
  const cards = deck();
  const ordered = [...state.selections].sort((a, b) => a.enemyId - b.enemyId);
  for (const s of ordered) {
    const tags = cards[s.cardIndex]?.tags;
    if (tags && tags.length) return { enemyId: s.enemyId, tags };
  }
  return null;
}

function canParry(): boolean {
  return (
    state.phase === "countdown" &&
    state.swingLevel === 0 &&
    !inputLocked() &&
    !state.repositioned &&
    state.parry === null &&
    parryTarget() !== null
  );
}

// Declare a parry on the earliest attack and start listening for the tags.
function armParry(): void {
  if (!canParry()) return;
  const target = parryTarget();
  if (!target) return;
  resumeAudio();
  state.parry = {
    targetId: target.enemyId,
    required: target.tags,
    rule: state.player.shield.parry,
    success: false,
    transcript: "",
  };
  log(`Parry declared on hollow #${target.enemyId} — call the tags!`);
  render();

  if (speechSupported()) {
    parryListener = listenForParry(
      target.tags,
      state.player.shield.parry,
      (t) => {
        if (state.parry && !state.parry.success) {
          state.parry.transcript = t;
          renderParryPanel();
        }
      },
      parrySucceeded
    );
  }
}

function parrySucceeded(): void {
  if (!state.parry || state.parry.success) return;
  state.parry.success = true;
  stopParryListen();
  log(`Parried! Hollow #${state.parry.targetId}'s strike is turned aside.`);
  render();
}

function submitParryText(text: string): void {
  if (!state.parry || state.parry.success) return;
  state.parry.transcript = text;
  if (matchTags(text, state.parry.required, state.parry.rule)) parrySucceeded();
  else {
    log("Not quite — try the tags again.");
    renderParryPanel();
  }
}

function stopParryListen(): void {
  parryListener?.stop();
  parryListener = null;
}

function renderParryPanel(): void {
  parryPanelEl.replaceChildren();
  const p = state.parry;
  if (!p || state.phase !== "countdown") {
    parryPanelEl.classList.remove("show");
    return;
  }
  parryPanelEl.classList.add("show");
  parryPanelEl.classList.toggle("ok", p.success);

  const title = document.createElement("div");
  title.className = "parry-title";
  title.textContent = p.success ? "PARRIED!" : `Parry #${p.targetId} — call the tags`;
  parryPanelEl.appendChild(title);

  const tags = document.createElement("div");
  tags.className = "parry-tags";
  const ruleHint = p.rule === "any2" ? "any 2" : "all, in order";
  tags.textContent = `${p.required.join(" · ")}   (${ruleHint})`;
  parryPanelEl.appendChild(tags);

  if (!p.success) {
    if (speechSupported()) {
      const heard = document.createElement("div");
      heard.className = "parry-heard";
      heard.textContent = p.transcript ? `🎤 “${p.transcript}”` : "🎤 listening…";
      parryPanelEl.appendChild(heard);
    }
    const form = document.createElement("form");
    form.className = "parry-form";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "or type the tags";
    input.autocomplete = "off";
    form.appendChild(input);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitParryText(input.value);
      input.value = "";
    });
    parryPanelEl.appendChild(form);
  }
}

// --- Player attack (staged on End turn) ---

// The player backstabs a foe when standing on the square directly behind it.
function isBackstab(e: EnemyToken): boolean {
  if (e.template.backstabImmune) return false;
  const fwd = step(e.facing);
  const behind = { x: e.pos.x - fwd.x, y: e.pos.y - fwd.y };
  return sameCoord(state.player.pos, behind);
}

function rollStun(e: EnemyToken): boolean {
  const roll = 1 + Math.floor(Math.random() * 10);
  const stunned = roll < e.template.stunResist;
  log(
    `Stun roll ${roll} vs #${e.id}'s resist ${e.template.stunResist} → ${
      stunned ? "stunned!" : "resisted"
    }`
  );
  return stunned;
}

function performAttack(atk: Attack, onDone: () => void): void {
  const targets = targetSquares(atk).filter((c) => inBounds(c, WIDTH, HEIGHT));
  state.busy = true;
  state.selected = false;
  log(`You strike — ${atk.name}.`);
  render();

  for (const t of targets) cellEls.get(key(t))?.classList.add("flash-target");

  setTimeout(() => {
    for (const t of targets) cellEls.get(key(t))?.classList.remove("flash-target");
    const hits = state.enemies.filter((e) => targets.some((t) => sameCoord(t, e.pos)));

    if (hits.length === 0) {
      log("The blade meets only air.");
      state.busy = false;
      render();
      onDone();
      return;
    }

    for (const e of hits) cellEls.get(key(e.pos))?.classList.add("flash-hit");
    setTimeout(() => {
      for (const e of hits) cellEls.get(key(e.pos))?.classList.remove("flash-hit");

      const stunnedSurvivors: EnemyToken[] = [];
      for (const e of hits) {
        const back = isBackstab(e);
        const dmg = back ? state.player.weapon.backstab : atk.damage;
        e.hp -= dmg;
        if (e.hp <= 0) {
          log(`${back ? "Backstab! " : ""}Hollow #${e.id} is cut down (${dmg}).`);
        } else {
          log(`${back ? "Backstab! " : ""}Hollow #${e.id} takes ${dmg}. (${e.hp} HP left)`);
          if (atk.stun && rollStun(e)) {
            e.stunned = true;
            stunnedSurvivors.push(e);
          }
        }
      }
      state.enemies = state.enemies.filter((e) => e.hp > 0);

      // A stun commits a follow-up that lands during the foe's next turn —
      // after the other hollows have acted on you.
      if (atk.comboOnStun) {
        for (const e of stunnedSurvivors) {
          if (state.enemies.includes(e)) {
            state.pendingCombos.push({ enemyId: e.id, attack: atk.comboOnStun });
            log(`You commit a ${atk.comboOnStun.name} on hollow #${e.id} — it lands next turn.`);
          }
        }
      }
      state.busy = false;
      render();
      onDone();
    }, FLASH_MS);
  }, FLASH_MS);
}

// Resolve every committed combo (on still-living targets) in turn, then onDone.
function resolvePendingCombos(onDone: () => void): void {
  const combos = state.pendingCombos.filter((c) =>
    state.enemies.some((e) => e.id === c.enemyId)
  );
  state.pendingCombos = [];
  let i = 0;
  const next = () => {
    if (i >= combos.length || state.player.hp <= 0) {
      onDone();
      return;
    }
    resolveComboStrike(combos[i], () => {
      i += 1;
      next();
    });
  };
  next();
}

function resolveComboStrike(
  combo: { enemyId: number; attack: Attack },
  onDone: () => void
): void {
  const e = state.enemies.find((x) => x.id === combo.enemyId);
  if (!e) {
    onDone();
    return;
  }
  state.busy = true;
  log(`Combo — ${combo.attack.name} lands on stunned hollow #${e.id} for ${combo.attack.damage}.`);
  render();
  const el = cellEls.get(key(e.pos));
  el?.classList.add("flash-hit");
  setTimeout(() => {
    el?.classList.remove("flash-hit");
    e.hp -= combo.attack.damage;
    if (e.hp <= 0) log(`Hollow #${e.id} is cut down by the combo.`);
    state.enemies = state.enemies.filter((x) => x.hp > 0);
    state.busy = false;
    render();
    onDone();
  }, FLASH_MS);
}

// --- Turn flow ---

function startPlayerTurn(): void {
  state.phase = "player";
  // A stun costs one square of movement (and bars attacking) this turn.
  state.movesLeft = MOVES_PER_TURN - (state.player.stunned ? 1 : 0);
  for (const e of state.enemies) e.stunned = false; // stun lasted one enemy turn
  state.stagedBlock = false;
  state.stagedRecover = false;
  state.blocking = false;
  state.selections = [];
  state.flippedCards = new Set();
  state.followUpsResolved = new Set();
  state.swingLevel = 0;
  state.cardsSlid = false;
  state.draggingCardIndex = null;
  state.staminaOwed = 0;
  state.pendingCombos = [];
  state.parry = null;
  stopParryListen();
  state.countdownNum = 0;
  if (state.player.stunned) log("You are stunned — no attack, reduced movement.");
  log("— Your turn —");
  flashTurn(state.player.stunned ? "Stunned" : "Your turn");
  renderCountdown();
  render();
  // Replenish: drag up to STAMINA_REGEN tokens from the zone back to the pile.
  requireStamina("replenish", STAMINA_REGEN, () => {});
}

function endTurn(): void {
  if (state.phase !== "player" || inputLocked()) return;
  resumeAudio();
  state.selected = false;
  state.player.stunned = false; // the stun penalty applied to this turn

  // Commit the guard stance (if staged) for the coming enemy resolution.
  state.blocking = state.stagedBlock;
  state.stagedBlock = false;

  const recover = state.stagedRecover;
  state.stagedRecover = false;

  const atk = state.stagedAttack;
  state.stagedAttack = null;
  const canAttack = atk != null && state.player.stamina >= atk.staminaCost;

  if (atk && canAttack) {
    // Pay the attack's stamina by dragging, then resolve it (ends the turn).
    requireStamina("spend", atk.staminaCost, () => performAttack(atk, beginEnemyPhase));
  } else if (recover) {
    // Forgo acting to pull extra stamina from the spend zone, then end turn.
    log("You catch your breath.");
    requireStamina("replenish", RECOVER_STAMINA, beginEnemyPhase);
  } else {
    beginEnemyPhase();
  }
}

function beginEnemyPhase(): void {
  if (state.enemies.length === 0) {
    startPlayerTurn();
    return;
  }
  state.phase = "enemyMove";
  log("— Enemy turn —");
  flashTurn("Enemy turn");
  render();
  setTimeout(moveEnemiesThen, ENEMY_STEP_MS);
}

// Advance each enemy in turn, then begin the attack roll.
function moveEnemiesThen(): void {
  let i = 0;
  const next = () => {
    if (i >= state.enemies.length) {
      beginEnemyAttack();
      return;
    }
    moveEnemy(state.enemies[i], 0, () => {
      i += 1;
      next();
    });
  };
  next();
}

function moveEnemy(enemy: EnemyToken, stepsTaken: number, done: () => void): void {
  const player = state.player;
  const dx = player.pos.x - enemy.pos.x;
  const dy = player.pos.y - enemy.pos.y;
  const facing = dirFromDelta(dx, dy);
  if (facing !== null) enemy.facing = facing;

  const adjacent = chebyshev(enemy.pos, player.pos) <= 1;
  const nextCell = { x: enemy.pos.x + Math.sign(dx), y: enemy.pos.y + Math.sign(dy) };
  const blocked = !inBounds(nextCell, WIDTH, HEIGHT) || occupied(nextCell, enemy.id);
  const moveBudget = enemy.template.moveSpeed - (enemy.stunned ? 1 : 0); // stun slows

  if (stepsTaken >= moveBudget || adjacent || facing === null || blocked) {
    render();
    done();
    return;
  }

  enemy.pos = nextCell;
  render();
  setTimeout(() => moveEnemy(enemy, stepsTaken + 1, done), ENEMY_STEP_MS);
}

// Roll one d10 per in-range enemy, then hand control to the player to place the
// tokens. Only hollows within ENGAGE_RANGE of the player attack.
function beginEnemyAttack(): void {
  const cards = deck();
  const attackers = state.enemies.filter(
    (e) => !e.stunned && chebyshev(e.pos, state.player.pos) <= ENGAGE_RANGE
  );
  if (attackers.length === 0 || cards.length === 0) {
    if (state.enemies.length) log("The hollows close in, still out of reach.");
    resolvePendingCombos(startPlayerTurn); // committed combos still land
    return;
  }

  // Each enemy may only pick cards that can reach from its distance; the d10
  // counts through just those valid cards (wrapping past the end).
  const selections: Selection[] = [];
  for (const e of attackers) {
    const dist = chebyshev(e.pos, state.player.pos);
    const valid = cards.reduce<number[]>((acc, c, i) => {
      if (c.range >= dist) acc.push(i);
      return acc;
    }, []);
    if (valid.length === 0) continue; // nothing in range — can't attack
    const roll = 1 + Math.floor(Math.random() * 10);
    const cardIndex = valid[(roll - 1) % valid.length];
    const card = cards[cardIndex];
    const followUp = card.followUpOn === "oddRoll" && roll % 2 === 1 && !!card.followUp;
    selections.push({ enemyId: e.id, roll, cardIndex, placed: false, followUp });
  }

  if (selections.length === 0) {
    if (state.enemies.length) log("The hollows close in, still out of reach.");
    startPlayerTurn();
    return;
  }

  rollDice(
    selections.map((s) => s.roll),
    () => {
      for (const s of selections) {
        log(`Hollow #${s.enemyId} rolls ${s.roll} → card ${s.cardIndex + 1}.`);
      }
      state.selections = selections;
      state.flippedCards = new Set();
      state.followUpsResolved = new Set();
      state.swingLevel = 0;
      state.cardsSlid = false;
      state.phase = "placing";
      log("Place each hollow's token on its card.");
      render();
    }
  );
}

// All tokens placed → slide the chosen cards forward, then run the countdown.
function onAllPlaced(): void {
  state.cardsSlid = true;
  render();
  setTimeout(() => {
    state.phase = "countdown";
    state.repositioned = false;
    state.selected = true;
    startCountdown();
  }, CARD_SLIDE_MS);
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
      state.selected = false;
      stopParryListen(); // time's up — lock in whatever the parry achieved
      if (state.parry && !state.parry.success) log("Parry failed — you brace for the blows.");
      if (state.swingLevel === 0) {
        state.phase = "revealing";
        log("Flip each card to resolve its attack.");
      } else {
        state.phase = "comboRevealing";
        log("Fold out the follow-up and resolve it.");
      }
      render();
    }
  };
  setTimeout(tick, 1000);
}

// Flip/fold a card face-up and resolve the given attack against every listed
// enemy, then continue. Shared by base swings and follow-up swings.
function resolveSwing(attack: EnemyCard, picks: Selection[], onDone: () => void): void {
  state.busy = true;
  render();

  setTimeout(() => {
    const actors = picks
      .map((s) => state.enemies.find((e) => e.id === s.enemyId))
      .filter((e): e is EnemyToken => e != null);

    // Pre-attack: leap toward the player and/or turn to face them.
    let moved = false;
    for (const enemy of actors) {
      if (attack.reface) {
        const f = dirFromDelta(state.player.pos.x - enemy.pos.x, state.player.pos.y - enemy.pos.y);
        if (f !== null) {
          enemy.facing = f;
          moved = true;
        }
      }
      for (let j = 0; j < (attack.jump ?? 0); j++) {
        const dx = Math.sign(state.player.pos.x - enemy.pos.x);
        const dy = Math.sign(state.player.pos.y - enemy.pos.y);
        const next = { x: enemy.pos.x + dx, y: enemy.pos.y + dy };
        if (chebyshev(enemy.pos, state.player.pos) <= 1) break; // already adjacent
        if (!inBounds(next, WIDTH, HEIGHT) || occupied(next, enemy.id)) break;
        enemy.pos = next;
        moved = true;
      }
    }
    if (moved) render();

    const plan = actors.map((enemy) => ({
      enemy,
      targets: squaresForOffsets(attack.pattern, enemy.pos, enemy.facing).filter(
        (c) => inBounds(c, WIDTH, HEIGHT)
      ),
    }));

    const allTargets = plan.flatMap((p) => p.targets);
    for (const t of allTargets) cellEls.get(key(t))?.classList.add("flash-target");

    setTimeout(() => {
      for (const t of allTargets) cellEls.get(key(t))?.classList.remove("flash-target");

      // A successful parry turns aside every blow for the rest of the round.
      const parried = state.parry?.success ?? false;
      let hitPlayer = false;
      for (const p of plan) {
        if (p.targets.some((t) => sameCoord(t, state.player.pos))) {
          if (parried) {
            log(`Hollow #${p.enemy.id}'s ${attack.name} is parried — no damage.`);
            continue;
          }
          const guard = guardedSquares();
          const blocked =
            state.blocking &&
            (guard.some((g) => sameCoord(g, p.enemy.pos)) ||
              p.targets.some((t) => guard.some((g) => sameCoord(g, t))));
          applyEnemyHit(attack, p.enemy, blocked);
          hitPlayer = true;
        } else {
          log(`Hollow #${p.enemy.id}'s ${attack.name} misses.`);
        }
      }

      const finish = () => {
        state.busy = false;
        onDone();
      };

      if (hitPlayer) {
        const el = cellEls.get(key(state.player.pos));
        el?.classList.add("flash-hit");
        render();
        setTimeout(() => {
          el?.classList.remove("flash-hit");
          finish();
        }, FLASH_MS);
      } else {
        finish();
      }
    }, FLASH_MS);
  }, CARD_FLIP_MS);
}

// Player clicks a face-down card to flip it and resolve every base swing on it.
function flipCard(i: number): void {
  if (state.phase !== "revealing" || inputLocked()) return;
  const picks = state.selections.filter((s) => s.cardIndex === i);
  if (picks.length === 0 || state.flippedCards.has(i)) return;
  state.flippedCards.add(i);
  resolveSwing(deck()[i], picks, afterFlip);
}

// Player folds out a triggered card to resolve its follow-up swing.
function resolveFollowUp(i: number): void {
  if (state.phase !== "comboRevealing" || inputLocked()) return;
  const picks = state.selections.filter((s) => s.cardIndex === i && s.followUp);
  const followUp = deck()[i].followUp;
  if (picks.length === 0 || !followUp || state.followUpsResolved.has(i)) return;
  state.followUpsResolved.add(i);
  resolveSwing(followUp, picks, afterFollowUp);
}

// After a base swing: death check, then advance to the follow-up wave (if any
// card triggered one) or to reset.
function afterFlip(): void {
  if (state.player.hp <= 0) return died();
  const rolled = new Set(state.selections.map((s) => s.cardIndex));
  const allRevealed = [...rolled].every((i) => state.flippedCards.has(i));
  if (!allRevealed) {
    render();
    return;
  }
  if (state.selections.some((s) => s.followUp)) beginFollowUpWave();
  else combosThenReset();
}

// After a follow-up swing: death check, then reset once all folds resolved.
function afterFollowUp(): void {
  if (state.player.hp <= 0) return died();
  const foldCards = new Set(
    state.selections.filter((s) => s.followUp).map((s) => s.cardIndex)
  );
  const allResolved = [...foldCards].every((i) => state.followUpsResolved.has(i));
  if (allResolved) combosThenReset();
  else render();
}

// Once the hollows have all acted: riposte (if parried), then committed combos.
function combosThenReset(): void {
  resolveRiposte(() =>
    resolvePendingCombos(() => {
      toResetting();
      render();
    })
  );
}

// A successful parry lets the player riposte the parried foe for backstab
// damage (auto in this prototype).
function resolveRiposte(onDone: () => void): void {
  const p = state.parry;
  if (!p || !p.success) {
    onDone();
    return;
  }
  const e = state.enemies.find((x) => x.id === p.targetId);
  if (!e) {
    onDone();
    return;
  }
  const dmg = state.player.weapon.backstab;
  state.busy = true;
  log(`Riposte! ${dmg} damage to hollow #${e.id}.`);
  render();
  const el = cellEls.get(key(e.pos));
  el?.classList.add("flash-hit");
  setTimeout(() => {
    el?.classList.remove("flash-hit");
    e.hp -= dmg;
    if (e.hp <= 0) log(`Hollow #${e.id} is cut down by the riposte.`);
    state.enemies = state.enemies.filter((x) => x.hp > 0);
    state.busy = false;
    render();
    onDone();
  }, FLASH_MS);
}

// A second reaction window precedes folding out the follow-up swings.
function beginFollowUpWave(): void {
  state.swingLevel = 1;
  state.repositioned = false;
  state.selected = true;
  state.phase = "countdown";
  flashTurn("Follow-up!");
  log("The hollow winds up again — react!");
  renderCountdown();
  render();
  startCountdown();
}

function toResetting(): void {
  state.phase = "resetting";
  log("Click each card to flip it back.");
}

function died(): void {
  state.busy = false;
  state.phase = "dead";
  log("You have died.");
  flashTurn("YOU DIED");
  render();
}

// During reset, clicking a face-up card flips it back; once all are reset, the
// cards slide home and the next turn begins.
function unflipCard(i: number): void {
  if (state.phase !== "resetting" || inputLocked()) return;
  if (!state.flippedCards.has(i)) return;
  state.flippedCards.delete(i);
  render();

  if (state.flippedCards.size === 0) {
    state.cardsSlid = false;
    render();
    setTimeout(() => {
      state.selections = [];
      // Pay the stamina spent this enemy turn (dodge + block + kick), then go.
      requireStamina("spend", state.staminaOwed, () => {
        state.staminaOwed = 0;
        startPlayerTurn();
      });
    }, CARD_SLIDE_MS);
  }
}

function applyEnemyHit(card: EnemyCard, enemy: EnemyToken, blocked: boolean): void {
  const player = state.player;
  let msg: string;

  if (blocked) {
    // Damage is absorbed by stamina (reserved as owed); overflow spills to HP.
    const absorbed = Math.min(staminaAvailable(), card.damage);
    state.staminaOwed += absorbed;
    const overflow = card.damage - absorbed;
    if (overflow > 0) player.hp -= overflow;
    msg = `Hollow #${enemy.id}'s ${card.name} blocked — stamina absorbs ${absorbed}`;
    msg += overflow > 0 ? `, ${overflow} health lost.` : ".";
  } else {
    player.hp -= card.damage;
    msg = `Hollow #${enemy.id}'s ${card.name} lands — ${card.damage} damage.`;
  }

  if (card.staminaDamage) {
    const lost = Math.min(staminaAvailable(), card.staminaDamage);
    state.staminaOwed += lost;
    msg += ` (−${lost} stamina)`;
  }
  if (card.knockback) {
    const dx = Math.sign(player.pos.x - enemy.pos.x);
    const dy = Math.sign(player.pos.y - enemy.pos.y);
    for (let i = 0; i < card.knockback; i++) {
      const next = { x: player.pos.x + dx, y: player.pos.y + dy };
      if (!inBounds(next, WIDTH, HEIGHT) || occupied(next)) break;
      player.pos = next;
    }
    msg += " You are knocked back.";
  }
  log(msg);

  // A stunning attack that connects rolls against the player's resistance.
  if (card.stun) {
    const roll = 1 + Math.floor(Math.random() * 10);
    if (roll < player.stunResist) {
      player.stunned = true;
      log(`Stun roll ${roll} vs your resist ${player.stunResist} → you are stunned!`);
    } else {
      log(`Stun roll ${roll} vs your resist ${player.stunResist} → you shrug it off.`);
    }
  }
}

function flashTurn(text: string): void {
  turnFlashEl.textContent = text;
  turnFlashEl.classList.toggle("died", text === "YOU DIED");
  turnFlashEl.classList.remove("show");
  void turnFlashEl.offsetWidth;
  turnFlashEl.classList.add("show");
}

// --- Wiring ---

turnLeftBtn.addEventListener("click", () => rotate(true));
turnRightBtn.addEventListener("click", () => rotate(false));
endBtn.addEventListener("click", endTurn);
parryBtn.addEventListener("click", armParry);

window.addEventListener("keydown", (e) => {
  // Don't steal keys while typing parry tags.
  if ((e.target as HTMLElement)?.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === "q") rotate(true);
  else if (k === "e") rotate(false);
  else if (k === "enter") endTurn();
  else if (k === "p") armParry();
  else return;
  e.preventDefault();
});

// --- Loadout selection ---

const loadoutEl = document.getElementById("loadout")!;
const weaponChoicesEl = document.getElementById("weapon-choices")!;
const shieldChoicesEl = document.getElementById("shield-choices")!;
const loadEl = document.getElementById("loadout-load")!;
const beginBtn = document.getElementById("begin") as HTMLButtonElement;

let pickedWeapon: Weapon | null = null;
let pickedShield: Shield | null = null;

function renderLoadout(): void {
  weaponChoicesEl.replaceChildren();
  shieldChoicesEl.replaceChildren();

  for (const w of WEAPONS) {
    const el = document.createElement("div");
    el.className = "choice" + (pickedWeapon === w ? " picked" : "");
    el.innerHTML = `
      <div class="choice-name">${w.name}</div>
      <div class="choice-stats">${w.weight} wt · backstab ${w.backstab}</div>
      <div class="choice-stats">${w.light.name}: ${w.light.damage}/${w.light.staminaCost}${
      w.light.stun ? " stun" : ""
    }</div>
      <div class="choice-stats">${w.heavy.name}: ${w.heavy.damage}/${w.heavy.staminaCost}${
      w.heavy.stun ? " stun" : ""
    }</div>`;
    el.addEventListener("click", () => {
      pickedWeapon = w;
      refreshLoadout();
    });
    weaponChoicesEl.appendChild(el);
  }

  for (const s of SHIELDS) {
    const el = document.createElement("div");
    el.className = "choice" + (pickedShield === s ? " picked" : "");
    const rule = s.parry === "any2" ? "any 2 tags" : "all tags, in order";
    el.innerHTML = `
      <div class="choice-name">${s.name}</div>
      <div class="choice-stats">${s.weight} wt</div>
      <div class="choice-stats">parry: ${rule}</div>`;
    el.addEventListener("click", () => {
      pickedShield = s;
      refreshLoadout();
    });
    shieldChoicesEl.appendChild(el);
  }
}

function refreshLoadout(): void {
  renderLoadout();
  const load = (pickedWeapon?.weight ?? 0) + (pickedShield?.weight ?? 0);
  if (pickedWeapon && pickedShield) {
    const dodge = load < MAX_LOAD / 2 ? 2 : 1;
    loadEl.textContent = `Load ${load}/${MAX_LOAD} — dodge ${dodge} square${dodge > 1 ? "s" : ""}`;
  } else {
    loadEl.textContent = "";
  }
  beginBtn.disabled = !(pickedWeapon && pickedShield);
}

beginBtn.addEventListener("click", () => {
  if (!pickedWeapon || !pickedShield) return;
  state.player.weapon = pickedWeapon;
  state.player.shield = pickedShield;
  loadoutEl.classList.add("hidden");
  render();
  flashTurn("Your turn");
});

renderLoadout();
refreshLoadout();
render();
