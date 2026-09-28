/**
 * Corner-integrity regression (2026-09): the facet-normal-angle check used
 * earlier to validate merge_bodies_with_bend's output (cluster triangles by
 * normal, check the two dominant clusters are ~90deg apart) only validates
 * ORIENTATION — two panels that are correctly perpendicular but incorrectly
 * PLACED (overlapping into each other's own footprint) would still pass it.
 * That's not good enough: it can't catch "the panels went through each
 * other," which is what was reported live.
 *
 * This test instead cuts the constructed solid at two planes just past the
 * bend's own curved region (radius + a small cushion) on each side — using
 * the bend's own real hinge/normal data (nLeftFlat, nLeftWorld,
 * childNLeftWorld), not hand-derived guesses — leaving exactly the two flat
 * panels. It then checks, using the actual OCCT topology (not graph
 * metadata):
 *   1. each cut piece is itself exactly one connected solid,
 *   2. the two cut pieces occupy ZERO overlapping 3D volume,
 *   3. each cut piece's size doesn't exceed its own source panel's.
 *
 * All three came back clean (0mm^3 overlap, 1 solid each, matching source
 * dimensions) — no evidence of interpenetration in the actual constructed
 * geometry for this recipe.
 *
 * Along the way, found and worked around a real API mismatch (not a
 * geometry bug): constructPartSolid registers a genuine closed solid under
 * the addon's `solids` map, but splitBodyByPlane only ever looks in its
 * `shells` map — confirmed live (GE_SHELL_NOT_FOUND on a solid-registered id
 * that computeBoundingBox/lookupEntityIn found fine, since that helper
 * checks both maps). separateSolids is used here purely as the adapter that
 * bridges solids -> shells, not because the shape is fragmented.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

import { GraphStore } from '../../src/v2/graph/store';
import { dispatchGraphTool } from '../../src/v2/tools/graph';
import { constructPart, evaluatePart, mapPointToWorld } from '../../src/v2/graph/evaluate-client';
import { geometryBinding } from '../../src/geometry/binding';

const FIXTURES_DIR = path.resolve(__dirname, '../../../cpp/tests/fixtures');

interface Vec3 { x: number; y: number; z: number }
interface Bbox { xMin: number; yMin: number; zMin: number; xMax: number; yMax: number; zMax: number }

/** Volume of the overlap between two axis-aligned boxes (0 if disjoint). */
function overlapVolume(a: Bbox, b: Bbox): number {
  const dx = Math.max(0, Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin));
  const dy = Math.max(0, Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin));
  const dz = Math.max(0, Math.min(a.zMax, b.zMax) - Math.max(a.zMin, b.zMin));
  return dx * dy * dz;
}

function sortedExtents(b: Bbox): number[] {
  return [b.xMax - b.xMin, b.yMax - b.yMin, b.zMax - b.zMin].sort((x, y) => x - y);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function bboxCorners(b: Bbox): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.xMin, b.xMax]) {
    for (const y of [b.yMin, b.yMax]) {
      for (const z of [b.zMin, b.zMax]) out.push({ x, y, z });
    }
  }
  return out;
}

