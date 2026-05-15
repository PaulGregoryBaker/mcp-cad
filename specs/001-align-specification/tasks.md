# Implementation Tasks: Apply Architecture and Engineering Designs to Specification

**Feature:** Apply Architecture and Engineering Designs to Specification
**Branch:** `001-align-specification`
**Date:** 2026-05-15

## Overview
Dependency-ordered task breakdown incorporating a post-MVP Tier-3 Braai STL E2E evaluation path, enforcing High Heat environmental contexts and long-running job bounds against the MCP-CAD stack.

Braai STL tasks are non-gating for MVP and must be executed only after INF-03 passes.

## Validation & Testing Criteria

### Story 1: Unified MVP Baseline (P1)
- **Independent Test**: Generated specification can be compared against Architecture and Engineering-Design documents to confirm all resolved MVP decisions (including Braai Tier-3 STL mesh ingestion rules and "High Heat" joint safety filters) are represented without contradiction.

### Story 2: Stable Tool Contract Alignment (P2)
- **Independent Test**: Tool contracts define asynchronous export behaviors (submission, status polling, result retrieval), error states, and extended timeout exceptions explicitly for complex Tier-3 STL stress tests.

### Story 3: Planning-Ready Specification Governance (P3)
- **Independent Test**: The quality-checked specification passes all mandatory checklist items entirely with zero blocking gaps.

---

## Phase 0: Pre-Setup

Initial test validation framework assertions mapped to requirement boundaries so they are defined prior to detailed implementation logic.

- [X] T016 [US1] Add configuration initialization logic bridging Manufacturing Domain constraints via MCP scaffolding (FR-006)
- [X] T017 [US2] Add negative tests explicitly validating terminal failure and not-found states against the structured error model (FR-008) in Phase 6 export flow
- [X] T018 [US3] Implement single-session verification tests ensuring subsequent E2E operations map cleanly to a single scoped boundary (FR-004)
- [X] T019 Run `/speckit.checklist` validation sign-off process and record compliance (FR-010)
- [X] T020 [US1] Add architecture-engineering baseline coherence review task that records evidence of no contradictions between Architecture.md and Engineering-Design.md (FR-001)
- [X] T021 [US2] Add rule-based bend-sequence validation assertions to ensure no dependency on full 3D collision simulation in MVP-path tests (FR-003)
- [X] T022 [US3] Add bounded-context technology allocation conformance check across GE/ACL/MD/MCP boundaries with evidence output (FR-007)
- [X] T023 [US3] Add deterministic replay verification for representative geometry and manufacturing scenarios to validate reproducibility (FR-009)

---

## Phase 1: Setup

Setup project configurations, test resources, and tool configurations required before feature implementation.

- [X] T001 [Post-MVP] Copy `Braai.stl` fixture into tracking path at `ts/tests/e2e/fixtures/Braai.stl` to serve as the canonical Tier-3 stress test fixture
- [X] T002 [Post-MVP] Update `ts/vitest.config.ts` test timeout limits for the Braai Tier-3 suite to 120s while keeping standard STEP flows at 30s (SC-005)

---

## Phase 2: Foundational

Blocking prerequisites that must be completed before any user stories can be fulfilled.

- [X] T003 [Post-MVP] Implement initial test scaffolding for `ts/tests/e2e/braai-assembly.e2e.test.ts` to map the 6 execution phases defined in `specs/001-align-specification/e2e-braai.md`
- [X] T004 [Post-MVP] Add Mock / Real bindings for `clean_geometry` dry-run/analyze STL ingestion into `ts/tests/e2e/braai-assembly.e2e.test.ts`

---

## Phase 3: [US1] Unified MVP Baseline

Implement unified specs reflecting architecture resolutions, enforcing STL mesh ingestion as a Tier 3 stress testing contract and high heat limits.

- [X] T005 [P] [US1] [Post-MVP] Implement `GeometryEngine` STL ingestion dry-run logic for mapping defects (`GEOMETRY_NOT_MANIFOLD`) within `ts/tests/e2e/braai-assembly.e2e.test.ts` Phase 1 tests
- [X] T006 [P] [US1] [Post-MVP] Implement `GeometryEngine` healing logic test flow asserting post-repair 100% manifold state on Braai solids within `ts/tests/e2e/braai-assembly.e2e.test.ts` Phase 2 tests
- [X] T007 [US1] [Post-MVP] Implement Manufacturing Decomposition phase evaluating logistic bounds against the Braai model within `ts/tests/e2e/braai-assembly.e2e.test.ts` Phase 3 tests

---

## Phase 4: [US2] Stable Tool Contract Alignment

Enforce MCP joint safety filter contracts and validate asynchronous production export states for the Braai.

- [X] T008 [P] [US2] [Post-MVP] Add mock assertion testing High Heat joint rejection (`JOINT_TYPE_BLOCKED`) within `ts/tests/e2e/braai-assembly.e2e.test.ts` Phase 4 synthesize joints flow
- [X] T009 [P] [US2] [Post-MVP] Add mock constraint test explicitly generating Kerf offsets for allowed Tab & Slot joints under High Heat contexts in `ts/tests/e2e/braai-assembly.e2e.test.ts` Phase 4 tools
- [X] T010 [US2] [Post-MVP] Implement manufacturability score validation testing minimum K-factors for the Mild Steel Braai structure within `ts/tests/e2e/braai-assembly.e2e.test.ts` Phase 5
- [X] T011 [US2] [Post-MVP] Implement asynchronous export state polling assertions ensuring the task sequence reaches the `succeeded` state within `ts/tests/e2e/braai-assembly.e2e.test.ts` Phase 6

---

## Phase 5: [US3] Planning-Ready Specification Governance

Finalise task quality and test suite metrics validating successful E2E integration compliance.

- [X] T012 [US3] [FR-002] [Post-MVP] Validate that `ts/tests/e2e/braai-assembly.e2e.test.ts` runs standalone, tests pass, and it demonstrates all Phase 1-6 assertions
- [X] T013 [US3] [Post-MVP] Confirm test coverage reports generate >95% block and branch coverage metrics for the integration pipeline (`docs/test-reports/coverage_summary.md`)

---

## Final Phase: Polish & Cross-Cutting Concerns

Documentation, code-cleanups, and sign-offs indicating final feature completion out to the primary branch.

- [X] T014 [FR-010] [SC-003] Run final linting and formatting across `ts/tests/e2e/braai-assembly.e2e.test.ts`
- [X] T015 [FR-001] [FR-010] Verify `docs/TESTING_STRATEGY.md` implicitly reflects the active status of `SYS-JTBD-07` and update test evidence
