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

persistence:                       # optional — Dolt semantic persistence
  driver: dolt                     # Only supported driver; omit block to disable persistence
  host: 127.0.0.1                  # Default: 127.0.0.1
  port: 3306                       # Default: 3306
  database: string                 # e.g. "semantic_braai" — one DB per product
  data_dir: ./state/dolt           # Directory for dolt sql-server data (default: ./state/dolt)
```

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

# Optional — remove block if Dolt persistence is not in use
persistence:
  driver: dolt
  host: 127.0.0.1
  port: 3306
  database: semantic_braai
  data_dir: ./state/dolt/braai
```
