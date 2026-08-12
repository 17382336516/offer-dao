// HTTP MCP 服务桥接：在 18060/mcp 上暴露 Streamable HTTP 传输，
// 业务逻辑直接复用全局安装的 xiaohongshu-mcp-node 服务层（playwright 真实驱动）。
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 读取项目根 .env（幂等，确保 QIANFAN_API_KEY 等配置就绪）
function loadDotEnv() {
  const p = path.resolve(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  try {
    const txt = fs.readFileSync(p, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* ignore */ }
}
loadDotEnv();

// 持久化小红书登录态 cookie：避免进程重启后丢失登录态，也确保登录成功能被保存
if (!process.env.COOKIES_PATH) {
  process.env.COOKIES_PATH = path.join(__dirname, 'xhs-cookies.json');
}
const COOKIES_PATH = process.env.COOKIES_PATH;

// 【用户级隔离】每个 offer dao 用户的小红书 cookie 独立存储，互不共享。
// 目录：data/xhs/user_<id>.json。MCP 全局 COOKIES_PATH 仅作为「当前活跃采集身份」的临时载体，
// 每次操作前由后端 switch_user_cookie 切换到对应用户文件，绝不跨用户复用。
const XHS_DATA_DIR = path.join(__dirname, 'data', 'xhs');
try { fs.mkdirSync(XHS_DATA_DIR, { recursive: true }); } catch {}
const userCookiePath = (userId) => path.join(XHS_DATA_DIR, `user_${userId}.json`);

// 登录二维码默认无头运行，只把二维码返回系统弹窗；获取失败时再切换可见窗口兜底。
if (process.env.HEADLESS === undefined) {
  process.env.HEADLESS = 'true';
}
function resolvePkgDir() {
  const local = path.resolve(__dirname, 'node_modules/xiaohongshu-mcp-node/dist');
  if (fs.existsSync(local)) return local;
  if (process.env.NODE_PATH) {
    const gp = path.join(process.env.NODE_PATH, 'xiaohongshu-mcp-node/dist');
    if (fs.existsSync(gp)) return gp;
  }
  return local;
}
const PKG = resolvePkgDir();
const importPkg = (p) => import(pathToFileURL(`${PKG}/${p}`).href);

const { loadConfig } = await importPkg('config/index.js');
const { CookieService } = await importPkg('services/cookie.service.js');
const { BrowserService } = await importPkg('services/browser.service.js');
const { XiaohongshuService } = await importPkg('services/xiaohongshu.service.js');
const { LoginAction } = await importPkg('actions/login.action.js');
const { getToolDefinitions } = await importPkg('mcp/tools/index.js');

// Windows 下 Playwright 自带 headless shell 可能被策略拦截（spawn EPERM），优先使用已安装的 Chrome。
const systemChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (fs.existsSync(systemChrome)) process.env.BROWSER_BIN_PATH = systemChrome;
const config = loadConfig();
const cookieService = new CookieService(config.cookiesPath);
// 登录用【有头】浏览器（弹出真实窗口，规避登录风控，且能渲染出可截图的二维码）。
// 注意：此处强制 headless:false，否则无头模式下小红书不渲染二维码图片/canvas，
// 导致 xhs-cookies 始终取不到二维码，前端只能降级到「打开浏览器窗口」而用户根本看不到（窗口在后端桌面）。
// 搜索/抓详情改用独立的【无头】浏览器，复用同一份登录 cookie，
// 这样点击「搜索帖子」时不会再弹出/跳转到可见的小红书窗口，结果直接回传到页面。
const loginConfig = { ...config, headless: false };
const browserService = new BrowserService(loginConfig, cookieService);
const xhs = new XiaohongshuService(browserService, cookieService);
const headlessConfig = { ...config, headless: true };
const scrapeBrowser = new BrowserService(headlessConfig, cookieService);
const xhsScrape = new XiaohongshuService(scrapeBrowser, cookieService);

// 惰性初始化无头搜索浏览器。
// 注意：init() 内部已用 storageState 加载了登录 cookie，切勿再 clearCookies/addCookies，
// 否则 addCookies 因个别 cookie 缺字段抛错被吞掉后，context 会被清空为未登录态。
// 为支持「先登录后搜索」：若登录 cookie 在浏览器首次初始化之后被更新（刚扫码登录），
// 自动重新初始化无头浏览器以加载最新登录态。
let scrapeInitAt = 0;
const dbg = (m) => { try { fs.appendFileSync('mcp-debug.log', `[${new Date().toISOString()}] ${m}\n`); } catch {} };
async function syncScrapeCookies() {
  if (!scrapeBrowser.context || !fs.existsSync(COOKIES_PATH)) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    const cookies = Array.isArray(raw) ? raw.filter((c) => c && c.name && c.value && (c.domain || c.url)) : [];
    if (!cookies.length) return 0;
    await scrapeBrowser.context.addCookies(cookies);
    dbg('scrape context cookies synced count=' + cookies.length);
    return cookies.length;
  } catch (e) {
    dbg('scrape context cookie sync err: ' + e.message);
    return 0;
  }
}
// 强制刷新：明确「读取最新 cookie → 清空旧 cookie → 重新注入」三步，
// 确保搜索前一定用的是登录后最新的登录态（而非 init 时的旧状态）。
// 仅在 scrapeBrowser 已初始化且 COOKIES_PATH 存在时执行；clearCookies 失败时回退到 addCookies 增量同步。
async function refreshXhsCookies() {
  if (!scrapeBrowser.context || !fs.existsSync(COOKIES_PATH)) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
    const cookies = Array.isArray(raw) ? raw.filter((c) => c && c.name && c.value && (c.domain || c.url)) : [];
    if (!cookies.length) return 0;
    // 先尝试清空旧 cookie 再注入（标准做法），失败则仅增量 addCookies，避免清空后注入失败导致未登录。
    try {
      await scrapeBrowser.context.clearCookies();
    } catch (e) {
      dbg('clearCookies err (fallback addCookies): ' + e.message);
    }
    await scrapeBrowser.context.addCookies(cookies);
    const injected = await scrapeBrowser.context.cookies();
    dbg('[XHS COOKIE SYNC] source=' + cookies.length + ' inject=' + injected.length + ' result=' + (injected.length > 0));
    return cookies.length;
  } catch (e) {
    dbg('refreshXhsCookies err: ' + e.message);
    return 0;
  }
}
async function ensureScrape() {
  if (!scrapeBrowser.browser) {
    dbg('init start (headless=' + headlessConfig.headless + ')');
    await scrapeBrowser.init();
    await syncScrapeCookies();
    dbg('init done');
    scrapeInitAt = Date.now();
    return;
  }
  try {
    const p = cookieService.cookiePath;
    // 仅当 scrape 浏览器尚未初始化时才 init；初始化后不再因 cookie 文件 mtime 变化就 close+reinit，
    // 否则会造成「关闭无头浏览器→并发调用又触发关闭→Cookie file not found」的自删除死循环，
    // 导致手机登录成功后登录态反复丢失。改为：若 cookie 文件有更新，直接重新 sync 注入，不重建浏览器。
    if (p && fs.existsSync(p) && fs.statSync(p).mtimeMs > scrapeInitAt) {
      dbg('cookie updated, re-sync (no reinit)');
      await syncScrapeCookies();
      scrapeInitAt = fs.statSync(p).mtimeMs;
    }
  } catch (e) {
    dbg('refresh cookie err: ' + e.message);
  }
}

