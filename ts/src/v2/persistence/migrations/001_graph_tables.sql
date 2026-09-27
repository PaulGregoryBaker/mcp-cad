-- 001 — Manufacturing graph, normalised (spec 010, R-016; rebuild/14-graph-schema.md §2).
-- Only the subset the v2 in-memory model populates today. seam / semantic_* /
-- anchor_feature / dimension_curation arrive in later migrations with their model.
-- Circular/self references (part.root_region_panel_id, part.merged_into_part_id,
-- region_panel.merged_into_region_panel_id) have no FOREIGN KEY: MySQL/Dolt has no
-- deferred constraints. They are enforced by graph/invariants.ts (R-013 layer 3).
-- Geometric validity is never checked here (constitution principle IV).
-- region_panel.order_key / bend.order_key (addendum to 14 §2): the evaluator
-- is sensitive to bend-array order (hinge-vertex insertion, cut order), so the
-- in-memory order is persisted with the same fractional keys as vertices.

CREATE TABLE part (
  part_id VARCHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  root_region_panel_id VARCHAR(36) NOT NULL,
  anchor_r00 DOUBLE NOT NULL, anchor_r01 DOUBLE NOT NULL, anchor_r02 DOUBLE NOT NULL,
  anchor_r10 DOUBLE NOT NULL, anchor_r11 DOUBLE NOT NULL, anchor_r12 DOUBLE NOT NULL,
  anchor_r20 DOUBLE NOT NULL, anchor_r21 DOUBLE NOT NULL, anchor_r22 DOUBLE NOT NULL,
  anchor_tx DOUBLE NOT NULL, anchor_ty DOUBLE NOT NULL, anchor_tz DOUBLE NOT NULL,
  material_id VARCHAR(64) NOT NULL,
  thickness_mm DOUBLE NOT NULL CHECK (thickness_mm > 0),
  k_factor DOUBLE NOT NULL CHECK (k_factor >= 0 AND k_factor <= 1),
  schema_version VARCHAR(16) NOT NULL,
  merged_into_part_id VARCHAR(36) NULL
);

CREATE TABLE part_ring (
  ring_id VARCHAR(36) NOT NULL PRIMARY KEY,
  part_id VARCHAR(36) NOT NULL,
  kind ENUM('outline', 'hole', 'feature_poly', 'semantic_region') NOT NULL,
  hole_order_key VARCHAR(64) NULL,
  CHECK (kind <> 'hole' OR hole_order_key IS NOT NULL),
  FOREIGN KEY (part_id) REFERENCES part (part_id) ON DELETE CASCADE
);

CREATE TABLE ring_vertex (
  vertex_id VARCHAR(36) NOT NULL PRIMARY KEY,
  ring_id VARCHAR(36) NOT NULL,
  order_key VARCHAR(64) NOT NULL,
  x DOUBLE NOT NULL,
  y DOUBLE NOT NULL,
  bulge DOUBLE NOT NULL DEFAULT 0,
  UNIQUE KEY ring_order (ring_id, order_key),
  FOREIGN KEY (ring_id) REFERENCES part_ring (ring_id) ON DELETE CASCADE
);

CREATE TABLE feature (
  feature_id VARCHAR(36) NOT NULL PRIMARY KEY,
  part_id VARCHAR(36) NOT NULL,
  kind ENUM('hole_circle', 'cutout_poly', 'slot', 'notch', 'relief') NOT NULL,
  cx DOUBLE NULL,
  cy DOUBLE NULL,
  r DOUBLE NULL,
  poly_ring_id VARCHAR(36) NULL,
  process ENUM('laser', 'punch', 'tap') NULL,
  hole_order_key VARCHAR(64) NULL,
  CHECK (kind <> 'hole_circle' OR (cx IS NOT NULL AND cy IS NOT NULL AND r > 0 AND hole_order_key IS NOT NULL)),
  FOREIGN KEY (part_id) REFERENCES part (part_id) ON DELETE CASCADE,
  FOREIGN KEY (poly_ring_id) REFERENCES part_ring (ring_id) ON DELETE CASCADE
);

CREATE TABLE region_panel (
  region_panel_id VARCHAR(36) NOT NULL PRIMARY KEY,
  part_id VARCHAR(36) NOT NULL,
  label VARCHAR(255) NOT NULL,
  k_factor_override DOUBLE NULL CHECK (k_factor_override IS NULL OR (k_factor_override >= 0 AND k_factor_override <= 1)),
  merged_into_region_panel_id VARCHAR(36) NULL,
  order_key VARCHAR(64) NOT NULL,
  FOREIGN KEY (part_id) REFERENCES part (part_id) ON DELETE CASCADE
);

CREATE TABLE bend (
  bend_id VARCHAR(36) NOT NULL PRIMARY KEY,
  part_id VARCHAR(36) NOT NULL,
  parent_region_panel_id VARCHAR(36) NOT NULL,
  child_region_panel_id VARCHAR(36) NOT NULL,
  hinge_ax DOUBLE NOT NULL, hinge_ay DOUBLE NOT NULL,
  hinge_bx DOUBLE NOT NULL, hinge_by DOUBLE NOT NULL,
  angle_deg DOUBLE NOT NULL,
  radius_mm DOUBLE NOT NULL CHECK (radius_mm >= 0),
  k_factor_override DOUBLE NULL CHECK (k_factor_override IS NULL OR (k_factor_override >= 0 AND k_factor_override <= 1)),
  bottom_is_concave BOOLEAN NULL,
  radius_measured BOOLEAN NOT NULL,
  bend_process VARCHAR(64) NULL,
  order_key VARCHAR(64) NOT NULL,
  FOREIGN KEY (part_id) REFERENCES part (part_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_region_panel_id) REFERENCES region_panel (region_panel_id),
  FOREIGN KEY (child_region_panel_id) REFERENCES region_panel (region_panel_id)
);

CREATE TABLE action_log (
  seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at TIMESTAMP(3) NOT NULL,
  actor_kind ENUM('human', 'agent', 'system') NOT NULL,
  actor_id VARCHAR(255) NOT NULL,
  tool VARCHAR(64) NOT NULL,
  params JSON NOT NULL,
  delta_summary JSON NOT NULL,
  undo_delta JSON NULL,
  undone BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (JSON_VALID(params) AND JSON_VALID(delta_summary)),
  CHECK ((actor_kind = 'system' AND undo_delta IS NULL) OR (actor_kind <> 'system' AND undo_delta IS NOT NULL))
);

CREATE TABLE meta (
  meta_key VARCHAR(64) NOT NULL PRIMARY KEY,
  meta_value VARCHAR(1024) NOT NULL
);

INSERT INTO meta (meta_key, meta_value) VALUES ('committed_seq', '0');
