# Clarification Session Report: Graph-Driven Geometry Pipeline

**Session Date**: 2026-06-08  
**Feature**: [spec.md](../spec.md)  
**Spec File Updated**: Yes  
**Status**: ✅ CLARIFICATIONS COMPLETE

## Questions Asked & Answered

| # | Question | Answer | Impact |
|---|----------|--------|--------|
| 1 | **Graph corruption/recovery strategy** | Fail-fast with diagnostics; detect divergence, reject operation, offer repair options | Defines reliability model; adds FR-011 for validation; updates edge case handling |
| 2 | **Geometry rebuild timing** | Asynchronous with optimistic updates; operation returns immediately; rebuild in background | Changes UX model; requires progress feedback; impacts acceptance scenarios; adds FR-012-015 |
| 3 | **Phase 1 mutation scope** | Core mutations only: split, merge, bend-param modifications; defer fuse/trim/flanges | Defines MVP boundary; reframes User Stories 3-4; adds FR-006a for explicit rejection; clarifies deferred work |

**Total Questions Asked**: 3 / 5 (quota not reached; early completion)

## Sections Updated

| Section | Changes | Notes |
|---------|---------|-------|
| **Clarifications** | Added session heading with 3 Q&A pairs | Records decisions for future reference |
| **User Story 3** | Replaced Fuse story with Bend Parameter Modification | Core Phase 1 operation; aligns with scope decision |
| **User Story 4** | Reframed from "all mutations" to "supported mutations only" | Explicitly rejects unsupported operations; defines Phase 1 boundaries |
| **Acceptance Scenarios** | Updated to reflect async rebuild model with cached geometry and progress | All 4 user stories now account for background rebuild |
| **Edge Cases** | Resolved 3 edge cases; deferred fuse to Phase 2+ | Fuse edge case now explicitly marked as deferred |
| **Functional Requirements** | Added FR-005 (bend param modification), FR-006a (unsupported rejection), FR-011-015 (validation/async/progress) | 15 total FRs; clear support for Phase 1 scope |
| **Key Entities** | Added "Supported Mutation" and "Unsupported Mutation" definitions | Clarifies scope boundaries for design team |
| **Success Criteria** | Updated SC-001/SC-002/SC-003/SC-006 to reflect async model (200ms operation, 2s rebuild, 10+ mutations) | Measurable and testable; async-aware |
| **Assumptions** | Added explicit Phase 1 scope boundary assumptions; clarified async behavior and rebuild queue safety | 12 total assumptions; clear scope for planning |

## Coverage Summary (After Clarification)

| Category | Status | Notes |
|----------|--------|-------|
| **Functional Scope & Behavior** | ✅ Clear | Core goals well-defined; Phase 1 scope explicit; out-of-scope (Phase 2+) listed |
| **Domain & Data Model** | ✅ Clear | Entities defined (Manufacturing Graph, DXF, Geometric Pipeline); state transitions now addressed via async model |
| **Interaction & UX Flow** | ✅ Clear | User journeys complete; error states handled (fail-fast); async progress feedback specified |
| **Non-Functional Quality Attributes** | ✅ Clear | Performance targets explicit (200ms ops, 2s rebuild, <500ms errors); reliability model defined (fail-fast); observability via progress indicators |
| **Integration & External Dependencies** | ✅ Clear | Assumptions document external dependencies; geometric pipeline assumed; DXF coupling explicit |
| **Edge Cases & Failure Handling** | ✅ Clear | All 5 edge cases resolved or deferred; recovery strategy defined (fail-fast with repair options) |
| **Constraints & Tradeoffs** | ✅ Clear | Hard constraint on pipeline usage explicit; Phase 1/2+ tradeoff clearly stated; scope boundaries defined |
| **Terminology & Consistency** | ✅ Clear | Canonical terms used consistently; "Supported/Unsupported Mutation" terminology introduced; no vague adjectives remain |
| **Completion Signals** | ✅ Clear | Acceptance scenarios testable; success criteria measurable; no "TBD" markers remain |
| **Misc/Placeholders** | ✅ Clear | No unresolved TODOs; clarifications session fully documents all decisions |

**Overall Spec Coverage**: ✅ **COMPLETE** — All critical ambiguities resolved; no outstanding Partial or Missing categories.

## Design Impact Summary

### High-Impact Decisions

1. **Fail-Fast Reliability Model** (Q1)
   - System validates graph/DXF consistency on every rebuild
   - Operations rejected if divergence detected; user can repair or revert
   - **Design implication**: Requires validation/reconciliation logic in geometry rebuild pipeline

2. **Asynchronous Rebuild with Optimistic Updates** (Q2)
   - Operations return to user immediately; cached geometry displayed; final geometry updates in background
   - Requires rebuild queue, progress tracking, and viewport update mechanisms
   - **Design implication**: More complex than synchronous model; requires careful state management to avoid conflicts; acceptable staleness ~2 seconds

3. **Phase 1 Scope: Core Mutations Only** (Q3)
   - Split-by-bends, Merge-by-bend, Bend parameter modifications
   - Fuse/Union, Trim/Cut, Flange/Tab additions explicitly deferred
   - Unsupported operations fail with "Not yet supported" message
   - **Design implication**: Smaller MVP; clearer task prioritization; Phase 2+ planning can evaluate architecture extension points for future mutations

### Risk Assessment

**Low Risk**:
- Fail-fast model aligns with CAD platform expectations
- Bend parameter modification is straightforward mutation

**Medium Risk**:
- Async rebuild with cached geometry may cause UX confusion if staleness exceeds ~2 seconds
- Rebuild queue must be truly thread-safe; race conditions could corrupt geometry
- Progress indicators must be visible and responsive; delayed feedback will frustrate users

**Design Validation Required** (before implementation):
- Verify geometric pipeline can handle all Phase 1 mutations; validate that split/merge/bend-param can always be represented
- Confirm rebuild time targets (2 seconds for 100 panels) achievable with current pipeline performance
- Validate that cached geometry remains acceptable during 2-second rebuild window; may require view-dependent caching (show fewer details during rebuild)

## Specification Quality Checklist

- [x] All clarifications in `## Clarifications` section
- [x] One bullet per Q&A pair; no duplicates
- [x] Total asked questions = 3 (≤5 quota)
- [x] No lingering ambiguous statements unresolved by clarifications
- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Terminology consistent across all sections
- [x] Markdown structure valid; only new headings: `## Clarifications`, `### Session 2026-06-08`
- [x] No contradictory statements; earlier vague text replaced, not duplicated

## Recommended Next Steps

1. **Proceed to `/speckit.plan`** → Design phase is ready; all key ambiguities resolved; high-level architecture can be defined around the three clarification decisions.

2. **Optional design review before planning** → If team wants to validate the async rebuild model and fail-fast reliability approach before committing to plan, conduct brief design review with architecture stakeholders.

3. **Phase 2+ roadmap** → Create separate spec for Fuse/Union operations once Phase 1 implementation provides foundation for extended mutations.

---

**Status**: ✅ Spec is complete and ready for implementation planning.
