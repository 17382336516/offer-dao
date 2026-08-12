const fs = require('fs');
const path = require('path');
const out = [];
try {
  let Database;
  try { Database = require('better-sqlite3'); }
  catch (e) { out.push('NO_BETTER_SQLITE: ' + e.message); }
  if (Database) {
    const db = new Database('rag.sqlite3');
    const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    out.push('TABLES: ' + JSON.stringify(tbl.map(t => t.name)));
    try {
      const xhs = db.prepare("SELECT doc_id,title,source FROM documents WHERE source='xhs' ORDER BY id DESC LIMIT 8").all();
      out.push('XHS_DOCS: ' + xhs.length);
      xhs.forEach(r => out.push('  ' + r.doc_id + ' | ' + r.title + ' | ' + r.source));
    } catch (e) { out.push('XHS_ERR: ' + e.message); }
    try {
      const tot = db.prepare('SELECT COUNT(*) c FROM documents').get();
      out.push('TOTAL_DOCS: ' + tot.c);
    } catch (e) { out.push('TOTAL_ERR: ' + e.message); }
  }
} catch (e) {
  out.push('FATAL: ' + e.message);
}
fs.writeFileSync('rag_check.log', out.join('\n') + '\n');
console.log('WROTE_LOG');
