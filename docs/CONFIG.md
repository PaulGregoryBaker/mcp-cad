# Configuration Reference

`config.yaml` controls materials, tooling, logistics, and environmental constraints for the MCP-CAD manufacturing pipeline.

## File Location

Place the config file at `ts/config/config.yaml` or set the `MCPCAD_CONFIG` environment variable to an absolute path.

## Structure

```yaml
materials:
  - id: string                     # Unique material identifier
    name: string                   # Human-readable name
    thickness_mm: number           # Sheet thickness (mm, > 0)
    k_factor: number               # K-factor [0, 1] for bend allowance
    yield_strength_mpa: number     # Yield strength in MPa
    grain_direction: x | y | any   # Grain direction constraint
    inventory_sheets:
      - width_mm: number
        height_mm: number
        label: string              # e.g. "4x8ft"

tooling:
  press_brake:
    max_tonnage: number            # Maximum press tonnage (kN)
    max_bend_length_mm: number     # Maximum bend length (mm)
    v_die_widths_mm: [number, ...] # Available V-die widths (mm)
    punch_radii_mm: [number, ...]  # Available punch radii (mm)
  laser:
    max_kerf_width_mm: number      # Maximum laser kerf (mm)
    min_hole_diameter_mm: number   # Minimum hole diameter (mm)

nesting:
  cutting_width_mm: number         # Kerf used as inter-part clearance; >0 and <= max_kerf_width_mm
  safety_gap_mm: number            # Extra spacing added to cutting width (default 0)
  sheet_margin_mm: number          # Min distance from part outline to sheet edge
  rotations_deg: [number, ...]     # Allowed part rotations
  optimizer:
    placement_accuracy: number     # 0..1 — NfpPlacer search effort
    rotation: none | genetic       # Global pile-rotation search (off by default)
    seed: number                   # genetic only — fixed for determinism
    max_iterations: number         # genetic only — NLopt maxeval
    relative_score_difference: number  # genetic only — NLopt ftol_rel

logistics:
  shipping_envelope:
    max_length_mm: number
    max_width_mm: number
    max_height_mm: number          # optional
  max_weight_kg: number
  coating_envelope:                # optional — for powder coat sizing
    max_length_mm: number
    max_width_mm: number

environmental:
  fire_rated: boolean              # Requires fire-rated materials/joints
  marine_grade: boolean            # Blocks adhesive/plastic fasteners
  high_vibration: boolean          # optional
  outdoor_exposed: boolean         # optional
```

> The former `persistence:` block has been **removed**. It is rejected at use
> with migration instructions. Storage is configured through storage accounts
> (below).

## Validation

The loader (`ts/src/config/loader.ts`) uses Zod to validate the config on startup. If validation fails, the process exits with a descriptive error message.

A JSON Schema document is also available at `ts/src/config/schema.ts` for IDE-based YAML validation. To enable it in VS Code, add to `.vscode/settings.json`:

```json
{
  "yaml.schemas": {
    "./ts/src/config/schema.ts": "ts/config/config.yaml"
  }
}
```

## Environment Variables

| Variable         | Default                  | Description                          |
|------------------|--------------------------|--------------------------------------|
| `MCPCAD_CONFIG`  | `ts/config/config.yaml`  | Absolute path to the config file     |
| `NODE_ENV`       | `development`            | `production` disables debug logging  |

## Example

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

## Manufacturing Graph (`graph:`)

Controls the behaviour of the Manufacturing Graph DAG engine introduced in Feature 009.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `graph.coplanarity_threshold_deg` | float | `1.0` | Dihedral angle threshold (degrees) below which two adjacent panels are merged into a single flat `PanelNode` rather than connected by a `BendNode`. Increase to tolerate slightly non-planar model imports. |
    min_hole_diameter_mm: 1.5

logistics:
  shipping_envelope:
    max_length_mm: 2400
    max_width_mm: 1200
    max_height_mm: 800
  max_weight_kg: 23.0

environmental:
  fire_rated: false
  marine_grade: false

