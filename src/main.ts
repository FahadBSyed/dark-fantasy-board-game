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
  STRAIGHT_SWORD,
  KITE_SHIELD,
  type Attack,
  type Shield,
  type Weapon,
} from "./weapons";
import { HOLLOW_AXEMAN, type EnemyCard, type EnemyTemplate } from "./enemies";
import { beep, blare, resumeAudio } from "./audio";
import { rollDice } from "./dice";

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
const MOVES_PER_TURN = 5;
const MAX_STAMINA = 5;
const STAMINA_REGEN = 2;
const MAX_HP = 5;
const ENEMY_MOVES_PER_TURN = 3;
const ENEMY_STEP_MS = 240;
const CARD_SLIDE_MS = 360;
const TOKEN_DROP_MS = 460; // token thrown onto the card before it slides
const CARD_FLIP_MS = 520; // matches the card-inner flip transition
const RESOLVE_GAP_MS = 280; // beat between enemies resolving
const FLASH_MS = 260;
const COUNTDOWN_SECONDS = 3;
const STEP_SQUARES = 1;
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
  shield: Shield;
}

interface EnemyToken {
  id: number; // shown on the icon and on its deck tokens
  pos: Coord;
  facing: Dir;
  hp: number;
  maxHp: number;
  template: EnemyTemplate;
}

// Which card an enemy rolled this turn.
interface Selection {
  enemyId: number;
  cardIndex: number;
  roll: number;
}

type Phase = "player" | "enemyMove" | "countdown" | "dead";

interface State {
  player: PlayerToken;
  enemies: EnemyToken[];
  phase: Phase;
  movesLeft: number;
  attacksUsed: number;
  selected: boolean;
  busy: boolean;
  stagedAttack: Attack | null;
  stagedBlock: boolean; // raise guard this turn (instead of attacking)
  blocking: boolean; // guard is up during the enemy resolution
  selections: Selection[]; // enemy card picks this turn
  flippedCards: Set<number>; // card indices revealed so far (sequential)
  cardsSlid: boolean; // selected cards have slid forward
  tokensDropping: boolean; // play the token-drop animation this render
  countdownNum: number;
  dodgeArmed: boolean;
  repositioned: boolean;
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
    weapon: STRAIGHT_SWORD,
    shield: KITE_SHIELD,
  },
  enemies: spawnEnemies(),
  phase: "player",
  movesLeft: MOVES_PER_TURN,
  attacksUsed: 0,
  selected: false,
  busy: false,
  stagedAttack: null,
  stagedBlock: false,
  blocking: false,
  selections: [],
  flippedCards: new Set(),
  cardsSlid: false,
  tokensDropping: false,
  countdownNum: 0,
  dodgeArmed: false,
  repositioned: false,
  log: ["The Ashen One stands ready. Three hollows stir across the hall."],
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

// Squares the player may move to right now — depends on the phase.
function reachable(): Set<string> {
  const out = new Set<string>();
  const { player } = state;
  const free = (c: Coord) => inBounds(c, WIDTH, HEIGHT) && !occupied(c);

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
        cell.addEventListener("click", onPlayerClick);
      } else if (enemy) {
        cell.appendChild(makeTokenSvg(enemy.facing, "enemy"));
        cell.appendChild(idBadge(enemy.id));
        cell.appendChild(hpBadge(enemy.hp, "enemy-hp"));
      } else if (reach.has(key(here))) {
        cell.classList.add(state.dodgeArmed ? "dodge-reach" : "reach");
        cell.addEventListener("click", () => moveTo(here));
      }

      boardEl.appendChild(cell);
    }
  }

  renderEnemyDeck();
  renderWeapon();
  renderShield();
  renderHud();
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
    void countdownEl.offsetWidth;
    countdownEl.classList.add("show");
  } else {
    countdownEl.classList.remove("show");
  }
}

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

// --- Enemy deck (one shared deck above the grid) ---

