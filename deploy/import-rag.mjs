// RAG 知识库导入脚本（稳健版：逐文件导入 + 断点续传 + 跳过大文件）
// 背景：一次性导入 154 个 PDF（含大量扫描版）会在 2G 内存的小服务器上 OOM 被杀，
//       导致一个文档都写不进去。改为逐个文件串行导入，内存可控，且天然支持中断后继续。
// 用法：
//   node deploy/import-rag.mjs                 # 继续导入（已入库的自动跳过）
//   node deploy/import-rag.mjs --max 40        # 本次最多处理 40 个文件
//   node deploy/import-rag.mjs --maxsize 30    # 跳过体积超过 30MB 的文件（默认 40MB）
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(APP_DIR, 'server');
const RAG_DB = path.join(DATA_DIR, 'rag.sqlite3');
const SRC = path.join(APP_DIR, 'rag_sources');

const argv = process.argv;
const getArg = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const MAX_FILES = Number(getArg('--max', 0)) || Infinity;
const MAX_SIZE_MB = Number(getArg('--maxsize', 40));

const EXTS = new Set(['.txt', '.md', '.markdown', '.pdf', '.docx', '.pptx']);

console.log('项目目录 :', APP_DIR);
console.log('知识库   :', SRC);
console.log('向量库   :', RAG_DB);
console.log('本次上限 :', MAX_FILES === Infinity ? '不限' : MAX_FILES + ' 个文件');
console.log('体积上限 :', MAX_SIZE_MB + ' MB');

if (!fs.existsSync(SRC)) {
  console.error('\n[ERR] 知识库目录不存在。请先上传：');
  console.error('  scp -r "d:/offer dao/offer dao/rag_sources" root@<服务器IP>:/var/www/offer-dao/rag_sources');
  process.exit(1);
}

// 收集全部受支持文件
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(p).toLowerCase())) out.push(p);
  }
  return out;
}
const allFiles = walk(SRC).sort();
console.log('受支持文档数:', allFiles.length);

const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const mb = (n) => (n / 1024 / 1024).toFixed(1);

const oversize = allFiles.filter((f) => sizeOf(f) > MAX_SIZE_MB * 1024 * 1024);
if (oversize.length) {
  console.log(`跳过 ${oversize.length} 个超大文件 (>${MAX_SIZE_MB}MB):`);
  oversize.slice(0, 8).forEach((f) => console.log('   -', path.relative(SRC, f), mb(sizeOf(f)) + 'MB'));
}
const targets = allFiles.filter((f) => sizeOf(f) <= MAX_SIZE_MB * 1024 * 1024).slice(0, MAX_FILES);
console.log('本次待处理:', targets.length);

const before = fs.existsSync(RAG_DB) ? fs.statSync(RAG_DB).size : 0;
console.log('导入前向量库:', mb(before) + ' MB');

const rag = await import(path.join(DATA_DIR, 'rag.mjs'));

const t0 = Date.now();
let done = 0, ok = 0, skipped = 0, failed = 0;
const failures = [];

for (const file of targets) {
  const rel = path.relative(SRC, file).replace(/\\/g, '/');
  let status;
  try {
    const r = await rag.importRagSources({
      sourceDir: SRC,
      onlyFiles: [rel],
      force: false,
      skipIndexed: true,
    });
    // importRagSources 返回 { total, success, skipped, failed, items }
    if (r && (r.success || 0) > 0) { status = 'ok'; ok += 1; }
    else if (r && (r.failed || 0) > 0) { status = 'failed'; failed += 1; }
    else { status = 'skipped'; skipped += 1; }
  } catch (e) {
    status = 'failed';
    failed += 1;
    failures.push({ file: rel, err: (e && e.message) || String(e) });
  }
  done += 1;
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`[${done}/${targets.length}] ${status.toUpperCase()} mem=${mem}MB ${rel.slice(-45)}`);
}

const after = fs.existsSync(RAG_DB) ? fs.statSync(RAG_DB).size : 0;
console.log('\n===== 导入结束 =====');
console.log('耗时:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log(`处理 ${done} 个 | 成功入库 ${ok} | 已存在跳过 ${skipped} | 失败 ${failed}`);
console.log(`向量库: ${mb(before)} MB -> ${mb(after)} MB`);
if (failures.length) {
  console.log('失败清单(前10):');
  failures.slice(0, 10).forEach((f) => console.log('  -', f.file, '|', String(f.err).slice(0, 100)));
}
console.log(after > before ? '\n[OK] 向量库已增长，知识库已灌入' : '\n[WARN] 向量库无增长（文档可能已全部入库或全部失败）');
process.exit(0);
