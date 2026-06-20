/**
 * Optional owner video message recorder (#85).
 *
 * Shown during vault setup. The owner records a short clip; when the
 * heir later opens their claim link, they see this clip and know the
 * claim is genuinely from the person they know — a face and a voice,
 * not a hash. Nothing technical is exposed: the encryption and signing
 * happen silently at creation time (the parent handles that). This
 * component only captures the clip and hands it back via `onChange`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "./ui";

const MAX_SECONDS = 30;

/** Container the browser will record into, best-supported first. */
function pickMime(): string | undefined {
  const candidates = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
    "video/mp4",
  ];
  if (typeof MediaRecorder === "undefined") return undefined;
  return candidates.find((m) => MediaRecorder.isTypeSupported(m));
}

export interface RecordedClip {
  blob: Blob;
  durationMs: number;
  mime: string;
}

type Phase = "idle" | "recording" | "review" | "denied" | "unsupported";

export function VideoMessageRecorder({
  heirName,
  onChange,
  disabled,
}: {
  heirName?: string;
  onChange: (clip: RecordedClip | null) => void;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);
  const stopTimerRef = useRef<number | null>(null);

  const who = heirName?.trim() ? heirName.trim() : "your heir";

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (tickRef.current) window.clearInterval(tickRef.current);
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    tickRef.current = null;
    stopTimerRef.current = null;
  }, []);

  // Tear everything down on unmount.
  useEffect(
    () => () => {
      stopStream();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [stopStream, previewUrl],
  );

  async function start() {
    setError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices) {
      setPhase("unsupported");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true; // avoid echo on the live preview
        await videoRef.current.play().catch(() => {});
      }
      const mime = pickMime();
      const recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        videoBitsPerSecond: 900_000,
        audioBitsPerSecond: 64_000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mime || "video/webm";
        const blob = new Blob(chunksRef.current, { type });
        const durationMs = Date.now() - startedAtRef.current;
        stopStream();
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        setPhase("review");
        onChange({ blob, durationMs, mime: blob.type || type });
      };
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setElapsed(0);
      recorder.start();
      setPhase("recording");
      tickRef.current = window.setInterval(() => {
        setElapsed((s) => s + 1);
      }, 1000);
      stopTimerRef.current = window.setTimeout(() => stop(), MAX_SECONDS * 1000);
    } catch (e) {
      stopStream();
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPhase("denied");
      } else {
        setError(
          e instanceof Error ? e.message : "Couldn't start the camera. Try again.",
        );
        setPhase("idle");
      }
    }
  }

  function stop() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }

  function reset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setElapsed(0);
    setPhase("idle");
    onChange(null);
  }

  return (
    <div className="rounded-2xl border border-app p-5">
      <h3 className="text-base font-semibold">
        Leave a video message{" "}
        <span className="text-app-subtle font-normal">(optional)</span>
      </h3>
      <p className="text-app-subtle mt-1 text-sm">
        When {who} opens their link, they'll see your face and hear your voice,
        so they know the message is really from you, not a scam. Just talk for a
        few seconds; nothing technical.
      </p>

      <div className="mt-4">
        {(phase === "idle" || phase === "recording") && (
          <div className="overflow-hidden rounded-xl bg-black/80">
            {/* Live camera preview while idle/recording. */}
            <video
              ref={videoRef}
              className="aspect-video w-full object-cover"
              playsInline
              muted
            />
          </div>
        )}

        {phase === "review" && previewUrl && (
          <div className="overflow-hidden rounded-xl bg-black/80">
            {/* Owner's own just-recorded clip — no caption file exists. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={previewUrl}
              className="aspect-video w-full object-cover"
              controls
              playsInline
            />
          </div>
        )}
      </div>

      {error ? (
        <div className="mt-3">
          <InlineAlert tone="alarm">{error}</InlineAlert>
        </div>
      ) : null}

      {phase === "denied" && (
        <div className="mt-3">
          <InlineAlert tone="warning">
            Camera and microphone access was blocked. You can allow it in your
            browser's address bar and try again, or skip this; it's optional.
          </InlineAlert>
        </div>
      )}

      {phase === "unsupported" && (
        <div className="mt-3">
          <InlineAlert tone="warning">
            This browser can't record video. You can skip this step; it's
            optional. Or finish setup on a phone or a recent desktop browser.
          </InlineAlert>
        </div>
      )}

      <div className="mt-4 flex items-center gap-3">
        {phase === "idle" || phase === "denied" || phase === "unsupported" ? (
          <Button
            variant="ghost"
            onClick={start}
            disabled={disabled || phase === "unsupported"}
          >
            Record a message
          </Button>
        ) : null}

        {phase === "recording" ? (
          <>
            <Button variant="primary" onClick={stop} disabled={disabled}>
              Stop
            </Button>
            <span className="text-app-subtle text-sm tabular-nums">
              Recording… {elapsed}s / {MAX_SECONDS}s
            </span>
          </>
        ) : null}

        {phase === "review" ? (
          <>
            <span className="text-ok text-sm font-medium">
              ✓ Saved. {who} will see this
            </span>
            <Button variant="quiet" onClick={start} disabled={disabled}>
              Re-record
            </Button>
            <Button variant="quiet" onClick={reset} disabled={disabled}>
              Remove
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
