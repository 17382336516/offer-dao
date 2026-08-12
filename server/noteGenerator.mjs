// 学习笔记生成模块
// 职责：把「当天已学内容（视频字幕 + PDF 相关 chunk）」整理成结构化学习笔记。
// 严格约束：模型只负责理解+整理，绝不生成新的 B站链接 / PDF / 章节 / 学习内容。
import { callQwen } from './plan.mjs';

// 统一使用 .env 中的 QWEN_MODEL（如 qwen-flash / qwen-turbo / qwen-plus），
// 不再写死模型名，保证配置生效且调用 callQwen 时不会覆盖环境变量。
const NOTE_MODEL = process.env.QWEN_MODEL || 'qwen-turbo';


// 单段合并上限（字符数），超过则先做分段小结再汇总，控制 token。
const CHUNK_SUMMARY_LIMIT = 6000;

// —— 测试模式：不调用大模型，节省 token ——
// 开启方式：环境变量 NOTE_LLM_MOCK=1（或 LLM_MOCK=1）。
// mock 只对输入材料做「确定性的本地摘取」，不产生任何编造内容，
// 因此上层的增量合并 / 覆盖 / 次数限制 / NovaForge 链路都能真实跑通。
export function isMockMode() {
  return process.env.NOTE_LLM_MOCK === '1' || process.env.LLM_MOCK === '1' || process.env.TEST_MODE === '1';
}

// 从材料里抽取若干「可读句子」，用于 mock 输出。纯本地字符串处理，零 token。
function pickSentences(text, max) {
  if (!text) return [];
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？.!?])\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && !/^【.*】$/.test(s))
    .slice(0, max);
}

function mockNote({ skill, videoNotes, pdfChunks }) {
  const vs = pickSentences(videoNotes, 5);
  const ps = pickSentences(pdfChunks, 5);
  const all = [...vs, ...ps];
  const scope = [videoNotes && videoNotes.trim() ? '视频' : '', pdfChunks && pdfChunks.trim() ? 'PDF' : '']
    .filter(Boolean).join('+') || '无';
  return {
    title: `${skill || '当天'} 学习笔记（MOCK）`,
    subtitle: skill || '',
    summary: `本次学习围绕${skill || '当天主题'}展开，材料来源包括${scope}。以下内容仅根据当天学习材料整理，帮助理解核心概念及其在 AI 产品中的应用价值。\n\n本节掌握：\n${all.slice(0, 4).map((s) => `- ${s}`).join('\n')}`,
    key_points: all.slice(0, 6).map((text) => ({ name: text.slice(0, 40), definition: text, core作用: [], product_application: [] })),
    mind_map: { root: skill || '当天学习主题', children: all.slice(0, 6).map((s) => ({ name: s.slice(0, 30), children: [] })) },
    user_note: '',
  };
}

// 构造带「主题锚定」的系统提示词。
// taskTitle / skill / resourceTitles 来自用户真实学习意图（daily_learning_task + resource_info.title），
// 不是模型猜测——用它们作为硬性主题闸门，杜绝无关素材混入笔记（治标兜底层）。
function buildSystemPrompt({ taskTitle, skill, resourceTitles } = {}) {
  const topic = String(taskTitle || skill || '').trim();
  const resList = Array.isArray(resourceTitles) ? resourceTitles.filter(Boolean) : [];

  const anchor = topic
    ? `
【本次学习主题（唯一目标，最高优先级）】
主题：${topic}
技能方向：${skill || topic}
${resList.length ? `本次学习资源：\n${resList.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}` : ''}

【主题锚定约束——违反即为错误输出】
1. 只总结与「${topic}」直接相关的内容。
2. 输入材料可能混入与本主题无关的内容（例如摄影技巧、影视叙事、伦理故事、零售案例、无关行业科普等），
   一律直接忽略，不要总结、不要提及、不要作为例子引用。
3. 严禁为了"覆盖全部素材"而在多个不相关主题之间创造统一理论、统一框架或统一主线
   （例如"X维认知体系""从A到B的完整链路"这类强行缝合的说法）。
4. 宁可笔记内容偏少，也不要纳入无关内容。相关内容不足时，如实产出较少条目即可。
5. 标题(title)必须直接反映「${topic}」，不超过 25 个字，禁止用"×"连接多个不相关领域。
6. 输入字幕由语音识别生成，可能存在错别字或错误缩写。遇到无法确认的专业术语或英文缩写，
   按材料原样保留即可，严禁自行推断、补全或杜撰其英文全称与定义；不确定含义的术语不要写进 concepts。
`
    : '';

  return `你是一名严谨的AI产品经理学习笔记助手，服务对象是正在系统学习的AI产品经理。

你的任务：根据用户当天真实学习的视频字幕与PDF内容，围绕其学习目标，生成可沉淀、可复用的结构化学习笔记。
${anchor}
【核心原则】
1. 只能基于输入材料总结，禁止编造材料中不存在的知识、案例、链接、章节、页码。
2. 不扩展外部知识，不加入个人推测。
3. 材料中若某一部分没有可用内容，对应字段返回空数组，不要凑数。
4. 输出必须是严格的 JSON。

【输出内容要求：幕布 / Notion 文档式学习笔记】
1. summary：100-200字，分两段；第二段必须以“本节掌握：”开头并列出3-5个能力点。
2. key_points：3-8个对象，每个对象包含 name、definition、core作用、product_application；内容短句化，不写论文。
3. mind_map：严格输出 {"root":"","children":[{"name":"","children":[{"name":""}]}]}，3-8个一级节点，适度展开。
4. user_note：固定为空字符串，必须让用户后续编辑填写。

【禁止】
- 添加材料外案例、不存在的资源与章节
- 为无关主题强行建立联系
- 生成面试/面经内容（本系统已有独立面经模块负责面试准备）
- 生成"复习问题/复习题/自测题/思考题"等任何形式的问题列表（用户不需要复习问题，严禁输出）
- 自行补全不确定英文缩写或杜撰概念

输出严格JSON：
{
  "title": "当天学习主题标题（不超过25字）",
  "subtitle": "副标题",
  "summary": "100-200字学习总结，第二段以本节掌握：开头",
  "key_points": [{"name":"概念名称","definition":"一句话定义","core作用":["作用"],"product_application":["产品应用"]}],
  "mind_map": {"root":"中心主题","children":[{"name":"一级节点","children":[{"name":"二级节点"}]}]},
  "user_note": ""
}`;
}

