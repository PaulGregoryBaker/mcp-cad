Engineering Design: AI-Driven Sheet Metal MCP

**Version:** 1.0  
**Status:** Draft  
**Domain:** CAD/CAM Manufacturing Automation  
**Source:** Derived from Architecture.md v3.0

---

## Table of Contents

1. [Pre-Decisions Required](#1-pre-decisions-required)
2. [DDD Bounded Contexts](#2-ddd-bounded-contexts)
3. [MCP Specification](#3-mcp-specification)
4. [Function Design Matrix](#4-function-design-matrix)
5. [Work Breakdown Structure](#5-work-breakdown-structure)
6. [Open Questions](#6-open-questions)

---

## 1. Pre-Decisions Required

These decisions must be resolved before detailed implementation begins. Each one materially changes the interface contracts and work breakdown.

| # | Decision | Options | Impact |
|---|---|---|---|
| D1 | **Geometry stack** | A) Local OCC/CadQuery only  B) Cloud API (Onshape/Fusion) primary  C) Local with cloud fallback | Determines Geometry Engine interface — local calls vs HTTP client |
| D2 | **Nesting library** | A) libnest2d (C++, local)  B) SVGnest (JS, local)  C) Cloud nesting API | Determines whether nesting is inside Geometry Engine context or a fourth context |
| D3 | **State persistence** | A) In-memory, session-scoped only  B) Persisted to local SQLite  C) Persisted to remote store | Determines rollback model and version history complexity |
| D4 | **Auth model** | A) No auth (local only)  B) API key  C) OAuth2 | Determines MCP transport security layer |
| D5 | **MCP transport** | A) stdio (local Claude Desktop)  B) HTTP/SSE (server mode)  C) Both | Determines deployment topology and session model |

**Recommended defaults for MVP:** D1-A, D2-A (libnest2d via Python bindings), D3-A, D4-A, D5-A. Revisit D5 for cloud/Kubernetes deployment.

---

## 2. DDD Bounded Contexts

### 2.1 Context Map

```
┌─────────────────────────────────────────────────────────────────────┐
│  AI Harness (External Consumer)                                      │
│  Uses: MCP Protocol — tools and resources only                       │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ MCP Protocol (stdio / HTTP+SSE)
┌──────────────────────────▼──────────────────────────────────────────┐
│  BOUNDED CONTEXT: MCP Protocol Layer                                 │
│  Owns: Tool dispatch, resource serving, session state, history       │
│  Language: Tool, Resource, Session, Snapshot, RollbackToken          │
└──────┬──────────────────────────────────┬───────────────────────────┘
       │ GeometryPort (internal Python)    │ ManufacturingPort (internal Python)
┌──────▼──────────────────┐   ┌───────────▼───────────────────────────┐
│  BOUNDED CONTEXT:        │   │  BOUNDED CONTEXT:                      │
│  Geometry Engine         │   │  Manufacturing Domain                  │
│                          │   │                                        │
│  Owns:                   │   │  Owns:                                 │
│  - B-Rep solids/shells   │   │  - Material specifications             │
│  - Topology graph        │   │  - Tooling capabilities                │
│  - Boolean operations    │   │  - Bend/feature rules                  │
│  - Unfolding math        │   │  - Safety constraints                  │
│  - Nesting layout        │   │  - Manufacturability scoring           │
│                          │   │                                        │
│  Language:               │   │  Language:                             │
│  Face, Edge, Vertex,     │   │  Feature, Bend, Flange, Relief,        │
│  Shell, Manifold, BRep,  │   │  Gauge, K-Factor, Kerf, Tonnage,       │
│  Topology, Solid         │   │  FireRating, JointType, Clearance      │
└──────────────────────────┘   └────────────────────────────────────────┘
           │                                    │
           └──── Anti-Corruption Layer ─────────┘
                 (Feature Extractor)
                 Translates B-Rep topology → Manufacturing Features
```

### 2.2 Geometry Engine Context

**Responsibility:** All mathematical operations on geometric primitives. Has no knowledge of manufacturing rules or MCP protocol.

**Ubiquitous Language:**

| Term | Definition |
|---|---|
| `Solid` | A closed, volumetric B-Rep body |
| `Shell` | An open surface body (sheet metal panel) |
| `Face` | A bounded surface patch on a body |
| `Edge` | The boundary curve between two faces |
| `Manifold` | A solid where every edge is shared by exactly two faces |
| `Topology` | The adjacency relationships between faces and edges |
| `UnfoldMap` | The 2D flat pattern derived from a 3D shell |
| `NestLayout` | A 2D packing arrangement of UnfoldMaps on a sheet |

**Public Interface — `GeometryPort`:**

```python
class GeometryPort(Protocol):

    # Ingestion
    def load_step(self, file_path: str) -> SolidId: ...
    def export_step(self, solid_id: SolidId, file_path: str) -> None: ...
    def export_dxf(self, unfold_id: UnfoldId, file_path: str) -> None: ...

    # Analysis
    def get_topology(self, solid_id: SolidId) -> TopologyGraph: ...
    def check_manifold(self, solid_id: SolidId) -> ManifoldReport: ...
    def heal_geometry(self, solid_id: SolidId) -> HealReport: ...

    # Decomposition
    def boolean_cut(self, solid_id: SolidId, cutter: CutPlane) -> list[SolidId]: ...
    def extract_shell(self, solid_id: SolidId, face_ids: list[FaceId]) -> ShellId: ...

    # Sheet Metal
    def add_corner_relief(self, shell_id: ShellId, edge_id: EdgeId, relief: ReliefSpec) -> ShellId: ...
    def add_tab_slot(self, shell_a: ShellId, shell_b: ShellId, spec: TabSlotSpec) -> tuple[ShellId, ShellId]: ...
    def unfold(self, shell_id: ShellId, k_factor: float) -> UnfoldId: ...

    # Nesting
    def nest(self, unfold_ids: list[UnfoldId], sheet: SheetSpec) -> NestLayout: ...
```

