/**
 * Shared "is this set-once tool already done?" signals.
 *
 * The dashboard uses them to hide finished tools from its More list
 * (a recorded video or an enabled reminder doesn't need a dashboard
 * slot forever); the Tools page uses the same signals to show where
 * each tool stands. `null` means unknown (fetch failed, no session,
 * unsupported browser) — callers treat unknown as not-done so the
 * tool stays reachable rather than vanishing on a hiccup.
 */
import { useEffect, useState } from "react";

import { api } from "./api";
import { getPushSubscription } from "./push";

export interface ToolDoneState {
  /** A heir video message is saved on the server. */
  hasVideo: boolean | null;
  /** This device holds a live push subscription. */
  remindersOn: boolean | null;
}

export function useToolDoneState(
  vaultId: string | null,
  ownerToken: string | null,
): ToolDoneState {
  const [hasVideo, setHasVideo] = useState<boolean | null>(null);
  const [remindersOn, setRemindersOn] = useState<boolean | null>(null);

  useEffect(() => {
    if (!vaultId || !ownerToken) {
      setHasVideo(null);
      return;
    }
    let alive = true;
    api
      .getVideoStatus(vaultId, ownerToken)
      .then((v) => {
        if (alive) setHasVideo(v.has_video);
      })
      .catch(() => {
        if (alive) setHasVideo(null);
      });
    return () => {
      alive = false;
    };
  }, [vaultId, ownerToken]);

  useEffect(() => {
    let alive = true;
    getPushSubscription()
      .then((s) => {
        if (alive) setRemindersOn(Boolean(s));
      })
      .catch(() => {
        if (alive) setRemindersOn(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { hasVideo, remindersOn };
}
