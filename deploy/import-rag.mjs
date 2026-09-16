// RAG 知识库导入脚本：把 rag_sources 下的文档灌入 rag.sqlite3（供学习资源匹配与笔记生成使用）
// 用法： node deploy/import-rag.mjs
// 说明：幂等，已入库文档默认跳过；加 --force 强制重建。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const force = process.argv.includes('--force');

const DATA_DIR = path.join(APP_DIR, 'server');
const RAG_DB = path.join(DATA_DIR, 'rag.sqlite3');
const SRC = path.join(APP_DIR, 'rag_sources');

console.log('项目目录   :', APP_DIR);
console.log('知识库目录 :', SRC);
console.log('向量库     :', RAG_DB);

if (!fs.existsSync(SRC)) {
  console.error('\n❌ 知识库目录不存在，请先把本地 rag_sources 上传到服务器：');
  console.error('   scp -r "d:/offer dao/offer dao/rag_sources" root@服务器IP:/var/www/offer-dao/rag_sources');
  process.exit(1);
}

function countFiles(dir) {
  const exts = new Set(['.txt', '.md', '.markdown', '.pdf', '.docx', '.pptx']);
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.has(path.extname(p).toLowerCase())) n++;
    }
  };
  walk(dir);
  return n;
}
console.log('支持格式的文档数:', countFiles(SRC));

const before = fs.existsSync(RAG_DB) ? fs.statSync(RAG_DB).size : 0;
console.log('导入前向量库大小:', (before / 1024).toFixed(1) + ' KB');

const rag = await import(path.join(DATA_DIR, 'rag.mjs'));

console.log('\n开始导入（force=' + force + '）...这可能需要几分钟，请耐心等待');
const t0 = Date.now();
let lastLog = 0;
try {
  const res = await rag.importRagSources({
    sourceDir: SRC,
    force,
    skipIndexed: !force,
    onProgress: (info) => {
      const now = Date.now();
      if (now - lastLog > 3000) {
        lastLog = now;
        const done = (info.done ?? info.current ?? 0);
        console.log(`  进度 ${done}/${info.total ?? '?'} 成功=${info.success ?? '-'} 失败=${info.failed ?? '-'} ${(info.file || '').slice(-40)}`);
      }
    },
  });
  console.log('\n导入完成，耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('结果:', JSON.stringify({
    total: res.total, success: res.success, skipped: res.skipped, failed: res.failed,
  }));
  const failedItems = (res.items || []).filter((i) => i && i.status === 'failed').slice(0, 10);
  if (failedItems.length) {
    console.log('失败样例:');
    for (const it of failedItems) console.log('  -', it.file || it.name, '|', (it.error || '').slice(0, 120));
  }
} catch (e) {
  console.error('导入失败:', e.message);
  process.exit(1);
}

const after = fs.existsSync(RAG_DB) ? fs.statSync(RAG_DB).size : 0;
console.log('导入后向量库大小:', (after / 1024).toFixed(1) + ' KB');
console.log(after > before ? '\n✅ 知识库已灌入' : '\n⚠ 向量库大小无变化，请检查文档格式是否受支持');
process.exit(0);