function renderEnemyDeck(): void {
  enemyDeckEl.replaceChildren();
  const cards = deck();
  if (cards.length === 0) return;

  cards.forEach((card, i) => {
    const picks = state.selections.filter((s) => s.cardIndex === i);
    const selected = picks.length > 0;
    const slid = selected && state.cardsSlid;
    const flipped = selected && state.flippedCards.has(i);

    const el = document.createElement("div");
    el.className =
      "enemy-card" + (slid ? " slid" : "") + (flipped ? " flipped" : "");

    const inner = document.createElement("div");
    inner.className = "card-inner";
    inner.appendChild(makeCardBack(card));
    inner.appendChild(makeCardFront(card));
    el.appendChild(inner);

    // Numbered tokens for each enemy that rolled this card.
    if (picks.length) {
      const tokens = document.createElement("div");
      tokens.className = "card-tokens";
      for (const p of picks) {
        const t = document.createElement("span");
        t.className = "card-token" + (state.tokensDropping ? " dropping" : "");
        t.textContent = String(p.enemyId);
        tokens.appendChild(t);
      }
      el.appendChild(tokens);
    }

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
  if (state.busy || !inBounds(dest, WIDTH, HEIGHT) || occupied(dest)) return;

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
  if (state.stagedAttack) state.stagedBlock = false; // one action per turn
  render();
}

function toggleBlock(): void {
  if (state.phase !== "player" || state.busy) return;
  state.stagedBlock = !state.stagedBlock;
  if (state.stagedBlock) state.stagedAttack = null;
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

// --- Player attack (staged on End turn) ---

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
      for (const e of hits) {
        e.hp -= atk.damage;
        if (e.hp <= 0) log(`Hollow #${e.id} is cut down.`);
        else log(`Hollow #${e.id} takes ${atk.damage}. (${e.hp} HP left)`);
      }
      state.enemies = state.enemies.filter((e) => e.hp > 0);
      state.busy = false;
      render();
      onDone();
    }, FLASH_MS);
  }, FLASH_MS);
}

// --- Turn flow ---

function startPlayerTurn(): void {
  state.phase = "player";
  state.movesLeft = MOVES_PER_TURN;
  state.attacksUsed = 0;
  state.stagedBlock = false;
  state.blocking = false;
  state.selections = [];
  state.flippedCards = new Set();
  state.cardsSlid = false;
  state.tokensDropping = false;
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

  // Commit the guard stance (if staged) for the coming enemy resolution.
  state.blocking = state.stagedBlock;
  state.stagedBlock = false;

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

  if (stepsTaken >= ENEMY_MOVES_PER_TURN || adjacent || facing === null || blocked) {
    render();
    done();
    return;
  }

  enemy.pos = nextCell;
  render();
  setTimeout(() => moveEnemy(enemy, stepsTaken + 1, done), ENEMY_STEP_MS);
}

// Roll one d10 per enemy, drop a numbered token on each chosen card, then slide
// the chosen cards forward and start the countdown.
function beginEnemyAttack(): void {
  const cards = deck();
  if (state.enemies.length === 0 || cards.length === 0) {
    startPlayerTurn();
    return;
  }

  const selections: Selection[] = state.enemies.map((e) => {
    const roll = 1 + Math.floor(Math.random() * 10);
    return { enemyId: e.id, roll, cardIndex: (roll - 1) % cards.length };
  });

  // 1. Tumble the dice (one per enemy).
  rollDice(
    selections.map((s) => s.roll),
    () => {
      for (const s of selections) {
        log(`Hollow #${s.enemyId} rolls ${s.roll} → card ${s.cardIndex + 1}.`);
      }
      // 2. Drop the numbered tokens onto the cards (still in their row).
      state.selections = selections;
      state.flippedCards = new Set();
      state.cardsSlid = false;
      state.tokensDropping = true;
      render();

      // 3. Slide the chosen cards forward.
      setTimeout(() => {
        state.tokensDropping = false;
        state.cardsSlid = true;
        render();

        // 4. Begin the reaction window.
        setTimeout(() => {
          state.phase = "countdown";
          state.dodgeArmed = false;
          state.repositioned = false;
          state.selected = true;
          startCountdown();
        }, CARD_SLIDE_MS);
      }, TOKEN_DROP_MS);
    }
  );
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
      resolveEnemyAttacks();
    }
  };
  setTimeout(tick, 1000);
}

