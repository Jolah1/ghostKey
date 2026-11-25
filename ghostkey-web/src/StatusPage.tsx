/**
 * Public system-status page (#/status).
 *
 * Probes GET /health (server up, version, assist flag), the same
 * endpoint the app already uses, and renders it as plain-language
 * component rows.
 * No backend changes: the page is hosted on the web CDN, which is a
 * different provider than the API server, so it stays reachable
 * precisely when the API isn't.
 *
 * Tone matters more than telemetry here. The audience is a vault
 * owner who just saw an error and is wondering if their money is
 * gone. The page leads with the honest answer (what's up, what
 * isn't) and closes with the part GhostKey can always promise: the
 * bitcoin lives on the Bitcoin network, and the emergency recovery
 * file opens it without us.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import { usePolling } from "./ui";

type ApiState = "checking" | "up" | "down";
/** Row states beyond the API probe (the assist row uses "off" and "unknown"). */
type RowState = "checking" | "up" | "degraded" | "off" | "unknown";

interface Probe {
  api: ApiState;
  assistEnabled: boolean;
  version?: string;
  checkedAt?: Date;
}

const INITIAL: Probe = { api: "checking", assistEnabled: false };

async function runProbe(): Promise<Probe> {
  try {
    const h = await api.health();
    return {
      api: "up",
      assistEnabled: Boolean(h.assist_enabled),
      version: h.version,
      checkedAt: new Date(),
    };
  } catch {
    return {
      api: "down",
      assistEnabled: false,
      checkedAt: new Date(),
    };
  }
}

export function StatusPage() {
  const [probe, setProbe] = useState<Probe>(INITIAL);

  // First probe fires on mount — usePolling alone would leave the page
  // on "Checking…" for a full interval before the first result.
  useEffect(() => {
    let alive = true;
    void runProbe().then((p) => {
      if (alive) setProbe(p);
    });
    return () => {
      alive = false;
    };
  }, []);
  usePolling(async () => setProbe(await runProbe()), 15_000);

  const allGood = probe.api === "up";

  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-16 md:py-20">
        <p className="eyebrow-tag">System status</p>
        <h1 className="mt-3 font-serif text-4xl md:text-5xl">
          {probe.api === "checking"
            ? "Checking…"
            : allGood
              ? "Everything is running"
              : probe.api === "down"
                ? "GhostKey is having trouble"
                : "Partly degraded"}
        </h1>
        <p className="mt-3 text-muted" role="status" aria-live="polite">
          {probe.api === "down"
            ? "Our server isn't responding right now. Your bitcoin is not affected. See below."
            : "Live checks from your browser, refreshed every 15 seconds."}
          {probe.checkedAt && (
            <span className="text-dim">
              {" "}
              Last checked {probe.checkedAt.toLocaleTimeString()}.
            </span>
          )}
        </p>

        <ul role="list" className="mt-10 space-y-3">
          <StatusRow
            state="up"
            name="Website"
            detail="The pages you're looking at. Hosted separately from our server, so it stays up even when the server doesn't."
          />
          <StatusRow
            state={probe.api}
            name="Vault server"
            detail={
              probe.api === "down"
                ? "Not responding. Dashboards, reminders, and claim links are paused until it's back. Deadlines are not silently missed. The schedule resumes where it left off."
                : `Keeps your schedule, sends reminders, takes your check-ins, and watches deadlines.${probe.version ? ` Version ${probe.version}.` : ""}`
            }
          />
          <StatusRow
            state={probe.api === "up" ? (probe.assistEnabled ? "up" : "off") : "unknown"}
            name="Setup guide (AI chat)"
            detail={
              probe.assistEnabled
                ? "The chat helper on the setup page."
                : "The chat helper on the setup page. Optional. Setup works without it."
            }
          />
        </ul>

        <section className="card-flat mt-12 p-5">
          <h2 className="text-sm font-semibold">
            Even if every light on this page were red, your bitcoin is safe.
          </h2>
          <p className="mt-1.5 text-sm text-muted">
            Your money never lives on these servers. It sits on the Bitcoin
            network, locked by keys, not by our uptime. Your emergency
            recovery file opens it with just your password. No GhostKey
            required. That's the whole point.
          </p>
        </section>

        <p className="mt-8 text-sm text-dim">
          Something look wrong for more than a few minutes? Email{" "}
          <a className="underline" href="mailto:support@ghostkeyapp.com">
            support@ghostkeyapp.com
          </a>{" "}
          or open an issue on{" "}
          <a
            className="underline"
            href="https://github.com/Jolah1/ghostKey/issues"
            target="_blank"
            rel="noreferrer noopener"
          >
            GitHub
          </a>
          .
        </p>
      </div>
    </main>
  );
}

/* ------------------------------- StatusRow -------------------------------- */

function StatusRow({
  state,
  name,
  detail,
}: {
  state: ApiState | RowState;
  name: string;
  detail: string;
}) {
  const { dot, label } = badge(state);
  return (
    <li className="card-flat flex items-start gap-3 p-4">
      <span
        aria-hidden="true"
        className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${dot}`}
      />
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          {name}
          <span className="ml-2 font-normal text-dim">{label}</span>
        </p>
        <p className="mt-0.5 text-sm text-muted">{detail}</p>
      </div>
    </li>
  );
}

function badge(state: ApiState | RowState): { dot: string; label: string } {
  switch (state) {
    case "up":
      return { dot: "bg-ok", label: "Up" };
    case "down":
      return { dot: "bg-alarm", label: "Down" };
    case "degraded":
      return { dot: "bg-warning", label: "Having trouble" };
    case "off":
      return { dot: "bg-[var(--text-dim)]", label: "Not enabled" };
    case "unknown":
      return { dot: "bg-[var(--text-dim)]", label: "Unknown" };
    case "checking":
      return { dot: "bg-[var(--text-dim)]", label: "Checking…" };
  }
}
