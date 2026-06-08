# infra/ghostkey-lnbits/Dockerfile
#
# Single-container image that runs both:
#
#   * phoenixd   — Acinq's headless Lightning node. Auto-manages
#                  channels via Acinq's LSP, no manual channel mgmt
#                  required by the operator.
#   * LNbits     — invoice/API layer on top of phoenixd. Exposes the
#                  HTTP wire API that the `ghostkey-lightning-lnbits`
#                  sidecar in this repo consumes.
#
# Both processes share a Fly volume mounted at /data. phoenixd stores
# its seed + channel state under /data/phoenix; LNbits stores its
# SQLite DB + admin key under /data/lnbits. Losing this volume means
# losing the Lightning wallet — back it up the same way you would any
# other Lightning node (`phoenixd-cli backup` or copy /data/phoenix
# while the container is stopped).
#
# Built and deployed via `fly deploy --config infra/ghostkey-lnbits/fly.toml`
# from the repo root. See infra/ghostkey-lnbits/README.md for the
# full operator runbook (incl. the initial on-chain funding step
# required before any check-ins can be received).

# ----- phoenixd binary --------------------------------------------------------

# Pinned for reproducible builds. Bump deliberately; phoenixd has
# wire-format compatibility within a minor version.
ARG PHOENIXD_VERSION=0.5.3

FROM debian:bookworm-slim AS phoenixd-fetch
ARG PHOENIXD_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
RUN curl -fL -o phoenixd.zip \
      "https://github.com/ACINQ/phoenixd/releases/download/v${PHOENIXD_VERSION}/phoenixd-${PHOENIXD_VERSION}-linux-x64.zip" \
 && unzip phoenixd.zip \
 && mv "phoenixd-${PHOENIXD_VERSION}-linux-x64/phoenixd" /phoenixd \
 && mv "phoenixd-${PHOENIXD_VERSION}-linux-x64/phoenix-cli" /phoenix-cli \
 && chmod +x /phoenixd /phoenix-cli

# ----- runtime image ----------------------------------------------------------

# LNbits 0.12+ ships with PhoenixdWallet support. Pinned for the same
# reason as phoenixd. Bump deliberately.
FROM lnbits/lnbits:0.12.12

USER root

# phoenixd has only a stdlib dep on jvm-style glibc; the LNbits image
# is debian-based so we drop the binary in directly. netcat is for
# the start.sh readiness probe of phoenixd's HTTP socket.
RUN apt-get update \
 && apt-get install -y --no-install-recommends netcat-openbsd ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=phoenixd-fetch /phoenixd     /usr/local/bin/phoenixd
COPY --from=phoenixd-fetch /phoenix-cli  /usr/local/bin/phoenix-cli

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# /data is the Fly volume mount point. start.sh creates /data/phoenix
# and /data/lnbits on first boot.
VOLUME ["/data"]

# LNbits HTTP — only reachable over Fly's 6PN private network; never
# expose this publicly. The shared-secret bearer on the
# `ghostkey-lightning-lnbits` sidecar is the only authentication.
EXPOSE 5000

ENTRYPOINT ["/usr/local/bin/start.sh"]
