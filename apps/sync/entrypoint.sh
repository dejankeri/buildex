#!/bin/sh
# Replication is opt-in, gated on LITESTREAM_ENDPOINT being configured:
#
#   - Endpoint set (production always sets one): restore THEN serve. `litestream replicate` never
#     reads from the replica - restoring is a separate invocation - so without the restore step a
#     machine that boots on an empty volume would create a fresh control.db and immediately
#     replicate it over the real backup, destroying it during the exact incident the backup exists
#     for. A restore is required for every database listed in litestream.yml's `dbs:` - replicating
#     a database without restoring it first is the worst of both worlds: the empty boot copy
#     overwrites the good replica. If the endpoint is unreachable and there is no local database,
#     this fails closed (exits non-zero) rather than boot on an empty db - that is correct: an
#     empty db clobbering a real backup is worse than refusing to start.
#
#   - Endpoint unset/empty (the local-dev default, infra/compose.yml): there is nothing to restore
#     from and nothing to replicate to, so skip litestream entirely and run node directly. Without
#     this branch, local dev's deliberately-unreachable placeholder endpoint would make `restore`
#     fail closed and the dev container would never boot at all.
#
#   -if-db-not-exists  : never clobber a database that is already on the volume
#   -if-replica-exists : a genuinely first-ever boot has no replica, and that is not an error
set -e

if [ -z "$LITESTREAM_ENDPOINT" ]; then
  echo "entrypoint: LITESTREAM_ENDPOINT not set - replication disabled, running unreplicated (this box is NOT backed up)"
  exec node /app/dist/main.js
fi

litestream restore -if-db-not-exists -if-replica-exists -config /etc/litestream.yml "$BUILDEX_DATA_DIR/control.db"
litestream restore -if-db-not-exists -if-replica-exists -config /etc/litestream.yml "$BUILDEX_DATA_DIR/schedules.db"
exec litestream replicate -config /etc/litestream.yml -exec "node /app/dist/main.js"
