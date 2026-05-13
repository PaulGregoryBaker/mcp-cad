# Quickstart: MCP-CAD Local Development

**Phase**: Phase 1 | **Status**: Complete  
**Task**: T017 | **Date**: 2026-05-13

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Docker Desktop | 24.x+ | https://docker.com |
| Node.js | 22.x LTS | https://nodejs.org |
| Git | any | https://git-scm.com |

---

## Option A: Full Docker Build (Recommended)

This is the fastest path to a running MCP server.

```bash
# Clone and enter the repo
git clone <repo-url> mcp-cad && cd mcp-cad

# First build: ~90 minutes (OCCT compilation)
# Subsequent builds: ~5 minutes (Docker layer cache)
docker build -t mcp-cad:dev -f cpp/Dockerfile .

# Start the server (stdio transport for Claude Desktop)
docker run --rm -i \
  -v $(pwd)/ts/config:/app/config:ro \
  mcp-cad:dev
```

---

## Option B: Local Dev Build

Use this when actively developing C++ or TypeScript components.

### Step 1: Install vcpkg and C++ dependencies

```bash
git clone https://github.com/microsoft/vcpkg.git /opt/vcpkg
/opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics
export VCPKG_ROOT=/opt/vcpkg

cd cpp
$VCPKG_ROOT/vcpkg install --triplet x64-linux
```

### Step 2: Build the C++ Geometry Engine

```bash
cd cpp
cmake -B build \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
```

### Step 3: Build the NAPI Addon

```bash
npm install -g cmake-js@7
cd cpp
cmake-js build --release \
  --CDCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake
```

The addon will be output to `cpp/build/Release/geometry_addon.node`.

### Step 4: Install TypeScript dependencies

```bash
cd ts
npm install
```

### Step 5: Configure the server

Copy and edit the configuration template:

```bash
cp ts/config/config.yaml.example ts/config/config.yaml
# Edit config.yaml to add your material inventory, tooling specs, etc.
```

### Step 6: Run the development server

```bash
cd ts
GEOMETRY_ADDON_PATH=../cpp/build/Release/geometry_addon.node \
CONFIG_PATH=./config/config.yaml \
npm run dev
```

---

## Claude Desktop Integration

Add the following to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-cad": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-v", "/path/to/your/config:/app/config:ro",
        "mcp-cad:dev"
      ]
    }
  }
}
```

Or, for local dev build:

```json
{
  "mcpServers": {
    "mcp-cad": {
      "command": "node",
      "args": ["/path/to/mcp-cad/ts/dist/index.js"],
      "env": {
        "GEOMETRY_ADDON_PATH": "/path/to/mcp-cad/cpp/build/Release/geometry_addon.node",
        "CONFIG_PATH": "/path/to/mcp-cad/ts/config/config.yaml"
      }
    }
  }
}
```

---

## Docker Compose (Local Dev Environment)

For iterative development with volume mounts:

```bash
docker-compose up -d
docker-compose logs -f mcp-server
```

---

## Running Tests

### TypeScript tests (fast, no NAPI required for unit/contract)

```bash
cd ts
npm run test:unit        # Unit tests only
npm run test:contract    # Contract tests
npm run test:integration # Integration tests (requires NAPI addon)
npm run test:e2e         # Golden-path INF-03 (requires full stack)
npm run test:coverage    # Coverage report
```

### C++ tests

```bash
cd cpp/build
ctest --output-on-failure
```

### AddressSanitizer (memory safety)

```bash
cd cpp
cmake -B build-asan \
  -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DASAN=ON
cmake --build build-asan -j$(nproc)
cd build-asan && ctest --output-on-failure
```

---

## config.yaml Structure

```yaml
materials:
  - id: mild_steel_1.5mm
    name: "Mild Steel 1.5mm"
    thickness_mm: 1.5
    k_factor: 0.33
    yield_strength_mpa: 250
    grain_direction: any
    inventory_sheets:
      - width_mm: 1220
        height_mm: 2440
        label: "4x8ft"

tooling:
  press_brake:
    max_tonnage: 1000
    max_bend_length_mm: 3000
    v_die_widths_mm: [6, 8, 10, 16, 25]
    punch_radii_mm: [0.5, 1.0, 2.0, 3.0]
  laser:
    max_kerf_width_mm: 0.15
    min_hole_diameter_mm: 1.5

logistics:
  shipping_envelope:
    max_length_mm: 2400
    max_width_mm: 1200
    max_height_mm: 800
  max_weight_kg: 23.0
  coating_envelope:
    max_length_mm: 2000
    max_width_mm: 1000

environmental:
  fire_rated: false
  marine_grade: false
  high_vibration: false
```

---

## Troubleshooting

See [docs/DEVELOPMENT.md](../docs/DEVELOPMENT.md) for detailed cmake-js, OCCT, and NAPI debugging guidance.
