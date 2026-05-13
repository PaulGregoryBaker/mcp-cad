# MVP Scope: Explicitly Deferred Capabilities

**Task**: T020 | **Date**: 2026-05-13  
**Purpose**: Define explicit boundaries of MVP implementation. All items listed here are out-of-scope for the current implementation phase.

---

## In-Scope for MVP

- STEP AP203/AP214 import via OCCT
- Volume decomposition (2–5 panels) via boolean cut
- Tab-and-slot joint synthesis with kerf compensation
- Sheet metal unfolding via CadQuery (simple/moderate bends)
- 2D nesting via libnest2d with >80% material utilization
- Nested DXF export (per sheet)
- BOM CSV generation
- Assembly instructions JSON generation
- Rollback/snapshot for all mutating operations
- Manufacturing rule validation (bend radius, hole diameter, flange width, safety filters)
- In-process async export job queue
- Single-session state management (one design project per process)
- stdio MCP transport (Claude Desktop)
- Docker single-container deployment

---

## Deferred Capabilities

### Cloud Geometry APIs
- **Deferred**: Onshape API, Fusion 360 API, PTC Onshape integrations
- **Reason**: External dependency; requires OAuth2; breaks determinism guarantees
- **Post-MVP trigger**: Multi-tenant SaaS deployment

### Multi-Session Concurrency
- **Deferred**: Concurrent design sessions, multi-user access
- **Reason**: In-process state management is single-session by design
- **Post-MVP trigger**: BullMQ/Redis job queue migration

### 3D Bend Collision Simulation
- **Deferred**: Full 3D simulation of press brake collision during bend sequence
- **Reason**: Computationally intensive; requires physics simulation beyond MVP scope
- **Current MVP**: Rule-based topological validation (heuristic collision detection)
- **Post-MVP trigger**: Customer need for complex multi-axis assemblies

### Tenant-Specific Configuration Overlays
- **Deferred**: Per-tenant material/tooling configuration, multi-tenant config management
- **Reason**: Single-tenant deployment for MVP; config loaded from static YAML
- **Post-MVP trigger**: SaaS product offering

### OAuth2 / Distributed Deployment
- **Deferred**: JWT authentication, role-based access control, Kubernetes deployment
- **Reason**: MVP is local/edge deployment; no authentication required
- **Post-MVP trigger**: Cloud deployment

### BullMQ / Redis Job Queue
- **Deferred**: Distributed job queue for export operations
- **Reason**: In-process Promise queue is sufficient for single-session MVP
- **Post-MVP trigger**: Multi-session or cloud deployment
- **Note**: Job interface is designed for BullMQ migration (see `research.md §In-Process Promise Job Queue`)

### STEP Assembly Export
- **Deferred**: Multi-part STEP assembly output from decomposition result
- **Reason**: DXF per-panel is sufficient for MVP laser/waterjet cutting
- **Post-MVP trigger**: CNC machining workflow support

### 180° Hem Flange Unfolding
- **Deferred**: Custom OCC-based unfolding for hem flanges
- **Reason**: CadQuery handles the 4/5 MVP cases; hem flanges deferred
- **Post-MVP trigger**: Customer need for hem flange designs
- **Fallback**: `BRepOffsetAPI_MakeFlatFace` candidate (validated in research.md)

### HTTP+SSE Transport
- **Deferred**: HTTP/SSE transport for cloud MCP server
- **Reason**: stdio is sufficient for Claude Desktop MVP
- **Post-MVP trigger**: Cloud deployment, web-based client

### SVG Nesting Preview
- **Status**: Implemented in MVP as debugging aid
- **Production UI**: Deferred (SVG rendering in client application post-MVP)

---

## MVP Success Criteria

A design can be processed from STEP input to nested DXF output (with BOM and assembly instructions) within 30 seconds, without errors, for a 2–5 panel sheet metal assembly.

See `docs/MVP_ACCEPTANCE.md` (generated in Phase D) for gate checklist.
