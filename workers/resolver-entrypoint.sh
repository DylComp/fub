#!/bin/sh
set -eu
# Only initialize the dedicated mount. All browser and Node work runs as pwuser.
if [ "$(id -u)" = 0 ]; then
  install -d -o pwuser -g pwuser -m 700 /data/.fomo-resolver-browser
  exec /usr/bin/tini -s -- /usr/sbin/gosu pwuser "$@"
fi
exec "$@"
