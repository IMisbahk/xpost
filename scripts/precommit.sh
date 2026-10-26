#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck
npm test
npm run lint
npm run check:secrets
echo "precommit checks passed"
