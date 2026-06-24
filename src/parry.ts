// Parry input. No NLP — the vocabulary is just the attack's printed tags, so
// this is fuzzy string-matching of spoken (or typed) words against those tags.

export type ParryRule = "exactAll" | "any2";

export function speechSupported(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return "SpeechRecognition" in w || "webkitSpeechRecognition" in w;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// "As best you can" — accept an exact match or a near miss (edit distance ≤ 1).
function wordMatches(spoken: string, tag: string): boolean {
  const s = normalize(spoken);
  const t = normalize(tag);
  if (!s || !t) return false;
  if (s === t) return true;
  return editDistance(s, t) <= 1;
}

// Does the spoken phrase satisfy the parry? exactAll = every tag, in order;
// any2 = at least two tags, any order.
export function matchTags(
  phrase: string,
  required: string[],
  rule: ParryRule
): boolean {
  const spoken = phrase.split(/\s+/).map(normalize).filter(Boolean);
  if (rule === "any2") {
    const hit = required.filter((tag) => spoken.some((w) => wordMatches(w, tag)));
    return hit.length >= 2;
  }
  // exactAll: the tags appear as an ordered subsequence of the spoken words.
  let ti = 0;
  for (const w of spoken) {
    if (ti < required.length && wordMatches(w, required[ti])) ti++;
  }
  return ti >= required.length;
}

export interface ParryListener {
  stop: () => void;
}

// Listen on the mic; report transcripts and fire onMatch once the tags land.
export function listenForParry(
  required: string[],
  rule: ParryRule,
  onTranscript: (text: string) => void,
  onMatch: () => void
): ParryListener {
  const w = window as unknown as Record<string, unknown>;
  const Ctor = (w.SpeechRecognition || w.webkitSpeechRecognition) as
    | (new () => SpeechRecognitionLike)
    | undefined;
  if (!Ctor) return { stop: () => {} };

  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  let done = false;

  rec.onresult = (e: SpeechResultEvent) => {
    let text = "";
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + " ";
    text = text.trim();
    onTranscript(text);
    if (!done && matchTags(text, required, rule)) {
      done = true;
      onMatch();
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
  };
  rec.onerror = () => {};
  try {
    rec.start();
  } catch {
    /* ignore */
  }
  return {
    stop: () => {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

// Minimal structural types for the (non-standard) Web Speech API.
interface SpeechResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (e: SpeechResultEvent) => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
}
