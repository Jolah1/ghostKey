/**
 * Web Worker that runs the Argon2id password KDF off the main thread.
 *
 * argon2idAsync only yields between mixing passes, and at 64 MiB each
 * pass pegs a thread for seconds. Run on the main thread that froze
 * the whole page during sign-in: no spinner, no progress, no clicks
 * (live-verified — the page repainted zero times during an unlock).
 * In a worker the derivation costs the same but the page stays alive.
 *
 * Protocol: one {id, pw, salt, t, m, p, dkLen} request in;
 * {id, progress} ticks stream back, then one {id, raw} result or
 * {id, error}. The password bytes never outlive the request: the
 * caller transfers them in and this worker zeroes them after use.
 */
import { argon2idAsync } from "@noble/hashes/argon2.js";

interface KdfRequest {
  id: number;
  pw: Uint8Array;
  salt: Uint8Array;
  t: number;
  m: number;
  p: number;
  dkLen: number;
}

self.onmessage = (event: MessageEvent<KdfRequest>) => {
  const { id, pw, salt, t, m, p, dkLen } = event.data;
  void (async () => {
    try {
      let lastPct = -1;
      const raw = await argon2idAsync(pw, salt, {
        t,
        m,
        p,
        dkLen,
        onProgress: (pct: number) => {
          // Progress arrives per internal tick; only forward whole-percent
          // changes so the message channel isn't flooded.
          const whole = Math.floor(pct * 100);
          if (whole !== lastPct) {
            lastPct = whole;
            self.postMessage({ id, progress: pct });
          }
        },
      });
      self.postMessage({ id, raw }, { transfer: [raw.buffer as ArrayBuffer] });
    } catch (error) {
      self.postMessage({ id, error: String(error) });
    } finally {
      pw.fill(0);
    }
  })();
};
