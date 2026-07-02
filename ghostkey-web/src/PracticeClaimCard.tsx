/**
 * Owner-side "Practice claim" card (#223).
 *
 * Inheritance tools fail silently: a wrong email or a confused heir
 * only surfaces when the owner is gone. One click here sends the heir
 * a clearly-labelled rehearsal of the real claim. The practice token
 * lives in its own server column, so it can't reach key material or
 * move coins on any endpoint; the only thing the rehearsal can write
 * is "the practice was completed", which this card then shows forever.
 */
import { useState } from "react";

import { api, ApiError, type DrillStartView } from "./api";
import { Button, InlineAlert } from "./ui";

/** The drill fields of `VaultView`, split out so tests don't need a
 *  whole vault. */
export interface DrillProgress {
  drill_started_at?: string | null;
  drill_opened_at?: string | null;
  drill_completed_at?: string | null;
}

function fmtDay(rfc: string): string | null {
  const d = new Date(rfc);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** One line describing where the rehearsal stands, for the card and
 *  its tests. */
export function drillStatusLine(progress: DrillProgress, who: string): string {
  if (progress.drill_completed_at) {
    const when = fmtDay(progress.drill_completed_at);
    return when
      ? `${who} completed a practice claim on ${when}.`
      : `${who} completed a practice claim.`;
  }
  if (progress.drill_opened_at) {
    const when = fmtDay(progress.drill_opened_at);
    return when
      ? `${who} opened the practice link on ${when} but hasn't finished it.`
      : `${who} opened the practice link but hasn't finished it.`;
  }
  if (progress.drill_started_at) {
    const when = fmtDay(progress.drill_started_at);
    return when
      ? `Practice sent ${when}. ${who} hasn't opened it yet.`
      : `Practice sent. ${who} hasn't opened it yet.`;
  }
  return `See the claim work while you're here to help. ${who} gets a clearly-marked practice email and walks the real steps. Nothing can move.`;
}

type Stage = "idle" | "confirming" | "sending" | "sent";

export function PracticeClaimCard({
  vaultId,
  ownerToken,
  heirName,
  progress,
}: {
  vaultId: string;
  ownerToken: string | null;
  heirName?: string;
  progress: DrillProgress;
}) {
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<DrillStartView | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!ownerToken) return null;

  const who = heirName?.trim() ? heirName.trim() : "Your heir";
  // A just-sent drill beats whatever the vault fetch knew.
  const line =
    stage === "sent" && result
      ? drillStatusLine({ drill_started_at: result.started_at }, who)
      : drillStatusLine(progress, who);
  const completed = Boolean(progress.drill_completed_at) && stage !== "sent";
  const startedBefore = Boolean(progress.drill_started_at) || stage === "sent";

  async function onSend() {
    setStage("sending");
    setError(null);
    try {
      const view = await api.startDrill(vaultId, ownerToken!);
      setResult(view);
      setStage("sent");
    } catch (e) {
      setStage("confirming");
      setError(
        e instanceof ApiError && e.status === 409
          ? "A real claim is already underway on this vault, so a practice run isn't possible."
          : "Sending failed. Your vault is fine. Try again in a moment.",
      );
    }
  }

  return (
    <section className="card-flat p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Practice claim</h3>
          <p className="mt-1 text-sm text-muted">{line}</p>
          {completed ? (
            <p className="mt-1 text-xs text-muted">
              The real claim will look exactly like what they practiced.
            </p>
          ) : null}
        </div>
        {stage === "idle" ? (
          <div className="shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStage("confirming")}
            >
              {startedBefore || completed ? "Send again" : "Send a practice"}
            </Button>
          </div>
        ) : null}
      </div>

      {stage === "confirming" || stage === "sending" ? (
        <div className="mt-3">
          <InlineAlert tone="warning">
            <p className="text-sm">
              This emails {who} right now. The message says clearly that you
              are fine and that this is practice.
            </p>
          </InlineAlert>
          {error ? (
            <p className="mt-2 text-sm text-[var(--alarm)]">{error}</p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              onClick={() => void onSend()}
              disabled={stage === "sending"}
            >
              {stage === "sending" ? "Sending…" : `Email ${who} now`}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStage("idle");
                setError(null);
              }}
              disabled={stage === "sending"}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {stage === "sent" && result ? (
        <div className="mt-3">
          <InlineAlert tone="ok">
            <p className="text-sm">
              {result.heir_notified
                ? `On its way. You'll see it here when ${who} opens the link and when they finish.`
                : `We couldn't email ${who} automatically. Share this practice link with them yourself:`}
            </p>
            {!result.heir_notified ? (
              <p className="mt-2 break-all font-mono text-xs">
                {result.claim_url}
              </p>
            ) : null}
          </InlineAlert>
        </div>
      ) : null}
    </section>
  );
}
