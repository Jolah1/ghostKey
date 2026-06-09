# syntax=docker/dockerfile:1.7
#
# Multi-stage Docker build for ghostkey-server.
#
# Stage 1 ("builder"): pull a pinned Rust toolchain, prefetch the
# workspace's dependencies (so they're cacheable across builds even when
# the source changes), then compile the release binary.
#
# Stage 2 ("runtime"): a minimal Debian image with just the shared libs
# the binary needs (libssl, libsqlite3, ca-certificates) and the binary
# itself. Runs as a non-root user.
#
# This image is the same one Fly.io's builder will use when it sees this
# Dockerfile at the repo root. To verify locally:
#
#   docker build -t ghostkey-server .
#   docker run --rm -p 8080:8080 -e GHOSTKEY_BIND=0.0.0.0:8080 ghostkey-server

# ---- builder ---------------------------------------------------------

FROM rust:1.86-slim-bookworm AS builder

# System deps for sqlx (needs libsqlite3) and rustls (needs ca-certificates).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       pkg-config libssl-dev libsqlite3-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Pre-fetch dependencies. We do this in a separate layer so changing
# our own source code doesn't bust the dep cache.
COPY Cargo.toml Cargo.lock ./
COPY crates/ghostkey-core/Cargo.toml   crates/ghostkey-core/Cargo.toml
COPY crates/ghostkey-cli/Cargo.toml    crates/ghostkey-cli/Cargo.toml
COPY crates/ghostkey-server/Cargo.toml crates/ghostkey-server/Cargo.toml

# Empty stub source files so `cargo fetch` can resolve.
RUN mkdir -p \
        crates/ghostkey-core/src \
        crates/ghostkey-cli/src \
        crates/ghostkey-server/src \
    && echo "fn main() {}" > crates/ghostkey-cli/src/main.rs \
    && echo "fn main() {}" > crates/ghostkey-server/src/main.rs \
    && echo "// stub"      > crates/ghostkey-core/src/lib.rs

RUN cargo fetch --locked

# Now bring in the real source and build.
COPY crates ./crates
RUN touch crates/*/src/*.rs
RUN cargo build --release -p ghostkey-server --locked

# ---- litestream ------------------------------------------------------
# Continuous SQLite replication to object storage. Fetched in its own
# stage so the runtime image doesn't need curl/wget. Version pinned;
# bump deliberately and re-run the restore fire drill in DEPLOY.md
# after upgrading.

FROM debian:bookworm-slim AS litestream

ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin && /usr/local/bin/litestream version

# ---- runtime ---------------------------------------------------------

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libssl3 libsqlite3-0 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 ghostkey \
    && useradd --system --uid 1001 --gid ghostkey --home /data ghostkey \
    && mkdir -p /data \
    && chown ghostkey:ghostkey /data

COPY --from=builder /build/target/release/ghostkey-server /usr/local/bin/ghostkey-server
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
# Litestream reads /etc/litestream.yml by default; the file holds no
# secrets (everything is ${ENV}-expanded at runtime).
COPY infra/litestream.yml /etc/litestream.yml
COPY --chmod=755 scripts/server-entrypoint.sh /usr/local/bin/server-entrypoint.sh

USER ghostkey
WORKDIR /data

# Fly.io maps the public port (443/80) onto whatever the container
# listens on inside (declared in fly.toml). We override the bind
# address there too; this EXPOSE is purely documentation.
EXPOSE 8080

# Sensible defaults that fly.toml overrides per environment.
ENV GHOSTKEY_BIND=0.0.0.0:8080
ENV DATABASE_URL=sqlite:///data/ghostkey.sqlite?mode=rwc
ENV GHOSTKEY_TICK_SECS=30
ENV RUST_LOG=ghostkey_server=info,info

# The entrypoint wraps the server in `litestream replicate -exec`
# when LITESTREAM_* credentials are present, and falls back to the
# bare server (with a loud warning) when they're not.
ENTRYPOINT ["/usr/local/bin/server-entrypoint.sh"]