**What the stack (OCC/CadQuery) handles directly:**
- B-Rep kernel operations (boolean cut, fillet, chamfer)
- Face/edge adjacency traversal
- Sheet metal unfolding (`BRepOffsetAPI_MakeFlatFace` or CadQuery equivalent)
- STEP import/export
- DXF export of 2D wire geometry

**What the Geometry Engine service adds:**
- `SolidId` / `ShellId` identity and in-memory registry
- Retry and error wrapping around OCC exceptions
- Geometry history snapshots (list of operation receipts)

---

### 2.3 Manufacturing Domain Context

**Responsibility:** Encodes all manufacturing knowledge — rules, constraints, material properties, and tooling capabilities. Has no knowledge of B-Rep primitives; it reasons over semantic features.

**Ubiquitous Language:**

| Term | Definition |
|---|---|
| `Feature` | A discrete manufacturing operation on a panel (bend, hole, flange, louver) |
| `Bend` | A linear deformation of sheet metal along an edge, defined by angle, radius, and direction |
| `Flange` | A flat extension created by bending an edge to 90° |
| `Relief` | A cut at a bend intersection to prevent material tearing |
| `K-Factor` | The ratio of the neutral axis position to material thickness |
| `Gauge` | The nominal material thickness |
| `Kerf` | Material removed by laser/waterjet cutting |
| `Tonnage` | Press brake force required to bend a given material at a given width |
| `FireRating` | An environmental constraint restricting fastener and adhesive choices |
| `JointType` | The connection method between two panels (TabSlot, Rivet, Weld, Adhesive) |

**Public Interface — `ManufacturingPort`:**

```python
class ManufacturingPort(Protocol):

    # Material & Tooling Queries
    def get_material(self, material_id: str) -> MaterialSpec: ...
    def get_tooling(self) -> ToolingCapability: ...
    def get_logistics(self) -> LogisticsConstraints: ...

    # Feature Validation
    def validate_bend(self, bend: BendFeature, material: MaterialSpec) -> ValidationResult: ...
    def validate_hole(self, hole: HoleFeature, material: MaterialSpec) -> ValidationResult: ...
    def validate_flange(self, flange: FlangeFeature, tooling: ToolingCapability) -> ValidationResult: ...

    # Manufacturability
    def score_panel(self, features: list[Feature], material: MaterialSpec) -> ManufacturabilityScore: ...
    def validate_bend_sequence(self, bends: list[BendFeature]) -> BendSequenceResult: ...

    # Constraint Enforcement
    def is_joint_type_allowed(self, joint: JointType, context: EnvironmentalContext) -> bool: ...
    def compute_kerf_offset(self, process: CutProcess) -> float: ...  # returns mm

    # K-Factor & Bend Allowance
    def compute_k_factor(self, material: MaterialSpec, bend_radius: float) -> float: ...
    def compute_bend_allowance(self, bend: BendFeature, k_factor: float) -> float: ...
```

**What the Manufacturing Domain service handles entirely** (no underlying stack):
- Rule lookups (min hole diameter ≥ material thickness)
- Safety filter (FireRating blocks adhesives/plastic fasteners)
- K-factor and bend allowance calculation (closed-form math)
- Tonnage estimation
- Manufacturability scoring (weighted rule violations)

---

### 2.4 Anti-Corruption Layer: Feature Extractor

Sits between the Geometry Engine and Manufacturing Domain. Translates raw topology into semantic manufacturing features.

**Interface:**

```python
class FeatureExtractor:
    def extract_bends(self, topology: TopologyGraph, material: MaterialSpec) -> list[BendFeature]: ...
    def extract_holes(self, topology: TopologyGraph) -> list[HoleFeature]: ...
    def extract_flanges(self, topology: TopologyGraph) -> list[FlangeFeature]: ...
    def extract_all(self, topology: TopologyGraph, material: MaterialSpec) -> FeatureSet: ...
```

**Logic:** Classifies faces by their surface type (planar vs. cylindrical), classifies edges by their dihedral angle, and maps these to manufacturing features. This is custom service logic — no OCC shortcut exists for manufacturing semantics.

---

### 2.5 MCP Protocol Layer Context

**Responsibility:** Exposes the system to the AI Harness via the Model Context Protocol. Manages session lifecycle, geometry state history, and resource serving. Orchestrates calls to Geometry Engine and Manufacturing Domain.

**Ubiquitous Language:**

| Term | Definition |
|---|---|
| `Session` | A stateful interaction with a single design project |
| `Snapshot` | An immutable record of geometry state at a point in time |
| `RollbackToken` | An opaque identifier for a prior Snapshot |
| `Resource` | A URI-addressable data feed exposed to the AI Harness |
| `Tool` | A callable action exposed to the AI Harness |
| `DecompositionStrategy` | The priority rule used to split a volume (Integrity, Simplicity, Logistics) |

---

## 3. MCP Specification

