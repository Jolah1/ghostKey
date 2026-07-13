/**
 * Which contact channels the server can actually deliver (#277).
 *
 * Mirrors the Lightning gate (#232): /health reports capability, the
 * UI disables what the server can't do — so an owner can never pick a
 * contact the notifier would have to drop (the "Ara's share" WhatsApp
 * vault sat undeliverable for 5 days before anyone noticed).
 *
 * Defaults to "everything works" until the probe answers, and for
 * older servers that don't emit the flags, so a slow or failed health
 * check can never lock an owner out of a channel the server actually
 * supports. If the optimistic default is ever wrong, the notifier now
 * fails the send visibly instead of going silent (#278).
 */
import { useEffect, useState } from "react";

import { api } from "./api";
import type { HeirContactChannel } from "./heirChannels";

export type ChannelCapability = Record<HeirContactChannel, boolean>;

const ALL_ON: ChannelCapability = { email: true, sms: true, whatsapp: true };

// Capability changes with deploys, not with clicks: fetch once per
// page load and share it across every picker.
let cached: ChannelCapability | null = null;

export function useChannelCapability(): ChannelCapability {
  const [cap, setCap] = useState<ChannelCapability>(cached ?? ALL_ON);

  useEffect(() => {
    if (cached) return;
    let alive = true;
    void api
      .health()
      .then((h) => {
        cached = {
          email: h.email_enabled ?? true,
          sms: h.sms_enabled ?? true,
          whatsapp: h.whatsapp_enabled ?? true,
        };
        if (alive) setCap(cached);
      })
      .catch(() => {
        // Probe failed: keep the optimistic default (see module doc).
      });
    return () => {
      alive = false;
    };
  }, []);

  return cap;
}

/** Short honest note for a disabled channel tile. */
export const CHANNEL_UNAVAILABLE_NOTE = "Not available on this server yet";
