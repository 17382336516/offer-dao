// 统一启动脚本：在单一进程内拉起 MCP 子进程并启动后端 API 服务。
// 用途：部署平台（Render/Vercel 后端）只需运行 `node start-all.mjs` 一个命令，
// 即可同时拥有 MCP（默认 18060）与后端 API（PORT/3000），无需单独部署 MCP 服务。
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 1. 拉起 MCP 子进程（带守护）----------
const mcpEnv = { ...process.env, PORT: '18060', HOST: '0.0.0.0' };
// 用绝对路径，避免 cwd 因目录名含特殊空格（NBSP）解析失败时找不到脚本
const mcpScript = path.join(__dirname, 'mcp-http-server.mjs');
const mcpArgs = [mcpScript];
let mcpProc = null;

function startMcp() {
  console.log('[start-all] 启动 MCP 子进程:', mcpScript);
  mcpProc = spawn(process.execPath, mcpArgs, {
    cwd: __dirname,
    env: mcpEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  mcpProc.on('exit', (code, signal) => {
    console.warn(`[start-all] MCP 子进程退出 code=${code} signal=${signal}，3 秒后重启...`);
    mcpProc = null;
    setTimeout(startMcp, 3000);
  });
  mcpProc.on('error', (err) => {
    console.error('[start-all] MCP 子进程启动失败:', err.message);
  });
}
startMcp();

// ---------- 2. 启动后端 API 服务（在主进程内执行，监听 PORT）----------
console.log('[start-all] 启动后端 API 服务...');
// Windows 上 ESM import() 需要 file:// URL，不能直接用裸盘符路径
await import(pathToFileURL(path.join(__dirname, 'server', 'index.mjs')).href);

// ---------- 3. 进程退出时清理 MCP 子进程 ----------
function shutdown(sig) {
  console.log(`[start-all] 收到 ${sig}，关闭 MCP 子进程...`);
  if (mcpProc) mcpProc.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