### 3.1 Transport

- **MVP:** stdio (compatible with Claude Desktop local configuration)
- **Cloud:** HTTP + SSE on port 8080, path `/mcp`

### 3.2 Resources

All resources are read-only for the AI Harness. They reflect the current session state.

#### `context://intent/environmental`

```json
{
  "uri": "context://intent/environmental",
  "mimeType": "application/json",
  "schema": {
    "type": "object",
    "properties": {
      "fire_rated": { "type": "boolean" },
      "marine_grade": { "type": "boolean" },
      "high_vibration": { "type": "boolean" },
      "ip_rating": { "type": "string", "example": "IP65" }
    }
  }
}
```

#### `context://intent/assembly`

```json
{
  "uri": "context://intent/assembly",
  "mimeType": "application/json",
  "schema": {
    "type": "object",
    "properties": {
      "method": { "type": "string", "enum": ["factory_welded", "field_riveted", "field_bolted"] },
      "skill_level": { "type": "string", "enum": ["unskilled", "semi_skilled", "skilled"] }
    }
  }
}
```

#### `logistics://envelope/shipping`

```json
{
  "uri": "logistics://envelope/shipping",
  "mimeType": "application/json",
  "schema": {
    "type": "object",
    "properties": {
      "max_length_mm": { "type": "number" },
      "max_width_mm": { "type": "number" },
      "max_height_mm": { "type": "number" },
      "max_weight_kg": { "type": "number" }
    },
    "required": ["max_length_mm", "max_width_mm", "max_height_mm", "max_weight_kg"]
  }
}
```

#### `logistics://envelope/coating`

```json
{
  "uri": "logistics://envelope/coating",
  "mimeType": "application/json",
  "schema": {
    "type": "object",
    "properties": {
      "max_length_mm": { "type": "number" },
      "max_width_mm": { "type": "number" },
      "max_height_mm": { "type": "number" },
      "process": { "type": "string", "enum": ["powder_coat", "anodise", "zinc_plate", "none"] }
    }
  }
}
```

#### `manufacturing://tooling/press_brake`

```json
{
  "uri": "manufacturing://tooling/press_brake",
  "mimeType": "application/json",
  "schema": {
    "type": "object",
    "properties": {
      "max_tonnage": { "type": "number" },
      "max_bend_length_mm": { "type": "number" },
      "v_die_widths_mm": { "type": "array", "items": { "type": "number" } },
      "min_punch_radius_mm": { "type": "number" }
    }
  }
}
```

#### `manufacturing://material/inventory`

```json
{
  "uri": "manufacturing://material/inventory",
  "mimeType": "application/json",
  "schema": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "material_id": { "type": "string" },
        "name": { "type": "string", "example": "Mild Steel 1.5mm" },
        "gauge_mm": { "type": "number" },
        "k_factor": { "type": "number" },
        "grain_direction": { "type": "string", "enum": ["rolling", "cross", "none"] },
        "sheet_width_mm": { "type": "number" },
        "sheet_length_mm": { "type": "number" }
      },
      "required": ["material_id", "gauge_mm", "k_factor"]
    }
  }
}
```

#### `manufacturing://rules`

```json
{
  "uri": "manufacturing://rules",
  "mimeType": "application/json",
  "schema": {
    "type": "object",
    "properties": {
      "min_hole_diameter_factor": { "type": "number", "description": "Min hole diameter as multiple of gauge. Typically 1.0." },
      "min_flange_width_factor": { "type": "number", "description": "Min flange width as multiple of gauge. Typically 4.0." },
      "min_hole_edge_distance_factor": { "type": "number" },
      "kerf_laser_mm": { "type": "number", "default": 0.1 },
      "kerf_waterjet_mm": { "type": "number", "default": 0.2 }
    }
  }
}
```

#### `geometry://part/{id}/topology`

```json
{
  "uri": "geometry://part/{id}/topology",
  "mimeType": "application/json",
  "schema": {
    "type": "object",
    "properties": {
      "part_id": { "type": "string" },
      "face_count": { "type": "integer" },
      "edge_count": { "type": "integer" },
      "is_manifold": { "type": "boolean" },
      "bounding_box_mm": {
        "type": "object",
        "properties": {
          "x": { "type": "number" }, "y": { "type": "number" }, "z": { "type": "number" }
        }
      },
      "volume_mm3": { "type": "number" },
      "surface_area_mm2": { "type": "number" }
    }
  }
}
```

#### `geometry://part/{id}/features`

```json
{
  "uri": "geometry://part/{id}/features",
  "mimeType": "application/json",
  "schema": {
    "type": "object",
    "properties": {
      "part_id": { "type": "string" },
      "bends": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "feature_id": { "type": "string" },
            "angle_deg": { "type": "number" },
            "radius_mm": { "type": "number" },
            "length_mm": { "type": "number" },
            "direction": { "type": "string", "enum": ["up", "down"] }
          }
        }
      },
      "holes": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "feature_id": { "type": "string" },
            "diameter_mm": { "type": "number" },
            "center_x_mm": { "type": "number" },
            "center_y_mm": { "type": "number" }
          }
        }
      },
      "flanges": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "feature_id": { "type": "string" },
            "width_mm": { "type": "number" },
            "length_mm": { "type": "number" }
          }
        }
      }
    }
  }
}
```

#### `geometry://part/{id}/nest`

