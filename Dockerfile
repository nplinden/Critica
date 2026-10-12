# Critica — static web app (CSG builder + OpenMC geometry/materials editor).
#
#   docker build -t critica .
#   docker run -d --name critica -p 8080:8080 --restart unless-stopped critica
#
# Then open http://<server>:8080/ (redirects to the builder).

# ---- 1. Build the WebAssembly module ------------------------------------------
# WebAssembly is architecture-independent, so this stage always runs natively on
# the build machine; multi-platform builds only differ in the nginx stage.
FROM --platform=$BUILDPLATFORM rust:1-slim-bookworm AS build
WORKDIR /src

# rust-toolchain.toml pins the toolchain and the wasm32 target; rustup installs
# them on first use.
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --target wasm32-unknown-unknown \
 && cp target/wasm32-unknown-unknown/release/critica.wasm /src/critica.wasm

# ---- 2. Serve the static files ------------------------------------------------
# Unprivileged nginx: runs as a non-root user and listens on 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=nginx:nginx examples /usr/share/nginx/html/examples
COPY --chown=nginx:nginx pkg/critica.js pkg/critica.d.ts /usr/share/nginx/html/pkg/
COPY --from=build --chown=nginx:nginx /src/critica.wasm /usr/share/nginx/html/pkg/critica.wasm

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/examples/ || exit 1
