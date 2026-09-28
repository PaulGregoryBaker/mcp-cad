# Development Guide: MCP-CAD Geometry Server

**Status**: Active | **Last updated**: 2026-05-13

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Docker | 24.x+ | Build and run the geometry server |
| Node.js | 22.x LTS | TypeScript MCP server |
| npm | 10.x | Package management |
| CMake | 3.26+ | C++ build system |
| vcpkg | latest | C++ dependency management |
| cmake-js | 7.x | NAPI addon build tool |
| Python | 3.11 | CadQuery unfolding backend |

---

## Quick Start (Docker)

```bash
# Build the multi-stage image (first build ~90 min due to OCCT compilation)
docker build -t mcp-cad:dev -f cpp/Dockerfile .

# Start local dev environment
docker-compose up -d

# Verify MCP server is running
docker-compose logs -f mcp-server
```

---

## Local C++ Build (Without Docker)

### 1. Install vcpkg

```bash
git clone https://github.com/microsoft/vcpkg.git /opt/vcpkg
/opt/vcpkg/bootstrap-vcpkg.sh
export VCPKG_ROOT=/opt/vcpkg
```

### 2. Install Dependencies via vcpkg

```bash
cd /path/to/mcp-cad/cpp
vcpkg install --triplet x64-linux
```

This installs OCCT 7.8.1, libnest2d, and Catch2 per `cpp/vcpkg.json`.

### 3. Build with CMake

```bash
cd cpp
cmake -B build \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

### 4. Run C++ Tests

```bash
cd cpp/build
ctest --output-on-failure
# Or run individual test binaries:
./tests/geometry_tests
./tests/feature_extractor_tests
```

---

## NAPI Addon Build (cmake-js)

The NAPI addon bridges the C++ Geometry Engine to the TypeScript MCP server.

### Install cmake-js

```bash
npm install -g cmake-js
```

### Build the Addon

```bash
cd cpp
cmake-js build --CDCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

Output: `cpp/build/Release/geometry_addon.node`

### cmake-js Platform Validation Matrix

| Platform | Status | Notes |
|----------|--------|-------|
| Ubuntu 22.04 (x64) | ✅ PASS | Primary CI platform |
| macOS 14 (Apple Silicon) | ✅ PASS | Requires Rosetta for x86 OCCT builds |
| Windows 11 (MSVC) | ⚠️ Partial | Post-MVP; OCCT MSVC build not validated |

### Common cmake-js Issues

**Problem**: `Cannot find module 'node-addon-api'`
```bash
cd ts && npm install
# node-addon-api is a ts/ dependency; addon build must run from cpp/ with ts/ installed
```

**Problem**: `OCCT headers not found during cmake-js build`
```bash
# Ensure VCPKG_ROOT is exported and vcpkg install was run first
export VCPKG_ROOT=/opt/vcpkg
cmake-js build --CDVCPKG_ROOT=$VCPKG_ROOT
```

**Problem**: `Illegal instruction` when loading addon on macOS ARM
```bash
# Rebuild for ARM64 explicitly
cmake-js build --arch arm64
```

---

## TypeScript Server Setup

```bash
cd ts
npm install
npm run build         # Compile TypeScript → dist/
npm run dev           # Run with ts-node for development
npm test              # Run Vitest test suite
npm run test:coverage # Coverage report
```

### Environment Variables

```bash
MCP_TRANSPORT=stdio          # Default: stdio (Claude Desktop)
MCP_PORT=8080                # HTTP+SSE (future cloud deployment)
GEOMETRY_ADDON_PATH=../cpp/build/Release/geometry_addon.node
CONFIG_PATH=./config/config.yaml
LOG_LEVEL=info               # debug | info | warn | error
```

---

## Testing

### C++ Tests (Catch2 + CTest)

```bash
cd cpp/build
ctest --output-on-failure --timeout 60
# Generate XML for CI:
ctest --output-on-failure -T Test
```

### TypeScript Tests (Vitest)

```bash
cd ts
npm test                      # All tests
npm run test:unit             # Unit tests only
npm run test:integration      # Integration tests (requires NAPI addon)
npm run test:e2e              # E2E test (requires full stack)
npm run test:coverage         # Coverage with v8 provider
```

### AddressSanitizer (GE Memory Testing)

```bash
cd cpp
cmake -B build-asan \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DCMAKE_CXX_FLAGS="-fsanitize=address -fno-omit-frame-pointer"
cmake --build build-asan -j$(nproc)
cd build-asan && ctest --output-on-failure
```

---

## Docker Layer Caching Strategy

The Dockerfile uses a multi-stage build to cache the OCCT compilation layer:

```
Stage 1: occt-builder   (~90 min first build; cached on subsequent builds)
  - Compiles OCCT 7.8.1 from source
  - Output: /usr/local/occt/

Stage 2: app-builder    (~5 min)
  - Builds C++ addon against cached OCCT
  - Builds TypeScript server
  - Output: dist/ + geometry_addon.node

Stage 3: runtime        (minimal image)
  - Copies only runtime artifacts
  - Sets up Python 3.11 for CadQuery
```

**Important**: Always use `--cache-from` in CI to preserve the OCCT builder layer between builds.

---

## Debugging

### Inspect Geometry State

The MCP server exposes `geometry://part/{id}/topology` as a resource. Use the MCP inspector:

```bash
# Install MCP inspector
npm install -g @modelcontextprotocol/inspector

# Connect to running server
mcp-inspector stdio -- node dist/index.js
```

### C++ Debug Builds

```bash
cmake -B build-debug \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
  -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_CXX_FLAGS="-g -O0"
cmake --build build-debug
# Now use GDB or LLDB against the test binaries
```

### TypeScript Debug (ts-node + inspector)

```bash
cd ts
node --inspect -r ts-node/register src/index.ts
# Attach VS Code debugger: "Node.js: Attach" configuration
```

---

## References

- [OCCT_STABILITY.md](OCCT_STABILITY.md)
- [MVP_SCOPE.md](MVP_SCOPE.md)
- [rebuild/README.md](../rebuild/README.md) — authoritative architecture/interface reference for the v2 rebuild
- [.specify/memory/constitution.md](../.specify/memory/constitution.md) — governing principles (v2.0.0)