```json
{
  "uri": "geometry://part/{id}/nest",
  "mimeType": "application/json",
  "schema": {
    "type": "object",
    "properties": {
      "part_id": { "type": "string" },
      "sheet_material_id": { "type": "string" },
      "utilisation_pct": { "type": "number" },
      "parts_per_sheet": { "type": "integer" },
      "offcut_area_mm2": { "type": "number" }
    }
  }
}
```

---

### 3.3 Tools

#### `clean_geometry`

```json
{
  "name": "clean_geometry",
  "description": "Heals non-manifold edges, sliver faces, and duplicate geometry in a loaded STEP file. Must be called before any other tool.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "Absolute path to the STEP file to load and heal."
      },
      "tolerance_mm": {
        "type": "number",
        "description": "Healing tolerance. Defaults to 0.01mm.",
        "default": 0.01
      }
    },
    "required": ["file_path"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "part_id": { "type": "string", "description": "Assigned ID for the loaded solid." },
      "is_manifold": { "type": "boolean" },
      "healed_edges": { "type": "integer" },
      "healed_faces": { "type": "integer" },
      "warnings": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["part_id", "is_manifold"]
  }
}
```

#### `decompose_volume`

```json
{
  "name": "decompose_volume",
  "description": "Splits the master solid volume into manufacturable sheet metal panels according to the chosen strategy.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "part_id": { "type": "string" },
      "strategy": {
        "type": "string",
        "enum": ["integrity", "simplicity", "logistics"],
        "description": "integrity: minimise joint count. simplicity: minimise panel complexity. logistics: minimise panel size against shipping envelope."
      },
      "max_panels": {
        "type": "integer",
        "description": "Upper bound on panel count. Defaults to 5.",
        "default": 5
      }
    },
    "required": ["part_id", "strategy"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "panel_ids": { "type": "array", "items": { "type": "string" } },
      "strategy_applied": { "type": "string" },
      "rollback_token": { "type": "string", "description": "Token to undo this decomposition." },
      "constraint_violations": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["panel_ids", "rollback_token"]
  }
}
```

#### `synthesize_joints`

```json
{
  "name": "synthesize_joints",
  "description": "Adds physical joint geometry between adjacent panels. Respects environmental constraints (e.g. fire-rated contexts block adhesives).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "panel_ids": {
        "type": "array",
        "items": { "type": "string" },
        "description": "The panels to join. Must be adjacent."
      },
      "joint_type": {
        "type": "string",
        "enum": ["tab_slot", "rivet", "weld_prep", "adhesive"],
        "description": "The joining method to apply."
      },
      "clearance_mm": {
        "type": "number",
        "description": "Tab-to-slot clearance including kerf compensation. Defaults to 0.15mm.",
        "default": 0.15
      }
    },
    "required": ["panel_ids", "joint_type"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "updated_panel_ids": { "type": "array", "items": { "type": "string" } },
      "rollback_token": { "type": "string" },
      "blocked_reason": {
        "type": "string",
        "description": "If joint_type was blocked by a safety constraint, explains why. Null if allowed."
      }
    },
    "required": ["updated_panel_ids", "rollback_token"]
  }
}
```

#### `generate_reliefs`

```json
{
  "name": "generate_reliefs",
  "description": "Adds bend relief cuts at internal bend intersections to prevent material tearing during press brake operation.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "panel_id": { "type": "string" },
      "relief_type": {
        "type": "string",
        "enum": ["dogbone", "circular", "square"],
        "description": "dogbone: two tangent circles. circular: single circle. square: rectangular notch."
      },
      "material_id": {
        "type": "string",
        "description": "Used to derive minimum relief radius from gauge."
      }
    },
    "required": ["panel_id", "relief_type", "material_id"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "updated_panel_id": { "type": "string" },
      "reliefs_added": { "type": "integer" },
      "rollback_token": { "type": "string" }
    },
    "required": ["updated_panel_id", "reliefs_added", "rollback_token"]
  }
}
```

#### `apply_unfold`

```json
{
  "name": "apply_unfold",
  "description": "Generates a 2D flat pattern from a 3D sheet metal panel with bend compensation applied.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "panel_id": { "type": "string" },
      "material_id": {
        "type": "string",
        "description": "Selects K-factor and gauge from material inventory."
      },
      "k_factor_override": {
        "type": "number",
        "description": "Optional. Overrides the inventory K-factor."
      }
    },
    "required": ["panel_id", "material_id"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "unfold_id": { "type": "string" },
      "flat_width_mm": { "type": "number" },
      "flat_height_mm": { "type": "number" },
      "bend_count": { "type": "integer" },
      "total_bend_deduction_mm": { "type": "number" },
      "k_factor_used": { "type": "number" }
    },
    "required": ["unfold_id", "flat_width_mm", "flat_height_mm"]
  }
}
```

#### `simulate_nesting`

```json
{
  "name": "simulate_nesting",
  "description": "Performs 2D bin-packing of flat patterns onto sheet stock to minimise material waste.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "unfold_ids": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Flat pattern IDs to nest."
      },
      "material_id": {
        "type": "string",
        "description": "Selects sheet dimensions from material inventory."
      },
      "quantity_per_part": {
        "type": "object",
        "description": "Map of unfold_id to quantity. Defaults to 1 each.",
        "additionalProperties": { "type": "integer" }
      },
      "rotation_step_deg": {
        "type": "number",
        "description": "Angular increment for rotation optimisation. Defaults to 90.",
        "default": 90
      }
    },
    "required": ["unfold_ids", "material_id"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "nest_id": { "type": "string" },
      "sheets_required": { "type": "integer" },
      "utilisation_pct": { "type": "number" },
      "offcut_area_mm2": { "type": "number" },
      "layout_preview_svg": { "type": "string", "description": "Base64-encoded SVG of the nest layout." }
    },
    "required": ["nest_id", "sheets_required", "utilisation_pct"]
  }
}
```

