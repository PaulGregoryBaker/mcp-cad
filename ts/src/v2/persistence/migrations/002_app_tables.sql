-- 002 — Application tables (spec 010, data-model §3).
-- client_meta is opaque to the server (the client owns its schema).
-- project_settings / import_source are validated by the server because it uses them.
-- session_state is dolt_ignore'd: it lives only in main's working set, is never
-- committed and never inherited by branches (confirmed by the T004 spike), and
-- is always read/written via `<db>/main`.

CREATE TABLE client_meta (
  part_id VARCHAR(36) NOT NULL PRIMARY KEY,
  doc JSON NOT NULL,
  CHECK (JSON_VALID(doc)),
  FOREIGN KEY (part_id) REFERENCES part (part_id) ON DELETE CASCADE
);

CREATE TABLE project_settings (
  id TINYINT NOT NULL PRIMARY KEY,
  manufacturing_profile JSON NULL,
  manufacturing_defaults JSON NULL,
  nesting JSON NULL,
  CHECK (id = 1),
  CHECK (manufacturing_profile IS NULL OR JSON_VALID(manufacturing_profile)),
  CHECK (manufacturing_defaults IS NULL OR JSON_VALID(manufacturing_defaults)),
  CHECK (nesting IS NULL OR JSON_VALID(nesting))
);

INSERT INTO project_settings (id) VALUES (1);

CREATE TABLE import_source (
  import_source_id VARCHAR(36) NOT NULL PRIMARY KEY,
  file_path TEXT NOT NULL,
  file_sha256 CHAR(64) NOT NULL,
  config JSON NOT NULL,
  measured_thickness_mm DOUBLE NULL,
  imported_at TIMESTAMP(3) NOT NULL,
  CHECK (JSON_VALID(config)),
  CHECK (CHAR_LENGTH(file_sha256) = 64),
  CHECK (measured_thickness_mm IS NULL OR measured_thickness_mm > 0)
);

INSERT INTO dolt_ignore VALUES ('session_state', true);

CREATE TABLE session_state (
  id TINYINT NOT NULL PRIMARY KEY,
  current_branch VARCHAR(255) NOT NULL,
  CHECK (id = 1)
);
