/**
 * Secondary vault pages, one per tool that used to crowd the dashboard:
 * the heir message, the practice run, emergency options, and reminders.
 *
 * Each is a thin wrapper: `useActiveVault()` loads the vault, a shared
 * shell draws the back link + title, and the existing card component does
 * the real work. Keeping the dashboard to status + money + heir was the
 * goal; these pages are one tap away from it.
 */
import { useEffect, useState, type ReactNode } from "react";

import type { Route } from "./App";
import { api, ApiError } from "./api";
import { useActiveVault } from "./useActiveVault";
import { useToolDoneState } from "./toolStatus";
import { VideoMessageCard } from "./VideoMessageCard";
import { PracticeClaimCard, type HeirChannel } from "./PracticeClaimCard";
import { PanicCard, PushOptInCard } from "./Dashboard";
import { Button, Field, Tile, InlineAlert } from "./ui";
import {
  useChannelCapability,
  CHANNEL_UNAVAILABLE_NOTE,
} from "./useChannelCapability";
import {
  HEIR_CHANNELS,
  contactShapeError,
  type HeirContactChannel,
} from "./heirChannels";

function ToolPage({
  title,
  intro,
  onNavigate,
  children,
}: {
  title: string;
  intro?: string;
  onNavigate: (r: Route) => void;
  children: ReactNode;
}) {
  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-10 md:py-14">
        <button
          type="button"
          onClick={() => onNavigate("dashboard")}
          className="text-sm text-muted underline hover:text-[var(--text)]"
        >
          ← Back to dashboard
        </button>
        <h1 className="mt-4 font-serif text-3xl">{title}</h1>
        {intro ? <p className="mt-2 text-sm text-muted">{intro}</p> : null}
        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}

/** Shared "no vault / still loading / nothing to show" fallback body. */
function Fallback({
  loading,
  hasVault,
  emptyText,
  onNavigate,
}: {
  loading: boolean;
  hasVault: boolean;
  emptyText: string;
  onNavigate: (r: Route) => void;
}) {
  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  if (!hasVault) {
    return (
      <div>
        <p className="text-sm text-muted">
          Open your dashboard first to use this.
        </p>
        <div className="mt-4">
          <Button onClick={() => onNavigate("dashboard")}>
            Go to dashboard
          </Button>
        </div>
      </div>
    );
  }
  return <p className="text-sm text-muted">{emptyText}</p>;
}

interface PageProps {
  onNavigate: (r: Route) => void;
}

export function HeirMessagePage({ onNavigate }: PageProps) {
  const { meta, ownerToken, vault, loading } = useActiveVault();
  const ready = Boolean(meta && vault && vault.status !== "claimed");
  return (
    <ToolPage
      title="Message for your heir"
      intro="A short video only your heir can unlock. Proof the claim link is really from you."
      onNavigate={onNavigate}
    >
      {ready && meta ? (
        <VideoMessageCard
          vaultId={meta.id}
          ownerToken={ownerToken}
          heirName={meta.heir.name}
        />
      ) : (
        <Fallback
          loading={loading}
          hasVault={Boolean(meta)}
          emptyText="A message isn't available once a vault is closed."
          onNavigate={onNavigate}
        />
      )}
    </ToolPage>
  );
}

export function PracticeRunPage({ onNavigate }: PageProps) {
  const { meta, ownerToken, vault, loading } = useActiveVault();
  // The card's copy names the channel the practice actually travels on
  // (email, text, WhatsApp), which only the server's heir profile knows.
  const [heirChannel, setHeirChannel] = useState<HeirChannel>(undefined);
  useEffect(() => {
    if (!meta?.id || !ownerToken) return;
    let alive = true;
    api
      .getVaultHeir(meta.id, ownerToken)
      .then((h) => {
        if (alive) setHeirChannel((h.channel as HeirChannel) ?? null);
      })
      .catch(() => {
        /* unknown channel keeps the generic wording */
      });
    return () => {
      alive = false;
    };
  }, [meta?.id, ownerToken]);
  const isClaiming =
    vault?.status === "timelock_started" || vault?.status === "claiming";
  const ready = Boolean(meta && vault && vault.status !== "claimed" && !isClaiming);
  return (
    <ToolPage
      title="Practice a claim"
      intro="Let your heir rehearse the real claim while you're here. No money moves, nothing changes."
      onNavigate={onNavigate}
    >
      {ready && meta && vault ? (
        <PracticeClaimCard
          vaultId={meta.id}
          ownerToken={ownerToken}
          heirName={meta.heir.name}
          heirChannel={heirChannel}
          progress={vault}
        />
      ) : (
        <Fallback
          loading={loading}
          hasVault={Boolean(meta)}
          emptyText="Practice runs pause once a claim is underway."
          onNavigate={onNavigate}
        />
      )}
    </ToolPage>
  );
}

