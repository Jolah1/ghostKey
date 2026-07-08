import { useState } from "react";

import { api, ApiError, type DrillStartView } from "./api";
import { Button, InlineAlert } from "./ui";
import { useVocab } from "./vocab";
import { type PracticeCardVocab } from "./vocab/types";

export interface DrillProgress {
  drill_started_at?: string | null;
  drill_opened_at?: string | null;
  drill_completed_at?: string | null;
}

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

export function drillStatusLine(
  progress: DrillProgress,
  who: string,
  channel?: HeirChannel,
  pc?: PracticeCardVocab,
): string {
  if (progress.drill_completed_at) {
    const when = fmtDay(progress.drill_completed_at);
    return pc
      ? pc.lineCompleted(who, when)
      : `${who} completed a practice claim${when ? ` on ${when}` : ""}.`;
  }
  if (progress.drill_opened_at) {
    const when = fmtDay(progress.drill_opened_at);
    return pc
      ? pc.lineOpened(who, when)
      : `${who} opened the practice link${when ? ` on ${when}` : ""} but hasn't finished it.`;
  }
  if (progress.drill_started_at) {
    const when = fmtDay(progress.drill_started_at);
    return pc
      ? pc.lineSent(who, when)
      : `Practice sent${when ? ` ${when}` : ""}. ${who} hasn't opened it yet.`;
  }
  if (pc) {
    const noun = practiceNoun(channel, pc);
    return pc.lineIdle(who, noun);
  }
  const legacyNoun = (() => {
    switch (channel) {
      case "email": return "practice email";
      case "sms": return "practice text message";
      case "whatsapp": return "practice WhatsApp message";
      default: return "practice message";
    }
  })();
  return `See the claim work while you're here to help. ${who} gets a clearly-marked ${legacyNoun} and walks the real steps. Nothing can move.`;
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
