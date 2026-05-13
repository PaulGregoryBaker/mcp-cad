#pragma once

/**
 * GeometrySnapshot — Snapshot registry for rollback support.
 *
 * Constitution Principle IV requires that every mutating tool produces
 * a rollback_token before executing. This header defines the snapshot
 * data structures and the SnapshotRegistry interface.
 *
 * Tasks: T089
 */

#include <string>
#include <vector>
#include <unordered_map>
#include <chrono>

namespace mcp_cad {

using SnapshotId = std::string;  // UUID v4

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * GeometrySnapshot captures the set of solid and shell IDs at a point in time.
 * The actual B-Rep data is stored by the GeometryService implementation;
 * the snapshot acts as a named reference to that stored state.
 */
struct GeometrySnapshot {
  SnapshotId               snapshotId;
  std::vector<std::string> solidIds;
  std::vector<std::string> shellIds;
  std::vector<std::string> unfoldIds;
  long long                timestampMs;   // Unix epoch ms
  std::string              operationLabel;
};

// ─── SnapshotRegistry interface ──────────────────────────────────────────────

/**
 * SnapshotRegistry manages the lifecycle of GeometrySnapshots.
 * Implemented by GeometryServiceImpl.
 */
class SnapshotRegistry {
public:
  virtual ~SnapshotRegistry() = default;

  /**
   * Creates a new snapshot of the current geometry state.
   * @param label  Human-readable label (e.g., "before decompose_volume")
   * @return       The new snapshotId (also used as rollback_token)
   */
  virtual SnapshotId createSnapshot(const std::string& label) = 0;

  /**
   * Restores the geometry state to the snapshot identified by snapshotId.
   * Clears all state created after the snapshot.
   */
  virtual void restoreSnapshot(const SnapshotId& snapshotId) = 0;

  /**
   * Removes all snapshots and frees associated B-Rep data.
   */
  virtual void clearSnapshots() = 0;

  /**
   * Returns the snapshot metadata (does not restore state).
   */
  virtual GeometrySnapshot getSnapshot(const SnapshotId& snapshotId) const = 0;

  /**
   * Returns true if the given snapshotId exists in the registry.
   */
  virtual bool hasSnapshot(const SnapshotId& snapshotId) const = 0;
};

}  // namespace mcp_cad