export function EmergencyPage({ onNavigate }: PageProps) {
  const { vault, loading, meta } = useActiveVault();
  const isClaiming =
    vault?.status === "timelock_started" || vault?.status === "claiming";
  const ready = Boolean(
    vault?.lnurl_panic &&
      vault.status !== "frozen" &&
      vault.status !== "claimed" &&
      !isClaiming,
  );
  return (
    <ToolPage
      title="Emergency options"
      intro="If your wallet is ever compromised, freeze this vault so no claim can proceed."
      onNavigate={onNavigate}
    >
      {ready && vault?.lnurl_panic ? (
        <PanicCard
          lnurl={vault.lnurl_panic}
          hasTrustedContact={Boolean(vault.has_trusted_contact)}
        />
      ) : (
        <Fallback
          loading={loading}
          hasVault={Boolean(meta)}
          emptyText="Emergency freeze isn't available for this vault right now."
          onNavigate={onNavigate}
        />
      )}
    </ToolPage>
  );
}

/**
 * The permanent home for every vault tool, linked from the nav.
 * The dashboard's More list only shows tools that still need doing;
 * once a video is saved, a practice is sent, or reminders are on,
 * this page is where the owner comes back to review or change them.
 */
export function ToolsPage({ onNavigate }: PageProps) {
  const { meta, ownerToken, vault, pushKey, loading } = useActiveVault();
  const done = useToolDoneState(meta?.id ?? null, ownerToken);
  const isClaiming =
    vault?.status === "timelock_started" || vault?.status === "claiming";
  const isClosed = vault?.status === "claimed";

  const items: Array<{ label: string; desc: string; route: Route }> = [];
  if (vault && !isClosed) {
    items.push({
      label: "Message for your heir",
      desc:
        done.hasVideo === true
          ? "Video saved. Watch, replace, or remove it"
          : "Record a short video for your heir",
      route: "heir-message",
    });
  }
  if (vault && !isClosed) {
    items.push({
      label: "How your heir is reached",
      desc: "Change their contact or the way we reach them",
      route: "heir-contact",
    });
  }
  if (vault && !isClosed && !isClaiming) {
    items.push({
      label: "Practice a claim",
      desc: vault.drill_completed_at
        ? "Completed. Send another any time"
        : vault.drill_started_at
          ? "Practice sent. See where it stands"
          : "Let your heir rehearse safely",
      route: "practice",
    });
  }
  if (vault && ownerToken && pushKey && !isClosed) {
    items.push({
      label: "Reminders",
      desc:
        done.remindersOn === true
          ? "On for this device"
          : "Get a nudge to check in",
      route: "reminders",
    });
  }
  if (vault?.lnurl_panic && vault.status !== "frozen" && !isClosed && !isClaiming) {
    items.push({
      label: "Emergency options",
      desc: "Freeze this vault if needed",
      route: "emergency",
    });
  }

  return (
    <ToolPage
      title="Vault tools"
      intro="Everything you can set up or check for this vault, in one place."
      onNavigate={onNavigate}
    >
      {items.length > 0 ? (
        <nav
          className="card-flat divide-y divide-[var(--border)] p-0"
          aria-label="Vault tools"
        >
          {items.map((it) => (
            <button
              key={it.route}
              type="button"
              onClick={() => onNavigate(it.route)}
              className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-[var(--surface-2)]"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-[var(--text)]">
                  {it.label}
                </span>
                <span className="block truncate text-xs text-muted">
                  {it.desc}
                </span>
              </span>
              <span aria-hidden="true" className="shrink-0 text-lg text-dim">
                ›
              </span>
            </button>
          ))}
        </nav>
      ) : (
        <Fallback
          loading={loading}
          hasVault={Boolean(meta)}
          emptyText="No tools apply to this vault right now."
          onNavigate={onNavigate}
        />
      )}
    </ToolPage>
  );
}

