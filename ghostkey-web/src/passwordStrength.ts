/**
 * Real password strength estimation via zxcvbn (the @zxcvbn-ts fork).
 *
 * Why this exists: the password IS the vault. There's no recovery
 * email and no support desk — a guessable password is the single
 * worst failure mode a password-vault owner can have. A length-only
 * meter calls "Sunshine2024!" strong; zxcvbn knows it's in every
 * cracker's first billion guesses.
 *
 * Bundle note: the dictionaries are ~800 KB raw (~250 KB gzipped).
 * We load them with a dynamic import the first time a strength check
 * is requested, so the landing page / dashboard never pay for them.
 * The password step shows a "checking…" beat on slow connections at
 * worst; everything after the first call is synchronous.
 */

export interface StrengthResult {
  /** zxcvbn score: 0 (guessed instantly) … 4 (centuries offline). */
  score: 0 | 1 | 2 | 3 | 4;
  /** Whether we let the user proceed with this password. */
  acceptable: boolean;
  /** One-word verdict for the meter. */
  label: string;
  /** Meter tone, mapped to theme colours by the caller. */
  tone: "bad" | "ok" | "good";
  /** One plain-words, actionable suggestion — or null when there's
   *  nothing useful to say (good passwords). */
  advice: string | null;
}

/** Score required to create a vault. 3 = "safely unguessable in an
 *  offline attack measured in months"; for a key that guards Bitcoin
 *  and can't be rotated cheaply, 2 ("hours to days") isn't enough. */
const MIN_SCORE = 3;

/** Floor independent of zxcvbn (matches the pre-existing rule, and
 *  Argon2id can't save a 6-character password however "random"). */
export const MIN_LENGTH = 10;

type ZxcvbnFn = (
  password: string,
  userInputs?: string[],
) => {
  score: 0 | 1 | 2 | 3 | 4;
  feedback: { warning: string | null; suggestions: string[] };
};

let loaded: ZxcvbnFn | null = null;
let loading: Promise<ZxcvbnFn> | null = null;

async function loadZxcvbn(): Promise<ZxcvbnFn> {
  if (loaded) return loaded;
  if (!loading) {
    loading = Promise.all([
      import("@zxcvbn-ts/core"),
      import("@zxcvbn-ts/language-common"),
      import("@zxcvbn-ts/language-en"),
    ]).then(([core, common, en]) => {
      core.zxcvbnOptions.setOptions({
        // Common = leaked-password lists, keyboard layouts, l33t
        // table. En = English words, names, dates. Both matter:
        // our users pick "correct horse"-style English phrases.
        dictionary: {
          ...common.dictionary,
          ...en.dictionary,
        },
        graphs: common.adjacencyGraphs,
        translations: en.translations,
      });
      loaded = core.zxcvbn;
      return core.zxcvbn;
    });
  }
  return loading;
}

/** Kick off the dictionary download without blocking. Call from the
 *  password step's mount so the data is usually ready before the
 *  user finishes typing their first candidate. */
export function preloadStrengthChecker(): void {
  void loadZxcvbn().catch(() => {
    // Network hiccup — checkPassword falls back to length-only.
  });
}

/** zxcvbn's terse suggestions, rewritten in the app's plain voice.
 *  Keyed on the feedback strings the en translation pack emits. */
function plainAdvice(warning: string | null, suggestions: string[]): string | null {
  // The warning is the most specific signal ("This is a commonly
  // used password"); prefer it, fall back to the first suggestion.
  const raw = warning || suggestions[0] || null;
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("commonly used") || lower.includes("top-10") || lower.includes("top-100")) {
    return "This exact password shows up in lists hackers try first. Pick something only you would think of.";
  }
  if (lower.includes("dates") || lower.includes("years") || lower.includes("recent years")) {
    return "Dates and years are easy to guess — leave them out.";
  }
  if (lower.includes("names") && lower.includes("surnames")) {
    return "Names are easy to guess. Try a few unrelated words instead.";
  }
  if (lower.includes("word by itself") || lower.includes("dictionary")) {
    return "A single word is easy to guess. String three or four unrelated words together.";
  }
  if (lower.includes("rows of keys") || lower.includes("keyboard pattern")) {
    return "Letters that sit next to each other on the keyboard are easy to guess.";
  }
  if (lower.includes("repeat") || lower.includes('"aaa"') || lower.includes('"abcabcabc"')) {
    return "Repeating the same characters doesn't add safety. Add different words instead.";
  }
  if (lower.includes("sequence") || lower.includes("abc") || lower.includes("6543")) {
    return "Sequences like abc or 123 are easy to guess.";
  }
  if (lower.includes("substitution") || lower.includes("l33t") || lower.includes("@ instead of a")) {
    return "Swapping letters for symbols (a → @) doesn't fool anyone — add more words instead.";
  }
  // Unknown feedback string: pass it through rather than hide it.
  return raw;
}

/**
 * Score a candidate password. Async because the first call may still
 * be downloading the dictionaries; subsequent calls resolve
 * immediately.
 *
 * `userInputs` should carry words an attacker targeting THIS user
 * would try first — their email, the heir names they just typed.
 * zxcvbn scores those as if they were in the common-passwords list.
 */
export async function checkPassword(
  password: string,
  userInputs: string[] = [],
): Promise<StrengthResult> {
  if (password.length < MIN_LENGTH) {
    return {
      score: 0,
      acceptable: false,
      label: "Too short",
      tone: "bad",
      advice: `Use at least ${MIN_LENGTH} characters. Longer is better.`,
    };
  }

  let fn: ZxcvbnFn;
  try {
    fn = await loadZxcvbn();
  } catch {
    // Dictionaries unreachable (offline setup, blocked CDN). Fall
    // back to the old length-only heuristic rather than locking the
    // user out of creating a vault.
    return {
      score: password.length >= 14 ? 3 : 2,
      acceptable: password.length >= 14,
      label: password.length >= 14 ? "Okay" : "Too short",
      tone: password.length >= 14 ? "ok" : "bad",
      advice:
        password.length >= 14
          ? null
          : "Use at least 14 characters. Longer is better.",
    };
  }

  // zxcvbn cost grows with input length; 72 bytes is bcrypt-style
  // truncation territory and far past where the score saturates.
  const result = fn(password.slice(0, 72), userInputs);
  const advice = plainAdvice(
    result.feedback.warning,
    result.feedback.suggestions,
  );

  if (result.score >= MIN_SCORE) {
    return {
      score: result.score,
      acceptable: true,
      label: result.score === 4 ? "Excellent" : "Strong",
      tone: "good",
      advice: null,
    };
  }
  return {
    score: result.score,
    acceptable: false,
    label: result.score <= 1 ? "Too easy to guess" : "Not strong enough",
    tone: "bad",
    advice:
      advice ??
      "Try three or four unrelated words — easy for you to remember, hard for anyone to guess.",
  };
}
