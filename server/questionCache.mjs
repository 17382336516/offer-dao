// Interview Question Cache —— 面试问题结构化知识资产层
//
// 设计原则（来自需求文档，已与用户对齐锁定）：
// 1. 不替换 RAG。RAG 继续负责 BGE-M3 向量召回原始内容；本模块只负责结构化问题资产。
// 2. 问题资产按「问题」存储，不按 chunk 存储。
//    业务唯一键：normalized_question + company + position + round
//    question_embedding（BGE-M3）仅用于语义去重，不做在线检索。
// 3. 一个问题允许多个 source_chunk_id（数组），证明多个面经来源共同存在该问题。
// 4. 查询走纯 SQL 三级优先级（不走 BGE-M3）：
//    ① company+position+round 完全匹配
//    ② position 匹配、公司不限（排除已完全匹配的本公司记录）
//    ③ 通用高频（company/position 皆空）
//    同档排序：hit_count DESC, created_time DESC（小红书靠 created_time 体现时效，不无条件置顶）。
// 5. hit_count 仅在「最终用于用户展示」时 +1，入库/查询都不 +1。
// 6. source 取值：xiaohongshu | rag | user_query。
//
// 依赖：db.mjs（JsonDatabaseSync，interview_question_cache 表）、rag.mjs（embedTexts 用于语义去重）。

import { db } from './db.mjs';
import * as rag from './rag.mjs';

// 语义去重阈值（cosine similarity）。后续可按实际重复率调整。
const SEMANTIC_DUP_THRESHOLD = 0.92;