#### `evaluate_manufacturability`

```json
{
  "name": "evaluate_manufacturability",
  "description": "Scores a panel against loaded manufacturing rules. Returns violations and a numeric score.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "panel_id": { "type": "string" },
      "material_id": { "type": "string" }
    },
    "required": ["panel_id", "material_id"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "score": {
        "type": "number",
        "description": "0.0 (completely unmanufacturable) to 1.0 (fully conformant)."
      },
      "violations": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "rule": { "type": "string" },
            "severity": { "type": "string", "enum": ["error", "warning"] },
            "feature_id": { "type": "string" },
            "message": { "type": "string" }
          }
        }
      },
      "pass": { "type": "boolean", "description": "True if no error-level violations." }
    },
    "required": ["score", "violations", "pass"]
  }
}
```

#### `validate_bend_sequence`

```json
{
  "name": "validate_bend_sequence",
  "description": "Checks that the bends on a panel can be executed in a valid order without tool collision on the press brake.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "panel_id": { "type": "string" },
      "material_id": { "type": "string" }
    },
    "required": ["panel_id", "material_id"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "valid": { "type": "boolean" },
      "suggested_sequence": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Ordered list of bend feature_ids."
      },
      "collision_warnings": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "bend_a": { "type": "string" },
            "bend_b": { "type": "string" },
            "message": { "type": "string" }
          }
        }
      }
    },
    "required": ["valid"]
  }
}
```

#### `export_production_pack`

```json
{
  "name": "export_production_pack",
  "description": "Starts an asynchronous export job that generates the full production output: nested DXFs, STEP assemblies, BOM CSV, and assembly instruction JSON.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "nest_id": { "type": "string" },
      "output_dir": { "type": "string", "description": "Absolute path to output directory." },
      "include": {
        "type": "array",
        "items": { "type": "string", "enum": ["dxf", "step", "bom", "assembly_instructions"] },
        "description": "Subset of outputs to generate. Defaults to all.",
        "default": ["dxf", "step", "bom", "assembly_instructions"]
      }
    },
    "required": ["nest_id", "output_dir"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "job_id": { "type": "string" },
      "status": {
        "type": "string",
        "enum": ["queued", "running", "succeeded", "failed"]
      },
      "accepted_at": { "type": "string", "description": "ISO-8601 UTC timestamp when the job was accepted." }
    },
    "required": ["job_id", "status", "accepted_at"]
  }
}
```

#### `get_export_job_status`

```json
{
  "name": "get_export_job_status",
  "description": "Returns status and progress information for an export job.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "job_id": { "type": "string" }
    },
    "required": ["job_id"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "job_id": { "type": "string" },
      "status": {
        "type": "string",
        "enum": ["queued", "running", "succeeded", "failed"]
      },
      "progress_pct": { "type": "number", "description": "0 to 100 inclusive." },
      "started_at": { "type": "string", "description": "ISO-8601 UTC timestamp. Null when queued." },
      "finished_at": { "type": "string", "description": "ISO-8601 UTC timestamp. Null unless terminal state." },
      "error_message": { "type": "string", "description": "Populated only when status=failed." }
    },
    "required": ["job_id", "status", "progress_pct"]
  }
}
```

#### `get_export_job_result`

```json
{
  "name": "get_export_job_result",
  "description": "Returns generated files and aggregate metadata for a completed export job.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "job_id": { "type": "string" }
    },
    "required": ["job_id"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "job_id": { "type": "string" },
      "files": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "type": { "type": "string" },
            "path": { "type": "string" }
          }
        }
      },
      "part_count": { "type": "integer" },
      "total_material_cost_estimate": {
        "type": "number",
        "description": "Estimated raw material cost based on utilisation and sheet count. Null if material costs not configured."
      }
    },
    "required": ["job_id", "files", "part_count"]
  }
}
```

#### `rollback`

```json
{
  "name": "rollback",
  "description": "Restores geometry state to a prior snapshot using a rollback token.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "rollback_token": { "type": "string" }
    },
    "required": ["rollback_token"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "restored_part_ids": { "type": "array", "items": { "type": "string" } },
      "snapshot_description": { "type": "string" }
    },
    "required": ["restored_part_ids"]
  }
}
```

### 3.4 Error Model

All tool errors return a structured error with the following fields:

```json
{
  "error": {
    "code": "GEOMETRY_NOT_MANIFOLD",
    "message": "The solid contains 3 non-manifold edges. Run clean_geometry first.",
    "recoverable": true,
    "suggested_tool": "clean_geometry"
  }
}
```

**Error Codes:**