export function RemindersPage({ onNavigate }: PageProps) {
  const { meta, ownerToken, vault, pushKey, loading } = useActiveVault();
  const ready = Boolean(meta && ownerToken && pushKey && vault?.status !== "claimed");
  return (
    <ToolPage
      title="Reminders"
      intro="Get a nudge on this device when it's time to check in, so you never miss it."
      onNavigate={onNavigate}
    >
      {ready && meta && ownerToken && pushKey ? (
        <PushOptInCard
          vaultId={meta.id}
          ownerToken={ownerToken}
          vapidPublicKey={pushKey}
        />
      ) : (
        <Fallback
          loading={loading}
          hasVault={Boolean(meta)}
          emptyText="Reminders aren't available on this device or server."
          onNavigate={onNavigate}
        />
      )}
    </ToolPage>
  );
}

/**
 * Title for the heir-contact editor.
 *
 * The page edits whichever vault is active, and an owner with several
 * heirs has no other way to tell which one they're about to rewrite —
 * the address typed here is where a real claim link goes (#315). Name
 * the heir whenever we know it.
 */
/** Swap the domain of an address, keeping the local part exactly as
 *  typed. Used to accept a "did you mean" suggestion in one tap — the
 *  alternative is asking someone to retype an address they already got
 *  wrong once. */
export function swapDomain(address: string, domain: string): string {
  const at = address.trim().lastIndexOf("@");
  if (at <= 0) return address;
  return `${address.trim().slice(0, at)}@${domain}`;
}

export function heirContactTitle(heirName?: string | null): string {
  const name = heirName?.trim();
  return name ? `How ${name} is reached` : "How your heir is reached";
}

/**
 * Why the editor is refusing, in the owner's words.
 *
 * Every blocked case used to read "This isn't available once a claim is
 * underway", including the common one where the browser simply holds no
 * owner credential — which sent an owner hunting for a claim that wasn't
 * happening (#315).
 */
export function heirContactBlockedReason({
  hasOwnerToken,
  status,
}: {
  hasOwnerToken: boolean;
  status?: string | null;
}): string {
  if (!hasOwnerToken) {
    return "This browser isn't signed in as the owner of this vault, so it can't change how the heir is reached. Sign in on the device you set the vault up on.";
  }
  if (status === "claimed") {
    return "This vault is closed, so there's nobody left to reach.";
  }
  return "This isn't available once a claim is underway.";
}

export function HeirContactPage({ onNavigate }: PageProps) {
  const { meta, ownerToken, vault, loading } = useActiveVault();
  const isClaiming =
    vault?.status === "timelock_started" || vault?.status === "claiming";
  const ready = Boolean(
    meta && ownerToken && vault?.status !== "claimed" && !isClaiming,
  );
  return (
    <ToolPage
      title={heirContactTitle(meta?.heir.name)}
      intro="Change their contact or the way we reach them. They're only ever contacted if you stop checking in."
      onNavigate={onNavigate}
    >
      {ready && meta && ownerToken ? (
        <HeirContactCard vaultId={meta.id} ownerToken={ownerToken} />
      ) : (
        <Fallback
          loading={loading}
          hasVault={Boolean(meta)}
          emptyText={heirContactBlockedReason({
            hasOwnerToken: Boolean(ownerToken),
            status: vault?.status,
          })}
          onNavigate={onNavigate}
        />
      )}
    </ToolPage>
  );
}