// ---- 向量工具 ----
function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function parseEmbedding(str) {
  if (!str) return null;
  if (Array.isArray(str)) return str;
  try {
    const v = JSON.parse(str);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// 单个问题对应的 chunk 来源合并（去重 + 多来源共存）
function mergeSourceChunks(existingArr, incoming) {
  const set = new Set((existingArr || []).filter(Boolean));
  for (const c of (incoming || [])) {
    if (c && !set.has(c)) set.add(c);
  }
  return [...set];
}

// 取某 normalized 记录当前 source_chunk_id 数组
function currentChunkIds(row) {
  if (!row) return [];
  if (Array.isArray(row.source_chunk_id)) return row.source_chunk_id;
  try {
    const v = JSON.parse(row.source_chunk_id || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * isInterviewPost —— 判断文本是否为面经帖子
 * 条件：含公司词 + 岗位词 + 面试行为词，三者皆满足才进入结构化流程。
 * @param {string} text
 * @returns {boolean}
 */
const COMPANY_KEYWORDS = ['字节', '腾讯', '阿里', '蚂蚁', '美团', '百度', '京东', '网易', '拼多多', '快手', '滴滴', '小米', '华为', '小红书', 'B站', '哔哩哔哩', '苹果', '微软', '谷歌', 'Amazon', 'Amazon', 'Meta', 'OpenAI'];
const POSITION_KEYWORDS = ['AI产品经理', '产品经理', '产品运营', '增长产品经理', '商业化产品经理', '数据产品经理', '研发产品经理', '项目经理'];
const BEHAVIOR_KEYWORDS = ['一面', '二面', '三面', 'HR面', '面经', '面试复盘', '被问', '面试', '终面', '笔试', '群面', '交叉面'];
export function isInterviewPost(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text;
  const hasCompany = COMPANY_KEYWORDS.some((k) => t.includes(k));
  const hasPosition = POSITION_KEYWORDS.some((k) => t.includes(k));
  const hasBehavior = BEHAVIOR_KEYWORDS.some((k) => t.includes(k));
  return hasCompany && hasPosition && hasBehavior;
}

/**
 * getStructured —— 按三级优先级返回结构化问题
 * @param {string} company
 * @param {string} position
 * @param {string} round
 * @returns {Array<{id,question,question_type,answer,source,hit_count,created_time}>}
 */
export function getStructured(company, position, round) {
  const c = (company || '').trim() || null;
  const p = (position || '').trim() || null;
  const r = (round || '').trim() || null;

  // 统一字段，便于前端消费
  const shape = (row) => ({
    id: row.id,
    question: row.question,
    normalized_question: row.normalized_question,
    question_type: row.question_type,
    answer: row.answer,
    company: row.company ?? null,
    position: row.position ?? null,
    round: row.round ?? null,
    source: row.source,
    hit_count: row.hit_count || 0,
    created_time: row.created_time || 0,
  });

  let rows = [];
  // ① 完全匹配
  if (c && p && r) {
    rows = db.prepare(
      `SELECT id, question, question_type, answer, source, hit_count, created_time FROM interview_question_cache WHERE company = ? AND position = ? AND round = ?`
    ).all(c, p, r).map(shape);
  }
  // ② 岗位匹配、公司不限（company 传入时排除完全匹配的本公司记录）
  if (p) {
    const posRows = db.prepare(
      `SELECT id, question, question_type, answer, source, hit_count, created_time FROM interview_question_cache WHERE position = ? AND (company IS NULL OR company = ?)`
    ).all(p, c || null).map(shape);
    const seen = new Set(rows.map((x) => x.id));
    for (const x of posRows) if (!seen.has(x.id)) rows.push(x);
  }
  // ③ 通用高频
  const genRows = db.prepare(
    `SELECT id, question, question_type, answer, source, hit_count, created_time FROM interview_question_cache WHERE company IS NULL AND position IS NULL`
  ).all().map(shape);
  const seen2 = new Set(rows.map((x) => x.id));
  for (const x of genRows) if (!seen2.has(x.id)) rows.push(x);

  // 同档排序已由 SQL 保证，跨档合并后整体再按 hit_count/created_time 稳定排序
  rows.sort((a, b) => (b.hit_count || 0) - (a.hit_count || 0) || (b.created_time || 0) - (a.created_time || 0));
  return rows;
}

/**
 * upsertQuestion —— 语义去重 + 新增/更新
 * 流程：业务唯一键先行 → 再 BGE-M3 语义近邻（>=0.92 视为同题）→
 *       命中：合并 source_chunk_id、保留最高 hit_count、不新增；
 *       未命中：插入新行（hit_count=0）。
 * @param {object} q
 * @param {string} q.question
 * @param {string} q.normalized_question
 * @param {string} q.question_type  '基础问题' | '场景问题' | '项目问题'
 * @param {string} q.answer
 * @param {string} q.company
 * @param {string} q.position
 * @param {string} q.round
 * @param {string} q.source  'xiaohongshu' | 'rag' | 'user_query'
 * @param {string[]} q.source_chunk_id
 * @param {number[]} [q.embedding]  可选，传则跳过重新向量化
 * @returns {Promise<{id:string, action:'inserted'|'updated', hit_count?:number}>}
 */
export async function upsertQuestion(q) {
  const question = String(q.question || '').trim();
  const normalized = String(q.normalized_question || '').trim();
  const type = q.question_type;
  const answer = q.answer != null ? String(q.answer) : '';
  const c = (q.company || '').trim() || null;
  const p = (q.position || '').trim() || null;
  const r = (q.round || '').trim() || null;
  const source = q.source || null;
  const incomingChunks = Array.isArray(q.source_chunk_id) ? q.source_chunk_id : (q.source_chunk_id ? [q.source_chunk_id] : []);

  if (!question || !normalized || !type) {
    throw new Error('upsertQuestion 需要 question / normalized_question / question_type');
  }

  // 1) 业务唯一键查询（字段列表与 db.mjs 中带 WHERE 过滤的分支一致，确保命中精确匹配）
  const byKey = db.prepare(
    `SELECT id, source_chunk_id, hit_count, created_time FROM interview_question_cache WHERE normalized_question = ? AND company = ? AND position = ? AND round = ?`
  ).all(normalized, c, p, r);

  // 2) 语义去重：在全部记录里找 embedding 近邻
  let embedding = q.embedding || null;
  if (!embedding) {
    try {
      const emb = await rag.embedTexts([question]);
      embedding = emb && emb[0] ? emb[0] : null;
    } catch {
      embedding = null;
    }
  }
  let semanticHit = null;
  if (embedding) {
    const all = db.prepare(
      `SELECT id, normalized_question, question_embedding FROM interview_question_cache /*semantic-scan*/`
    ).all();
    let best = -1, bestId = null;
    for (const row of all) {
      const v = parseEmbedding(row.question_embedding);
      if (!v) continue;
      const sim = cosineSimilarity(embedding, v);
      if (sim > best) { best = sim; bestId = row.id; }
    }
    if (bestId && best >= SEMANTIC_DUP_THRESHOLD) semanticHit = bestId;
  }

  const hitId = (byKey && byKey[0] && byKey[0].id) || semanticHit;

  if (process.env.QC_DEBUG === '1') {
    console.log('[qc/upsert]', JSON.stringify({ normalized, type, byKeyHit: !!(byKey && byKey[0]), semanticHit, hitId: hitId || null }));
  }

  if (hitId) {
    // 命中：合并 source_chunk_id 与 source（多来源共存），保留 hit_count（不清零），不新增
    const rows = db.prepare(
      `SELECT id, source_chunk_id, hit_count, created_time FROM interview_question_cache WHERE id = ?`
    ).all(hitId);
    const row = rows && rows[0];
    if (row) {
      const mergedChunks = mergeSourceChunks(currentChunkIds(row), incomingChunks);
      // source 合并为去重集合（逗号分隔），体现该问题来自多个入口
      const srcSet = new Set(String(row.source || '').split(',').map((s) => s.trim()).filter(Boolean));
      if (source) srcSet.add(source);
      const mergedSource = [...srcSet].join(',');
      db.prepare(
        `UPDATE interview_question_cache SET source_chunk_id = ?, source = ?, hit_count = ? WHERE id = ?`
      ).run(JSON.stringify(mergedChunks), mergedSource, row.hit_count || 0, hitId);
      return { id: hitId, action: 'updated', hit_count: row.hit_count || 0 };
    }
  }

  // 未命中：插入新行
  const now = Date.now();
  const res = db.prepare(
    `INSERT INTO interview_question_cache (question, normalized_question, question_type, answer, source_chunk_id, company, position, round, source, question_embedding, hit_count, created_time) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    question, normalized, type, answer, JSON.stringify(incomingChunks),
    c, p, r, source, embedding ? JSON.stringify(embedding) : null, 0, now
  );
  const newId = (res && res.lastInsertRowid) || `iqc_${now}_new`;
  return { id: String(newId), action: 'inserted' };
}

/**
 * markHit —— 展示后批量增加 hit_count（仅最终用于用户展示的问题）
 * @param {string[]} ids
 */
export function markHit(ids) {
  const arr = (ids || []).filter(Boolean);
  if (!arr.length) return { changes: 0 };
  const placeholders = arr.map(() => '?').join(',');
  // 逐条 +1，避免 SQLite 参数数量隐患（JsonDatabaseSync 模拟支持 IN 语句）
  let changes = 0;
  for (const id of arr) {
    const r = db.prepare(`UPDATE interview_question_cache SET hit_count = hit_count + 1 WHERE id = ?`).run(id);
    changes += (r && r.changes) || 0;
  }
  return { changes };
}

export default { isInterviewPost, getStructured, upsertQuestion, markHit };
