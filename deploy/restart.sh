#!/usr/bin/env bash
# 代码更新后重启
set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "[deploy] 重新构建前端..."
VITE_API_BASE_URL='' npm run build

echo "[deploy] 重启后端..."
pm2 restart offerdao-api || pm2 start "$APP_DIR/deploy/ecosystem.config.cjs"

echo "[deploy] 重载 nginx..."
nginx -s reload

echo "[deploy] ✅ 已重启"
