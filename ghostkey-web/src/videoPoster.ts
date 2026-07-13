/**
 * Playback helpers for the recorded video message (#85).
 *
 * Two gaps these close, both found on the first real mainnet claim:
 *
 *  - Browsers don't paint a frame of a blob-URL clip until playback
 *    starts, so the player sat as a blank black box before play was
 *    pressed. `captureVideoPoster` grabs an early frame offscreen and
 *    hands back a data-URL poster.
 *
 *  - A clip records in whatever container the OWNER's browser prefers
 *    (historically WebM), and the heir's browser may not decode it at
 *    all — iPhones have no WebM playback, so the heir got a player
 *    that never played. `videoIsPlayable` asks the browser up front so
 *    the UI can offer a download instead of a dead player.
 */

/** Can this browser decode the clip at all? `canPlayType` returning ""
 *  means the player would render but never play (WebM on an iPhone).
 *  Errs on the side of showing the player when the API is missing. */
export function videoIsPlayable(mime: string): boolean {
  if (typeof document === "undefined") return true;
  const probe = document.createElement("video");
  if (typeof probe.canPlayType !== "function") return true;
  return probe.canPlayType(mime) !== "";
}

/**
 * Best-effort first-frame poster: load the clip in an offscreen video,
 * nudge past t=0 (camera clips often open on a black frame), draw to a
 * canvas, return a JPEG data URL. `null` on any failure or after
 * `timeoutMs` — the player then renders exactly as it did before.
 */
export function captureVideoPoster(
  url: string,
  timeoutMs = 4000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let settled = false;
    const done = (poster: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Detach so the offscreen element releases its decoder promptly.
      video.removeAttribute("src");
      video.load();
      resolve(poster);
    };
    const timer = setTimeout(() => done(null), timeoutMs);

    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.addEventListener("error", () => done(null));
    video.addEventListener("loadeddata", () => {
      try {
        // A MediaRecorder WebM often reports Infinity duration (no
        // seek head), so don't lean on duration for the target time.
        video.currentTime = 0.25;
      } catch {
        done(null);
      }
    });
    video.addEventListener("seeked", () => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return done(null);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return done(null);
      try {
        ctx.drawImage(video, 0, 0, w, h);
        done(canvas.toDataURL("image/jpeg", 0.8));
      } catch {
        done(null);
      }
    });
    video.src = url;
  });
}

/** Download filename for a clip, from its container MIME. */
export function videoDownloadName(mime: string): string {
  const subtype = mime.split(";")[0].split("/")[1]?.trim();
  return `video-message.${subtype || "webm"}`;
}
