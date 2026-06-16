# Feature Specification: Service Decomposition Refactor

**Feature Branch**: `013-service-decomposition`

**Created**: 2026-06-14

**Status**: Draft

**Input**: User description: "Both geometry_service.cc and tools.ts are extremely large and difficult to manage. Goals: (1) Move into smaller function-specific files/classes, (2) Ensure one function does one thing — remove duplication, (3) Reduce complexity, (4) Remove old code."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Developer Navigates to a Specific Capability (Priority: P1)

A developer working on the CAD geometry pipeline needs to find and modify the logic for a specific operation (e.g., shell resolution, bend unfolding, boolean fusion). Today they must scroll through thousands of lines in a single file to locate it. After this refactor, they open a file whose name directly describes the capability they are looking for.

**Why this priority**: Navigation speed is the most immediate day-to-day pain. Fixing this unblocks all other development work and delivers value even if nothing else changes.

**Independent Test**: Given the refactored codebase, when a developer searches for "unfold" or "boolean" by filename, they find a file dedicated to that concern within one lookup.

**Acceptance Scenarios**:

1. **Given** a developer needs to modify bend-unfolding logic, **When** they look at the file listing, **Then** there is a file whose name clearly identifies it as the unfold module.
2. **Given** a developer needs to change how MCP tool arguments are validated, **When** they look at the MCP layer file listing, **Then** they find a file responsible for that concern without opening an omnibus file.
3. **Given** a developer is unfamiliar with the codebase, **When** they read the directory listing, **Then** the module names sufficiently describe the system's major responsibilities.

---

### User Story 2 - Developer Adds a New Operation Without Touching Unrelated Code (Priority: P1)

A developer wants to add a new geometry operation (e.g., a new MCP tool or a new C++ geometry pass). Today, adding it requires editing a single large file containing all operations, creating a high risk of merge conflicts and accidental regressions. After this refactor, new operations are added to isolated, purpose-specific modules.

**Why this priority**: Isolation is the core value of decomposition. Without it, the large-file problem simply re-grows.

**Independent Test**: A new operation can be added by creating or editing exactly one module file without modifying any unrelated module.

**Acceptance Scenarios**:

1. **Given** the refactored codebase, **When** a developer adds a new MCP tool, **Then** they edit only the file(s) specific to that tool's domain, not a shared omnibus file.
2. **Given** a new C++ geometry function is added, **When** a developer opens the relevant module, **Then** all related helpers are co-located in that module.
3. **Given** two developers add different operations simultaneously, **When** they merge their branches, **Then** there are no conflicts caused by editing the same omnibus file.

---

### User Story 3 - Developer Identifies and Eliminates Duplicate Logic (Priority: P2)

A developer discovers that the same transformation or validation is applied in multiple places across the codebase. After this refactor, each logical operation exists in exactly one location and is shared by callers rather than duplicated.

**Why this priority**: Duplication is the second-order problem — it causes inconsistent behaviour when one copy is updated but others are not. Fixing it reduces bug surface.

**Independent Test**: Given two callers that previously had identical inline logic, both now call the same shared function and that function exists in exactly one file.

**Acceptance Scenarios**:

1. **Given** a piece of logic that was duplicated across the old file, **When** the refactored code is reviewed, **Then** that logic appears in exactly one place.
2. **Given** a fix is applied to shared logic, **When** both callers exercise that path, **Then** both callers receive the fix automatically.

---

### User Story 4 - Developer Removes Dead Code (Priority: P2)

Commented-out blocks, unused helper functions, superseded implementations, and legacy workarounds have accumulated in both files. After this refactor, those artifacts are gone from the codebase — not just moved.

**Why this priority**: Dead code is noise that increases cognitive load and misleads future readers. It should be deleted, not reorganised.

**Independent Test**: Given a function that was identified as unused, when the refactored codebase is searched for its name, the function no longer exists.

**Acceptance Scenarios**:

1. **Given** a function identified as unused via static analysis or manual review, **When** the refactor is complete, **Then** that function does not exist in the codebase.
2. **Given** commented-out code blocks that are not referenced anywhere, **When** the refactor is complete, **Then** those blocks have been deleted.

---

### User Story 5 - All Existing Tests Pass After Refactor (Priority: P1)

All existing integration and unit tests continue to pass with no functional regression after the decomposition. The public interface exposed through the MCP layer and the C++ NAPI bindings remains identical from the perspective of callers.

