# syntax=docker/dockerfile:1.7
#
# Multi-stage Docker build for the ghostkey-lightning-breez sidecar.
#
# This crate is workspace-excluded from the main GhostKey workspace
# (see `../../Cargo.toml` [workspace.exclude] for why), so this build
# only sees this directory. Build context is the crate root, not the
# repo root.
#
#   docker build -t ghostkey-lightning-breez -f crates/ghostkey-lightning-breez/Dockerfile crates/ghostkey-lightning-breez
#
# On Fly.io, `fly deploy --config crates/ghostkey-lightning-breez/fly.toml`
# will pick up the adjacent fly.toml, which sets `dockerfile = "Dockerfile"`
# relative to the same directory.
#
# UPSTREAM BUILD STATUS (see README.md "Current upstream build status"):
#   As of 2026-05-26, breez-sdk-liquid 0.12.2 does not compile from a
#   clean checkout because of a boltz-client / secp256k1_zkp version
#   skew. This Dockerfile is still committed because the deploy
#   plumbing (fly.toml, secrets, volume, networking) is what the
#   sidecar's first deploy actually needs; the moment Breez ships a
#   tag whose `boltz-client` rev compiles against current
#   `secp256k1_zkp`, bumping `Cargo.toml`'s `breez-sdk-liquid` tag is
#   the only change required to make this build green.

# ---- builder ---------------------------------------------------------

FROM rust:1.86-slim-bookworm AS builder

# breez-sdk-liquid pulls in C deps: libssl for TLS, the elements /
# secp256k1_zkp build needs a C compiler + autoconf for vendored
# secp256k1, and git for the boltz-client git dep.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       pkg-config libssl-dev ca-certificates \
       build-essential clang cmake git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Pre-fetch dependencies in a separate layer so source-only changes
# don't bust the dep cache. The crate's Cargo.lock is committed.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs
RUN cargo fetch --locked

# Real source.
COPY src ./src
RUN touch src/*.rs
RUN cargo build --release --locked

# ---- runtime ---------------------------------------------------------

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 breez \
    && useradd --system --uid 1001 --gid breez --home /data breez \
    && mkdir -p /data \
    && chown breez:breez /data

COPY --from=builder /build/target/release/ghostkey-lightning-breez /usr/local/bin/ghostkey-lightning-breez

USER breez
WORKDIR /data

# Sidecar listens on this port internally. fly.toml exposes it only
# to the Fly 6PN private network, not the public internet.
EXPOSE 8788

# Defaults — overridden by fly.toml [env] and per-machine secrets.
# The bind is 0.0.0.0 (not the 127.0.0.1 dev default) because on Fly
# the main app's machine reaches us over the 6PN private network. The
# bearer secret in GHOSTKEY_LN_BREEZ_SHARED_SECRET is defence in depth.
ENV GHOSTKEY_LN_BREEZ_BIND=0.0.0.0:8788
ENV BREEZ_WORKING_DIR=/data/breez
ENV BREEZ_NETWORK=testnet
ENV RUST_LOG=ghostkey_lightning_breez=info,info

ENTRYPOINT ["/usr/local/bin/ghostkey-lightning-breez"]
