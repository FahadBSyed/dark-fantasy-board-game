// A lightweight pseudo-3D dice roll. Each die tumbles via 3D rotation while its
// face flickers through random pips, then settles on its final value with a
// little bounce. Purely cosmetic — the caller already knows the results.

const DICE_TRAY_ID = "dice-tray";
const TUMBLE_MS = 1100;
const FLICKER_MS = 70;
const SETTLE_MS = 650;

// Animate one die per value, then call onDone. Total ~ TUMBLE_MS + SETTLE_MS.
export function rollDice(values: number[], onDone: () => void): void {
  const tray = document.getElementById(DICE_TRAY_ID);
  if (!tray || values.length === 0) {
    onDone();
    return;
  }

  tray.replaceChildren();
  tray.classList.add("show");

  const dice = values.map((value) => {
    const die = document.createElement("div");
    die.className = "die rolling";
    const face = document.createElement("span");
    face.className = "die-face";
    face.textContent = "?";
    die.appendChild(face);
    tray.appendChild(die);
    return { die, face, value };
  });

  const flicker = window.setInterval(() => {
    for (const d of dice) d.face.textContent = String(1 + Math.floor(Math.random() * 10));
  }, FLICKER_MS);

  window.setTimeout(() => {
    window.clearInterval(flicker);
    for (const d of dice) {
      d.face.textContent = String(d.value);
      d.die.classList.remove("rolling");
      d.die.classList.add("landed");
    }
    window.setTimeout(() => {
      tray.classList.remove("show");
      onDone();
    }, SETTLE_MS);
  }, TUMBLE_MS);
}