function buildUserPrompt({ taskTitle, skill, resourceTitles, videoNotes, pdfChunks }) {
  const parts = [];
  const topic = String(taskTitle || skill || '').trim();
  if (topic) {
    parts.push(`【本次学习目标】${topic}${skill && skill !== topic ? `（技能方向：${skill}）` : ''}`);
  } else {
    parts.push(`【当天学习的技能】${skill || '（未知）'}`);
  }
  parts.push('\n【视频学习内容（仅当天学习且与目标相关的分P字幕）】');
  parts.push(videoNotes && videoNotes.trim() ? videoNotes.trim() : '（当天无视频学习内容）');
  parts.push('\n【PDF 阅读内容（仅当天阅读范围的 RAG 切片）】');
  parts.push(pdfChunks && pdfChunks.trim() ? pdfChunks.trim() : '（当天无 PDF 阅读内容）');
  parts.push('\n请严格基于以上材料整理学习笔记，遵守系统指令中的所有约束，只输出 JSON。');
  return parts.join('\n');
}

// 若材料过长（如整本 PDF），先按块做结构化小结，再汇总为最终笔记。
// 优化C-2：整本 PDF 不再被单次截断喂丢内容——按 CHUNK_SUMMARY_LIMIT 切块，
// 每块用 qwen-turbo 产出完整 8 字段小结，最后 qwen-plus 把所有块的结构化小结合并为一份。
async function chunkedSummarize({ taskTitle, skill, resourceTitles, videoNotes, pdfChunks }) {
  const combined = `${videoNotes || ''}\n${pdfChunks || ''}`;
  if (combined.length <= CHUNK_SUMMARY_LIMIT) {
    return callQwen(buildSystemPrompt({ taskTitle, skill, resourceTitles }), buildUserPrompt({ taskTitle, skill, resourceTitles, videoNotes, pdfChunks }), NOTE_MODEL);
  }
  // 整本材料切块（视频+PDF 合并后均匀切片，覆盖全部内容，不丢任何一段）
  const blocks = [];
  const text = `视频内容：\n${videoNotes || ''}\n\nPDF内容：\n${pdfChunks || ''}`;
  for (let i = 0; i < text.length; i += CHUNK_SUMMARY_LIMIT) {
    blocks.push(text.slice(i, i + CHUNK_SUMMARY_LIMIT));
  }
  const subNotes = [];
  for (const b of blocks) {
    // 每块小结保留最终笔记结构，供最终汇总对齐
    const s = await callQwen(
      '你是学习笔记助手。请把下面这段学习材料提炼为结构化笔记（只输出完整 JSON：{"title":"","subtitle":"","summary":"","key_points":[],"mind_map":{"root":"","children":[]},"user_note":""}），只基于材料、不要编造任何材料外的内容。',
      b,
      NOTE_MODEL
    );
    subNotes.push(safeParseNote(s, skill));
  }
  // 把所有块的结构化小结作为数组整体交给 qwen-plus 汇总，确保各块要点都不遗漏
  const merged = `【技能】${skill || ''}\n以下是分段小结（共 ${subNotes.length} 段），请汇总为一份最终结构化学习笔记，保留所有要点：\n` +
    JSON.stringify(subNotes, null, 2);
  return callQwen(buildSystemPrompt({ taskTitle, skill, resourceTitles }), merged, NOTE_MODEL);
}

