# Testing Strategy

## Purpose

Define a consistent, auditable testing approach for the MCP-CAD system across all bounded contexts (BCs), with clear local and CI execution paths, JTBD-based functional validation, and requirement traceability.

This strategy is designed to:
- Prevent regressions in deterministic geometry and manufacturing rules.
- Validate interface contracts between BCs.
- Prove end-to-end production readiness for MVP acceptance.
- Provide evidence for phase gates and release sign-off.

## Scope

Applies to all four BCs:
- Geometry Engine (GE)
- Manufacturing Domain (MD)
- Feature Extractor / Anti-Corruption Layer (ACL)
- MCP Protocol Layer (MCP)

Also applies to cross-BC flows and non-functional quality gates (stability, determinism, performance, memory safety).

---

## Corrected Terminology

To avoid ambiguity, the project will use these terms:

1. Unit tests
- Test a single function/class/module in isolation.
- Fast, deterministic, no external process orchestration.

2. Contract tests
- Validate interface compatibility between producer and consumer.
- Includes:
  - NAPI boundary contracts (TypeScript <-> C++)
  - MCP tool input/output schema contracts
  - Error model contracts

3. BC functional tests (preferred term: BC integration tests)
- Validate business behavior within one BC, including collaboration of internal modules.
- Example: MD evaluates manufacturability across rule engine + validators + config.

4. Cross-BC functional tests (preferred term: system integration tests)
- Validate multi-BC workflows with real boundaries.
- Example: GE decomposition + ACL extraction + MD validation + MCP orchestration.

5. End-to-end acceptance tests
- Validate user-visible outcomes and acceptance criteria from external entrypoint to final artifacts.
- MVP anchor: INF-03 golden path.

6. Non-functional tests
- Memory safety, determinism, performance, and stability.

---

## Test Architecture

## Test Pyramid

1. Unit (largest volume)
- GE: geometry operations and helpers
- MD: pure rule functions and scoring
- ACL: classification helpers and feature composition
- MCP: command handlers and error mapping

2. Contract
- NAPI serialization/deserialization invariants
- MCP tool schema and structured error compliance
- Resource schema/config loader compatibility

3. BC integration
- Internal BC workflows with realistic fixtures

4. System integration (cross-BC)
- Multi-step, multi-context orchestration flows

5. E2E acceptance (smallest volume, highest confidence)
- Full STEP -> production export flow with acceptance checks

---

## Test Responsibilities by Bounded Context (JTBD)

## GE: Geometry Engine

Jobs to be done:
- GE-JTBD-01: Ingest STEP and produce valid geometry handle.
- GE-JTBD-02: Build topology graph and classify manifold quality.
- GE-JTBD-03: Heal repairable geometry deterministically.
- GE-JTBD-04: Perform decomposition and joint geometry with kerf compliance.
- GE-JTBD-05: Unfold panels and export valid DXF wire geometry.
- GE-JTBD-06: Simulate nesting with utilization targets.
- GE-JTBD-07: Snapshot and rollback atomic geometry states.

Primary test layers:
- Unit: topology operations, manifold checks, helper math.
- Contract: NAPI type and precision boundaries.
- BC integration: ingest -> analyze -> mutate -> export workflow inside GE.
- Non-functional: sanitizer, determinism replay, benchmark thresholds.

## MD: Manufacturing Domain

Jobs to be done:
- MD-JTBD-01: Load and validate manufacturing configuration.
- MD-JTBD-02: Validate bends/holes/flanges against constraints.
- MD-JTBD-03: Enforce safety filter constraints by environment.
- MD-JTBD-04: Compute K-factor and bend allowance deterministically.
- MD-JTBD-05: Compute manufacturability score with explainable violations.
- MD-JTBD-06: Generate BOM and assembly instructions.

Primary test layers:
- Unit: rule functions, scoring math, config validators.
- Contract: config schema and error format.
- BC integration: feature set + config -> pass/fail + score + outputs.

## ACL: Feature Extractor

Jobs to be done:
- ACL-JTBD-01: Translate B-Rep topology to manufacturing features.
- ACL-JTBD-02: Extract bends with angle/radius/length fidelity.
- ACL-JTBD-03: Detect holes/flanges and compose FeatureSet.

Primary test layers:
- Unit: classification algorithms.
- Contract: feature DTO compatibility for MD consumption.
- BC integration: geometry sample -> feature set quality metrics.

