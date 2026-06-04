# Research Report: Build Manufacturing Plan

## 1. Existing Capabilities

### C++ Geometry Engine (`splitBodyByBends`)
The native C++ Geometry Service already implements:
- **Facet Unification**: Merges coplanar triangular facets from complex models.
- **Decomposition Modes**: Thin-solid cutting (Mode 2) using cutting planes and BFS (Mode 1) for surface/thick models.
- **Protrusion Isolation**: Automatically extracts tabs/bosses/gussets (`protrusion_ids`) and tracks which panel they originate from (`protrusion_parents`).
- **AABB Calculation**: Exposes vertex-based tight bounding boxes for panels and protrusions.

### TypeScript Manufacturing Graph (`bootstrapGraph`)
The TypeScript layer currently includes `bootstrapGraph()` in `ts/src/manufacturing/graph/bootstrap.ts`, which:
- Calls the NAPI `splitBodyByBends` binding.
- Creates `PanelNode` entries for each detected panel.
- Classifies junctions (coplanar fusion vs. bend creation) using a basic sequential heuristic.
- Instantiates a `FoldabilityChecker` to return advisory foldability warnings.

---

## 2. Technical Approach for Reconstruction Orchestrator

To implement the requirements of `build_manufacturing_plan`, the orchestrator will execute the following workflow:

### Step 1: Initial Decompose with Split Pair Tracking
We will extend the C++ `splitBodyByBends` to populate `splitPairs` during the decomposition process. 
- When a cut is executed between two face groups (mode 2) or when BFS partitions the face list (mode 1), the C++ engine maps which panel IDs share the splitting plane or boundary edge.
- The NAPI wrapper converts this into a JS array of string arrays `split_pairs` (`Array<[string, string]>`).
- This provides an authoritative topological adjacency list from the C++ layer, bypassing the need for expensive geometric distance-probing heuristics in TS.

### Step 2: Panel Validation
Run `isPanelValid` (which maps to C++ `validateSheetMetal`) for each panel ID:
- If a panel is invalid (e.g. non-uniform thickness), we log a validation error and flag it.
- Valid panels are added as `PanelNode`s to a local manufacturing graph instance.

### Step 3: Protrusion (Non-Panel) Isolation
Per Q2 choice, all `protrusion_ids` are:
- Kept as separate bodies in the session.
- Excluded from the manufacturing graph.
- Added to the `unmerged_parts` list in the final report.

### Step 4: Adjacency Mapping from `split_pairs`
- We directly construct the candidate joint list from the `split_pairs` returned by NAPI.
- For each pair in `split_pairs`, we look up the dihedral angle and confirm if they require coplanar fusion or a bend joint.
- Add candidate `BendNode`s to the manufacturing graph for non-coplanar adjacent pairs.

### Step 5: Merge Rating & Prioritization Pass
To ensure a structured and robust reassembly process, candidate merges are ranked and prioritized before trial merging. The priority rating is computed as follows:
1. **Dihedral Angle Score**: Standard 90-degree bends are prioritized first (Score = 100), as they represent the golden-path sheet metal tooling. Non-standard angles (e.g. 45° or 135°) are rated lower (Score = 50).
2. **Size/Mass Balance**: Merges between larger panels and smaller flanges are prioritized (Score based on the ratio of bounding box volumes) to establish a stable reference panel early in the graph.
3. **Collision Clearance**: Bends with larger clearances (fewer nearby protrusion bounding boxes) are prioritized to resolve non-complex sheets first.

The prioritized list is sorted in descending order of the combined score.

### Step 6: Trial Merge & Validation (Manufacturing Checks)
Iterate through the prioritized candidate merges:
1. Temporarily merge the two adjacent panels via `mergeBodiesWithBend`.
2. Run the `DrcChecker` and `FoldabilityChecker` on the candidate graph.
3. **DRC / Foldability Violations**:
   - If a collision occurs or foldability is blocked, mark the joint as impossible.
   - Roll back the merge operation for this joint.
   - Keep the panels as separate bodies and log the skipped joint in the report.
4. **Valid Joint**:
   - Keep the merge and update the active part ID.

### Step 7: Final Output
Return the structured report detailing the reconstructed single part, unmerged parts (non-panels and skipped panels), and skipped/impossible joints.

---

## 3. Alternatives Considered

### Alternative A: Perform reconstruction in C++ Geometry Engine
- *Pros*: Faster execution time.
- *Cons*: Violates Bounded Context Separation (Principle II). Bending limits, DRC rules, and foldability checks are owned by the TypeScript Manufacturing Domain. Putting this orchestration in C++ would leak manufacturing domain knowledge into the Geometry Engine.
- *Decision*: Rejected. Keep orchestration in the TypeScript layer.

### Alternative B: Discard non-panel protrusions
- *Pros*: Simplifies final assembly.
- *Cons*: Discards necessary components (welded nuts, inserts) and makes it impossible to reproduce the exact imported STEP geometry.
- *Decision*: Rejected in favor of keeping them as separate bodies (Q2 choice).