// 登录页（有头浏览器窗口）保持常驻，不自动关闭，避免用户还没扫码窗口就消失
let loginPage = null;

// 后台等待登录成功并保存 cookie；无论成功/超时都不关闭 page，保持窗口
function waitForLoginBackground(page, timeout = 240000) {
  setTimeout(async () => {
    try {
      const ok = await new LoginAction(page).waitForLogin(timeout);
      if (ok) {
        await browserService.saveCookies();
        let cc = 0;
        try { const arr = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')); cc = Array.isArray(arr) ? arr.length : 0; } catch {}
        console.log('[XHS LOGIN] logged:true cookiesCount:' + cc + ' saveSuccess:true');
      }
    } catch (e) {
      console.error('[mcp-http] 后台登录等待失败:', e.message);
    }
  }, 0);
}

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

// ---------- 百度智能云「通用文字识别」：识别小红书配图内的文字 ----------
// 鉴权：用 API Key + Secret Key 换 access_token，再带 token 调 OCR 接口
const BAIDU_OCR_URL = 'https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic';
const OCR_IMAGE_LIMIT = 4; // 单篇最多识别前 N 张配图，控制耗时与调用额度

async function fetchWithTimeout(url, opts, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// 下载图片为 base64（带 Referer 规避 CDN 防盗链），再调用百度通用文字识别接口
let _baiduToken = null;
let _baiduTokenExpire = 0;
async function getBaiduToken() {
  const apiKey = process.env.QIANFAN_API_KEY;
  const secretKey = process.env.BAIDU_OCR_SECRET_KEY;
  if (!apiKey || !secretKey) return null;
  const now = Date.now();
  if (_baiduToken && now < _baiduTokenExpire) return _baiduToken;
  const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
  try {
    const r = await fetchWithTimeout(url, { method: 'GET' }, 15000);
    const j = await r.json().catch(() => null);
    if (!j || !j.access_token) { dbg('baidu token fail ' + JSON.stringify(j)); return null; }
    _baiduToken = j.access_token;
    _baiduTokenExpire = now + (j.expires_in ? j.expires_in * 1000 : 3600 * 1000) - 60000;
    return _baiduToken;
  } catch (e) {
    dbg('baidu token err ' + e.message);
    return null;
  }
}

async function ocrOneImage(imgUrl) {
  const apiKey = process.env.QIANFAN_API_KEY;
  const secretKey = process.env.BAIDU_OCR_SECRET_KEY;
  if (!apiKey || !secretKey) return null;
  let b64 = '';
  try {
    const resp = await fetchWithTimeout(imgUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.xiaohongshu.com/' },
    }, 20000);
    if (!resp.ok) { dbg('ocr download fail ' + resp.status); return null; }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) { dbg('ocr image too large skip ' + buf.length); return null; } // 百度 base64 限制 ~4MB
    b64 = buf.toString('base64');
  } catch (e) {
    dbg('ocr download err ' + e.message);
    return null;
  }
  try {
    const token = await getBaiduToken();
    if (!token) return null;
    const r = await fetchWithTimeout(BAIDU_OCR_URL + '?access_token=' + token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'image=' + encodeURIComponent(b64),
    }, 30000);
    if (!r.ok) { dbg('ocr api fail ' + r.status); return null; }
    const j = await r.json().catch(() => null);
    if (j && j.error_code) { dbg('ocr err ' + j.error_code + ' ' + j.error_msg); return null; }
    const words = (j?.words_result || []).map((w) => (w.words || '').trim()).filter(Boolean);
    return words.join('\n');
  } catch (e) {
    dbg('ocr api err ' + e.message);
    return null;
  }
}