## MCP: Protocol Layer

Jobs to be done:
- MCP-JTBD-01: Expose resources and tools with schema correctness.
- MCP-JTBD-02: Orchestrate cross-BC workflows deterministically.
- MCP-JTBD-03: Return structured errors for all failure paths.
- MCP-JTBD-04: Manage async export lifecycle (submit/status/result).
- MCP-JTBD-05: Manage rollback tokens and restoration.

Primary test layers:
- Unit: tool handler logic and error wrapper behavior.
- Contract: input/output schema, error object compliance.
- BC integration: orchestrated calls with mocked/real adapters as appropriate.

---

## Cross-BC JTBD System Integration Tests

These tests deploy all BCs together and run realistic user flows.

1. SYS-JTBD-01: STEP Clean and Decompose
- Flow: MCP clean_geometry -> GE ingest/heal -> MCP decompose_volume -> GE split -> ACL extract -> MD validate
- Assertions: deterministic shell count, topology consistency, no unstructured errors.

2. SYS-JTBD-02: Joint Synthesis with Safety
- Flow: MCP synthesize_joints -> MD safety filter -> GE joint generation with kerf
- Assertions: forbidden joints rejected in fire-rated context, kerf offset within tolerance.

3. SYS-JTBD-03: Unfold and Evaluate Manufacturability
- Flow: MCP apply_unfold -> GE unfold -> ACL features -> MD score
- Assertions: unfold tolerance met, violations classified correctly.

4. SYS-JTBD-04: Nest and Async Export
- Flow: MCP simulate_nesting -> GE nest -> MCP export_production_pack -> status polling -> result retrieval
- Assertions: job lifecycle transitions valid, output artifact set complete.

5. SYS-JTBD-05: Rollback Integrity
- Flow: mutating operations -> rollback
- Assertions: state restored exactly, no partial mutation residue.

6. SYS-JTBD-06: MVP Golden Path (INF-03)
- Flow: STEP -> clean -> decompose -> joints -> unfold -> nest -> async export -> retrieve outputs
- Assertions: full success, runtime threshold, output validity.

---

## Local and CI Execution Model

## Local Runs

1. Local fast (developer inner loop)
- Unit tests for touched modules
- Relevant contract tests
- Target runtime: under 5 minutes

2. Local pre-push
- Full unit + contract suites
- BC integration tests for touched BCs
- Target runtime: under 20 minutes

3. Local full verification (optional before large merges)
- Full unit + contract + BC integration + selected system integration

## CI Runs

1. Pull request CI (blocking)
- Lint/static checks
- Full unit tests
- Full contract tests
- Targeted BC integration tests impacted by changed paths

2. Merge-to-branch CI (blocking)
- Full unit + contract + all BC integration
- Selected cross-BC system integration
- Sanitizer subset for GE

3. Nightly CI (non-blocking alert, blocking for release)
- Full system integration suite
- INF-03 dry run
- Full sanitizer + determinism replay set
- Performance trend capture

4. Release candidate CI (blocking)
- Full matrix execution
- Coverage thresholds
- Gate evidence bundle generation

## Windows Compatibility Notes

1. Keep Catch2 test and section names ASCII-only
- Prefer `->` over Unicode arrows in `TEST_CASE` and `SECTION` names.
- Reason: Windows code page conversion can corrupt non-ASCII names in CTest filter arguments and XML output paths.

2. Do not call fixture helpers that can `SKIP` inside `REQUIRE_NOTHROW`
- Resolve the fixture path first, then run the non-throw assertion.
- Reason: nested `SKIP` inside assertions can be interpreted as a failure in Catch2.

---

## Traceability Matrix

## Requirements to Tests