| Code | Meaning | Recoverable |
|---|---|---|
| `GEOMETRY_NOT_MANIFOLD` | Solid has topological defects | Yes — call `clean_geometry` |
| `JOINT_TYPE_BLOCKED` | Safety filter rejected joint type | Yes — choose different `joint_type` |
| `LOGISTICS_VIOLATION` | Panel exceeds shipping envelope | Yes — choose `logistics` strategy |
| `BEND_SEQUENCE_INVALID` | No valid press brake sequence exists | Maybe — redesign geometry |
| `MATERIAL_NOT_FOUND` | `material_id` not in inventory | No — fix input |
| `ROLLBACK_TOKEN_EXPIRED` | Session state no longer holds this snapshot | No — session has advanced too far |
| `EXPORT_JOB_NOT_FOUND` | `job_id` not found in active session | No — fix input |
| `EXPORT_JOB_NOT_READY` | Export job is not in `succeeded` state yet | Yes — poll `get_export_job_status` |
| `EXPORT_JOB_FAILED` | Export job reached terminal failure | Maybe — inspect error and retry |
| `GEOMETRY_ENGINE_FAULT` | OCC kernel exception | No — report bug |

---

## 4. Function Design Matrix

For each tool, this table records the split between the underlying geometry stack and the service layer.

### `clean_geometry`

| Layer | Responsibility |
|---|---|
| **OCC/CadQuery** | `BRepCheck_Analyzer` for defect detection; `ShapeFix_Shape` for healing; `BRep_Builder` for topology repair |
| **Geometry Engine Service** | STEP file I/O; `SolidId` registration; healing threshold configuration; result serialisation |
| **Manufacturing Domain** | Not involved |
| **MCP Layer** | Session initialisation; assigns `part_id`; stores initial snapshot for rollback |

### `decompose_volume`

| Layer | Responsibility |
|---|---|
| **OCC/CadQuery** | Boolean cut (`BRepAlgoAPI_Cut`); face extraction; shell creation from face sets |
| **Geometry Engine Service** | Generates candidate cut planes from bounding box analysis; iterates boolean cuts; registers resulting `ShellId`s |
| **Manufacturing Domain** | Evaluates each candidate decomposition against `logistics://` envelope and `manufacturing://rules`; ranks options by constraint satisfaction |
| **MCP Layer** | Applies `strategy` flag to select Manufacturing Domain ranking function; stores pre-decomposition snapshot; returns `rollback_token` |

**Key decision:** The decomposition heuristic (where to cut) lives in the **MCP Layer** as an orchestration policy, calling Manufacturing Domain for constraint checking and Geometry Engine for the actual cuts. Neither sub-context owns the strategy logic.

### `synthesize_joints`

| Layer | Responsibility |
|---|---|
| **OCC/CadQuery** | Creates tab/slot geometry via extrude and boolean cut; creates rivet hole cylinders; creates weld prep chamfers |
| **Geometry Engine Service** | Identifies adjacent face pairs between panels; applies kerf offset (`0.1–0.2mm`) to slot geometry; registers updated shells |
| **Manufacturing Domain** | `is_joint_type_allowed()` check against `context://intent/environmental`; returns `blocked_reason` if fire-rated context blocks adhesives |
| **MCP Layer** | Enforces safety filter before delegating to Geometry Engine; records snapshot |

### `generate_reliefs`

| Layer | Responsibility |
|---|---|
| **OCC/CadQuery** | Creates circular or dogbone cut profiles; applies boolean cut at each bend intersection vertex |
| **Geometry Engine Service** | Detects bend intersection vertices from topology graph; computes relief radius from gauge |
| **Manufacturing Domain** | Provides minimum relief radius rule (`radius ≥ gauge / 2`); validates relief doesn't violate minimum edge-distance rules |
| **MCP Layer** | Passes `material_id` to Manufacturing Domain for gauge lookup; delegates geometry to Geometry Engine |

### `apply_unfold`

| Layer | Responsibility |
|---|---|
| **OCC/CadQuery** | `BRepOffsetAPI_MakeFlatFace` (or CadQuery sheet metal unfold); projects 3D bend geometry to 2D |
| **Geometry Engine Service** | Accepts `k_factor` parameter; registers `UnfoldId`; exports DXF wire geometry |
| **Manufacturing Domain** | `compute_k_factor()` from material spec; `compute_bend_allowance()` for each bend; validates unfolded dimensions fit within sheet stock |
| **MCP Layer** | Orchestrates: gets K-factor from Manufacturing Domain, passes to Geometry Engine unfold; no logic of its own |

**Note:** OCC's native unfolding is limited — CadQuery's sheet metal extension or a custom unfold implementation may be needed for complex panels. This is the highest geometric risk area in the implementation.

### `simulate_nesting`

| Layer | Responsibility |
|---|---|
| **libnest2d / SVGnest** | Bin-packing algorithm (no-fit polygon computation, placement optimisation) |
| **Geometry Engine Service** | Extracts polygon outlines from `UnfoldId` DXF; invokes nesting library; registers `NestId`; generates SVG preview |
| **Manufacturing Domain** | Provides sheet dimensions from `material_id`; enforces grain direction constraint (restricts rotation if `grain_direction != "none"`) |
| **MCP Layer** | Passes `quantity_per_part` and `rotation_step_deg` to Geometry Engine; returns utilisation metrics |

**Key decision:** Nesting stays within the Geometry Engine bounded context (it is a 2D geometric packing problem), but Manufacturing Domain controls sheet selection and grain direction constraints.

### `evaluate_manufacturability`

| Layer | Responsibility |
|---|---|
| **OCC/CadQuery** | None — this is a pure analysis tool that reads already-extracted topology |
| **Geometry Engine Service** | Provides `TopologyGraph` and extracted features via Feature Extractor |
| **Manufacturing Domain** | All validation logic: minimum hole diameter, minimum flange width, minimum edge distances, tonnage check, bend radius check |
| **MCP Layer** | Calls Feature Extractor, passes `FeatureSet` to Manufacturing Domain; aggregates `score` and `violations` |

