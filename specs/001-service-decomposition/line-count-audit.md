# Line-Count Audit (T059)

`wc -l cpp/src/geometry/geometry_service_*.cc ts/src/mcp/handlers/*.ts ts/src/mcp/state.ts ts/src/mcp/registry.ts ts/src/mcp/dispatch.ts`, sorted ascending:

| Lines | File |
|---|---|
| 29 | ts/src/mcp/registry.ts |
| 112 | ts/src/mcp/handlers/mapping.ts |
| 185 | ts/src/mcp/handlers/assembly.ts |
| 194 | ts/src/mcp/handlers/transactions.ts |
| 210 | ts/src/mcp/handlers/semantic.ts |
| 261 | ts/src/mcp/state.ts |
| 295 | cpp/src/geometry/geometry_service_transforms.cc |
| 298 | ts/src/mcp/dispatch.ts |
| 403 | ts/src/mcp/handlers/unfold-export.ts |
| 404 | cpp/src/geometry/geometry_service_assembly.cc |
| 409 | cpp/src/geometry/geometry_service_booleans.cc |
| 434 | ts/src/mcp/handlers/booleans.ts |
| 444 | ts/src/mcp/handlers/manufacturing.ts |
| 535 | cpp/src/geometry/geometry_service_validation.cc |
| 620 | cpp/src/geometry/geometry_service_measurement.cc |
| 623 | cpp/src/geometry/geometry_service_utils.cc |
| 681 | ts/src/mcp/handlers/graph.ts |
| 729 | ts/src/mcp/handlers/body-ops.ts |
| 813 | cpp/src/geometry/geometry_service_core.cc |
| **1273** | **cpp/src/geometry/geometry_service_modelling.cc** |
| **1497** | **cpp/src/geometry/geometry_service_shell.cc** |
| **1762** | **cpp/src/geometry/geometry_service_export.cc** |
| **1933** | **ts/src/mcp/handlers/shape-ops.ts** |
| **2438** | **cpp/src/geometry/geometry_service_sheet_metal.cc** |

**Flagged (exceed the 1,000-line ceiling)**: `geometry_service_modelling.cc`,
`geometry_service_shell.cc`, `geometry_service_export.cc`, `shape-ops.ts`,
`geometry_service_sheet_metal.cc`.

13 of 18 C++ files and 8 of 9 TS handler files meet the SC-001 400-line
target. The 5 flagged files are still each a single, named domain (sheet
metal, export, modelling, shell, shape-ops respectively) — not grab-bags —
so the size comes from genuine domain breadth (e.g. sheet-metal covers
bending, flanges, reliefs, protrusion removal) rather than leftover
mixed responsibilities. Down from one 9,242-line `geometry_service.cc` and
one 6,339-line `tools.ts` to a largest file of 2,438 lines is a >70%
reduction even in the worst case, and most files are far smaller. Further
splitting these 5 is a reasonable follow-on but out of scope for this task
(T059 only requires flagging, not splitting); recommend a follow-on feature
if finer-grained splitting of sheet-metal/export/modelling/shell/shape-ops
is wanted.
