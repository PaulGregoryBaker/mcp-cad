/**
 * MappingLayer — commit-time remap of face-group and spatial-region bindings.
 *
 * Called by handleCommitTransaction after the geometry snapshot is discarded
 * but before the Dolt branch is merged.
 *
 * JSON strategy note (see dolt_adapter.ts): the remap join is done app-side
 * rather than via SQL MEMBER OF / JSON_TABLE, per the T015 decision.
 */

import type { SemanticStore } from './semantic_store';
import type { FaceGroupBinding } from './types';

export class MappingLayer {
  constructor(private store: SemanticStore) {}

  /**
   * For each face-group binding whose face IDs appear in the transaction's
   * shape_history, insert a new semantic_mapping row with the remapped IDs.
   *
   * Remapping rules:
   *   modified  → replace original face with new face
   *   generated → add new face to the set (keep original too, as a sibling)
   *   deleted   → remove the face from the set
   *
   * If all face IDs in a binding are deleted, the new binding has an empty
   * face_ids list and a remap_reason of "all faces deleted".
   */
  async applyShapeHistoryToBindings(
    transactionId: string,
    topologyRevision: number,
  ): Promise<string[]> {
    const port = this.store.getPort();

    // 1. Fetch shape history for this transaction.
    const history = await port.getShapeHistoryForTransaction(transactionId);
    if (history.length === 0) return [];

    // Build lookup maps from original_id for O(1) access.
    const modifiedMap = new Map<string, string>(); // original → new
    const generatedMap = new Map<string, string[]>(); // original → [new, ...]
    const deletedSet = new Set<string>(); // original ids

    for (const rec of history) {
      if (rec.verdict === 'modified' && rec.new_id) {
        modifiedMap.set(rec.original_id, rec.new_id);
      } else if (rec.verdict === 'generated' && rec.new_id) {
        const existing = generatedMap.get(rec.original_id) ?? [];
        existing.push(rec.new_id);
        generatedMap.set(rec.original_id, existing);
      } else if (rec.verdict === 'deleted') {
        deletedSet.add(rec.original_id);
      }
    }

    const affectedOriginals = new Set([
      ...modifiedMap.keys(),
      ...generatedMap.keys(),
      ...deletedSet,
    ]);

    // 2. Fetch all current face_group bindings (app-side join).
    const allMappings = await port.getAllCurrentMappings();
    const faceGroupMappings = allMappings.filter((m) => m.binding_kind === 'face_group');

    const affectedEntityIds: string[] = [];

    for (const mapping of faceGroupMappings) {
      const binding = mapping.binding as FaceGroupBinding;
      const originalFaceIds = binding.face_ids;

      const hasAffected = originalFaceIds.some((fid) => affectedOriginals.has(fid));
      if (!hasAffected) {
        // Carry forward unchanged binding with a new row so lineage is complete.
        await port.insertMapping({
          semantic_id: mapping.semantic_id,
          binding: { kind: 'face_group', face_ids: originalFaceIds },
          topology_revision: topologyRevision,
          transaction_id: transactionId,
          remap_reason: undefined,
        });
        continue;
      }

      // Compute new face ID set.
      const newFaceIds: string[] = [];
      let remapReason = '';

      for (const fid of originalFaceIds) {
        if (deletedSet.has(fid)) {
          remapReason = `${mapping.semantic_id} face deleted`;
          // drop this face
        } else if (modifiedMap.has(fid)) {
          const newId = modifiedMap.get(fid)!;
          newFaceIds.push(newId);
          remapReason = `${getOperationLabel(history, fid)} → OCCT Modified()`;
        } else if (generatedMap.has(fid)) {
          const generated = generatedMap.get(fid)!;
          newFaceIds.push(...generated);
          remapReason = `${getOperationLabel(history, fid)} → OCCT Generated()`;
        } else {
          // Not in history — keep unchanged.
          newFaceIds.push(fid);
        }
      }

      if (newFaceIds.length === 0) {
        remapReason = 'all faces deleted';
      }

      await port.insertMapping({
        semantic_id: mapping.semantic_id,
        binding: { kind: 'face_group', face_ids: newFaceIds },
        topology_revision: topologyRevision,
        transaction_id: transactionId,
        remap_reason: remapReason || undefined,
      });

      affectedEntityIds.push(mapping.semantic_id);
    }

    return affectedEntityIds;
  }

  /**
   * For each spatial_region binding whose constituents were affected by the
   * remap, insert a new mapping row preserving the same derivation rule.
   * The new row records the updated topology_revision so resolveCurrent
   * picks it up on the next query.
   */
  async refreshDerivedBindings(
    transactionId: string,
    topologyRevision: number,
    affectedEntityIds: string[],
  ): Promise<void> {
    if (affectedEntityIds.length === 0) return;

    const port = this.store.getPort();
    const affected = new Set(affectedEntityIds);

    const allMappings = await port.getAllCurrentMappings();
    const spatialMappings = allMappings.filter((m) => m.binding_kind === 'spatial_region');

    for (const mapping of spatialMappings) {
      if (mapping.binding.kind !== 'spatial_region') continue;
      const [idA, idB] = mapping.binding.between;

      if (!affected.has(idA) && !affected.has(idB)) continue;

      // Refresh: insert new row with the same rule but updated revision.
      await port.insertMapping({
        semantic_id: mapping.semantic_id,
        binding: { kind: 'spatial_region', between: [idA, idB] },
        topology_revision: topologyRevision,
        transaction_id: transactionId,
        remap_reason: 'spatial_region refresh',
      });
    }
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function getOperationLabel(
  history: Array<{ original_id: string; operation_label: string }>,
  faceId: string,
): string {
  return history.find((r) => r.original_id === faceId)?.operation_label ?? 'unknown_op';
}