### `validate_bend_sequence`

| Layer | Responsibility |
|---|---|
| **OCC/CadQuery** | None |
| **Geometry Engine Service** | Provides 3D bend geometry (positions, orientations) for collision detection |
| **Manufacturing Domain** | Topological sort of bend operations; checks each candidate sequence for tool-flange collision using tooling geometry from `manufacturing://tooling/press_brake` |
| **MCP Layer** | Orchestration only — passes data between contexts |

**Note:** Full collision simulation requires 3D tooling geometry models. For MVP, use a simplified rule-based sequence validator (sort bends longest-first, flag flanges that would collide with press brake backgauge).

### `export_production_pack`

| Layer | Responsibility |
|---|---|
| **OCC/CadQuery** | STEP assembly export; DXF wire export |
| **Geometry Engine Service** | Retrieves all `UnfoldId`s and `NestLayout` from `NestId`; writes DXF files per sheet |
| **Manufacturing Domain** | Generates BOM (part number, material, gauge, quantity, weight estimate); generates assembly instruction sequence |
| **MCP Layer** | Enqueues async export job; returns `job_id`; exposes `get_export_job_status` and `get_export_job_result`; enforces job retention for single-session lifecycle |

### `rollback`

| Layer | Responsibility |
|---|---|
| **OCC/CadQuery** | None — snapshot is a registry of `SolidId` / `ShellId` / `UnfoldId` references |
| **Geometry Engine Service** | Stores snapshot as a dict of registered shape IDs at each operation boundary; restores by re-pointing the active registry to the snapshot |
| **Manufacturing Domain** | Not involved |
| **MCP Layer** | Validates token; invokes Geometry Engine restore; clears downstream IDs (unfolds, nests) invalidated by the rollback |

---

## 5. Work Breakdown Structure

Stories are sized as S (< 1 day), M (1–2 days), L (3–5 days).

### Epic 1 — Geometry Engine

| ID | Story | Size | Notes |
|---|---|---|---|
| GE-01 | STEP import pipeline: load file, register `SolidId`, return bounding box | S | OCC `STEPControl_Reader` |
| GE-02 | Topology analysis: build face/edge adjacency graph from loaded solid | M | Custom OCC traversal |
| GE-03 | Manifold check and geometry healing | M | `BRepCheck_Analyzer`, `ShapeFix_Shape` |
| GE-04 | Boolean cut decomposition: slice solid by plane, register child shells | M | `BRepAlgoAPI_Cut` |
| GE-05 | Tab-and-slot geometry generation with kerf offset | L | Most complex OCC operation |
| GE-06 | Rivet hole generation | S | Cylinder boolean cut |
| GE-07 | Weld prep chamfer generation | S | |
| GE-08 | Corner relief generation (dogbone and circular) | M | |
| GE-09 | Sheet metal unfold (`UnfoldId` registration, K-factor input) | L | Highest geometric risk |
| GE-10 | DXF export of flat patterns | M | `BRepTools` + DXF writer |
| GE-11 | STEP assembly export | S | |
| GE-12 | Nesting integration (polygon extraction + libnest2d invocation) | L | Python binding to C++ lib |
| GE-13 | SVG nest preview generation | S | |
| GE-14 | Geometry snapshot and rollback registry | M | |

### Epic 2 — Manufacturing Domain

| ID | Story | Size | Notes |
|---|---|---|---|
| MD-01 | Material inventory store (load from config YAML) | S | |
| MD-02 | Tooling capability store (press brake specs from config) | S | |
| MD-03 | Logistics constraints store (envelope, weight, coating) | S | |
| MD-04 | Environmental context store (fire-rated, marine, vibration) | S | |
| MD-05 | K-factor and bend allowance calculation | S | Closed-form math |
| MD-06 | Minimum hole diameter rule validator | S | |
| MD-07 | Minimum flange width rule validator | S | |
| MD-08 | Minimum edge distance rule validator | S | |
| MD-09 | Tonnage estimation | S | |
| MD-10 | Joint type safety filter (fire-rated blocks adhesives/plastic) | S | |
| MD-11 | Bend sequence validator (simplified rule-based MVP) | M | |
| MD-12 | Manufacturability scorer (aggregate violations to 0.0–1.0) | M | |
| MD-13 | Grain direction constraint for nesting | S | |
| MD-14 | BOM generator (part number, material, weight estimate) | M | |
| MD-15 | Assembly instruction generator | M | |

### Epic 3 — Anti-Corruption Layer (Feature Extractor)

| ID | Story | Size | Notes |
|---|---|---|---|
| ACL-01 | Classify faces by surface type (planar, cylindrical, other) | M | OCC surface type query |
| ACL-02 | Classify edges by dihedral angle → bend detection | M | Angle threshold heuristic |
| ACL-03 | Detect holes from cylindrical face pairs | M | |
| ACL-04 | Detect flanges from adjacent planar face chains | M | |
| ACL-05 | Produce `FeatureSet` from `TopologyGraph` | S | Composition of ACL-01–04 |

### Epic 4 — MCP Protocol Layer