function safeParseNote(raw, skill) {
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { obj = {}; }
  return {
    title: String(obj.title || `${skill || '当天'} 学习笔记`),
    subtitle: String(obj.subtitle || obj.skill || skill || ''),
    summary: String(obj.summary || ''),
    key_points: Array.isArray(obj.key_points) ? obj.key_points : (Array.isArray(obj.keyPoints) ? obj.keyPoints.map((x) => ({ name: String(x), definition: String(x), core作用: [], product_application: [] })) : []),
    mind_map: obj.mind_map && typeof obj.mind_map === 'object' ? obj.mind_map : { root: skill || '当天学习主题', children: [] },
    user_note: '',
  };
}

// 主入口：输入当天学习内容，返回结构化笔记对象。
// taskTitle / skill / resourceTitles 携带用户真实学习意图，用于主题锚定。
export async function generateNote({ taskTitle, skill, resourceTitles, videoNotes, pdfChunks }) {
  if (isMockMode()) return safeParseNote(mockNote({ skill, videoNotes, pdfChunks }), skill);
  const raw = await chunkedSummarize({ taskTitle, skill, resourceTitles, videoNotes, pdfChunks });
  return safeParseNote(raw, skill);
}

// 把「已有笔记」压缩为极短摘要，用于增量合并时替代完整旧笔记，
// 大幅降低 token：旧笔记只作为「已学过的上下文」而非全量重复输入。
const COMPRESS_SYSTEM_PROMPT = `你是学习笔记摘要压缩器。请把下面这份结构化学习笔记压缩为极简摘要，保留关键知识点并只输出同结构 JSON：
{"title":"","subtitle":"","summary":"","key_points":[],"mind_map":{"root":"","children":[]},"user_note":""}`;

async function compressNote(note) {
  const raw = await callQwen(COMPRESS_SYSTEM_PROMPT, JSON.stringify(note), NOTE_MODEL);
  return safeParseNote(raw, note.skill);
}

// —— 增量合并：把「已有笔记（压缩摘要）」与「本次新增材料生成的增量笔记」合并为一份最终笔记 ——
// Token 控制核心：新增材料只处理一次，旧材料先压缩为短摘要再送模型；
// 模型仅收到「旧笔记压缩摘要（很短）+ 新增材料」，而不是全部原始内容。
const MERGE_SYSTEM_PROMPT = `你是学习笔记合并助手。用户会给你「已有当天学习笔记的压缩摘要（JSON）」和「本次新增学习内容整理出的增量笔记（JSON）」。
请把两者合并为一份完整、去重、条理清晰的当天学习笔记。

【硬性约束】
1. 只能合并、去重、重新组织已给出的内容，绝对不能编造新的知识点、链接、章节或例子。
2. 已有笔记摘要中的要点不得丢失，新增笔记的要点必须补充进来。
3. 语义重复的条目合并为一条，不要简单罗列两份。
4. 输出严格 JSON，结构与输入笔记一致：
{"title":"","subtitle":"","summary":"","key_points":[],"mind_map":{"root":"","children":[]},"user_note":""}`;

// mock 下的本地合并：按字符串去重并集，行为确定、零 token。
function mergeLocally(oldNote, deltaNote, skill) {
  const uniq = (a = [], b = []) => {
    const seen = new Set();
    const out = [];
    for (const x of [...a, ...b]) {
      const k = JSON.stringify(x);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  };
  return safeParseNote({
    title: oldNote.title || deltaNote.title,
    subtitle: oldNote.subtitle || deltaNote.subtitle || skill,
    summary: `${oldNote.summary || ''}\n[增量] ${deltaNote.summary || ''}`.trim(),
    key_points: uniq(oldNote.key_points, deltaNote.key_points),
    mind_map: deltaNote.mind_map || oldNote.mind_map,
    user_note: '',
  }, skill);
}

// 增量生成入口：
//   oldNote     —— 已保存的当天笔记对象（第一次生成时为 null）
//   videoNotes  —— 仅「本次新增完成」的视频字幕
//   pdfChunks   —— 仅「本次新增完成」的 PDF 切片
// 若 oldNote 为空 → 等价于首次全量生成。
export async function generateNoteIncremental({ taskTitle, skill, resourceTitles, oldNote, videoNotes, pdfChunks }) {
  const delta = await generateNote({ taskTitle, skill, resourceTitles, videoNotes, pdfChunks });
  if (!oldNote) return delta;
  if (isMockMode()) return mergeLocally(oldNote, delta, skill);
  // 优化C-1：旧笔记先压缩为短摘要，再与增量笔记合并，避免重复输入全量旧内容。
  const oldSummary = await compressNote(oldNote);
  const topic = String(taskTitle || skill || '').trim();
  const userPrompt = [
    topic ? `【本次学习目标】${topic}` : '',
    '【已有的当天学习笔记（压缩摘要）】',
    JSON.stringify(oldSummary),
    '\n【本次新增学习内容的增量笔记】',
    JSON.stringify(delta),
    '\n请合并为一份最终笔记，只输出 JSON。保持主题聚焦，不要引入与学习目标无关的内容。',
  ].filter(Boolean).join('\n');
  const raw = await callQwen(MERGE_SYSTEM_PROMPT, userPrompt, NOTE_MODEL);
  return safeParseNote(raw, skill);
}

export default { generateNote, generateNoteIncremental, isMockMode };
