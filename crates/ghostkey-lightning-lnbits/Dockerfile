# syntax=docker/dockerfile:1.7
#
# Multi-stage Docker build for the ghostkey-lightning-lnbits sidecar.
#
# This crate is workspace-excluded from the main GhostKey workspace
# (see `../../Cargo.toml` [workspace.exclude]), so this build only
# sees this directory. Build context is the crate root.
#
#   docker build -t ghostkey-lightning-lnbits \
#     -f crates/ghostkey-lightning-lnbits/Dockerfile \
#     crates/ghostkey-lightning-lnbits
#
# On Fly.io, `fly deploy --config crates/ghostkey-lightning-lnbits/fly.toml`
# picks up the adjacent fly.toml, which sets `dockerfile = "Dockerfile"`
# relative to this directory.

# ---- builder ---------------------------------------------------------

FROM rust:1.86-slim-bookworm AS builder

# No openssl-dev needed: reqwest is built with rustls-tls. ca-certs are
# only required at runtime; the build doesn't make network calls.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Pre-fetch deps so source-only changes don't bust the cache.
COPY Cargo.toml Cargo.lock* ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs
RUN cargo fetch

# Real source.
COPY src ./src
RUN touch src/*.rs
RUN cargo build --release

# ---- runtime ---------------------------------------------------------

FROM debian:bookworm-slim AS runtime

# ca-certificates so reqwest's rustls can verify LNbits' TLS cert.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 lnbits \
    && useradd --system --uid 1001 --gid lnbits --home /home/lnbits lnbits

COPY --from=builder /build/target/release/ghostkey-lightning-lnbits /usr/local/bin/ghostkey-lightning-lnbits

USER lnbits
WORKDIR /home/lnbits

EXPOSE 8788

# Defaults — overridden by fly.toml [env] and per-machine secrets.
# Bind to 0.0.0.0 (not the dev default 127.0.0.1) because on Fly the
# main app reaches us over the 6PN private network. The bearer secret
# is the defence in depth.
ENV GHOSTKEY_LN_LNBITS_BIND=0.0.0.0:8788
ENV LNBITS_TIMEOUT_SECS=15
ENV RUST_LOG=ghostkey_lightning_lnbits=info,info

ENTRYPOINT ["/usr/local/bin/ghostkey-lightning-lnbits"]