| ID | Story | Size | Notes |
|---|---|---|---|
| MCP-01 | MCP server scaffold (FastMCP or mcp-python-sdk, stdio transport) | M | |
| MCP-02 | Resource server: `context://`, `logistics://`, `manufacturing://` | M | Read from config YAML |
| MCP-03 | Resource server: `geometry://part/{id}/topology` | S | Reads from Geometry Engine registry |
| MCP-04 | Resource server: `geometry://part/{id}/features` | S | Calls Feature Extractor |
| MCP-05 | Resource server: `geometry://part/{id}/nest` | S | Reads from NestId registry |
| MCP-06 | Tool: `clean_geometry` | S | Thin orchestration |
| MCP-07 | Tool: `decompose_volume` (strategy dispatch) | M | Orchestration logic lives here |
| MCP-08 | Tool: `synthesize_joints` (with safety filter) | M | |
| MCP-09 | Tool: `generate_reliefs` | S | |
| MCP-10 | Tool: `apply_unfold` | S | |
| MCP-11 | Tool: `simulate_nesting` | S | |
| MCP-12 | Tool: `evaluate_manufacturability` | M | |
| MCP-13 | Tool: `validate_bend_sequence` | M | |
| MCP-14 | Tool: `export_production_pack` | M | |
| MCP-15 | Tool: `rollback` | M | |
| MCP-16 | Structured error model and error propagation | M | |

### Epic 5 — Infrastructure & Integration

| ID | Story | Size | Notes |
|---|---|---|---|
| INF-01 | Docker image: python:3.11-slim + OCC + mcp server | M | |
| INF-02 | Config YAML schema: materials, tooling, logistics, environmental | S | |
| INF-03 | Integration test: STEP → clean → decompose → tab-slot → unfold → nest → DXF | L | End-to-end golden path |
| INF-04 | Unit tests: Manufacturing Domain rules | M | Pure function, easy to test |
| INF-05 | Unit tests: Feature Extractor (test fixtures with known geometry) | M | |

### Recommended Build Order

```
Phase A (Foundation):
  GE-01 → GE-02 → GE-03          (load, analyse, heal)
  MD-01 → MD-02 → MD-03 → MD-04  (config stores)
  MCP-01 → MCP-02                  (server scaffold + static resources)

Phase B (Core Tools):
  GE-04 → GE-05 → GE-06           (decompose, joints, holes)
  MD-05 → MD-06 → MD-07 → MD-10   (rules + K-factor)
  ACL-01 → ACL-05                  (feature extractor)
  MCP-06 → MCP-07 → MCP-08         (clean, decompose, joints)

Phase C (Sheet Metal):
  GE-08 → GE-09 → GE-10           (reliefs, unfold, DXF)
  MD-11 → MD-12                    (bend sequence, scoring)
  MCP-09 → MCP-10 → MCP-12 → MCP-13

Phase D (Production Output + MVP):
  GE-12 → GE-13                   (nesting)
  MD-14 → MD-15                   (BOM, assembly instructions)
  MCP-11 → MCP-14 → MCP-15 → MCP-16
  INF-01 → INF-03                  (Docker + integration test)
```

---

## 6. Open Questions

Resolved decisions for MVP (updated May 13, 2026).

| # | Decision for MVP | Impact |
|---|---|---|
| OQ-01 | CadQuery unfold is sufficient for MVP. Revisit custom unfold only if validation drift appears in production. | Keeps GE-09 at S/M scope for MVP |
| OQ-02 | Use `libnest2d` for MVP nesting. Prefer native C++ implementation with a thin integration layer. | Improves deterministic nesting quality; adds native build complexity |
| OQ-03 | Bend sequence validation is rule-based for MVP. 3D collision simulation is deferred. | Keeps MD-11 at M scope |
| OQ-04 | MCP session model is single-session for MVP. | Simplifies state and rollback model |
| OQ-05 | Configuration is authored and updated through MCP tools/APIs (no admin UI in MVP). Tenant-specific overlays are deferred to cloud phase. | Keeps INF-02 scoped to schema + MCP config endpoints |
| OQ-06 | `export_production_pack` runs as an asynchronous job for MVP. | Avoids MCP timeout pressure; requires job status/polling contract |

### 6.1 Bounded Context Language Recommendations

Language preference order provided: C++ first, then TypeScript, then Python.

| Bounded Context | Recommended Language | Why this is appropriate | MVP Implementation Note |
|---|---|---|---|
| Geometry Engine | C++ | Native fit for OCC and `libnest2d`; best runtime and memory characteristics for geometry-heavy workloads. | Expose via a stable C ABI or RPC boundary to keep integration simple. |
| Anti-Corruption Layer (Feature Extractor) | C++ | Runs close to topology traversal and geometric classification; avoids expensive cross-language data marshalling. | Keep extracted feature DTOs plain and serialization-friendly. |
| Manufacturing Domain | TypeScript | Strong schema typing and maintainable rules engine ergonomics; good fit for JSON-centric constraints and policy logic. | Implement deterministic rule evaluation with explicit versioned rule packs. |
| MCP Protocol Layer | TypeScript | Excellent async model, mature MCP/JSON tooling, and clean orchestration for job-based workflows. | Implement async `export_production_pack` with `job_id`, `status`, and result retrieval tool/resource. |

### 6.2 Async Export Contract Status

OQ-06 is now reflected directly in Section 3.3:

1. `export_production_pack` now returns `job_id`, `status`, and `accepted_at`.
2. `get_export_job_status(job_id)` is defined for queue/progress/terminal states.
3. `get_export_job_result(job_id)` is defined for completed output retrieval.
4. Job scope and retention are defined as single-session lifecycle behavior.
