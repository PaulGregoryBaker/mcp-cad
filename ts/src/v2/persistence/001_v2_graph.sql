-- v2 graph persistence table (Slice 10, rebuild/14-graph-schema.md §2).
-- One row per part; entire graph snapshot stored as JSON for Dolt row-level
-- diffability.  The JSON shape matches GraphStore.snapshotPart() exactly:
--   { part: PartRow, regionPanels: RegionPanelRow[], bends: BendRow[] }

CREATE TABLE IF NOT EXISTS v2_part (
  part_id VARCHAR(36) NOT NULL PRIMARY KEY,
  graph_json JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
