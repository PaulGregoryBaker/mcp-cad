#!/usr/bin/env bash
# Starts a local dolt sql-server for MCP-CAD development.
# Usage: ./scripts/run_dolt.sh [data_dir] [database]
#
# Defaults match the config.yaml persistence block defaults:
#   data_dir  = ./state/dolt
#   database  = semantic_braai
#   host      = 127.0.0.1
#   port      = 3306

set -euo pipefail

DATA_DIR="${1:-./state/dolt}"
DATABASE="${2:-semantic_braai}"
HOST="127.0.0.1"
PORT="3306"

DB_DIR="$DATA_DIR/$DATABASE"

if ! command -v dolt &>/dev/null; then
  echo "ERROR: dolt not found. Install from https://github.com/dolthub/dolt/releases"
  exit 1
fi

# Initialise the database directory if it doesn't exist yet.
if [ ! -d "$DB_DIR" ]; then
  echo "Initialising Dolt database at $DB_DIR ..."
  mkdir -p "$DB_DIR"
  (cd "$DB_DIR" && dolt init)
fi

echo "Starting dolt sql-server on $HOST:$PORT (data: $DATA_DIR) ..."
exec dolt sql-server \
  --host="$HOST" \
  --port="$PORT" \
  --user=root \
  --password="" \
  --data-dir="$DATA_DIR"
