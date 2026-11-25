/**
 * "Add GhostKey to your Home Screen", for iPhone and iPad only.
 *
 * Safari can erase a website's saved data after about a week without a
 * visit, unless it's on the Home Screen. GhostKey keeps your sign-in on
 * the device, so after that week it would ask for the email link again.
 * Installed, it doesn't. Android and desktop browsers don't do this, and
 * GhostKey asks them to keep its data (device.ts), so they get no card.
 * Dismissed for good with one tap.
 */
import { useState } from "react";

const DISMISSED_KEY = "gk:installNudgeDismissed";

export interface DeviceInfo {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** Already running from the Home Screen. */
  standalone: boolean;
}

/** Pure, so it's tested on its own. iPadOS reports a Mac platform but
 *  has touch. */
export function shouldNudgeInstall(d: DeviceInfo, dismissed: boolean): boolean {
  if (dismissed || d.standalone) return false;
  const iOS = /iPhone|iPad|iPod/.test(d.userAgent) || (d.platform === "MacIntel" && d.maxTouchPoints > 1);
  return iOS;
}

function readDevice(): DeviceInfo {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    userAgent: nav.userAgent ?? "",
    platform: nav.platform ?? "",
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: nav.standalone === true || window.matchMedia?.("(display-mode: standalone)")?.matches === true,
  };
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function InstallNudge() {
  const [show, setShow] = useState(() => {
    try {
      return shouldNudgeInstall(readDevice(), readDismissed());
    } catch {
      return false;
    }
  });
  if (!show) return null;
  return (
    <section className="card-flat mt-5 p-4" data-testid="install-nudge">
      <p className="text-sm font-medium">Add GhostKey to your Home Screen</p>
      <p className="mt-1 text-xs text-muted">
        On iPhone, Safari can forget your sign-in after a week without a visit. From the Home Screen it won&apos;t. Tap
        Share, then Add to Home Screen.
      </p>
      <button
        type="button"
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED_KEY, "1");
          } catch {
            /* ignore */
          }
          setShow(false);
        }}
        className="mt-2 text-xs text-muted underline-offset-2 hover:underline"
      >
        Done
      </button>
    </section>
  );
}