**Why this priority**: A refactor that breaks existing behaviour is worse than no refactor at all. Passing tests are the non-negotiable safety net.

**Independent Test**: Run the full test suite against the refactored code; all tests that passed before must pass after.

**Acceptance Scenarios**:

1. **Given** the test suite runs against the refactored codebase, **When** all tests complete, **Then** zero regressions are introduced (same pass/fail as baseline).
2. **Given** the MCP tool interface consumed by external callers, **When** the same tool calls are made post-refactor, **Then** responses are semantically identical.
3. **Given** the C++ geometry bindings used by the TypeScript layer, **When** the same operations are called post-refactor, **Then** results are identical.

---

### Edge Cases

- What happens when a helper function is used in only one place — is it kept in that module or extracted to a shared utilities module?
- How does the system handle circular dependencies that may emerge when splitting a monolithic file?
- What if a legacy function is used by an external test fixture but is otherwise dead in production paths?
- How are build system dependencies (include paths, module registrations) updated when files are split?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The geometry service C++ source MUST be split into multiple files, each responsible for a single coherent area of geometry concern (e.g., boolean operations, bend unfolding, shell resolution, body transformations).
- **FR-002**: The MCP tools TypeScript source MUST be split into multiple modules, each responsible for a single tool domain or shared concern (e.g., tool registration, argument validation, individual tool handlers).
- **FR-003**: Each function in the refactored codebase MUST perform exactly one logical task; functions that currently perform multiple tasks MUST be decomposed.
- **FR-004**: Duplicate logic that appears in more than one location MUST be consolidated into a single shared implementation and all callers updated.
- **FR-005**: All code identified as dead (unused functions, unreachable branches, superseded implementations, commented-out blocks) MUST be deleted.
- **FR-006**: The external interface — MCP tool names, argument schemas, and return shapes — MUST remain identical after the refactor.
- **FR-007**: The C++ NAPI binding surface consumed by the TypeScript layer MUST remain identical after the refactor.
- **FR-008**: All existing automated tests MUST pass after the refactor with no modifications to test logic or fixtures.
- **FR-009**: The build system configuration MUST be updated to reflect the new file structure without requiring callers to change their build commands.
- **FR-010**: Module and file names MUST be descriptive enough that the responsibility of a file can be understood from its name alone.

### Key Entities

- **Geometry Module**: A single-concern C++ source file grouping related geometry operations (e.g., boolean fusions, unfold passes, shell/body queries).
- **MCP Tool Module**: A single-concern TypeScript module grouping related tool handlers or a shared concern such as argument parsing.
- **Shared Utility**: A function or helper that is referenced by more than one module and therefore lives in a dedicated shared/utility file rather than any one domain module.
- **Dead Code**: Any function, class, variable, or comment block that is unreachable, unused, or superseded by a later implementation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The largest single source file in the refactored set is at most 400 lines — down from the current multi-thousand-line files.
- **SC-002**: Zero duplicate implementations of the same logical operation exist across the codebase after the refactor (measured by code review and static analysis).
- **SC-003**: 100% of existing automated tests pass after the refactor with no changes to test code or fixture data.
- **SC-004**: A developer unfamiliar with the change can locate the file responsible for any named operation (e.g., "boolean union", "unfold", "shell query") within 60 seconds of reading the directory listing.
- **SC-005**: The number of distinct source files in the geometry and MCP layers increases by at least 4 compared to the current state, reflecting genuine decomposition.
- **SC-006**: Zero dead-code items (unused functions, commented-out blocks, superseded implementations) remain in the refactored files, as confirmed by a code review pass.

## Assumptions

- The refactor is purely structural — no new capabilities are introduced and no existing behaviour is changed.
- The primary consumers of this codebase are the project's own test suite and the MCP tool layer; no other external consumers need to be accounted for.
- The C++ build system (CMake or equivalent) can be updated as part of this work; build system changes are in scope.
- The TypeScript module system (import/export) can be restructured; callers within the project will be updated as part of the refactor.
- Dead code identification will rely on a combination of manual review, compiler/type-checker unused-symbol warnings, and test coverage data.
- The 400-line ceiling in SC-001 is a practical guideline; a module may exceed it only if the operation it encapsulates is genuinely indivisible and well-named.
- Mobile or web-facing deployment concerns are out of scope; this refactor targets the backend geometry and tooling layer only.
