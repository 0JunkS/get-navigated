#!/bin/bash
set -e

echo "=== Using npx pnpm@9 (no global install needed) ==="
npx --yes pnpm@9 --version

echo "=== Installing dependencies ==="
npx pnpm@9 install --no-frozen-lockfile

echo "=== Building navigated app ==="
PORT=19477 BASE_PATH=/ npx pnpm@9 --filter @workspace/navigated run build

echo "=== Build complete ==="
ls -la artifacts/navigated/dist/public/ 2>/dev/null || echo "Warning: dist/public not found"
