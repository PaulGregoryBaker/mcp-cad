# Contract: Manufacturing Port (Manufacturing Domain Interface)

**Phase**: Phase 1 | **Status**: Complete  
**Task**: T015 | **Date**: 2026-05-13  
**Reference**: Engineering-Design.md §3, data-model.md

---

## Overview

The Manufacturing Port defines the interface between the MCP Protocol Layer and the Manufacturing Domain. The Manufacturing Domain contains all rule-based validation, scoring, BOM generation, and assembly instruction logic.

---

## Config Loader Interface

### `loadConfig(configPath: string): ManufacturingConfig`

```typescript
import { ManufacturingConfig } from '../data-model';

function loadConfig(configPath: string): ManufacturingConfig;
```

- Throws `ConfigValidationError` if YAML schema is invalid.
- Returns fully-validated `ManufacturingConfig` with all sub-entities populated.

---

## Material Rules Interface

### `computeBendAllowance(material: MaterialSpec, angleDeg: number, radiusMm: number): number`

Returns bend allowance in mm using the K-factor formula:

$$BA = (\pi / 180) \times \text{angle} \times (\text{radius} + k \times t)$$

Where $t$ = material thickness, $k$ = K-factor.

```typescript
function computeBendAllowance(material: MaterialSpec, angleDeg: number, radiusMm: number): number;
```

---

## Validation Rules Interface

### `validateBend(feature: BendFeature, material: MaterialSpec, tooling: ToolingCapability): ValidationResult`

```typescript
interface ValidationResult {
  valid: boolean;
  violations: RuleViolation[];
}

interface RuleViolation {
  ruleCode: string;          // e.g., "MIN_BEND_RADIUS"
  severity: 'error' | 'warning';
  featureId: string;
  description: string;
  measuredValueMm?: number;
  limitValueMm?: number;
}

function validateBend(feature: BendFeature, material: MaterialSpec, tooling: ToolingCapability): ValidationResult;
```

**Rules checked**:
- `MIN_BEND_RADIUS`: inner radius >= material thickness
- `MAX_BEND_ANGLE`: angle <= 180°
- `MIN_FLANGE_WIDTH`: adjacent flange width >= 4× material thickness
- `PRESS_BRAKE_TONNAGE`: estimated tonnage <= max press tonnage

---

### `validateHole(feature: HoleFeature, material: MaterialSpec, tooling: ToolingCapability): ValidationResult`

```typescript
function validateHole(feature: HoleFeature, material: MaterialSpec, tooling: ToolingCapability): ValidationResult;
```

**Rules checked**:
- `MIN_HOLE_DIAMETER`: diameter >= material thickness
- `MIN_HOLE_EDGE_DISTANCE`: center-to-edge >= 1.5× diameter
- `MIN_HOLE_SPACING`: center-to-center >= 2× diameter

---

### `validateFlange(feature: FlangeFeature, material: MaterialSpec): ValidationResult`

```typescript
function validateFlange(feature: FlangeFeature, material: MaterialSpec): ValidationResult;
```

**Rules checked**:
- `MIN_FLANGE_WIDTH`: width >= 4× material thickness
- `MAX_FLANGE_LENGTH`: length <= press brake max bend length

---

## Safety Filter Interface

### `isJointTypeAllowed(jointType: JointType, env: EnvironmentalContext): SafetyFilterResult`

```typescript
type JointType = 'tab_slot' | 'rivet' | 'weld' | 'adhesive' | 'plastic_fastener';

interface SafetyFilterResult {
  allowed: boolean;
  reason?: string;          // Required if allowed=false
  overrideable: boolean;    // Always false (Constitution Principle III)
}

function isJointTypeAllowed(jointType: JointType, env: EnvironmentalContext): SafetyFilterResult;
```

**Safety filter rules** (non-bypassable per Constitution Principle III):
- `fireRated=true` → blocks `adhesive`, `plastic_fastener`
- `marineGrade=true` → blocks `adhesive`
- `highVibration=true` → blocks `adhesive`

---

## Manufacturability Scoring Interface

### `scorePanel(featureSet: FeatureSet, config: ManufacturingConfig): ManufacturabilityScore`

```typescript
interface ManufacturabilityScore {
  score: number;             // 0.0 (non-manufacturable) – 1.0 (fully compliant)
  violations: RuleViolation[];
  summary: string;
}

function scorePanel(featureSet: FeatureSet, config: ManufacturingConfig): ManufacturabilityScore;
```

---

## Bend Sequence Interface

### `validateBendSequence(featureSet: FeatureSet, tooling: ToolingCapability): BendSequenceResult`

```typescript
interface BendSequenceResult {
  valid: boolean;
  suggestedSequence: string[];  // featureIds in recommended bend order
  collisionWarnings: CollisionWarning[];
}

interface CollisionWarning {
  bendIdA: string;
  bendIdB: string;
  description: string;
}

function validateBendSequence(featureSet: FeatureSet, tooling: ToolingCapability): BendSequenceResult;
```

---

## BOM Generation Interface

### `generateBOM(featureSets: FeatureSet[], config: ManufacturingConfig): BOMResult`

```typescript
interface BOMResult {
  csvContent: string;
  lineItems: BOMLineItem[];
}

interface BOMLineItem {
  partId: string;
  description: string;
  materialId: string;
  quantityMm2: number;
  estimatedCost: number;
  currency: 'USD';
}

function generateBOM(featureSets: FeatureSet[], config: ManufacturingConfig): BOMResult;
```

---

## Assembly Instructions Interface

### `generateAssembly(featureSets: FeatureSet[], joints: JointSpec[]): AssemblyResult`

```typescript
interface JointSpec {
  shellIdA: string;
  shellIdB: string;
  jointType: JointType;
}

interface AssemblyResult {
  jsonContent: string;
  steps: AssemblyStep[];
}

interface AssemblyStep {
  stepNumber: number;
  description: string;
  toolingRequired: string[];
  panelIds: string[];
  estimatedTimeMin: number;
}

function generateAssembly(featureSets: FeatureSet[], joints: JointSpec[]): AssemblyResult;
```
