# Data Model: Assembly Validation

This document defines the schemas and structures used by the validation engine at the C++ and TypeScript layers.

---

## TypeScript Layer Schemas (`ts/src/geometry/types.ts`)

### `validate_assembly` Input Parameters
```typescript
export interface ValidateAssemblyParams {
  /**
   * Optional list of specific part IDs to validate.
   * If omitted, validates all parts in the active workspace.
   */
  part_ids?: string[];
  
  /**
   * Optional map of part IDs to their explicit sheet metal flags.
   * Overrides database metadata.
   */
  sheet_metal_flags?: Record<string, boolean>;
}
```

### Validation Report Output
```typescript
export interface ValidationReport {
  /**
   * Overall validation status.
   */
  valid: boolean;
  
  /**
   * List of all validation errors, warnings, or informational checks.
   */
  errors: ValidationError[];
  
  /**
   * Performance and execution metadata.
   */
  summary: {
    total_parts_checked: number;
    rule_count: number;
    execution_time_ms: number;
  };
}

export interface ValidationError {
  id: string;
  category: 'sheet_metal' | 'clash_detection' | 'semantic_graph' | 'manufacturing' | 'nesting';
  severity: 'error' | 'warning' | 'info';
  message: string;
  affected_part_ids: string[];
  autofix?: AutofixRecommendation;
}

export interface AutofixRecommendation {
  tool_name: string;
  arguments: Record<string, any>;
}
```

---

## C++ Layer Structs (`geometry_service.hpp`)

We expose a new method `checkAssemblyClashes` in the `GeometryService` to support fast AABB filtering and topological checks in native code.

```cpp
struct BBox3D {
  double xMin, yMin, zMin;
  double xMax, yMax, zMax;
};

struct ClashPair {
  ShellId partA;
  ShellId partB;
  double  overlapVolume; // volume of intersection (or area if in surface mode)
};

class GeometryService {
public:
  virtual std::vector<ClashPair> checkAssemblyClashes(
      const std::vector<ShellId>& partIds,
      const std::vector<std::pair<ShellId, ShellId>>& adjacentPairs) = 0;
};
```

---

## Bounded Context Boundaries

1. **Geometry Engine**:
   - Calculates AABBs (`Bnd_Box`) and computes topological intersection shapes (`BRepAlgoAPI_Common`).
   - Pure geometric computations; unaware of rules or autofixes.
2. **Feature Extractor (Anti-Corruption Layer)**:
   - Translates geometric clash structures (`ClashPair`) and unfolding status into higher-level validation reports.
3. **Manufacturing Domain (TypeScript)**:
   - Evaluates sheet-metal properties, checks semantic graphs, and aggregates Autofix recommendations (mapping errors to MCP tool commands).
