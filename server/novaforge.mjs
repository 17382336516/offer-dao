// NovaForge —— 阶段知识沉淀生成器
//
// 定位（与每日笔记严格区分）：
//   · 每日笔记 noteGenerator：输入「当天完成的原始学习材料」（视频字幕 / PDF chunk），增量生成。
//   · NovaForge  本模块      ：输入「该阶段已生成的所有 daily notes」，做知识体系重组。
//
// 因此 NovaForge 永远不会读取原始 PDF / 视频字幕，天然满足 token 控制与测试6的要求。

import { callQwen } from './plan.mjs';
import { isMockMode } from './noteGenerator.mjs';

const NOVAFORGE_SYSTEM_PROMPT = `你是 NovaForge，一个「阶段知识体系沉淀」引擎。
用户会给你某个学习阶段内若干天的每日学习笔记（JSON 数组）。请把这些零散的每日笔记，重组成一份结构化的阶段知识体系文档。

【硬性约束】
1. 只能基于给定的每日笔记内容进行归纳、聚类、重组，绝对不能引入笔记中不存在的知识点。
2. 必须建立概念之间的关联，而不是把每日笔记简单拼接。
3. knowledgeTree 为多层知识树，体现「主题 → 子主题 → 知识点」的层级。
4. 严格输出 JSON，不要 markdown 代码块，结构如下：
{
  "title": "阶段知识体系标题",
  "overview": "阶段整体概述",
  "knowledgeTree": [
    { "name": "一级主题", "children": [ { "name": "二级主题", "children": [ { "name": "知识点" } ] } ] }
  ],
  "concepts": [ { "name": "概念", "definition": "定义", "relatedTo": ["相关概念"] } ],
  "connections": [ "概念A 与 概念B 的关系说明" ],
  "gaps": ["本阶段仍然薄弱/未覆盖的点"],
  "nextSteps": ["下一阶段建议"]
}`;

// 结构规整，保证前端拿到的形状永远稳定。
function normalizeStageNote(raw, stageTitle) {
  let obj = raw;
  if (typeof raw === 'string') {
    const text = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    try {
      obj = JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : text);
    } catch {
      obj = { overview: text };
    }
  }
  obj = obj && typeof obj === 'object' ? obj : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const normTree = (nodes) =>
    arr(nodes)
      .map((n) => {
        if (typeof n === 'string') return { name: n, children: [] };
        if (!n || typeof n !== 'object') return null;
        return { name: String(n.name || n.title || ''), children: normTree(n.children) };
      })
      .filter((n) => n && n.name);
  return {
    title: String(obj.title || stageTitle || '阶段知识体系'),
    overview: String(obj.overview || obj.summary || ''),
    knowledgeTree: normTree(obj.knowledgeTree || obj.tree),
    concepts: arr(obj.concepts)
      .map((c) => (typeof c === 'string'
        ? { name: c, definition: '', relatedTo: [] }
        : { name: String(c?.name || ''), definition: String(c?.definition || ''), relatedTo: arr(c?.relatedTo).map(String) }))
      .filter((c) => c.name),
    connections: arr(obj.connections).map(String),
    gaps: arr(obj.gaps).map(String),
    nextSteps: arr(obj.nextSteps).map(String),
  };
}

// mock：把每日笔记按天聚成知识树，纯本地聚合，零 token。
function mockStageNote(stageTitle, dailyNotes) {
  const uniq = (list) => [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
  const allKeyPoints = uniq(dailyNotes.flatMap((n) => n.keyPoints || []));
  const allConcepts = uniq(dailyNotes.flatMap((n) => n.concepts || []));
  return normalizeStageNote(
    {
      title: `${stageTitle || '阶段'} 知识体系（MOCK）`,
      overview: `[MOCK] 由 ${dailyNotes.length} 篇每日笔记聚合而成，未调用大模型。来源日期：${dailyNotes.map((n) => n.__date).filter(Boolean).join('、')}`,
      knowledgeTree: dailyNotes.map((n) => ({
        name: n.__date ? `${n.__date} ${n.title || ''}`.trim() : n.title || '当日笔记',
        children: uniq(n.keyPoints || []).slice(0, 5).map((k) => ({ name: k })),
      })),
      concepts: allConcepts.slice(0, 10).map((c) => ({ name: c, definition: '', relatedTo: [] })),
      connections: allKeyPoints.slice(0, 5).map((k) => `本阶段围绕「${String(k).slice(0, 20)}」形成关联`),
      gaps: [],
      nextSteps: [],
    },
    stageTitle
  );
}

/**
 * 生成阶段知识总结。
 * @param {object}  p
 * @param {string}  p.stageTitle  阶段名称
 * @param {Array}   p.dailyNotes  该阶段全部每日笔记（结构化对象数组，可带 __date 标记来源日期）
 * @returns {Promise<object>} 规整后的阶段总结
 */
export async function generateStageSummary({ stageTitle, dailyNotes }) {
  const notes = Array.isArray(dailyNotes) ? dailyNotes : [];
  if (!notes.length) throw new Error('EMPTY_DAILY_NOTES');
  if (isMockMode()) return mockStageNote(stageTitle, notes);

  // Token 控制：只把每日笔记的结构化字段送入模型，丢弃冗长的原始 content 文本。
  const compact = notes.map((n) => ({
    date: n.__date || '',
    title: n.title || '',
    keyPoints: n.keyPoints || [],
    concepts: n.concepts || [],
  }));
  const userPrompt = [
    `【阶段名称】${stageTitle || '未命名阶段'}`,
    `【本阶段每日笔记，共 ${compact.length} 篇】`,
    JSON.stringify(compact),
    '\n请生成阶段知识体系文档，只输出 JSON。',
  ].join('\n');
  const raw = await callQwen(NOVAFORGE_SYSTEM_PROMPT, userPrompt, 'qwen-plus');
  return normalizeStageNote(raw, stageTitle);
}

export default { generateStageSummary };