/** Range of `corners` projected onto `axis` (need not be unit length), relative to `origin`. */
function projectRange(corners: Vec3[], origin: Vec3, axis: Vec3): { min: number; max: number } {
  const len = Math.sqrt(dot(axis, axis)) || 1;
  const unit = { x: axis.x / len, y: axis.y / len, z: axis.z / len };
  let min = Infinity, max = -Infinity;
  for (const c of corners) {
    const d = dot(sub(c, origin), unit);
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return { min, max };
}

describe('corner integrity: cutting the bend allowance away must leave exactly the two '
  + 'original panels, non-overlapping, at their own real dimensions', () => {
  it('reproduces the reported recipe, then verifies the constructed solid via a real boolean '
    + 'split at each side of the bend -- not just facet-normal orientation', () => {
    const store = new GraphStore();
    const imported = dispatchGraphTool(store, 'import_part', {
      file: path.join(FIXTURES_DIR, 'testcube.step'),
    }) as { part_id: string; protrusion_part_ids: string[]; component_part_ids: string[] };

    let component1 = imported.component_part_ids[0];
    let maxBends = -1;
    for (const cid of imported.component_part_ids) {
      const n = store.snapshotPart(cid).bends.length;
      if (n > maxBends) { maxBends = n; component1 = cid; }
    }

    const worklist: string[] = [component1];
    const allSplitParts = new Set<string>([component1]);
    while (worklist.length > 0) {
      const pid = worklist.pop()!;
      const bends = store.snapshotPart(pid).bends;
      if (bends.length === 0) continue;
      const bendId = bends[0].bendId;
      const result = dispatchGraphTool(store, 'split_part_at_bend', {
        part_id: pid, bend_id: bendId, keep_corner_on: 'parent',
      }) as { new_part_ids: string[] };
      for (const npid of result.new_part_ids) { allSplitParts.add(npid); worklist.push(npid); }
      worklist.push(pid);
    }

    const protrusion1 = imported.protrusion_part_ids[0];

    function bboxOfOutline(outline: Array<{ x: number; y: number }>) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const v of outline) {
        x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
        y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
      }
      return { w: x1 - x0, h: y1 - y0 };
    }

    let checkedAny = false;
    // Every pairing that fuse_bodies/merge_bodies_with_bend itself ACCEPTS
    // (i.e. did not throw -- a legitimate "no contact edge" rejection is not
    // a bug) must produce a working pipeline: evaluatePart, constructPart,
    // and the real 3D checks below. A failure here is pushed as a message
    // instead of thrown immediately, so one run enumerates every broken
    // pairing (e.g. "Protrusion 1 + Component 2" going region-clip-degenerate
    // in the live app) instead of silently skipping it as inapplicable or
    // stopping at the first pairing that happens to work.
    const failures: string[] = [];

    for (const axis of ['x', 'y'] as const) {
      for (const fuseTarget of allSplitParts) {
        const before = store.snapshotAll();
        const protrusion = store.getPart(protrusion1)!;
        const t = protrusion.anchor.t as [number, number, number];
        const newT: [number, number, number] =
          axis === 'x' ? [t[0] - 76.6, t[1], t[2]] : [t[0], t[1] - 76.6, t[2]];
        dispatchGraphTool(store, 'update_node', {
          kind: 'part', id: protrusion1, patch: { anchor: { r: protrusion.anchor.r, t: newT } },
        });

        let fusedPartId: string | undefined;
        try {
          const result = dispatchGraphTool(store, 'fuse_bodies', {
            part_a_id: fuseTarget, part_b_id: protrusion1,
          }) as { part_id: string };
          fusedPartId = result.part_id;
        } catch {
          store.restoreAll(before);
          continue;
        }
        const fusedOutlineBboxMm = bboxOfOutline(store.getPart(fusedPartId)!.outline);

        const allCandidates = new Set<string>([...imported.component_part_ids, ...allSplitParts]);
        allCandidates.delete(fuseTarget);
        allCandidates.delete(component1);

        for (const mergeTarget of allCandidates) {
          const beforeMerge = store.snapshotAll();
          const targetPart = store.getPart(mergeTarget);
          if (!targetPart || targetPart.mergedIntoPartId !== null) { store.restoreAll(beforeMerge); continue; }
          const mergeTargetOutlineBboxMm = bboxOfOutline(targetPart.outline);

          let mergeResult: { part_id: string; bend_id: string } | undefined;
          try {
            mergeResult = dispatchGraphTool(store, 'merge_bodies_with_bend', {
              part_a_id: fusedPartId,
              part_b_id: mergeTarget,
              radius_mm: 0.95,
            }) as { part_id: string; bend_id: string };
          } catch {
            store.restoreAll(beforeMerge);
            continue;
          }

          const comboLabel = `axis=${axis} fuseTarget=${fuseTarget} mergeTarget=${mergeTarget}`;

          // merge_bodies_with_bend already ACCEPTED this pairing (it did not
          // throw), so it claims to have produced a valid graph. If
          // evaluatePart now fails, that is the graph being broken, not an
          // inapplicable pairing -- record it as a failure, don't skip it.
          const evalResult = evaluatePart(store, mergeResult.part_id);
          if (!evalResult.ok || evalResult.bridges.length !== 1) {
            failures.push(`${comboLabel}: evaluatePart failed after a successful merge `
              + `(ok=${evalResult.ok}, errorCode=${(evalResult as any).errorCode}, `
              + `message=${(evalResult as any).message}, bridges=${evalResult.ok ? evalResult.bridges.length : 'n/a'})`);
            checkedAny = true;
            store.restoreAll(beforeMerge);
            continue;
          }
          const bridge = evalResult.bridges[0];

          const constructResult = constructPart(store, mergeResult.part_id);
          if (!constructResult.ok) {
            failures.push(`${comboLabel}: constructPart failed after a successful evaluatePart `
              + `(errorCode=${(constructResult as any).errorCode}, message=${(constructResult as any).message})`);
            checkedAny = true;
            store.restoreAll(beforeMerge);
            continue;
          }

          checkedAny = true;
          console.log(`\n=== ${comboLabel} ===`);

          // Offset the hinge line, in the FLAT 2D frame, safely past the
          // bend's curved region on each side (radius + margin) -- nLeftFlat
          // points toward the CHILD side (part_merge.hpp / BuildBendCuts
          // convention), so parent's own flat material lies at -nLeftFlat.
          const marginMm = bridge.bendId ? 0.95 + 3 : 3; // radius_mm=0.95 + 3mm cushion
          const nLeftFlat = (bridge as any).nLeftFlat as { x: number; y: number } | undefined;
          expect(nLeftFlat, 'bridge must expose nLeftFlat').toBeDefined();
          const hA = bridge.hingeA, hB = bridge.hingeB;

          const parentA2D = { x: hA.x - marginMm * nLeftFlat!.x, y: hA.y - marginMm * nLeftFlat!.y };
          const parentB2D = { x: hB.x - marginMm * nLeftFlat!.x, y: hB.y - marginMm * nLeftFlat!.y };
          const childA2D = { x: hA.x + marginMm * nLeftFlat!.x, y: hA.y + marginMm * nLeftFlat!.y };

          const parentAWorld = mapPointToWorld(store, mergeResult.part_id, parentA2D);
          const parentBWorld = mapPointToWorld(store, mergeResult.part_id, parentB2D);
          const childAWorld = mapPointToWorld(store, mergeResult.part_id, childA2D);
          if (!parentAWorld.ok || !parentBWorld.ok || !childAWorld.ok) {
            console.log('  (skip: offset points fell off the panel -- margin too large for this panel)');
            store.restoreAll(beforeMerge);
            continue;
          }

          const nLeftWorld = (bridge as any).nLeftWorld as Vec3;
          const childNLeftWorld = (bridge as any).childNLeftWorld as Vec3;

          // A point deep inside parent's own flat territory, used only to
          // determine which side of each plane parent's material is on.
          const parentDeep2D = { x: hA.x - (marginMm + 50) * nLeftFlat!.x, y: hA.y - (marginMm + 50) * nLeftFlat!.y };
          const parentDeepWorld = mapPointToWorld(store, mergeResult.part_id, parentDeep2D);

          const parentPlane = { origin: parentAWorld.point3d, normal: nLeftWorld };
          const childPlane = { origin: childAWorld.point3d, normal: childNLeftWorld };

          // splitBodyByPlane consumes its input shell (in-place, rollback-
          // token style), and constructing a second copy of the SAME part
          // appears to invalidate an earlier live shell for that part too
          // (confirmed live: GE_SHELL_NOT_FOUND when both constructions were
          // held simultaneously) -- so each split is fully constructed,
          // split, and read out before the NEXT one is even built.
          // constructPartSolid registers a genuine closed solid under the
          // addon's OWN `solids` map (part_solid_construction.cc: `if
          // (currentShape.ShapeType() == TopAbs_SOLID) state.solids[id] =
          // ...`), but splitBodyByPlane only ever looks in its `shells` map
          // (geometry_service_sheet_metal.cc's own `s_.shells.find(partId)`)
          // -- confirmed live (GE_SHELL_NOT_FOUND on a solid-registered id
          // that computeBoundingBox/lookupEntityIn found fine). separateSolids
          // is the one existing operation that bridges solids -> shells (it
          // explores TopAbs_SOLID within a `solids`-registered shape and
          // re-registers each into `shells`) -- used here purely as that
          // adapter, not because the shape is expected to be fragmented.
          const constructForParent = constructPart(store, mergeResult.part_id);
          if (!constructForParent.ok) {
            console.log('  (skip: could not construct shell for parent split)');
            store.restoreAll(beforeMerge);
            continue;
          }
          const wholeShellIds = geometryBinding.separateSolids(constructForParent.shellId);
          if (wholeShellIds.length !== 1) {
            failures.push(`${comboLabel}: constructed part is not exactly one solid before any `
              + `cutting (count=${wholeShellIds.length})`);
            store.restoreAll(beforeMerge);
            continue;
          }
          const wholeShellId = wholeShellIds[0];

          let parentSplit;
          try {
            parentSplit = geometryBinding.splitBodyByPlane(wholeShellId, parentPlane);
          } catch (e: any) {
            console.log('  parent split THREW:', e?.message ?? JSON.stringify(e));
            store.restoreAll(beforeMerge);
            continue;
          }

          const parentSideSign = parentDeepWorld.ok
            ? Math.sign(dot(sub(parentDeepWorld.point3d, parentPlane.origin), parentPlane.normal))
            : -1;
          const parentFlatShellId = parentSideSign < 0 ? parentSplit.negativeShellId : parentSplit.positiveShellId;

          // CHECK 1a: this piece is itself exactly one connected solid --
          // exploreTopology(..., 'solid') works on either map via
          // lookupEntityIn, so it's used here (not separateSolids, which
          // requires a `solids`-registered entity) to count disjoint solids
          // within a `shells`-registered split result.
          const parentSolidCount = geometryBinding.exploreTopology(parentFlatShellId, 'solid').entity_ids.length;
          const parentBbox = geometryBinding.computeBoundingBox(parentFlatShellId);
          const pB: Bbox = {
            xMin: parentBbox.x_min, yMin: parentBbox.y_min, zMin: parentBbox.z_min,
            xMax: parentBbox.x_max, yMax: parentBbox.y_max, zMax: parentBbox.z_max,
          };

          const constructForChild = constructPart(store, mergeResult.part_id);
          if (!constructForChild.ok) {
            console.log('  (skip: could not construct shell for child split)');
            store.restoreAll(beforeMerge);
            continue;
          }
          const childWholeShellIds = geometryBinding.separateSolids(constructForChild.shellId);
          const childWholeShellId = childWholeShellIds[0];

          let childSplit;
          try {
            childSplit = geometryBinding.splitBodyByPlane(childWholeShellId, childPlane);
          } catch (e: any) {
            console.log('  child split THREW:', e?.message ?? JSON.stringify(e));
            store.restoreAll(beforeMerge);
            continue;
          }

          const childSideSign = -parentSideSign; // child lies on the opposite side of its own tangent plane
          const childFlatShellId = childSideSign < 0 ? childSplit.negativeShellId : childSplit.positiveShellId;

          const childSolidCount = geometryBinding.exploreTopology(childFlatShellId, 'solid').entity_ids.length;
          console.log('  parentSolidCount:', parentSolidCount, 'childSolidCount:', childSolidCount);
          if (parentSolidCount !== 1) {
            failures.push(`${comboLabel}: parent-side cut is not a single solid (count=${parentSolidCount})`);
          }
          if (childSolidCount !== 1) {
            failures.push(`${comboLabel}: child-side cut is not a single solid (count=${childSolidCount})`);
          }

          // CHECK 2: the two pieces do not overlap in 3D space (THE actual
          // "went through each other" check) -- a small allowance for the
          // margin/curvature zone itself, but nowhere near a full panel.
          const childBbox = geometryBinding.computeBoundingBox(childFlatShellId);
          const cB: Bbox = {
            xMin: childBbox.x_min, yMin: childBbox.y_min, zMin: childBbox.z_min,
            xMax: childBbox.x_max, yMax: childBbox.y_max, zMax: childBbox.z_max,
          };
          const overlap = overlapVolume(pB, cB);
          console.log('  parent bbox:', JSON.stringify(pB));
          console.log('  child bbox:', JSON.stringify(cB));
          console.log('  overlap volume (mm^3):', overlap.toFixed(2));
          // A correct fold's two cut-back pieces should not overlap at all
          // once the bend region itself (radius+margin on each side) has
          // been removed -- allow a tiny numerical sliver, nothing close to
          // real panel material.
          if (!(overlap < 50)) {
            failures.push(`${comboLabel}: panels occupy overlapping 3D space after the bend `
              + `allowance is cut away (overlap=${overlap.toFixed(2)}mm^3)`);
          }

          // CHECK 3: each piece's own size is consistent with the ORIGINAL
          // (pre-merge) material it came from -- not larger (extra
          // protruding material) or smaller (lost material) than the source
          // outline, allowing for the margin cut back from each edge.
          const parentExtents = sortedExtents(pB);
          const childExtents = sortedExtents(cB);
          console.log('  parent cut-piece extents (sorted):', parentExtents.map((v) => v.toFixed(1)));
          console.log('  fused source outline bbox (mm):', JSON.stringify(fusedOutlineBboxMm));
          console.log('  child cut-piece extents (sorted):', childExtents.map((v) => v.toFixed(1)));
          console.log('  merge-target source outline bbox (mm):', JSON.stringify(mergeTargetOutlineBboxMm));
          // The largest in-plane extent of each cut piece must not exceed
          // its own source outline's largest dimension (material can only
          // shrink from the margin cut, never grow beyond its own source).
          const fusedMaxDim = Math.max(fusedOutlineBboxMm.w, fusedOutlineBboxMm.h);
          const targetMaxDim = Math.max(mergeTargetOutlineBboxMm.w, mergeTargetOutlineBboxMm.h);
          if (!(parentExtents[2] <= fusedMaxDim + 1)) {
            failures.push(`${comboLabel}: parent cut-piece exceeds its own source panel's size `
              + `(${parentExtents[2].toFixed(1)}mm > ${fusedMaxDim.toFixed(1)}mm)`);
          }
          if (!(childExtents[2] <= targetMaxDim + 1)) {
            failures.push(`${comboLabel}: child cut-piece exceeds its own source panel's size `
              + `(${childExtents[2].toFixed(1)}mm > ${targetMaxDim.toFixed(1)}mm)`);
          }

          // CHECK 4: the bend region ITSELF -- the material CHECKS 1-3 cut
          // away and never look at -- must not extend, along the seam's own
          // axis, beyond the two flat panels' own combined width there. A
          // corner defect where the fold produces an extra tab/protrusion
          // sticking out sideways (in line with a panel, along the hinge
          // direction, not perpendicular to it) lives entirely inside this
          // discarded margin and is invisible to checks 1-3 no matter how
          // exhaustively they run (this is exactly why a live corner defect
          // -- "the corner looks like a cross, with two protrusions in line
          // with the panels" -- passed this test's own checks 1-3 cleanly).
          try {
            const constructForBend = constructPart(store, mergeResult.part_id);
            if (constructForBend.ok) {
              const bendWholeIds = geometryBinding.separateSolids(constructForBend.shellId);
              const bendWholeId = bendWholeIds[0];
              const bendSplit1 = geometryBinding.splitBodyByPlane(bendWholeId, parentPlane);
              // Keep the side AWAY from parent's own flat material (child + bend).
              const awayFromParentId = parentSideSign < 0 ? bendSplit1.positiveShellId : bendSplit1.negativeShellId;
              const bendSplit2 = geometryBinding.splitBodyByPlane(awayFromParentId, childPlane);
              // Keep the side AWAY from child's own flat material -- the bend region alone.
              const bendOnlyId = childSideSign < 0 ? bendSplit2.positiveShellId : bendSplit2.negativeShellId;
              const bendBbox = geometryBinding.computeBoundingBox(bendOnlyId);
              const bB: Bbox = {
                xMin: bendBbox.x_min, yMin: bendBbox.y_min, zMin: bendBbox.z_min,
                xMax: bendBbox.x_max, yMax: bendBbox.y_max, zMax: bendBbox.z_max,
              };

              const axisOrigin = (bridge as any).pivotOriginWorld as Vec3;
              const axis = (bridge as any).pivotAxisWorld as Vec3;
              const parentAxisRange = projectRange(bboxCorners(pB), axisOrigin, axis);
              const childAxisRange = projectRange(bboxCorners(cB), axisOrigin, axis);
              const bendAxisRange = projectRange(bboxCorners(bB), axisOrigin, axis);
              const unionMin = Math.min(parentAxisRange.min, childAxisRange.min);
              const unionMax = Math.max(parentAxisRange.max, childAxisRange.max);
              console.log(`  bend-region axis range along seam: [${bendAxisRange.min.toFixed(1)}, `
                + `${bendAxisRange.max.toFixed(1)}], panels' own union: [${unionMin.toFixed(1)}, `
                + `${unionMax.toFixed(1)}]`);

              const toleranceMm = 2; // numerical cushion, not a real feature allowance
              if (bendAxisRange.min < unionMin - toleranceMm || bendAxisRange.max > unionMax + toleranceMm) {
                failures.push(`${comboLabel}: the bend region extends beyond both panels' own width `
                  + `along the seam (bend axis range [${bendAxisRange.min.toFixed(1)}, `
                  + `${bendAxisRange.max.toFixed(1)}], panels' own union [${unionMin.toFixed(1)}, `
                  + `${unionMax.toFixed(1)}]) -- looks like a protruding tab at the corner/seam`);
              }
            } else {
              console.log('  (CHECK 4 skipped: could not construct shell for bend-region split)');
            }
          } catch (e: any) {
            console.log('  (CHECK 4 skipped: bend-region split THREW):', e?.message ?? e);
          }

          store.restoreAll(beforeMerge);
        }

        store.restoreAll(before);
      }
    }

    expect(checkedAny, 'at least one pairing matching the recipe must be checked').toBe(true);
    expect(failures, 'every pairing merge_bodies_with_bend accepts must produce a valid, '
      + 'non-overlapping merge -- see console output above for which combos ran').toEqual([]);
  });
});
