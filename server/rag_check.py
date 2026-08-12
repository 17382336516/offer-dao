import sqlite3
out = []
try:
    c = sqlite3.connect('rag.sqlite3')
    cur = c.cursor()
    cur.execute("SELECT doc_id, title, source, created_at FROM rag_docs WHERE source='xhs'")
    rows = cur.fetchall()
    out.append('XHS_DOCS_COUNT: ' + str(len(rows)))
    for r in rows:
        out.append('DOC: ' + str(r[0]) + ' | TITLE: ' + str(r[1]) + ' | SRC: ' + str(r[2]) + ' | TIME: ' + str(r[3]))
    # 同时看最近创建的 doc（任何 source）确认是这次生成的
    cur.execute("SELECT doc_id, title, source, created_at FROM rag_docs ORDER BY created_at DESC LIMIT 5")
    out.append('--- LATEST 5 DOCS ---')
    for r in cur.fetchall():
        out.append('DOC: ' + str(r[0]) + ' | TITLE: ' + str(r[1]) + ' | SRC: ' + str(r[2]) + ' | TIME: ' + str(r[3]))
except Exception as e:
    out.append('FATAL: ' + str(e))
with open('rag_check.log', 'w', encoding='utf-8') as f:
    f.write('\n'.join(out) + '\n')
print('WROTE')