| Requirement | Test IDs | Levels | Owning BC(s) | Evidence |
|-------------|----------|--------|--------------|----------|
| FR-001 Spec alignment coherence | GOV-TEST-01 | Contract/Governance | MCP | checklist sign-off |
| FR-002 MVP flow (STEP -> export) | SYS-JTBD-01, SYS-JTBD-02, SYS-JTBD-03, SYS-JTBD-04, SYS-JTBD-06 | System integration/E2E | GE, ACL, MD, MCP | INF-03 report |
| FR-003 Rule-based bend sequence | MD-JTBD-02, SYS-JTBD-03 | Unit/BC integration/System integration | MD, MCP | bend sequence report |
| FR-004 Single-session behavior | MCP-JTBD-05, SYS-JTBD-05 | Unit/BC integration/System integration | MCP, GE | session state logs |
| FR-005 Async export lifecycle | MCP-JTBD-04, SYS-JTBD-04, SYS-JTBD-06 | Contract/System integration/E2E | MCP, GE, MD | export lifecycle logs |
| FR-006 Config through MCP interfaces | MD-JTBD-01, MCP-JTBD-01 | Unit/Contract/BC integration | MD, MCP | schema validation report |
| FR-007 Bounded-context tech allocation consistency | ARCH-TEST-01 | Governance/Contract | GE, ACL, MD, MCP | architecture review artifact |
| FR-008 Export error model | MCP-JTBD-03, SYS-JTBD-04 | Unit/Contract/System integration | MCP | structured error compliance report |
| FR-009 Deterministic reproducibility | GE-JTBD-03, MD-JTBD-04, SYS-JTBD-06 | Unit/Non-functional/E2E | GE, MD, MCP | determinism replay logs |
| FR-010 Quality checklist before planning | GOV-TEST-01 | Governance | MCP/Project | requirements checklist |

## Constitution Principles to Tests

| Principle | Test IDs | Enforcement |
|-----------|----------|------------|
| I Deterministic Geometry | GE-JTBD-03, SYS-JTBD-06 | determinism replay and fixture comparison |
| II Bounded Context Separation | ARCH-TEST-01, contract suites | contract boundary assertions |
| III Safety Filter Enforcement | MD-JTBD-03, SYS-JTBD-02 | forbidden-joint negative tests |
| IV Rollback-First State | GE-JTBD-07, MCP-JTBD-05, SYS-JTBD-05 | rollback integrity tests |
| V Kerf Compensation Mandatory | GE-JTBD-04, SYS-JTBD-02 | tolerance assertions |
| VI Structured Errors Always | MCP-JTBD-03, SYS-JTBD-04 | error shape compliance checks |
| VII MVP Scope Discipline | SYS-JTBD-06 | gate check against MVP path |
| VIII Config over Hard-coding | MD-JTBD-01, MCP-JTBD-01 | config schema and runtime load tests |
| IX Async Export Contract | MCP-JTBD-04, SYS-JTBD-04 | lifecycle contract tests |

---

## Quality Gates and Exit Criteria

1. Unit and contract tests
- Must pass in local pre-push and PR CI.

2. BC integration tests
- Must pass at the phase gate for any BC touched in that phase.

3. System integration tests
- Mandatory for phase advancement B -> C, C -> D, and D release gate.

4. E2E INF-03
- Mandatory and non-quarantinable for MVP acceptance.

5. Non-functional gates
- No sanitizer memory errors.
- Determinism replay shows no drift.
- Performance thresholds satisfied for MVP scenarios.

---

## Test Data and Fixture Management

1. Fixture tiers
- Tier 1: simple deterministic geometries
- Tier 2: medium complexity production-like parts
- Tier 3: stress and edge-case geometries

2. Fixture governance
- Every fixture change requires rationale, expected-output update, and reviewer approval.

3. Golden fixture
- One canonical fixture reserved for INF-03 trend comparability.

4. Snapshot policy
- Store expected outputs for topology counts, feature summaries, utilization ranges, and export artifact inventories.

---

## Reporting and Governance

1. Required test artifacts per release candidate
- Unit coverage summary
- Contract compliance report
- BC integration summary
- System integration report
- INF-03 acceptance report
- Sanitizer and performance reports

2. Defect severity policy
- Critical: data corruption, crash, contract break, wrong manufacturing outcome.
- High: deterministic mismatch, blocked gate, flaky INF-03.
- Medium: workflow defect with workaround.
- Low: non-blocking test/documentation issue.

3. Blocker policy
- Critical and high defects must be resolved before phase gate sign-off.

---

## Suggested Repository Mapping

- Unit and BC integration
  - cpp/tests/
  - ts/tests/

- Contract tests
  - ts/tests/contracts/
  - cpp/tests/napi_contract/

- System integration and E2E
  - ts/tests/integration/
  - ts/tests/e2e/

- Test evidence outputs
  - docs/test-reports/

This mapping aligns with the existing plan and can be refined as implementation scaffolding is created.
