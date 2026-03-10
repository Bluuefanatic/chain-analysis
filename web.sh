#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# web.sh — Web visualizer
#
# Starts the web visualizer server.
#
# Behavior:
#   - Reads PORT env var (default: 3000)
#   - Prints the URL (e.g., http://127.0.0.1:3000) to stdout
#   - Keeps running until terminated (CTRL+C / SIGTERM)
#   - Must serve GET /api/health -> 200 { "ok": true }
#
# TODO: Replace the stub below with your web server start command.
###############################################################################

export PORT="${PORT:-3000}"

# Build the React front-end (outputs to src/web/dist/)
npm run build:web

# Start the API + static-file server.
# The server prints exactly one line to stdout: "http://127.0.0.1:<PORT>"
# All other log messages go to stderr.
exec node src/web/server.js
