# Module Map: Service Decomposition Refactor

This document describes the target file structure after the refactor. It replaces the traditional data-model artifact since this feature reorganises code rather than introducing new data entities.

## C++ Geometry Layer

### Current state
```text
cpp/src/geometry/
├── geometry_service.cc       ← 9,242 lines (decompose this)
├── geometry_service.hpp      ← class declaration (keep, minimal edits)
├── nesting.hpp
├── relief.hpp
├── shape_history.cc
├── shape_history.hpp
├── snapshot.hpp
├── topology_graph.cc
└── topology_graph.hpp
```

### Target state
```text
cpp/src/geometry/
├── geometry_service.hpp              ← unchanged (facade declaration)
├── geometry_service_core.cc          ← constructor, clearState, clearSnapshots, restoreSnapshot, utilities
├── geometry_service_validation.cc    ← checkManifold, healGeometryEx, simplifyBody
├── geometry_service_booleans.cc      ← fuseBodies, cutBodies, intersectBodies
├── geometry_service_transforms.cc    ← translateBody, rotateBody, mirrorBody, scaleBody, alignToFace
├── geometry_service_modelling.cc     ← filletEdges, chamferEdges, offsetShape, deleteFace, sewFaces, closeGap
├── geometry_service_shell.cc         ← separateSolids, thickenSheet, reconstructCurvedBends, getPanelFrame
├── geometry_service_export.cc        ← exportDxf, buildSheetFromDxf, exportGlb
├── geometry_service_measurement.cc   ← computeBoundingBox, computeMassProperties, measureDistance, exploreTopology
├── geometry_service_assembly.cc      ← createAssemblyDocument, addAssemblyInstance, mateRigid, listAssemblyTree
├── geometry_service_sheet_metal.cc   ← splitBodyByBends, validateSheetMetal
├── nesting.hpp
├── relief.hpp
├── shape_history.cc
├── shape_history.hpp
├── snapshot.hpp
├── topology_graph.cc
└── topology_graph.hpp
```

**Note**: `geometry_service.cc` (the original monolith) is deleted. Its content is redistributed into the `_core`, `_validation`, `_booleans`, etc. files above.

### Method → File mapping

| Method | Target file |
|--------|-------------|
| `checkManifold` | `geometry_service_validation.cc` |
| `separateSolids` | `geometry_service_shell.cc` |
| `unfoldShell` | `geometry_service_shell.cc` |
| `exportDxf` | `geometry_service_export.cc` |
| `buildSheetFromDxf` | `geometry_service_export.cc` |
| `thickenSheet` | `geometry_service_shell.cc` |
| `getPanelFrame` | `geometry_service_shell.cc` |
| `exportGlb` | `geometry_service_export.cc` |
| `restoreSnapshot` | `geometry_service_core.cc` |
| `computeBoundingBox` | `geometry_service_measurement.cc` |
| `computeMassProperties` | `geometry_service_measurement.cc` |
| `measureDistance` | `geometry_service_measurement.cc` |
| `exploreTopology` | `geometry_service_measurement.cc` |
| `fuseBodies` | `geometry_service_booleans.cc` |
| `cutBodies` | `geometry_service_booleans.cc` |
| `intersectBodies` | `geometry_service_booleans.cc` |
| `translateBody` | `geometry_service_transforms.cc` |
| `rotateBody` | `geometry_service_transforms.cc` |
| `mirrorBody` | `geometry_service_transforms.cc` |
| `scaleBody` | `geometry_service_transforms.cc` |
| `alignToFace` | `geometry_service_transforms.cc` |
| `filletEdges` | `geometry_service_modelling.cc` |
| `chamferEdges` | `geometry_service_modelling.cc` |
| `simplifyBody` | `geometry_service_validation.cc` |
| `healGeometryEx` | `geometry_service_validation.cc` |
| `offsetShape` | `geometry_service_modelling.cc` |
| `deleteFace` | `geometry_service_modelling.cc` |
| `sewFaces` | `geometry_service_modelling.cc` |
| `createAssemblyDocument` | `geometry_service_assembly.cc` |
| `addAssemblyInstance` | `geometry_service_assembly.cc` |
| `mateRigid` | `geometry_service_assembly.cc` |
| `listAssemblyTree` | `geometry_service_assembly.cc` |
| `clearSnapshots` | `geometry_service_core.cc` |
| `clearState` | `geometry_service_core.cc` |
| `closeGap` | `geometry_service_modelling.cc` |
| `splitBodyByBends` | `geometry_service_sheet_metal.cc` |
| `validateSheetMetal` | `geometry_service_sheet_metal.cc` |
| `reconstructCurvedBends` | `geometry_service_shell.cc` |

## TypeScript MCP Layer

### Current state
```text
ts/src/mcp/
├── errors.ts
├── resources.ts
├── tools.ts        ← 6,339 lines (decompose this)
└── transactions.ts
```

### Target state
```text
ts/src/mcp/
├── errors.ts          ← unchanged
├── resources.ts       ← unchanged
├── transactions.ts    ← unchanged
├── state.ts           ← extracted: binding mock, semantic store, graph, parts map, solver init
├── tools.ts           ← thin barrel: re-exports getToolDefinitions, dispatchTool, test helpers
├── handlers/
│   ├── body-ops.ts          ← body geometry: clean, measurements, transforms, modelling
│   ├── booleans.ts          ← fuse, cut, intersect
│   ├── shape-ops.ts         ← split, merge, close gap, panel ops, boundary
│   ├── manufacturing.ts     ← decompose, joints, reliefs, sheet metal, manufacturability
│   ├── unfold-export.ts     ← apply unfold, export production pack, job status/result
│   ├── assembly.ts          ← assembly document CRUD + validate
│   ├── transactions.ts      ← rollback, begin/commit/rollback transaction, history
│   ├── semantic.ts          ← declare, bind, resolve, lineage
│   ├── graph.ts             ← part CRUD, bootstrap, bend, solve, foldability, graph ops, join/cut
│   └── mapping.ts           ← map_3d_to_2d, map_2d_to_3d
└── registry.ts       ← assembles getToolDefinitions() from handler modules
```

### Handler → Module mapping

Each handler module exports:
- An array of tool definitions (schema objects)
- Named handler functions

The `registry.ts` spreads all definition arrays into one export.
The `dispatch.ts` (or updated `tools.ts`) maps case labels to imported handler functions.

## Build System Changes

### C++ (CMakeLists.txt)
Replace the single `geometry_service.cc` source entry with all new `.cc` files:
```cmake
target_sources(mcp_cad_geometry PRIVATE
  geometry_service_core.cc
  geometry_service_validation.cc
  geometry_service_booleans.cc
  geometry_service_transforms.cc
  geometry_service_modelling.cc
  geometry_service_shell.cc
  geometry_service_export.cc
  geometry_service_measurement.cc
  geometry_service_assembly.cc
  geometry_service_sheet_metal.cc
  shape_history.cc
  topology_graph.cc
  unfold.cc
)
```

### TypeScript (tsconfig / imports)
No tsconfig changes needed. All new modules are in the same `ts/src/mcp/` tree. Existing callers that import from `ts/src/mcp/tools` continue to work because `tools.ts` remains as a barrel.
