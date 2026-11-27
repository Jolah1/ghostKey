/**
 * Secondary vault pages, one per tool that used to crowd the dashboard:
 * the heir message, the practice run, emergency options, and reminders.
 *
 * Each is a thin wrapper: `useActiveVault()` loads the vault, a shared
 * shell draws the back link + title, and the existing card component does
 * the real work. Keeping the dashboard to status + money + heir was the
 * goal; these pages are one tap away from it.
 */
import { useEffect, useState } from "react";

import type { Route } from "./App";
import { api, ApiError } from "./api";
import { ShowHeirCodeCard } from "./HeirCodeCard";
import { useActiveVault } from "./useActiveVault";
import { getVaultOwnerToken, getVaultsByGroup } from "./vaultStore";
import { PageShell } from "./PageShell";
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

/** Every page here is opened from Inheritance, so back goes there. */
function ToolPage(props: Omit<Parameters<typeof PageShell>[0], "onBack" | "backLabel">) {
  return (
    <PageShell {...props} onBack={() => props.onNavigate("tools")} backLabel="Back to inheritance" />
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
          emptyText="A message isn't available once the share is claimed."
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
  const { vault, loading, meta, ownerToken } = useActiveVault();
  const [contactChanged, setHasContact] = useState<boolean | null>(null);
  const hasContact = contactChanged ?? Boolean(vault?.has_trusted_contact);
  const isClaiming =
    vault?.status === "timelock_started" || vault?.status === "claiming";
  const ready = Boolean(
    vault &&
      vault.status !== "frozen" &&
      vault.status !== "claimed" &&
      !isClaiming,
  );
  return (
    <ToolPage
      title="Something feel wrong?"
      intro="Freeze your vault if you think someone has your password or device."
      onNavigate={onNavigate}
    >
      {ready && vault ? (
        <>
          <PanicCard
            vaultId={vault.id}
            ownerToken={ownerToken}
            hasTrustedContact={hasContact}
            onMoveAll={() => onNavigate("send")}
          />
          <EmergencyContactCard
            vaultIds={meta?.groupId ? getVaultsByGroup(meta.groupId).map((m) => m.id) : [vault.id]}
            hasContact={hasContact}
            onChange={setHasContact}
          />
        </>
      ) : (
        <Fallback
          loading={loading}
          hasVault={Boolean(meta)}
          emptyText="Emergency freeze isn't available for this share right now."
          onNavigate={onNavigate}
        />
      )}
    </ToolPage>
  );
}

/** The emergency contact: who we email if the owner freezes their
 *  savings. The server keeps it sealed and never sends it back, so this
 *  says only whether one is on file. Saved to every share in the account. */
function EmergencyContactCard({
  vaultIds,
  hasContact,
  onChange,
}: {
  vaultIds: string[];
  hasContact: boolean;
  onChange: (has: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(contact: string | null) {
    setBusy(true);
    setError(null);
    try {
      for (const id of vaultIds) {
        await api.setTrustedContact(id, getVaultOwnerToken(id), contact);
      }
      onChange(contact !== null);
      setEditing(false);
      setEmail("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card-flat mt-6 p-5" data-testid="emergency-contact">
      <h2 className="font-medium">Emergency contact</h2>
      <p className="mt-1 text-sm text-muted">
        If you ever freeze your savings, we email this person to check on you.
      </p>
      {editing || !hasContact ? (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) void save(email.trim());
          }}
        >
          <input
            type="email"
            aria-label="Their email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Their email"
            autoComplete="off"
            className="input w-full"
          />
          <div className="mt-3 flex gap-2">
            <Button type="submit" size="sm" disabled={!email.trim()} loading={busy}>
              Save
            </Button>
            {editing ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-sm">Someone is on file.</p>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Change
          </Button>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void save(null)}>
            Remove
          </Button>
        </div>
      )}
      {error ? (
        <p className="mt-3 text-sm text-alarm" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The permanent home for every vault tool, linked from the nav.
 * The dashboard's More list only shows tools that still need doing;
 * once a video is saved, a practice is sent, or reminders are on,
 * this page is where the owner comes back to review or change them.
 */

export function RemindersPage({ onNavigate }: PageProps) {
  const { meta, ownerToken, vault, pushKey, loading } = useActiveVault();
  const ready = Boolean(meta && ownerToken && pushKey && vault?.status !== "claimed");
  return (
    <ToolPage
      title="Check-in reminders"
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
    return "This share is claimed, so there's nobody left to reach.";
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
        <>
          <HeirContactCard vaultId={meta.id} ownerToken={ownerToken} />
          <ShowHeirCodeCard vaultId={meta.id} ownerToken={ownerToken} heirName={meta.heir.name} />
        </>
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
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getVaultHeir(vaultId, ownerToken)
      .then((h) => {
        if (!alive) return;
        setVerifiedAt(h.contact_verified_at ?? null);
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
      // The server voids the proof when the address changes, so mirror
      // whatever it just told us rather than assuming.
      setVerifiedAt(saved.contact_verified_at ?? null);
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

  // Only channels this server can deliver, plus the current one if it
  // can't (so the warning below has something to point at). With just
  // email left, there's nothing to pick.
  const shownChannels = HEIR_CHANNELS.filter((c) => cap[c.id] || c.id === channel);

  return (
    <div className="card-flat p-5">
      {shownChannels.length > 1 ? (
      <Field label="How should we reach them">
        <div className="grid grid-cols-3 gap-2">
          {shownChannels.map((c) => (
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
      ) : null}

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

      {/* Whether we have ever actually reached this address (#327).
          Deliberately not phrased as a warning when unconfirmed: most
          vaults are unconfirmed simply because the owner hasn't run a
          practice yet, and crying wolf here would train them to ignore
          the badge that matters. */}
      {loaded ? (
        <p className="mb-4 text-sm text-muted">
          {verifiedAt ? (
            <>
              Confirmed: something we sent was delivered to this address on{" "}
              {new Date(verifiedAt).toLocaleDateString()}.
            </>
          ) : (
            <>
              We haven't reached this address yet, so we can't promise a typo
              would show up. A practice run confirms it.
            </>
          )}
        </p>
      ) : null}

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