```

## Storage accounts (`storage-accounts.yaml`)

Graph persistence (spec 010, `src/v2/persistence/README.md`) connects to Dolt
through named **storage accounts**. Clients (Form·AI·tion) choose an account
**by id** and a database name per project. **Credentials never pass through MCP
tool calls.** They are resolved here, from a secret reference, and redacted
from every log and error.

- **Location**: `ts/config/storage-accounts.yaml`, or set `MCPCAD_ACCOUNTS` to
  an absolute path. The file is git-ignored because it is machine- and
  tenant-specific. It holds **no secrets**.
- **Management**: use the account CLI rather than editing the file by hand:

  ```powershell
  npm run account -- add local --host 127.0.0.1 --port 3316 --user root --no-secret --prefix proj_
  npm run account -- add acme --host dolt.acme.internal --user formaition_svc --secret-prompt --tls required --prefix acme_proj_
  npm run account -- list            # never prints secrets
  npm run account -- test acme
  npm run account -- remove acme
  ```

```yaml
storage_accounts:
  - id: local                      # [a-z][a-z0-9_-]{0,31}, unique
    driver: dolt                   # only supported driver
    host: 127.0.0.1
    port: 3316
    user: root
    secret_ref: null               # null = no password
    tls: off                       # off | preferred | required (default off)
    database_prefix: proj_         # project databases must start with this
  - id: acme
    driver: dolt
    host: dolt.acme.internal
    port: 3306
    user: formaition_svc
    secret_ref: keyring:formaition-mcp/acme   # or env:ACME_DOLT_PASSWORD, or file:C:/secure/acme.pw
    tls: required
    database_prefix: acme_proj_
```

`secret_ref` schemes:

| Scheme | Resolves to |
|---|---|
| `keyring:<service>/<account>` | The OS credential store (Windows Credential Manager), via `@napi-rs/keyring`. `--secret-prompt` stores it here |
| `env:<VAR>` | The environment variable `VAR` of the MCP process |
| `file:<path>` | The file's contents, trimmed (protect it with file ACLs) |

An unresolvable reference fails with `STORAGE_SECRET_UNRESOLVED`, which names
the scheme and key, never a value.

## Nesting (`nesting:`)

Controls irregular-shape nesting (`simulate_nesting`). See
`rebuild/21-nesting-libnest2d.md` for the full design.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `nesting.cutting_width_mm` | float | `tooling.laser.max_kerf_width_mm` | Cutting width (kerf) used as the inter-part clearance. Must be `> 0` and `<= tooling.laser.max_kerf_width_mm`; out-of-range values fail with `NEST_INVALID_CUTTING_WIDTH`. |
| `nesting.safety_gap_mm` | float | `0.0` | Extra spacing added to the cutting width. Inter-part distance passed to the solver is `cutting_width_mm + safety_gap_mm`. |
| `nesting.sheet_margin_mm` | float | `2.0` | Minimum distance from a part outline to the sheet edge. |
| `nesting.rotations_deg` | int[] | `[0, 90, 180, 270]` | Allowed part rotations. |
| `nesting.optimizer.placement_accuracy` | float 0..1 | `0.65` | NFP-placer search effort (`floor(1000 × accuracy)` iterations). |
| `nesting.optimizer.rotation` | `none` \| `genetic` | `none` | Global pile-rotation search. Off by default. |
| `nesting.optimizer.seed` | int | `42` | Fixed RNG seed for the genetic search (determinism). Genetic only. |
| `nesting.optimizer.max_iterations` | int | `800` | NLopt maxeval for the genetic search. Genetic only. |
| `nesting.optimizer.relative_score_difference` | float | `1e-6` | NLopt ftol_rel for the genetic search. Genetic only. |

### Cutting width process

The cutting width is the **kerf** — the material removed along one cut line. It
is taken from shop tooling, not computed from part geometry: the default is
`tooling.laser.max_kerf_width_mm`, and a shop may set `nesting.cutting_width_mm`
as long as it stays within `(0, max_kerf_width_mm]`. `simulate_nesting` may
also pass a per-job `cutting_width_mm` override, validated against the same
ceiling. The solver's inter-part clearance is `cutting_width_mm + safety_gap_mm`,
and the sheet margin shrinks the packing area on each side.

### Optimiser

libnest2d ships no simulated-annealing optimiser. Placement always uses the
NFP + local subplex (`L_SUBPLEX`) search; the optional `optimizer.rotation:
genetic` enables a seeded NLopt ESCH evolutionary search over the whole-pile
rotation to minimise bounding box / material use. It is off by default so the
default path is deterministic.
