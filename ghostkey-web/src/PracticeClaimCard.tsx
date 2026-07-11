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
import { useVocab } from "./vocab";
import { type PracticeCardVocab } from "./vocab/types";

/**
 * Practice token storage — the server stores the practice token in a
 * separate database column from the real claim token, so the server
 * refuses it on every endpoint that could reveal keys or move coins.
 * The only thing this token can write is "the practice was completed".
 *
 * Because practice data never holds or references key material, there
 * is no way for a practice request to access keys, sign transactions,
 * or move coins — even if the component or server logic had a bug.
 */
export interface DrillProgress {
  drill_started_at?: string | null;
  drill_opened_at?: string | null;
  drill_completed_at?: string | null;
}

/** How the practice notification was sent (email, SMS, WhatsApp, or
 *  unknown). Used to pick the correct noun for the status line so the
 *  owner sees "practice email" vs "practice text message" vs the
 *  generic fallback. */
export type HeirChannel = "email" | "sms" | "whatsapp" | null | undefined;

function practiceNoun(channel: HeirChannel, pc: PracticeCardVocab): string {
  switch (channel) {
    case "email":
      return pc.practiceNounEmail;
    case "sms":
      return pc.practiceNounSms;
    case "whatsapp":
      return pc.practiceNounWhatsapp;
    default:
      return pc.practiceNounDefault;
  }
}

function sendWords(channel: HeirChannel, who: string, pc: PracticeCardVocab): {
  alert: string;
  button: string;
} {
  switch (channel) {
    case "email":
      return { alert: pc.sendWordsEmailAlert(who), button: pc.sendWordsEmailButton(who) };
    case "sms":
      return { alert: pc.sendWordsSmsAlert(who), button: pc.sendWordsSmsButton(who) };
    case "whatsapp":
      return {
        alert: pc.sendWordsWhatsappAlert(who),
        button: pc.sendWordsWhatsappButton(who),
      };
    default:
      return {
        alert: pc.sendWordsDefaultAlert(who),
        button: pc.sendWordsDefaultButton(who),
      };
  }
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
export function drillStatusLine(
  progress: DrillProgress,
  who: string,
  channel: HeirChannel = undefined,
  pc: PracticeCardVocab,
): string {
  if (progress.drill_completed_at) {
    const when = fmtDay(progress.drill_completed_at);
    return pc.lineCompleted(who, when);
  }
  if (progress.drill_opened_at) {
    const when = fmtDay(progress.drill_opened_at);
    return pc.lineOpened(who, when);
  }
  if (progress.drill_started_at) {
    const when = fmtDay(progress.drill_started_at);
    return pc.lineSent(who, when);
  }
  const noun = practiceNoun(channel, pc);
  return pc.lineIdle(who, noun);
}

type Stage = "idle" | "confirming" | "sending" | "sent";

export function PracticeClaimCard({
  vaultId,
  ownerToken,
  heirName,
  heirChannel,
  progress,
}: {
  vaultId: string;
  ownerToken: string | null;
  heirName?: string;
  heirChannel?: HeirChannel;
  progress: DrillProgress;
}) {
  const v = useVocab();
  const pc = v.practiceCard;
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<DrillStartView | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!ownerToken) return null;

  const who = heirName?.trim() ? heirName.trim() : "Your heir";
  // A just-sent drill beats whatever the vault fetch knew.
  const line =
    stage === "sent" && result
      ? drillStatusLine({ drill_started_at: result.started_at }, who, heirChannel, pc)
      : drillStatusLine(progress, who, heirChannel, pc);
  const send = sendWords(heirChannel, who, pc);
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
          ? pc.errorRealClaimUnderway
          : pc.errorSendingFailed,
      );
    }
  }

  return (
    <section className="card-flat p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{pc.title}</h3>
          <p className="mt-1 text-sm text-muted">{line}</p>
          {completed ? (
            <p className="mt-1 text-xs text-muted">
              {pc.realClaimLooksSame}
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
              {startedBefore || completed ? pc.sendAgain : pc.sendPractice}
            </Button>
          </div>
        ) : null}
      </div>

      {stage === "confirming" || stage === "sending" ? (
        <div className="mt-3">
          <InlineAlert tone="warning">
            <p className="text-sm">
              {pc.confirmAlert(send.alert)}
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
              {stage === "sending" ? pc.sending : send.button}
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
              {pc.cancel}
            </Button>
          </div>
        </div>
      ) : null}

      {stage === "sent" && result ? (
        <div className="mt-3">
          <InlineAlert tone="ok">
            <p className="text-sm">
              {result.heir_notified
                ? pc.sentNotified(who)
                : pc.sentNotNotified(who)}
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
