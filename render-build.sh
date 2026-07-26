#!/bin/bash
set -e

echo "=== Installing pnpm 9 ==="
npm install -g pnpm@9

echo "=== pnpm version ==="
pnpm --version

echo "=== Installing dependencies ==="
pnpm install --no-frozen-lockfile

echo "=== Building navigated app ==="
PORT=19477 BASE_PATH=/ pnpm --filter @workspace/navigated run build

echo "=== Build complete ==="
ls -la artifacts/navigated/dist/public/ 2>/dev/null || echo "Warning: dist/public not found"
