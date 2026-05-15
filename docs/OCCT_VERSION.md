# OCCT Version Management

## Current Version
- **Target Version**: OpenCASCADE Technology (OCCT) 7.8.1

## Upgrade Path
When upgrading to newer minor or major versions of OCCT:
1. Ensure `vcpkg.json` specifies the target OCCT version.
2. Update bounded-context C++ code in `src/geometry` to accommodate any deprecated functions. Typical breaking changes in OCCT concern standard collections (`NCollection`) replacing legacy structures, or changes in Boolean operations logic (`BRepAlgoAPI_BooleanOperation`).
3. Re-run `ge_integration_test` and `determinism_test` to verify geometric stability across versions.

## Known Architecture Caveats
- OCCT uses a lot of handles (`Handle(T)`) which act as intrustive smart pointers. The codebase abstracts this inside `GeometryServiceImpl` to prevent handles from leaking into the Node.js Addon environment.
- Any OCCT internal error (like `Standard_Failure`) must be caught and transformed into a structured JSON error string before permeating back through N-API.
