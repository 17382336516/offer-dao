import json
import sqlite3
import sys
import io
from pathlib import Path

# 强制标准输出使用 UTF-8，避免 Windows 控制台默认 GBK 编码在遇到生僻汉字时崩溃
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')


def load_payload(payload_path):
    if not payload_path:
        return {}
    return json.loads(Path(payload_path).read_text(encoding="utf-8"))


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS rag_docs (
          doc_id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          title TEXT,
          ref TEXT,
          chunk_count INTEGER DEFAULT 0,
          created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS rag_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_id TEXT NOT NULL,
          source TEXT NOT NULL,
          title TEXT,
          content TEXT NOT NULL,
          embedding TEXT NOT NULL,
          meta TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc ON rag_chunks(doc_id);
        CREATE INDEX IF NOT EXISTS idx_rag_chunks_source ON rag_chunks(source);
        """
    )
    conn.commit()


def parse_meta(value):
    if not value:
        return {}
    try:
        return json.loads(value)
    except Exception:
        return {}


def main():
    command = sys.argv[1]
    db_path = sys.argv[2]
    payload = load_payload(sys.argv[3] if len(sys.argv) > 3 else None)
    conn = connect(db_path)
    init_db(conn)

    if command == "init":
        print(json.dumps({"ok": True}))
        return
    if command == "get_first_chunk_meta":
        row = conn.execute("SELECT meta FROM rag_chunks WHERE doc_id = ? ORDER BY id LIMIT 1", (payload["doc_id"],)).fetchone()
        print(json.dumps({"meta": row["meta"] if row else None}, ensure_ascii=False))
        return
    if command == "doc_exists":
        row = conn.execute("SELECT 1 FROM rag_docs WHERE doc_id = ?", (payload["doc_id"],)).fetchone()
        print(json.dumps({"exists": bool(row)}))
        return
    if command == "replace_document":
        conn.execute("DELETE FROM rag_chunks WHERE doc_id = ?", (payload["doc_id"],))
        conn.execute("DELETE FROM rag_docs WHERE doc_id = ?", (payload["doc_id"],))
        conn.execute(
            "INSERT INTO rag_docs (doc_id, source, title, ref, chunk_count, created_at) VALUES (?,?,?,?,?,?)",
            (payload["doc_id"], payload["source"], payload.get("title", ""), payload.get("ref", ""), payload["chunk_count"], payload["created_at"]),
        )
        conn.executemany(
            "INSERT INTO rag_chunks (doc_id, source, title, content, embedding, meta) VALUES (?,?,?,?,?,?)",
            [
                (payload["doc_id"], payload["source"], payload.get("title", ""), chunk["content"], chunk["embedding"], chunk.get("meta"))
                for chunk in payload["chunks"]
            ],
        )
        conn.commit()
        print(json.dumps({"ok": True, "chunks": payload["chunk_count"]}))
        return
    if command == "list_docs":
        rows = conn.execute("SELECT doc_id, source, title, ref, chunk_count, created_at FROM rag_docs ORDER BY created_at DESC").fetchall()
        print(json.dumps([dict(row) for row in rows], ensure_ascii=False))
        return
    if command == "list_chunk_rows":
        limit = int(payload.get("limit") or 200)
        offset = int(payload.get("offset") or 0)
        rows = conn.execute(
            "SELECT id, doc_id, title, content, meta FROM rag_chunks ORDER BY id LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        print(json.dumps([dict(row) for row in rows], ensure_ascii=False))
        return
    if command == "delete_doc":
        conn.execute("DELETE FROM rag_chunks WHERE doc_id = ?", (payload["doc_id"],))
        conn.execute("DELETE FROM rag_docs WHERE doc_id = ?", (payload["doc_id"],))
        conn.commit()
        print(json.dumps({"ok": True, "docId": payload["doc_id"]}, ensure_ascii=False))
        return
    if command == "clear_source":
        rows = conn.execute("SELECT doc_id FROM rag_docs WHERE source = ?", (payload["source"],)).fetchall()
        conn.execute("DELETE FROM rag_chunks WHERE source = ?", (payload["source"],))
        conn.execute("DELETE FROM rag_docs WHERE source = ?", (payload["source"],))
        conn.commit()
        print(json.dumps({"ok": True, "source": payload["source"], "removedDocs": len(rows)}, ensure_ascii=False))
        return
    if command == "get_chunks":
        if payload.get("doc_id"):
          # 按文档精确取回全部 chunk（仅 content + meta，不含大向量），用于学习笔记生成
          rows = conn.execute(
            "SELECT id, doc_id, source, title, content, meta FROM rag_chunks WHERE doc_id = ? ORDER BY id",
            (payload["doc_id"],),
          ).fetchall()
          print(json.dumps([dict(row) for row in rows], ensure_ascii=False))
          return
        if payload.get("source"):
          rows = conn.execute("SELECT id, doc_id, source, title, content, embedding, meta FROM rag_chunks WHERE source = ?", (payload["source"],)).fetchall()
        else:
          rows = conn.execute("SELECT id, doc_id, source, title, content, embedding, meta FROM rag_chunks").fetchall()
        # 岗位隔离：仅对 xhs 来源的帖子按 meta.jobName 过滤（不论是否带查询向量，统一在此前置过滤）
        job_filter = (payload.get("job") or "").strip()
        if job_filter:
          def _meta_job(meta_text):
            m = parse_meta(meta_text)
            return m.get("jobName") or m.get("job") or ""
          rows = [
            r for r in rows
            if (r["source"] if "source" in r.keys() else parse_meta(r["meta"]).get("source")) != "xhs"
            or _meta_job(r["meta"]).strip() == job_filter
          ]
        # 面经隔离：按 meta 的 company/role/round 精确过滤（type=interview 时启用）。
        # 仅对 type=interview 的 chunk 做精确匹配，避免影响其他来源检索。
        company_filter = (payload.get("company") or "").strip()
        role_filter = (payload.get("role") or "").strip()
        round_filter = (payload.get("round") or "").strip()
        if company_filter or role_filter or round_filter:
          def _meta_match(meta_text):
            m = parse_meta(meta_text)
            if m.get("type") != "interview":
              return False
            if company_filter and (m.get("company") or "").strip() != company_filter:
              return False
            if role_filter and (m.get("role") or "").strip() != role_filter:
              return False
            if round_filter and (m.get("round") or "").strip() != round_filter:
              return False
            return True
          rows = [r for r in rows if _meta_match(r["meta"])]
        # 若传入查询向量，则在 Python 侧直接计算余弦相似度并返回 topK，
        # 避免把全库 embedding 一次性传回 Node 导致缓冲区溢出。
        q_emb = payload.get("query_embedding")
        if q_emb:
            import math
            def cosine(a, b):
                if not a or not b or len(a) != len(b):
                    return 0.0
                dot = sum(x * y for x, y in zip(a, b))
                na = math.sqrt(sum(x * x for x in a))
                nb = math.sqrt(sum(y * y for y in b))
                if na == 0 or nb == 0:
                    return 0.0
                return dot / (na * nb)
            scored = []
            skill_filter = (payload.get("skill") or "").strip()
            skill_aliases = set(payload.get("skill_aliases") or [])
            category_filter = (payload.get("category") or "").strip()
            for r in rows:
                meta = parse_meta(r["meta"])
                skills = meta.get("skills") or []
                if skill_filter:
                    normalized_skills = {str(s).strip() for s in skills}
                    if skill_filter not in normalized_skills and not (skill_aliases & normalized_skills):
                        continue
                if category_filter and meta.get("category") != category_filter:
                    continue
                try:
                    emb = json.loads(r["embedding"])
                except Exception:
                    continue
                d = dict(r)
                d.pop("embedding", None)  # 不再回传大向量，避免额外开销
                scored.append((cosine(q_emb, emb), d))
            scored.sort(key=lambda x: x[0], reverse=True)
            top_k = int(payload.get("top_k") or 30)
            print(json.dumps([{"score": s[0], **s[1]} for s in scored[:top_k]], ensure_ascii=False))
            return
        print(json.dumps([dict(row) for row in rows], ensure_ascii=False))
        return
    if command == "update_chunk_meta":
        rows = conn.execute("SELECT id, title, content, meta FROM rag_chunks").fetchall()
        updated = 0
        for row in rows:
            patch = payload.get("updates", {}).get(str(row["id"])) or payload.get("updates", {}).get(row["id"])
            if not patch:
                continue
            meta = parse_meta(row["meta"])
            meta.update(patch)
            conn.execute("UPDATE rag_chunks SET meta = ? WHERE id = ?", (json.dumps(meta, ensure_ascii=False), row["id"]))
            updated += 1
        conn.commit()
        print(json.dumps({"ok": True, "updated": updated}, ensure_ascii=False))
        return
    raise SystemExit(f"Unknown command: {command}")


if __name__ == "__main__":
    main()
