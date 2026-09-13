# Bug Report: complex panel bends lose rounded inside and outside surfaces

**Status:** Open
**Date:** 2026-09-09
**Component:** `cpp/src/geometry/translation/part_solid_construction.cc`
**Related component:** `cpp/src/geometry/geometry_service_export.cc`
**Severity:** High

## Statement of the requirement

Every modeled nonzero-radius bend must contain real curved material across its full bend span. The constructed solid must expose both the inside and outside surfaces of the bend as rounded cylindrical or cylindrical-equivalent surfaces. A complex panel boundary, miter, partial-width seam, or multi-edge bend zone must not reduce the bend to a flat rectangular strip.

The bend in the generated mesh must therefore show:

- a rounded inside surface at the bend's true inner radius;
- a rounded outside surface at the bend's true outer radius;
- continuous curved material across the complete bend length;
- the same result for both mountain and valley folds;
- no rectangular `approximately 1 mm x 1 mm` strip replacing a bend that is approximately `150 mm` long.

A mesh-resolution change may improve visual sampling, but it does not satisfy this requirement if the constructed B-Rep has lost one of the curved bend surfaces.

## Observed behavior

A slightly more complex panel layout containing a bend can produce a mesh where the bend appears as a narrow rectangular strip approximately 1 mm thick and 1 mm high over a bend length of approximately 150 mm. The expected rounded corner is absent on the inside, the outside, or both.

The current investigation shows:

- the bridge construction can contain two analytic cylindrical faces before final assembly;
- the final panel/bridge Boolean union can retain only one cylindrical face on a complex T-shaped or partial-width topology;
- the resulting solid can remain valid and have one solid, so validity alone does not detect the defect;
- coarse mesh tessellation can make small-radius curvature appear flatter, but tessellation is not the root fix when the B-Rep has already lost a surface.

## Geometric contract

For a bend with signed angle $\theta$, thickness $t$, bend radius $r$, and bend span $L$:

1. The bend bridge must be generated from the evaluated bend axis and true tangent boundaries.
2. The inner and outer material boundaries must have radii consistent with the bend orientation:
   - concave bottom: $r_{bottom}=r$, $r_{top}=r+t$;
   - convex bottom: $r_{bottom}=r+t$, $r_{top}=r$.
3. The curved material must span the complete effective bend zone, including partial-width and multi-edge panel boundaries.
4. Panel/bridge Boolean assembly must not replace a valid cylindrical bridge boundary with a planar panel boundary.
5. The final result must remain one valid solid. No disconnected or partial result may be accepted as success.
6. A failed repair must return a typed construction error. No fallback may silently return the flat strip or a degraded panel union.

## Scope

This bug applies to constructed 3D solids and their exported meshes. Flat-pattern geometry and bend allowance calculations remain separate source-of-truth concerns and must not be changed unless the repair proves that their shared boundary data is incorrect.

The existing no-fallback policy remains mandatory.

## Reproduction requirements

The regression fixture must include all of the following:

- a panel with a partial-width or T-shaped bend zone;
- a bend span of approximately 150 mm;
- nonzero bend radius and sheet thickness near 1 mm;
- both inside and outside bend surfaces;
- both positive and negative bend angles;
- a complex panel boundary with at least one mitered or multi-edge corner.

The regression must inspect the constructed solid, not only the exported mesh. It must confirm that the final solid retains at least two distinct cylindrical or cylindrical-equivalent bend surfaces associated with the bend. It must also verify that the exported mesh samples the curved region sufficiently for the inside and outside surfaces to be visibly rounded.

## Acceptance criteria

A repair is complete only when:

- the complex-panel regression produces a valid single solid;
- the bend's inner and outer curved surfaces are present after the final panel/bridge Boolean assembly;
- the bend surfaces extend across the complete bend span;
- the result is correct for both mountain and valley folds;
- existing simple-strip, T-shaped, branching, cauldron, and no-fallback tests remain green;
- the mesh contains sufficient curvature samples for the configured bend radius;
- no fallback or degraded flat-strip result is returned as success.

## Non-acceptance signals

The following do not satisfy this bug report on their own:

- `BRepCheck_Analyzer` reporting a valid shape;
- the final result containing one solid;
- a successful GLB export;
- increasing tessellation density while the final B-Rep still has only one curved bend surface;
- accepting a planar panel/bridge union because its volume or bounding box appears plausible.

## Current test evidence

The existing native construction and mesh-resource tests pass, but they do not yet assert that a complex final assembly retains both analytic bend surfaces. A focused analytic-surface regression is required before the repair is considered complete.

## Repair plan

1. **Add a focused B-Rep regression**
   - Use the existing partial-width T-shaped panel fixture.
   - Assert the final assembled solid contains both inside and outside cylindrical bend surfaces.
   - Cover positive and negative bend angles, approximately 1 mm thickness, and 0.95 mm / 2 mm radii.
   - Assert the bend spans the full approximately 150 mm seam.
   - Keep the no-fallback failure behavior under test.

2. **Trace bridge ownership through assembly**
   - Inspect the bridge before panel fusion.
   - Inspect the result after each panel/bridge Boolean.
   - Identify which operation removes the second cylindrical face.
   - Compare n-ary and balanced assembly paths using the same fixture.

3. **Repair the geometric ownership model**
   - Keep the bridge's analytic inner and outer cylindrical surfaces as the authoritative bend geometry.
   - Prevent adjoining planar panel faces from replacing or masking those surfaces during union.
   - Resolve the shared boundary through the translation/construction model itself.
   - Do not add a second geometry solver, final-position correction, or silent fallback.
   - Preserve valid one-solid and typed-error requirements.

4. **Handle complex bend spans**
   - Verify partial-width seams, mitered corners, and multi-edge bend zones.
   - Ensure every real tagged edge contributes to the bend span.
   - Ensure transition edges do not create artificial rectangular strips.
   - Confirm the bridge remains continuous across the full seam.

5. **Validate mesh output separately**
   - Retain the improved tessellation settings in `cpp/src/geometry/geometry_service_export.cc`.
   - Verify the exported mesh samples both curved surfaces sufficiently.
   - Treat tessellation improvements as necessary presentation fidelity, not as a substitute for correct B-Rep geometry.

6. **Run regression gates**
   - Focused complex-panel native regression.
   - Existing native construction and no-fallback tests.
   - T-shaped and partial-width bend tests.
   - `testcube.step` fixture suite.
   - `cauldron.step` radius-sweep suite.
   - Mesh-resource integration tests.
   - Full C++ and v2 TypeScript suites where practical.

7. **Commit in two stages**
   - First commit: regression and diagnostic instrumentation, if needed.
   - Second commit: final geometric repair and cleanup.
   - Keep the current mesh-resolution change separate unless the repository convention requires combining the fixes.

The key repair decision is to make the Boolean boundary preserve the bridge's curved surfaces, rather than merely increasing tessellation or accepting a valid-looking planar union.