function HeirContactCard({
  vaultId,
  ownerToken,
}: {
  vaultId: string;
  ownerToken: string;
}) {
  const [channel, setChannel] = useState<HeirContactChannel>("email");
  const [contact, setContact] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  // Prefill state: until the current profile loads we don't want the
  // owner typing into a field that's about to be overwritten.
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getVaultHeir(vaultId, ownerToken)
      .then((h) => {
        if (!alive) return;
        if (h.channel === "sms" || h.channel === "whatsapp" || h.channel === "email") {
          setChannel(h.channel);
        }
        if (h.contact) setContact(h.contact);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [vaultId, ownerToken]);

  const meta = HEIR_CHANNELS.find((c) => c.id === channel) ?? HEIR_CHANNELS[0];
  const cap = useChannelCapability();

  async function save() {
    const trimmed = contact.trim();
    if (!trimmed) {
      setError(channel === "email" ? "Enter their email." : "Enter their phone number.");
      return;
    }
    const shapeError = contactShapeError(channel, trimmed);
    if (shapeError) {
      setError(shapeError);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const saved = await api.updateVaultHeir(vaultId, ownerToken, {
        contact: trimmed,
        channel,
      });
      // Re-sync the inputs to what the server actually stored (it trims and
      // re-seals), so the fields match the saved state exactly.
      if (
        saved.channel === "sms" ||
        saved.channel === "whatsapp" ||
        saved.channel === "email"
      ) {
        setChannel(saved.channel);
      }
      if (saved.contact) setContact(saved.contact);
      setSaved(true);
    } catch (e) {
      // The server refuses an address change on easy-setup vaults, where
      // the heir's key is tied to their email. Surface its message plainly.
      setError(
        e instanceof ApiError && e.message
          ? e.message
          : "Couldn't save that. Check your connection and try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return <p className="text-sm text-muted">Loading…</p>;
  }

  return (
    <div className="card-flat p-5">
      <Field label="How should we reach them">
        <div className="grid grid-cols-3 gap-2">
          {HEIR_CHANNELS.map((c) => (
            <Tile
              key={c.id}
              title={c.title}
              sub={cap[c.id] ? c.sub : CHANNEL_UNAVAILABLE_NOTE}
              selected={channel === c.id}
              onClick={() => {
                setChannel(c.id);
                setSaved(false);
                setError(null);
              }}
              disabled={!cap[c.id]}
            />
          ))}
        </div>
        {/* An existing vault may already sit on a channel this server
            can't deliver (#277) — the exact silent failure that stranded
            a WhatsApp heir for 5 days. Say it here, where it can be
            fixed, instead of at claim time when it can't. */}
        {!cap[channel] ? (
          <div className="mt-3">
            <InlineAlert tone="warning">
              This server can't send {meta.title} messages right now, so
              nothing will reach them this way. Switch to a channel that
              works, or messages to your heir won't be delivered.
            </InlineAlert>
          </div>
        ) : null}
      </Field>

      <Field
        label={channel === "email" ? "Their email" : "Their phone number"}
        hint="Stored encrypted. We don't message them unless you stop checking in."
        error={error}
      >
        <input
          type={channel === "email" ? "email" : "tel"}
          value={contact}
          onChange={(e) => {
            setContact(e.target.value);
            setSaved(false);
            setError(null);
            setSuggestion(null);
          }}
          onBlur={async () => {
            // Advisory only, and deliberately never blocking: if the
            // check fails or the server is old, the owner saves exactly
            // as before.
            if (channel !== "email" || !contact.includes("@")) return;
            try {
              const r = await api.checkContact(contact);
              setSuggestion(r.suggestion);
            } catch {
              setSuggestion(null);
            }
          }}
          placeholder={meta.placeholder}
          autoComplete="off"
          inputMode={channel === "email" ? "email" : "tel"}
          className="input"
        />
      </Field>

      {/* A typo in an heir's address stays invisible until the claim
          link fires, which is the one moment nobody can fix it. Every
          address on our bounce list has been a misspelling. Ask now.
          Never blocks the save: it is a question, not a verdict, and
          gmial.com is a real domain that accepts mail. */}
      {suggestion ? (
        <div className="mb-4">
          <InlineAlert tone="warning">
            Did you mean{" "}
            <button
              type="button"
              className="underline font-medium"
              onClick={() => {
                setContact(swapDomain(contact, suggestion));
                setSuggestion(null);
                setSaved(false);
              }}
            >
              {swapDomain(contact, suggestion)}
            </button>
            ? If not, carry on and save.
          </InlineAlert>
        </div>
      ) : null}

      {saved ? (
        <div className="mb-4">
          <InlineAlert tone="ok">Saved. This is how we'll reach them.</InlineAlert>
        </div>
      ) : null}

      {/* Once saved, there is nothing left to save until the owner edits
          something — both inputs clear `saved` on change. Leaving a live
          Save button next to a "Saved" banner reads as though the save
          didn't take, and re-pressing it re-seals the same blob. */}
      <Button onClick={save} disabled={saving || saved}>
        {saving ? "Saving…" : saved ? "Saved" : "Save"}
      </Button>
    </div>
  );
}
