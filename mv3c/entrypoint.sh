#!/bin/sh
set -eu
cd /app
umask 077
node /app/mv3c/bootstrap.cjs
set -a
. /app/data/mv3c-bootstrap.env
set +a
exec npm run backend
