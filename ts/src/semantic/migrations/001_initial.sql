-- 001_initial.sql — Semantic Mapping Layer initial schema
-- Tables match SemanticCad/Persistence-Dolt.md §4 exactly.

CREATE TABLE IF NOT EXISTS semantic_entity (
    id                      VARCHAR(255) NOT NULL PRIMARY KEY,
    type                    ENUM('panel', 'panel_group', 'joint_interface',
                                  'functional_system', 'spatial_region') NOT NULL,
    purpose_json            JSON NULL,
    state                   ENUM('candidate', 'confirmed', 'deprecated') NOT NULL
                               DEFAULT 'confirmed',
    created_in_transaction  VARCHAR(64) NOT NULL,
    created_at              DATETIME(3) NOT NULL,

    INDEX (type),
    INDEX (created_in_transaction)
);

CREATE TABLE IF NOT EXISTS semantic_relationship (
    source_id               VARCHAR(255) NOT NULL,
    relationship            ENUM('contains', 'bounded_by', 'connected_to',
                                  'manufactured_as', 'joined_by', 'bent_along') NOT NULL,
    target_id               VARCHAR(255) NOT NULL,
    created_in_transaction  VARCHAR(64) NOT NULL,
    created_at              DATETIME(3) NOT NULL,

    PRIMARY KEY (source_id, relationship, target_id),
    INDEX (target_id, relationship)
);

CREATE TABLE IF NOT EXISTS semantic_mapping (
    revision_id             BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    semantic_id             VARCHAR(255) NOT NULL,
    binding_kind            ENUM('face_group', 'body', 'spatial_region') NOT NULL,
    binding_json            JSON NOT NULL,
    topology_revision       BIGINT NOT NULL,
    created_in_transaction  VARCHAR(64) NOT NULL,
    created_at              DATETIME(3) NOT NULL,
    remap_reason            VARCHAR(255) NULL,

    INDEX (semantic_id, revision_id),
    INDEX (topology_revision)
);

CREATE TABLE IF NOT EXISTS topology_revision (
    id              BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    transaction_id  VARCHAR(64) NOT NULL,
    brep_file_path  VARCHAR(1024) NOT NULL,
    brep_sha256     CHAR(64) NOT NULL,
    created_at      DATETIME(3) NOT NULL,

    UNIQUE (transaction_id),
    INDEX (brep_sha256)
);

CREATE TABLE IF NOT EXISTS shape_history (
    transaction_id  VARCHAR(64)  NOT NULL,
    verdict         ENUM('modified', 'generated', 'deleted') NOT NULL,
    original_id     VARCHAR(255) NOT NULL,
    -- new_id uses '' as a sentinel for verdict='deleted' (no successor shape).
    -- Dolt (MySQL-strict) requires every PRIMARY KEY column to be NOT NULL.
    new_id          VARCHAR(255) NOT NULL DEFAULT '',
    operation_label VARCHAR(64)  NOT NULL,

    PRIMARY KEY (transaction_id, verdict, original_id, new_id),
    INDEX (original_id),
    INDEX (transaction_id)
);

CREATE TABLE IF NOT EXISTS `transaction` (
    id          VARCHAR(64) NOT NULL PRIMARY KEY,
    label       VARCHAR(255) NOT NULL,
    product     VARCHAR(64) NOT NULL,
    state       ENUM('active', 'committed', 'rolled_back') NOT NULL,
    started_at  DATETIME(3) NOT NULL,
    ended_at    DATETIME(3) NULL,

    INDEX (state)
);
