#!/usr/bin/env bash
# 阿里云 ECS（Alibaba Cloud Linux 3）一键部署脚本
# 用法：
#   1. 把项目代码放到 /var/www/offer-dao
#   2. cd /var/www/offer-dao
#   3. bash deploy/install.sh
# 脚本需要 root 权限。

set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "[deploy] 项目目录: $APP_DIR"

# ---------- 1. 系统依赖 ----------
echo "[deploy] 安装系统依赖..."
dnf update -y
dnf install -y git nginx

# ---------- 2. Node 20 ----------
echo "[deploy] 安装 Node 20..."
if ! command -v node &>/dev/null || [[ "$(node -v | sed 's/^v//; s/\..*//')" -lt 18 ]]; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
  dnf install -y nodejs
fi
node -v
npm -v

# ---------- 3. pm2 进程守护 ----------
echo "[deploy] 安装 pm2..."
npm install -g pm2

# ---------- 4. 项目依赖 ----------
echo "[deploy] 安装 npm 依赖..."
cd "$APP_DIR"
npm ci

# ---------- 5. Playwright 浏览器及系统依赖 ----------
echo "[deploy] 安装 Playwright Chromium..."
npx playwright install chromium
echo "[deploy] 安装 Playwright 系统依赖（需要 root，耗时几分钟）..."
npx playwright install-deps chromium || echo "[deploy] 系统依赖安装部分失败，继续尝试启动"

# ---------- 6. 前端构建 ----------
echo "[deploy] 构建前端（VITE_API_BASE_URL 置空，走同域 /api）..."
VITE_API_BASE_URL='' npm run build

# ---------- 7. nginx 配置 ----------
echo "[deploy] 配置 nginx..."
cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/conf.d/offer-dao.conf
mkdir -p /var/log/offerdao
nginx -t
systemctl enable nginx
systemctl restart nginx

# ---------- 8. pm2 启动并设置开机自启 ----------
echo "[deploy] 启动后端 + MCP..."
pm2 start "$APP_DIR/deploy/ecosystem.config.cjs"
pm2 save
pm2 startup systemd -u root --hp /root || true

PUBLIC_IP=$(curl -s ifconfig.me || echo "你的公网IP")
echo ""
echo "[deploy] ✅ 部署完成"
echo "[deploy] 访问地址: http://${PUBLIC_IP}:8080"
echo "[deploy] 后端 API: http://${PUBLIC_IP}:3000 (建议只通过 8080 访问)"
echo "[deploy] 日志: pm2 logs offerdao-api"
echo "[deploy] 重启: bash deploy/restart.sh"
