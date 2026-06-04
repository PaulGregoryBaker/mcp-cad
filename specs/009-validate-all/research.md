# Research: Assembly Validation and Autofix Recommendations

## Overview
We need to design an efficient assembly-wide validation system (`validate_assembly`) that checks for:
1. Sheet metal unfolding errors.
2. Part intersections/clashes.
3. Extensible rules (semantic graph, manufacturing, nesting).

We also need to provide structured `autofix` recommendations (tool names and parameters) for each validation error.

---

## 1. Efficient Clash/Intersection Detection (Avoiding $O(N^2)$ Complexity)

### Problem
An assembly of $N$ parts has $N(N-1)/2$ potential clashing pairs. For $N = 500$, this is $124,750$ pairs. Running exact B-Rep solid-solid intersection checks (which are computationally expensive in OpenCASCADE) on all pairs would violate our requirement of completing validation under 2 seconds.

### Solution: Two-Level Filtering Pipeline
1. **Adjacency Pruning (Semantic/Graph Level)**:
   - According to the requirements, clash checks only need to be performed on parts that are *adjacent* in the assembly tree/semantic graph.
   - We query the semantic graph (or parent-child relationships) to identify adjacent parts. For $N$ parts, the number of adjacent pairs $M$ is typically $O(N)$ (roughly $2N$ to $3N$ edges in the contact graph).
2. **AABB Proximity Filtering (Geometric Level)**:
   - For the $M$ adjacent pairs, we compute their Axis-Aligned Bounding Boxes (AABBs) using OpenCASCADE's `BRepBndLib::AddOptimal`.
   - We check if their AABBs overlap (a very fast $O(1)$ interval comparison). If they do not overlap, they cannot physically intersect, and we skip exact checks.
3. **Exact B-Rep Intersection Check**:
   - Only for pairs that are both *adjacent* AND have *overlapping AABBs*, we run a B-Rep clash check using `BRepAlgoAPI_Common` or `BRepAlgoAPI_Section`.
   - If the intersection result is a solid/shell with positive volume/area (greater than a tiny tolerance like $10^{-3} \text{ mm}^3$), we classify it as a physical clash/overlap.

### Performance Analysis
- **AABB calculation**: $O(N)$ using optimal bounds.
- **Filtering**: $O(N)$ because the contact graph is sparse.
- **B-Rep checks**: Performed only on $K$ pairs where $K \le M \ll N^2$. Typically, $K \approx 0$ to $5$ pairs.
- This easily achieves our performance target of $< 2.0\text{ seconds}$ for $N = 500$.

---

## 2. Extensible Rule Engine

### Architecture
To support the Open-Closed Principle (SC-004), we will implement a registry-based Validation Engine in TypeScript/C++:
* A `ValidationEngine` class maintains a registry of `ValidationRule` implementations grouped by category.
* Each `ValidationRule` implements an interface:
  ```typescript
  interface ValidationRule {
    name: string;
    category: 'sheet_metal' | 'clash_detection' | 'semantic_graph' | 'manufacturing' | 'nesting';
    validate(context: ValidationContext): Promise<ValidationError[]>;
  }
  ```
* The `validate_assembly` tool queries all registered rules, runs them, and aggregates their results.
* New modules (e.g., `NestingRule`, `ManufacturingAccessRule`) can be registered at startup via a simple `registerRule()` API without modifying the core validation manager.

---

## 3. Autofix Recommendations

### Structure
Each `ValidationError` includes a structured recommendation payload that allows AI agents to automatically invoke repair tools:
```typescript
interface AutofixRecommendation {
  tool_name: string;
  arguments: Record<string, any>;
}
```

### Typical Mappings
1. **Sheet Metal Unfolding Failure**:
   - If the part is not planar or lacks thickness: recommend `split_body_by_bends` with `part_id` and the default or detected `max_thickness_mm`.
   - If there is a missing corner seam: recommend `rip_edge` with `part_id` and the candidate `edge_id`.
2. **Adjacent Part Intersection**:
   - Recommend `trim_body_with_plane` specifying the `part_id` of the overlapping part and the `plane` parameters computed from the interface face of the host part.

---

## Decisions & Rationale

- **Decision**: Use a combination of AABB filtering and contact-graph filtering for clash detection.
  - **Rationale**: Meets the strict performance requirement while ensuring that exact math is only run where parts are expected to touch.
- **Decision**: Return Autofix recommendations as metadata only (Question 2: Option A).
  - **Rationale**: Keeps the core validation decoupled, secure, and easily reviewable by the client/user.
