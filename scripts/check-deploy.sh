#!/bin/sh
# Push the built package to a real (local, anonymous) Convex backend.
#
# convex-test runs functions in-process and never validates module paths,
# component wiring or bundling, so an offline-green build can still be
# rejected by `convex dev` / deploy (for example "InvalidConfig: Invalid module
# path 'turns/decision-proposals.js'"). This script builds `dist/`, creates a
# throwaway host app that mounts the native Agent component plus agevex and
# every optional module the way a consumer does, and pushes it once to a
# local anonymous deployment. It never reads or writes a cloud deployment:
# CONVEX_DEPLOYMENT/CONVEX_URL are unset and the host lives in a temp folder.
#
# Usage: bun run check:deploy   (also run by release:git before publishing)
set -eu

repo=$(git rev-parse --show-toplevel)
cd "$repo"
bun run build >/dev/null

host=$(mktemp -d)
trap 'rm -rf "$host"' EXIT
mkdir -p "$host/convex" "$host/node_modules"

# Resolve agevex from this checkout and its dependencies from our install.
ln -s "$repo" "$host/node_modules/agevex"
for dep in convex @convex-dev; do ln -s "$repo/node_modules/$dep" "$host/node_modules/$dep"; done

cat > "$host/package.json" <<'EOF'
{
  "name": "agevex-deploy-check",
  "private": true,
  "type": "module",
  "dependencies": { "convex": "*", "@convex-dev/agent": "*", "agevex": "*" }
}
EOF

cat > "$host/convex/convex.config.ts" <<'EOF'
import { defineApp } from "convex/server";
import agent from "@convex-dev/agent/convex.config";
import agevex from "agevex/convex.config";
import meter from "agevex/meter/convex.config";
import sandbox from "agevex/sandbox/convex.config";
import extract from "agevex/extract/convex.config";

const app = defineApp();
app.use(agent);
app.use(agevex);
app.use(meter);
app.use(sandbox);
app.use(extract);
export default app;
EOF

cd "$host"
env -u CONVEX_DEPLOYMENT -u CONVEX_URL CONVEX_AGENT_MODE=anonymous \
  ./node_modules/convex/bin/main.js dev --once --typecheck disable
echo "check:deploy: agevex and its modules push cleanly to a local Convex backend"
