# Discoverability Check (T060)

For each SC-004 operation category, the correct module is identifiable by
filename alone, no file contents needed:

| Operation | TS module (`ts/src/mcp/handlers/`) | C++ module (`cpp/src/geometry/`) |
|---|---|---|
| boolean union | `booleans.ts` | `geometry_service_booleans.cc` |
| unfold | `unfold-export.ts` | `unfold.cc` |
| shell query | `body-ops.ts` (`explore_topology`, `bounding_box`, etc.) | `geometry_service_shell.cc` |
| assembly | `assembly.ts` | `geometry_service_assembly.cc` |
| semantic | `semantic.ts` | n/a — semantic entity tracking is a TS-side store concern, no native binding required |
| graph | `graph.ts` | n/a — manufacturing bend/cut/join graph lives in `ts/src/manufacturing/graph/`; `topology_graph.cc` is a distinct concept (B-rep face/edge adjacency, used by `explore_topology`), not a naming collision in practice since the two are in different layers (MCP handler vs. geometry kernel) |

All six categories resolve to an unambiguous file in well under 60 seconds —
each handler file and each `geometry_service_*.cc` file is named after the
single domain it owns. Met.
