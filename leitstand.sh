#!/bin/sh
# Leitstand aller beadskit-Projekte (Liste in ~/.config/beadskit/projects.txt), http://127.0.0.1:3738.
# Läuft aus dem Kit dieses Templates; Optionen gehen an inbox.mjs durch.
exec node "$(dirname "$0")/scripts/beadskit/leitstand/inbox.mjs" "$@"
