// Minimal Web Audio helpers for the countdown timer. No assets — tones are
// synthesized. The AudioContext is created lazily and resumed on demand, since
// browsers require a user gesture before audio can play.

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    ctx = new Ctor();
  }
  return ctx;
}

// Call from within a user gesture (e.g. a click) to unblock audio.
export function resumeAudio(): void {
  const c = audio();
  if (c.state === "suspended") void c.resume();
}

function tone(freq: number, durMs: number, type: OscillatorType, gain: number): void {
  const c = audio();
  if (c.state === "suspended") void c.resume();
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(c.destination);
  const t = c.currentTime;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
  osc.start(t);
  osc.stop(t + durMs / 1000);
}

// A short tick for each second of the countdown.
export function beep(): void {
  tone(660, 120, "square", 0.12);
}

// A longer, harsher blare when the countdown ends.
export function blare(): void {
  tone(196, 500, "sawtooth", 0.2);
}
