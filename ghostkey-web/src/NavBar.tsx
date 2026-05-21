/**
 * Top navigation bar. Always visible on every view.
 *
 * Items (left to right): brand · Set up · I'm OK today · Inherit · Connect wallet.
 *
 * Mobile: brand + hamburger; menu opens as a sheet under the bar.
 */
import { useEffect, useState } from "react";
import { Menu, X, Wallet, Sparkles, Heart, HandHeart } from "lucide-react";
import { Brand } from "./Brand";
import type { Route } from "./App";
import { ApiError } from "./api";
import { WalletError, connect, hasProvider, type WalletIdentity } from "./wallet";

interface Props {
  route: Route;
  onNavigate: (r: Route) => void;
  wallet: WalletIdentity | null;
  onWalletChange: (w: WalletIdentity | null) => void;
}

interface NavItem {
  key: Route;
  label: string;
  icon: typeof Sparkles;
}

const ITEMS: NavItem[] = [
  { key: "setup",   label: "Set up",          icon: Sparkles },
  { key: "checkin", label: "I'm OK today",    icon: Heart },
  { key: "inherit", label: "Inherit",         icon: HandHeart },
];

export function NavBar({ route, onNavigate, wallet, onWalletChange }: Props) {
  const [open, setOpen] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  // Auto-close mobile menu when the route changes.
  useEffect(() => {
    setOpen(false);
  }, [route]);

  async function onConnect() {
    setWalletBusy(true);
    setWalletError(null);
    try {
      if (wallet) {
        onWalletChange(null);
        return;
      }
      const id = await connect();
      onWalletChange(id);
    } catch (e) {
      const msg =
        e instanceof WalletError || e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      setWalletError(msg);
    } finally {
      setWalletBusy(false);
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-ink/5 bg-cream/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-3.5">
        <Brand size="sm" onClick={() => onNavigate("landing")} />

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {ITEMS.map((item) => {
            const Icon = item.icon;
            const active = item.key === route;
            return (
              <button
                key={item.key}
                onClick={() => onNavigate(item.key)}
                className={`nav-link inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 ${
                  active ? "nav-link-active bg-ink/5" : ""
                }`}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Wallet button (desktop) + hamburger (mobile) */}
        <div className="flex items-center gap-2">
          <button
            onClick={onConnect}
            disabled={walletBusy}
            className={`hidden md:inline-flex ${
              wallet ? "btn-outline" : "btn-primary"
            }`}
            title={wallet ? "Disconnect" : "Connect a Lightning wallet"}
          >
            <Wallet className="h-4 w-4" />
            {walletBusy ? "Connecting…" : wallet ? truncate(wallet.alias, 12) : "Connect wallet"}
          </button>

          <button
            onClick={() => setOpen((v) => !v)}
            className="btn-outline !rounded-full !px-3 md:hidden"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label="Open menu"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Wallet error toast (under the bar) */}
      {walletError && (
        <div className="mx-auto max-w-6xl px-5 pb-3">
          <div className="rounded-xl border border-bitcoin/30 bg-bitcoin-50 px-3 py-2 text-xs text-bitcoin-900">
            <p className="font-semibold">{walletError}</p>
            {!hasProvider() && (
              <p className="mt-1 text-bitcoin-800/80">
                Install{" "}
                <a
                  href="https://getalby.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Alby
                </a>{" "}
                or another Lightning browser wallet to connect.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Mobile sheet */}
      {open && (
        <div
          id="mobile-menu"
          className="border-t border-ink/5 bg-cream md:hidden"
        >
          <nav className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-3">
            {ITEMS.map((item) => {
              const Icon = item.icon;
              const active = item.key === route;
              return (
                <button
                  key={item.key}
                  onClick={() => onNavigate(item.key)}
                  className={`inline-flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium ${
                    active ? "bg-ink/5 text-ink" : "text-ink-500"
                  }`}
                >
                  <Icon className="h-4 w-4" strokeWidth={2.25} />
                  {item.label}
                </button>
              );
            })}
            <button
              onClick={onConnect}
              disabled={walletBusy}
              className={`mt-2 ${wallet ? "btn-outline" : "btn-primary"}`}
            >
              <Wallet className="h-4 w-4" />
              {walletBusy
                ? "Connecting…"
                : wallet
                  ? `Disconnect ${truncate(wallet.alias, 14)}`
                  : "Connect wallet"}
            </button>
          </nav>
        </div>
      )}
    </header>
  );
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