// Reveal each selected card in turn — flip, flash, resolve — left-to-right,
// one enemy at a time, so the pacing mirrors a tabletop.
function resolveEnemyAttacks(): void {
  const cards = deck();
  state.busy = true;
  state.selected = false;
  state.dodgeArmed = false;
  render();

  const plan = state.selections
    .map((s) => {
      const enemy = state.enemies.find((e) => e.id === s.enemyId);
      if (!enemy) return null;
      return { cardIndex: s.cardIndex, enemy, card: cards[s.cardIndex] };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => a.cardIndex - b.cardIndex);

  let i = 0;
  const next = () => {
    if (i >= plan.length || state.player.hp <= 0) {
      finishEnemyAttacks();
      return;
    }
    resolveOne(plan[i], () => {
      i += 1;
      setTimeout(next, RESOLVE_GAP_MS);
    });
  };
  next();
}

function resolveOne(
  p: { cardIndex: number; enemy: EnemyToken; card: EnemyCard },
  done: () => void
): void {
  // Flip this enemy's card face-up.
  state.flippedCards.add(p.cardIndex);
  render();

  setTimeout(() => {
    const targets = squaresForOffsets(p.card.pattern, p.enemy.pos, p.enemy.facing).filter(
      (c) => inBounds(c, WIDTH, HEIGHT)
    );
    for (const t of targets) cellEls.get(key(t))?.classList.add("flash-target");

    setTimeout(() => {
      for (const t of targets) cellEls.get(key(t))?.classList.remove("flash-target");
      const hit = targets.some((t) => sameCoord(t, state.player.pos));

      if (hit) {
        // Blocked when the attack's squares overlap the shield's guarded arc.
        const guard = guardedSquares();
        const blocked =
          state.blocking &&
          targets.some((t) => guard.some((g) => sameCoord(g, t)));
        applyEnemyHit(p.card, p.enemy, blocked);
        const el = cellEls.get(key(state.player.pos));
        el?.classList.add("flash-hit");
        render();
        setTimeout(() => {
          el?.classList.remove("flash-hit");
          done();
        }, FLASH_MS);
      } else {
        log(`Hollow #${p.enemy.id}'s ${p.card.name} misses.`);
        done();
      }
    }, FLASH_MS);
  }, CARD_FLIP_MS);
}

function applyEnemyHit(card: EnemyCard, enemy: EnemyToken, blocked: boolean): void {
  const player = state.player;
  let msg: string;

  if (blocked) {
    // Damage hits stamina first; any overflow spills to health.
    const absorbed = Math.min(player.stamina, card.damage);
    player.stamina -= absorbed;
    const overflow = card.damage - absorbed;
    if (overflow > 0) player.hp -= overflow;
    msg = `Hollow #${enemy.id}'s ${card.name} blocked — stamina absorbs ${absorbed}`;
    msg += overflow > 0 ? `, ${overflow} health lost.` : ".";
  } else {
    player.hp -= card.damage;
    msg = `Hollow #${enemy.id}'s ${card.name} lands — ${card.damage} damage.`;
  }

  if (card.staminaDamage) {
    player.stamina = Math.max(0, player.stamina - card.staminaDamage);
    msg += ` (−${card.staminaDamage} stamina)`;
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
}

function finishEnemyAttacks(): void {
  state.selections = [];
  state.flippedCards = new Set();
  state.cardsSlid = false;
  state.tokensDropping = false;
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
  void turnFlashEl.offsetWidth;
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
