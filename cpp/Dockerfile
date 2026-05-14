# ─── Stage 1: OCCT Builder ────────────────────────────────────────────────────
# Compiles OCCT 7.8.1 from source. This layer is cache-heavy (~90 min first build).
# Subsequent builds use Docker layer cache if OCCT version is unchanged.
FROM ubuntu:22.04 AS occt-builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y autoconf autoconf-archive automake libtool python3 curl && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ninja-build \
    git \
    curl \
    zip \
    unzip \
    pkg-config \
    libfreetype-dev \
    libfontconfig-dev \
    libgl-dev \
    patchelf \
    ca-certificates \
    tk-dev \
    && rm -rf /var/lib/apt/lists/*

# Install vcpkg
RUN git clone https://github.com/microsoft/vcpkg.git /opt/vcpkg && \
    /opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics

ENV VCPKG_ROOT=/opt/vcpkg
ENV PATH="${VCPKG_ROOT}:${PATH}"

# Copy vcpkg manifest and install dependencies (OCCT + Catch2 + nlohmann-json)
WORKDIR /build/cpp
COPY cpp/vcpkg.json .
COPY cpp/ports/ ./ports/
RUN vcpkg install --triplet x64-linux --x-manifest-root=. \
    --x-install-root=/opt/vcpkg/installed \
    --overlay-ports=./ports \
    && vcpkg integrate install \
    || (echo "=== VCPKG BUILD FAILED ===" && cat /opt/vcpkg/buildtrees/opencascade/install-x64-linux-dbg-out.log /opt/vcpkg/buildtrees/opencascade/install-x64-linux-rel-out.log 2>/dev/null && exit 1)

# ─── Stage 2: C++ Addon Builder ──────────────────────────────────────────────
FROM occt-builder AS cpp-builder

COPY cpp/ /build/cpp/
WORKDIR /build/cpp

# We must use vcpkg's cmake because the system cmake is 3.22 and our CMakeLists requires >=3.26
ENV PATH="/opt/vcpkg/downloads/tools/cmake-4.3.2-linux/cmake-4.3.2-linux-x86_64/bin:${PATH}"

RUN cmake -B build \
    -DCMAKE_TOOLCHAIN_FILE=/opt/vcpkg/scripts/buildsystems/vcpkg.cmake \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/opt/geometry && \
    cmake --build build -j$(nproc) && \
    cmake --install build

# ─── Stage 3: Node.js / TypeScript Builder ───────────────────────────────────
FROM node:22-bookworm-slim AS ts-builder

WORKDIR /build/ts
COPY ts/package.json ts/package-lock.json* ./
RUN npm ci --include=dev

COPY ts/ .
RUN npm run build

# ─── Stage 4: NAPI Addon Builder ─────────────────────────────────────────────
FROM cpp-builder AS napi-builder

RUN apt-get update && apt-get install -y autoconf autoconf-archive automake libtool python3 libx11-dev libxext-dev libxmu-dev libxi-dev libgl1-mesa-dev libglu1-mesa-dev tk-dev --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g cmake-js@7

WORKDIR /build/cpp
COPY --from=ts-builder /build/ts/node_modules /build/ts/node_modules

ENV VCPKG_ROOT=/opt/vcpkg
RUN cmake-js rebuild --release \
    --CDCMAKE_TOOLCHAIN_FILE=/opt/vcpkg/scripts/buildsystems/vcpkg.cmake

# ─── Stage 5: Runtime Image ──────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y autoconf autoconf-archive automake libtool python3 libx11-dev libxext-dev libxmu-dev libxi-dev libgl1-mesa-dev libglu1-mesa-dev tk-dev curl --no-install-recommends \
    libfreetype6 \
    libfontconfig1 \
    libgl1 && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install CadQuery for Python-based unfolding
RUN pip install --no-cache-dir cadquery==2.4.0

# Install Node.js production dependencies
WORKDIR /app
COPY --from=ts-builder /build/ts/dist ./dist/
COPY --from=ts-builder /build/ts/package.json /build/ts/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Copy NAPI addon
COPY --from=napi-builder /build/cpp/build/Release/geometry_addon.node ./

# Copy runtime configuration
COPY ts/config/ ./config/

# Security: run as non-root user
RUN useradd --system --uid 1001 --no-create-home mcp-server
USER mcp-server

ENV GEOMETRY_ADDON_PATH=/app/geometry_addon.node
ENV CONFIG_PATH=/app/config/config.yaml
ENV MCP_TRANSPORT=stdio
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "dist/index.js"]