async function ocrImagesQianfan(images) {
  const apiKey = process.env.QIANFAN_API_KEY;
  const secretKey = process.env.BAIDU_OCR_SECRET_KEY;
  if (!apiKey || !secretKey) return { text: '', missingKey: true };
  const list = (images || []).filter(Boolean).slice(0, OCR_IMAGE_LIMIT);
  if (!list.length) return { text: '' };
  const texts = [];
  for (const url of list) {
    const t = await ocrOneImage(url);
    if (t) texts.push(t);
  }
  return { text: texts.join('\n\n').trim() };
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'check_login_status': {
      // 登录态判定的权威来源 = 已落盘的 COOKIES_PATH 文件 + 无头真实访问校验。
      // 不再优先依赖「有头窗口 browserService.context 内存 cookie」，因为该内存态会在
      // 浏览器 reinit / close 时丢失（日志中反复 Browser closed），导致「手机已登录、
      // 但某次轮询时内存态刚好被清空 → 判未登录 → 前端卡住」的偶发死锁。
      // 而 COOKIES_PATH 文件在手机确认登录时由 saveCookies 持久化，是无头浏览器 init 时
      // 通过 storageState 加载的真相源。因此：文件存在即视为「可能已登录」，再用无头
      // checkLoginStatus 真实校验，与 search_feeds 共用同一份判定，保证一致、稳定。
      // 仅作辅助：有头窗口内存 cookie 用于「扫码中间态」探测（见下方 scanned-probe）。

      // 探测「已扫码待确认」中间态：手机扫了码但还没在手机上点确认时，
      // 有头登录窗口的二维码区域会变成「已扫描 / 请在手机上确认」提示。
      // 此分支只读取 loginPage 文本，不启动无头浏览器，几乎瞬时返回，
      // 让前端能在手机扫码后立刻给出反馈并锁定二维码防重复扫码。
      try {
        if (loginPage && !loginPage.isClosed()) {
          const pageText = (await loginPage.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')) || '';
          const scannedHint = /已扫描|扫描成功|请在手机上确认|已扫|扫码成功|确认登录/i.test(pageText);
          const stillHasQr = await loginPage.locator('.login-container .qrcode-img').count().catch(() => 0);
          // 已扫码待确认：页面出现确认提示，且尚未进入已登录态（cookie 文件尚未生成）。
          if (scannedHint || (stillHasQr === 0 && pageText.includes('小红书'))) {
            return textResult(JSON.stringify({
              status: 'scanned',
              message: '已扫描，请在手机上点击「确认登录」',
            }));
          }
        }
      } catch (e) {
        dbg('check_login_status scanned-probe err: ' + e.message);
      }
      // 快速失败：连 cookie 文件都不存在，必定未登录，直接返回，避免无谓启动无头浏览器去访问小红书（极慢/易卡）。
      if (!fs.existsSync(COOKIES_PATH)) {
        return textResult(`❌ 未登录\n\n请使用 get_login_qrcode 工具获取二维码进行登录。`);
      }
      // 以已落盘的 COOKIES_PATH 为登录态的持久真相源（手机确认登录时由 MCP 真实 saveCookies 成功写入）。
      // 完整登录 cookie 文件通常 > 1KB（残缺失效文件仅 ~142 字节），用体积阈值区分「有效登录态」与「残缺残留」，
      // 既避免残缺 cookie 假阳性，又不再依赖易失的浏览器内存态（reinit/close 会丢失）与易被风控的无头实时校验。
      // 真实抓取（search_feeds）会复用同一份 cookie，若服务端已让 token 失效会在生成时暴露，届时前端重新弹登录。
      let cookieSize = 0;
      try { cookieSize = fs.statSync(COOKIES_PATH).size; } catch { cookieSize = 0; }
      if (cookieSize >= 1024) {
        return textResult(`✅ 已登录\n用户名: (cookie 登录态)\n\n你可以使用其他功能了。`);
      }
      // 兜底：文件存在但体积过小（疑似残缺），再用无头 xhsScrape 真实校验一次
      await ensureScrape();
      const r = await xhsScrape.checkLoginStatus();
      const isLoggedIn = !!r.isLoggedIn;
      if (isLoggedIn) {
        try {
          await browserService.saveCookies();
        } catch (e) {
          dbg('check_login_status saveCookies err: ' + e.message);
        }
        return textResult(`✅ 已登录\n用户名: ${r.username || '(cookie 登录态)'}\n\n你可以使用其他功能了。`);
      }
      return textResult(`❌ 未登录\n\n请使用 get_login_qrcode 工具获取二维码进行登录。`);
    }
    case 'get_login_qrcode': {
      // 注意：有头窗口 browserService 仅按 cookie 字段名判定登录（xhs.checkLoginStatus 基于内存/cookie 名），
      // 残缺 cookie 文件（如只含 web_session 字段名但值已失效，仅 100+ 字节）会被误判为「已登录」，
      // 导致此处直接 return 不出二维码、复用旧失效会话，手机扫码后小红书服务端判会话无效 → 显示 fail to login。
      // 因此必须以无头真实校验为准：仅当无头 xhsScrape 确认真正登录时才 return「已登录」；
      // 否则（含残缺 cookie 假阳性）一律清掉全局 cookie 并重新出全新二维码，保证手机扫到的是有效会话。
      let realLoggedIn = false;
      try {
        await ensureScrape();
        const realSt = await xhsScrape.checkLoginStatus();
        realLoggedIn = !!realSt.isLoggedIn;
      } catch (e) {
        dbg('get_login_qrcode real-check err: ' + e.message);
      }
      if (realLoggedIn) return textResult('你当前已处于登录状态');
      // 非真实登录：重建登录页出全新二维码。注意：不要删除全局 COOKIES_PATH，
      // 否则会误杀手机刚登录成功的合法 cookie（造成「Cookie file not found」登录态丢失），
      // 残缺 cookie 的识别已由上方无头真实校验兜底处理。
      try { await browserService.close().catch(() => {}); await browserService.init(); } catch (e) { dbg('get_login_qrcode reinit err: ' + e.message); }
      loginPage = null;
      // 复用/创建无头登录页，只将二维码图片返回给前端系统弹窗。
      if (!loginPage || loginPage.isClosed()) {
        loginPage = await browserService.newPage();
        waitForLoginBackground(loginPage, 240000);
      }
      const loginAction = new LoginAction(loginPage);
      let image = '';
      try {
        await loginPage.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded' });
        await loginPage.waitForTimeout(2000);
        loginPage.setDefaultTimeout(120000);
        const qrEl = loginPage.locator('.login-container .qrcode-img').first();
        await qrEl.waitFor({ state: 'visible', timeout: 120000 }).catch(() => {});
        image = (await qrEl.getAttribute('src').catch(() => '')) || '';
        if (!image) {
          // 小红书页面结构会变化，兜底从页面图片中寻找二维码 data URL。
          const sources = await loginPage.locator('img').evaluateAll((els) =>
            els.map((el) => el.getAttribute('src') || '').filter(Boolean)
          ).catch(() => []);
          image = sources.find((src) => /^data:image\//i.test(src)) || '';
        }
        if (!image) {
          // 部分版本将二维码绘制到 canvas，没有 img src，直接截图二维码区域。
          const qrCanvas = loginPage.locator('canvas:visible').first();
          if (await qrCanvas.count().catch(() => 0)) {
            image = `data:image/png;base64,${(await qrCanvas.screenshot()).toString('base64')}`;
          }
        }
        if (!image && loginPage.url().includes('xiaohongshu.com')) {
          // 页面结构再次变化时，返回无头登录页截图，用户仍可直接扫描其中的二维码。
          image = `data:image/png;base64,${(await loginPage.screenshot({ type: 'png', fullPage: false })).toString('base64')}`;
        }
      } catch (e) {
        console.warn('[mcp-http] 自动获取二维码失败:', e.message);
        dbg(`get_login_qrcode failed url=${loginPage.url()} error=${e.message}`);
        // 导航超时或页面局部加载失败时，当前页面可能已经包含二维码，仍尝试返回截图。
        try {
          if (loginPage.url().includes('xiaohongshu.com')) {
            image = `data:image/png;base64,${(await loginPage.screenshot({ type: 'png', fullPage: false })).toString('base64')}`;
          }
        } catch { /* 页面未加载完成，交由前端显示重试 */ }
      }
      if (!image && browserService.config.headless) {
        // 无头模式受小红书风控或页面加载失败时，切换到可见窗口作为最后兜底。
        try {
          await browserService.close();
          browserService.config.headless = false;
          loginPage = await browserService.newPage();
          waitForLoginBackground(loginPage, 240000);
          await loginPage.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded' });
          await loginPage.waitForTimeout(2000);
          const qrEl = loginPage.locator('.login-container .qrcode-img').first();
          image = (await qrEl.getAttribute('src').catch(() => '')) || '';
        } catch (e) {
          dbg(`visible login fallback failed error=${e.message}`);
        }
      }
      const deadline = new Date(Date.now() + 4 * 60 * 1000).toLocaleString('zh-CN');
      const content = [{
        type: 'text',
        text: `请用手机小红书 App 扫描系统中的二维码登录。二维码约在 ${deadline} 前有效 👇`,
      }];
      if (image) {
        content.push({ type: 'image', data: image.replace('data:image/png;base64,', ''), mimeType: 'image/png' });
      } else {
        content.push({ type: 'text', text: 'BROWSER_LOGIN_REQUIRED：二维码图片暂时无法回传，请直接在已打开的小红书登录窗口中扫码。' });
      }
      return { content };
    }
    case 'publish_content':
      return textResult(await xhs.publishContent({
        title: args.title, content: args.content, imagePaths: args.images,
        tags: args.tags, scheduleTime: args.scheduleTime ? new Date(args.scheduleTime) : undefined,
        isOriginal: args.isOriginal, visibility: args.visibility, products: args.products,
      }));
    case 'publish_video':
      return textResult(await xhs.publishVideo({
        title: args.title, content: args.content, videoPath: args.video,
        tags: args.tags, scheduleTime: args.scheduleTime ? new Date(args.scheduleTime) : undefined,
        visibility: args.visibility, products: args.products,
      }));
    case 'search_feeds': {
      dbg('search_feeds start kw=' + args.keyword + ' cookiePath=' + cookieService.cookiePath);
      await ensureScrape();
      // 搜索前强制刷新 Cookie：保证登录后立即可搜索，不会用到旧登录态
      const synced = await refreshXhsCookies();
      dbg('[XHS SEARCH] cookie loaded:true keyword:' + args.keyword + ' syncedCookies:' + synced);
      const page = await scrapeBrowser.newPage();
      try {
        const url = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(args.keyword);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        // 等待初始渲染 + 滚动触发懒加载
        await page.waitForTimeout(3000);
        for (let s = 0; s < 4; s++) {
          await page.mouse.wheel(0, 1500).catch(() => {});
          await page.waitForTimeout(700);
        }
        let cnt = await page.locator('.note-item').count().catch(() => -1);
        const ptitle = await page.title().catch(() => '?');
        // 若仍为空：可能渲染慢或被要求登录，诊断页面状态后重试一次
        let loginState = 'empty';
        if (cnt === 0) {
          loginState = await page.evaluate(() => {
            const t = document.body ? document.body.innerText : '';
            return (t.includes('登录') || t.includes('二维码') || !!document.querySelector('.login-container')) ? 'login-page' : 'empty';
          }).catch(() => 'unknown');
          dbg('first count=0, state=' + loginState + ' url=' + page.url());
          await page.waitForTimeout(4000);
          await page.mouse.wheel(0, 1500).catch(() => {});
          cnt = await page.locator('.note-item').count().catch(() => -1);
        }
        dbg('title=' + ptitle + ' note-item count=' + cnt);
        if (cnt === 0) {
          // 登录态失效：搜索页被重定向到登录页，无内容可抓，明确告知需要重新登录
          if (loginState === 'login-page') {
            return textResult(JSON.stringify({ needLogin: true, posts: [], message: '小红书登录态已失效，请重新扫码登录后再搜索。' }));
          }
          // 登录成功但当前关键词无结果：不要误判为未登录，返回空帖子供上层降级 RAG
          return textResult(JSON.stringify({ needLogin: false, posts: [], message: '小红书已登录，但当前未找到相关帖子。' }));
        }
        // 在浏览器内一次性提取前 20 条，避免逐元素 locator 的 auto-waiting 卡死
        const result = await page.$$eval('.note-item', (els) => {
          const out = [];
          for (const el of els.slice(0, 20)) {
            // 优先用 data-note-id（最可靠），否则回退到 /explore/ 链接里的 id
            let id = el.getAttribute('data-note-id') || '';
            if (!id) {
              const ea = el.querySelector('a[href*="/explore/"]');
              const m = ea ? (ea.getAttribute('href') || '').match(/\/explore\/([a-f0-9]+)/) : null;
              id = m ? m[1] : '';
            }
            if (!id) continue;
            // 取「带 xsec_token 的链接」（封面/标题 a），用于 xsec 与构造 link
            const tokA = el.querySelector('a[href*="xsec_token"]');
            const tokHref = tokA ? tokA.getAttribute('href') : '';
            const xsecMatch = tokHref.match(/xsec_token=([^&]+)/);
            const xsec = xsecMatch ? xsecMatch[1] : '';
            const titleEl = el.querySelector('.title');
            const title = titleEl ? (titleEl.textContent || '').trim() : '';
            const img = el.querySelector('img');
            const cover = img ? (img.getAttribute('src') || '') : '';
            const authorEl = el.querySelector('.author-wrapper .name, .footer .name, .name, .author-name');
            const author = authorEl ? (authorEl.textContent || '').trim() : '';
            const likeEl = el.querySelector('.like-wrapper .count, .footer .count, .like .count, .count');
            const like = likeEl ? (likeEl.textContent || '').trim() : '';
            out.push({ id, xsecToken: xsec, title, user: { nickname: author }, cover, likeCount: like, link: '' });
          }
          // 回传首个 footer 的 html，便于核对作者/点赞 class
          const footer = els[0] && els[0].querySelector('.footer')
            ? els[0].querySelector('.footer').outerHTML.slice(0, 1400) : '';
          return { feeds: out, html: footer };
        }).catch((e) => { dbg('eval err ' + e.message); return { feeds: [], html: '' }; });
        const feeds = result.feeds;
        dbg('feeds ' + feeds.length + ' withXsec=' + feeds.filter((f) => f.xsecToken).length);
        if (result.html) dbg('footer html=' + result.html);
        return textResult(feeds);
      } finally {
        await page.close().catch(() => {});
      }
    }

    case 'prepare_bind': {
      // 用户开始绑定自己的小红书前：清空 MCP 全局 cookie，确保出的是「干净二维码」，
      // 不残留任何前任用户的登录态（旧 cookie 不自动归属给新用户）。
      // 注意：删除【全局】cookie 不依赖 userId（只是删文件 + 重建浏览器上下文），
      // 这样前端/后端在任何时机调用（含未带 userId 的拉码前清理）都能成功清干净。
      try { if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH); } catch {}
      // 关闭并重建有头登录上下文，避免复用旧浏览器会话导致未扫码直接显示已登录。
      await browserService.close().catch(() => {});
      await scrapeBrowser.close().catch(() => {});
      // 删除该用户隔离文件（若之前有脏数据），强制重新扫码（需要 userId，缺失则跳过）
      const userId = args.userId;
      if (userId) {
        try { if (fs.existsSync(userCookiePath(userId))) fs.unlinkSync(userCookiePath(userId)); } catch {}
      }
      return textResult('已重置采集身份，请扫描新二维码绑定当前用户');
    }
    case 'switch_user_cookie': {
      // 切换当前 MCP 全局 cookie 到指定用户：每次小红书操作前调用，保证只用该用户自己的账号。
      const userId = args.userId;
      if (!userId) return textResult('缺少 userId');
      const p = userCookiePath(userId);
      if (!fs.existsSync(p)) {
        return textResult('该用户尚未绑定小红书账号');
      }
      try {
        const cookies = JSON.parse(fs.readFileSync(p, 'utf-8'));
        fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf-8');
        // 刷新 mtime 并强制无头浏览器下次 reload，确保使用刚切到的用户 cookie
        fs.utimesSync(COOKIES_PATH, new Date(), new Date());
        await scrapeBrowser.close().catch(() => {});
        return textResult('已切换到用户 ' + userId + ' 的小红书采集身份');
      } catch (e) {
        return textResult('切换失败：' + e.message);
      }
    }
    case 'commit_user_cookie': {
      // 用户扫码登录成功后：把 MCP 全局 cookie（刚由浏览器保存）落盘到该用户隔离文件。
      const userId = args.userId;
      if (!userId) return textResult('缺少 userId');
      // 若 COOKIES_PATH 文件尚未落盘，优先从有头登录窗口（browserService.context）实时取 cookie。
      // 解决：waitForLogin 回调时序异常或前端未先调 check_login_status 导致文件缺失时，
      // 弹窗已登录但无法提交的问题。
      if (!fs.existsSync(COOKIES_PATH)) {
        try {
          if (browserService.context) {
            const ctxCookies = await browserService.context.cookies();
            const names = ctxCookies.map((c) => (c && c.name) || '').join(',');
            if (/web_session|id_token|passport|customer_session/i.test(names)) {
              await browserService.saveCookies();
              console.log('[mcp-http] commit_user_cookie: 从有头窗口落盘 cookie 成功');
            }
          }
        } catch (e) {
          dbg('commit_user_cookie saveCookies from context err: ' + e.message);
        }
      }
      if (!fs.existsSync(COOKIES_PATH)) {
        return textResult('尚未检测到登录 cookie，请先扫码');
      }
      try {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
        if (!Array.isArray(cookies) || cookies.length === 0) {
          return textResult('登录 cookie 为空，请重新扫码');
        }
        fs.writeFileSync(userCookiePath(userId), JSON.stringify(cookies, null, 2), 'utf-8');
        return textResult('已保存用户 ' + userId + ' 的小红书登录态（隔离存储）');
      } catch (e) {
        return textResult('保存失败：' + e.message);
      }
    }

    case 'get_feed_detail': {
      dbg('get_feed_detail start id=' + args.feedId);
      await ensureScrape();
      const page = await scrapeBrowser.newPage();
      try {
        const fid = args.feedId || '';
        const xsec = args.xsecToken || '';
        const url = 'https://www.xiaohongshu.com/explore/' + encodeURIComponent(fid) +
          (xsec ? '?xsec_token=' + encodeURIComponent(xsec) + '&xsec_source=pc_search' : '');
        dbg('goto ' + url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        // 尝试点击「展开全文」以获取完整正文（多次尝试不同选择器，兼容页面改版）
        await page.evaluate(() => {
          const sels = ['.expand', '.note-content .expand', 'button.expand', '.expand-wrapper', '.show-more', '.content-wrapper .expand'];
          for (const s of sels) {
            const btn = document.querySelector(s);
            if (btn) { try { btn.click(); break; } catch {} }
          }
        }).catch(() => {});
        await page.waitForTimeout(1000);
        const data = await page.evaluate(() => {
          const tryText = (el) => (el && (el.innerText || el.textContent || '').trim()) || '';
          // 候选正文容器（按优先级），取最长者，兼容不同版本 DOM
          const descSels = ['#detail-desc', '.note-content .desc', '.note-content', 'article .desc', 'article', '.desc'];
          let desc = '';
          for (const s of descSels) {
            const t = tryText(document.querySelector(s));
            if (t && t.length > desc.length) desc = t;
          }
          const title = tryText(document.querySelector('.note-content .title'))
            || tryText(document.querySelector('#detail-title'))
            || tryText(document.querySelector('.title'));
          // 评论区等无关文本过滤：仅取正文容器内的图片
          const imgs = Array.from(document.querySelectorAll(
            '#detail-desc img, .note-content img, .swiper-slide img, .carousel img, .detail-img img, .note-image img'
          )).map((i) => i.getAttribute('src') || i.getAttribute('data-src') || '')
            .filter((s) => s && s.includes('xhscdn'));
          return { title, desc, images: imgs.slice(0, 9) };
        }).catch((e) => ({ title: '', desc: '', images: [], err: e.message }));
        dbg('get_feed_detail ok len=' + (data.desc || '').length + ' imgs=' + (data.images || []).length);
        // 用千帆 PaddleOCR-VL 识别配图内的文字，拼进正文一起返回
        let ocrText = '';
        let ocrMissingKey = false;
        try {
          const ocr = await ocrImagesQianfan(data.images);
          ocrText = ocr.text || '';
          ocrMissingKey = !!ocr.missingKey;
          if (ocrText) dbg('ocr text len=' + ocrText.length);
        } catch (e) {
          dbg('ocr err ' + e.message);
        }
        const payload = JSON.stringify({
          desc: data.desc || data.title || '',
          images: data.images || [],
          ocrText,
          ocrMissingKey,
        });
        return textResult(payload);
      } finally {
        await page.close().catch(() => {});
      }
    }
    case 'open_feed': {
      // 在用户扫码登录的「已登录有头浏览器」中打开笔记，规避"该笔记无法查看"。
      const fid = args.feedId || '';
      const xsec = args.xsecToken || '';
      if (!fid) return textResult('缺少笔记 ID');
      const url = 'https://www.xiaohongshu.com/explore/' + encodeURIComponent(fid) +
        (xsec ? '?xsec_token=' + encodeURIComponent(xsec) + '&xsec_source=pc_search' : '');
      try {
        const page = await browserService.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        return textResult('已在小红书客户端打开笔记：' + url);
      } catch (e) {
        return textResult('打开失败（' + e.message + '），请直接在弹出窗口中访问：' + url);
      }
    }
    case 'list_feeds':
      await ensureScrape();
      return textResult(await xhsScrape.listFeeds());
    case 'post_comment':
      await xhs.postComment(args.feedId, args.xsecToken, args.content);
      return textResult(`评论发表成功 - Feed ID: ${args.feedId}`);
    case 'reply_comment':
      await xhs.replyComment(args.feedId, args.xsecToken, args.commentId, args.content);
      return textResult(`评论回复成功 - Feed ID: ${args.feedId}, Comment ID: ${args.commentId}`);
    case 'like_feed':
      if (args.unlike) { await xhs.unlikeFeed(args.feedId, args.xsecToken); return textResult(`取消点赞成功 - Feed ID: ${args.feedId}`); }
      await xhs.likeFeed(args.feedId, args.xsecToken);
      return textResult(`点赞成功 - Feed ID: ${args.feedId}`);
    case 'favorite_feed':
      if (args.unfavorite) { await xhs.unfavoriteFeed(args.feedId, args.xsecToken); return textResult(`取消收藏成功 - Feed ID: ${args.feedId}`); }
      await xhs.favoriteFeed(args.feedId, args.xsecToken);
      return textResult(`收藏成功 - Feed ID: ${args.feedId}`);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// 用户级隔离扩展工具定义（追加到第三方包的工具列表之后）
const XHS_EXTRA_TOOLS = [
  {
    name: 'prepare_bind',
    description: '用户绑定小红书前清空 MCP 全局 cookie，确保二维码干净（不残留前任用户登录态）',
    inputSchema: { type: 'object', properties: { userId: { type: 'string', description: 'offer dao 用户 id' } }, required: ['userId'] },
  },
  {
    name: 'switch_user_cookie',
    description: '将 MCP 全局 cookie 切换为指定用户隔离存储的 cookie（每次小红书操作前调用，保证账号隔离）',
    inputSchema: { type: 'object', properties: { userId: { type: 'string', description: 'offer dao 用户 id' } }, required: ['userId'] },
  },
  {
    name: 'commit_user_cookie',
    description: '用户扫码登录成功后，把 MCP 全局 cookie 落盘到该用户隔离文件',
    inputSchema: { type: 'object', properties: { userId: { type: 'string', description: 'offer dao 用户 id' } }, required: ['userId'] },
  },
];

function buildServer() {
  const server = new Server({ name: 'xiaohongshu-mcp-node', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...getToolDefinitions(), ...XHS_EXTRA_TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await handleToolCall(req.params.name, req.params.arguments || {});
    } catch (error) {
      return { content: [{ type: 'text', text: `工具执行失败: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });
  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : null); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const PORT = Number(process.env.PORT || 18060);
const HOST = process.env.HOST || '0.0.0.0';

const httpServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/mcp') { res.writeHead(404); res.end('Not Found'); return; }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed' }, id: null }));
    return;
  }

  try {
    const body = await readBody(req);
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => transport.close().catch(() => {}));
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[mcp-http] request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err) }, id: null }));
    }
  }
});

// 启动恢复：若全局 COOKIES_PATH 不存在，但有已绑定用户的隔离 cookie 文件，
// 则自动恢复为全局 cookie，避免 MCP 重启后登录态丢失、用户被迫重新扫码。
(function restoreCookiesOnBoot() {
  try {
    if (fs.existsSync(COOKIES_PATH)) { dbg('boot: COOKIES_PATH exists, skip restore'); return; }
    const dir = XHS_DATA_DIR;
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir)
      .filter((f) => /^user_\d+\.json$/.test(f))
      .map((f) => {
        const fp = path.join(dir, f);
        let info = { fp, mtime: 0, valid: false };
        try {
          const st = fs.statSync(fp);
          info.mtime = st.mtimeMs;
          const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          const cookies = Array.isArray(j) ? j : (j.cookies || []);
          info.valid = cookies.some((c) => c && (c.name === 'web_session' || c.name === 'a1'));
        } catch {}
        return info;
      })
      .filter((x) => x.valid)
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) { dbg('boot: no valid user cookie to restore'); return; }
    const src = files[0].fp;
    fs.copyFileSync(src, COOKIES_PATH);
    dbg('boot: restored COOKIES_PATH from ' + src);
    console.log('[mcp-http] restored global xhs cookie from ' + src);
  } catch (e) {
    dbg('boot restore err: ' + e.message);
  }
})();

httpServer.listen(PORT, HOST, () => {
  console.log(`[mcp-http] Xiaohongshu MCP (Streamable HTTP) listening on http://${HOST}:${PORT}/mcp`);
});
