#!/bin/sh
# Restore THEN serve. `litestream replicate` never reads from the replica - restoring is a separate
# invocation - so without this line a machine that boots on an empty volume would create a fresh
# control.db and immediately replicate it over the real backup, destroying it during the exact
# incident the backup exists for.
#
#   -if-db-not-exists  : never clobber a database that is already on the volume
#   -if-replica-exists : a genuinely first-ever boot has no replica, and that is not an error
set -e
litestream restore -if-db-not-exists -if-replica-exists -config /etc/litestream.yml "$BUILDEX_DATA_DIR/control.db"
exec litestream replicate -config /etc/litestream.yml -exec "node /app/dist/main.js"
