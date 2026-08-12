import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 必须在读取任何 process.env 之前加载 .env（重写同名变量），
// 否则后续 EMBED_PROVIDER / *_TIMEOUT_MS 等常量会读到默认值而非 .env 配置。
// 注意：loadDotEnv 内部用到 __dirname，故放在其初始化之后调用。
loadDotEnv();
const RAG_DB_PATH = path.join(__dirname, 'rag.sqlite3');
const RAG_SQLITE_SCRIPT = path.join(__dirname, 'rag_sqlite.py');
const PYTHON_BIN = process.env.PYTHON_BIN || (fs.existsSync('D:\\anaa\\python.exe') ? 'D:\\anaa\\python.exe' : 'python');
const DEFAULT_SOURCE_DIR = path.join(PROJECT_ROOT, 'rag_sources');

const EMBED_PROVIDER = (process.env.EMBED_PROVIDER || 'huggingface').toLowerCase(); // 'ollama' | 'dashscope' | 'huggingface'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'bge-m3';
const EMBED_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const EMBED_MODEL = process.env.QWEN_EMBED_MODEL || 'text-embedding-v3';
const BGE_M3_LOCAL_DIR = process.env.BGE_M3_LOCAL_DIR || 'D:/bge-m3';
const CHUNK_SIZE = Number(process.env.RAG_CHUNK_SIZE || 1200);
const CHUNK_OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP || 100);
const BATCH = Number(process.env.RAG_EMBED_BATCH || 16);
const HF_MAX_CHARS = Number(process.env.RAG_HF_MAX_CHARS || 4000);
const HF_BATCH_FALLBACK = Number(process.env.RAG_HF_BATCH_FALLBACK || 4);
const EXTRACT_TIMEOUT_MS = Number(process.env.RAG_EXTRACT_TIMEOUT_MS || 90000);
const INGEST_TIMEOUT_MS = Number(process.env.RAG_INGEST_TIMEOUT_MS || 180000);
const SUPPORTED_EXTS = new Set(['.txt', '.md', '.markdown', '.pdf', '.docx', '.pptx']);

function loadDotEnv() {
  const p = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(p)) return;
  try {
    const txt = fs.readFileSync(p, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // ignore .env loading errors
  }
}

function callRagSqlite(command, payload = {}, { timeout = 120000, sync = false } = {}) {
  const payloadPath = path.join(os.tmpdir(), `rag-sqlite-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
  if (sync) {
    try {
      const stdout = execFileSync(PYTHON_BIN, [RAG_SQLITE_SCRIPT, command, RAG_DB_PATH, payloadPath], {
        timeout,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout ? JSON.parse(stdout) : null;
    } finally {
      try { fs.unlinkSync(payloadPath); } catch {}
    }
  }
  return new Promise((resolve, reject) => {
    execFile(PYTHON_BIN, [RAG_SQLITE_SCRIPT, command, RAG_DB_PATH, payloadPath], { timeout, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      try { fs.unlinkSync(payloadPath); } catch {}
      if (error) {
        reject(new Error((stderr || error.message || '').trim()));
        return;
      }
      try {
        resolve(stdout ? JSON.parse(stdout) : null);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

export function initRag() {
  if (process.env.SKIP_RAG_INIT === '1') return;
  callRagSqlite('init', {}, { sync: true });
  // 预热本地 BGE-M3 嵌入模型：异步、不阻塞启动；失败仅警告（首次生成计划会降级为无嵌入检索）。
  // 避免用户首次点击「生成学习路线」时触发冷加载卡在 95%。
  loadHfExtractor()
    .then(() => console.error('[rag] BGE-M3 预热完成'))
    .catch((e) => console.error('[rag] BGE-M3 预热失败（不致命）:', e.message));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedOneBatchDashscope(texts) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('Missing DASHSCOPE_API_KEY for embedding generation');

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(EMBED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`embedding 鎺ュ彛 ${res.status}: ${t.slice(0, 200)}`);
      }
      const j = await res.json();
      const arr = Array.isArray(j?.data) ? j.data : [];
      const embeddings = arr
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => d.embedding);
      if (embeddings.length !== texts.length) {
        throw new Error(`embedding 杩斿洖鏁伴噺寮傚父锛?{embeddings.length}/${texts.length}`);
      }
      return embeddings;
    } catch (e) {
      lastError = e;
      if (attempt < 3) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

async function embedOneOllama(text) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`Ollama embedding 鎺ュ彛 ${res.status}: ${t.slice(0, 200)}`);
      }
      const j = await res.json();
      if (!Array.isArray(j?.embedding)) throw new Error('Ollama 鏈繑鍥?embedding 鍚戦噺');
      return j.embedding;
    } catch (e) {
      lastError = e;
      if (attempt < 3) await sleep(500 * attempt);
    }
  }
  throw lastError;
}

// Local BGE-M3 via @huggingface/transformers, loaded from BGE_M3_LOCAL_DIR.
let _hfExtractor = null;
let _hfReady = false;
let _hfLoading = null; // 并发保护：避免多次生成并发触发多次模型加载
const HF_LOAD_TIMEOUT = 120000; // 本地 1.46GB 模型加载上限；超时即失败，调用方降级兜底
const HF_INFER_TIMEOUT = 60000; // 单次批量推理上限；超时即降级为单条回退，避免永久挂起
async function loadHfExtractor() {
  if (_hfReady) return _hfExtractor;
  if (_hfLoading) return _hfLoading; // 复用进行中的加载
  _hfLoading = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    // 全部用本地文件，禁止联网
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    const localModel = BGE_M3_LOCAL_DIR;
    console.error('[rag] 加载本地 BGE-M3:', localModel);
    try {
      _hfExtractor = await Promise.race([
        pipeline('feature-extraction', localModel, { local_files_only: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('BGE-M3 加载超时(120s)，已降级为无嵌入检索')), HF_LOAD_TIMEOUT)),
      ]);
      _hfReady = true;
      console.error('[rag] BGE-M3 加载完成');
    } catch (e) {
      _hfReady = false;
      console.error('[rag] BGE-M3 加载失败:', e.message);
      throw e;
    } finally {
      _hfLoading = null;
    }
    return _hfExtractor;
  })();
  return _hfLoading;
}

async function embedOneHf(text) {
  const extractor = await loadHfExtractor();
  const out = await extractor(prepareTextForEmbedding(text), { pooling: 'mean', normalize: true });
  // out.dims 鍙兘鏄?[1, dim] 鎴?[dim]
  const data = Array.from(out.data);
  if (data.length !== 1024) throw new Error(`Unexpected HF embedding dim: ${data.length}`);
  return data;
}

function prepareTextForEmbedding(text) {
  const normalized = normalizeText(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= HF_MAX_CHARS) return normalized;
  return normalized.slice(0, HF_MAX_CHARS);
}

function unpackHfBatchOutput(out, expectedCount) {
  const flat = Array.from(out?.data || []);
  if (!expectedCount) return [];
  if (expectedCount === 1) {
    if (flat.length !== 1024) throw new Error(`Unexpected HF embedding dim: ${flat.length}`);
    return [flat];
  }

  const dims = Array.isArray(out?.dims) ? out.dims.map(Number) : [];
  let rows = dims.length >= 2 ? dims[0] : expectedCount;
  let cols = dims.length >= 2 ? dims[dims.length - 1] : Math.floor(flat.length / expectedCount);
  if (!rows || !cols || rows * cols !== flat.length) {
    rows = expectedCount;
    cols = Math.floor(flat.length / expectedCount);
  }
  if (rows !== expectedCount || cols !== 1024 || rows * cols !== flat.length) {
    throw new Error(`HF batch output mismatch: dims=${JSON.stringify(dims)} flat=${flat.length} expected=${expectedCount}x1024`);
  }

  const embeddings = [];
  for (let i = 0; i < rows; i++) {
    embeddings.push(flat.slice(i * cols, (i + 1) * cols));
  }
  return embeddings;
}

async function embedManyHf(texts) {
  const extractor = await loadHfExtractor();
  const prepared = texts.map(prepareTextForEmbedding);
  const withTimeout = (p, ms, label) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时')), ms))]);
  try {
    const out = await withTimeout(
      extractor(prepared, { pooling: 'mean', normalize: true }),
      HF_INFER_TIMEOUT,
      'BGE-M3 批量推理'
    );
    return unpackHfBatchOutput(out, prepared.length);
  } catch (error) {
    // Some local ONNX runs are unstable on larger batches; degrade gracefully.
    if (prepared.length <= 1) throw error;
    const fallbackSize = Math.max(1, Math.min(HF_BATCH_FALLBACK, prepared.length - 1));
    if (fallbackSize === prepared.length) throw error;
    const embeddings = [];
    for (let i = 0; i < prepared.length; i += fallbackSize) {
      const slice = prepared.slice(i, i + fallbackSize);
      if (slice.length === 1) {
        embeddings.push(await embedOneHf(slice[0]));
        continue;
      }
      try {
        const out = await extractor(slice, { pooling: 'mean', normalize: true });
        embeddings.push(...unpackHfBatchOutput(out, slice.length));
      } catch {
        for (const item of slice) embeddings.push(await embedOneHf(item));
      }
    }
    return embeddings;
  }
}

async function embedOneBatch(texts) {
  if (EMBED_PROVIDER === 'ollama') {
    const out = [];
    for (const t of texts) out.push(await embedOneOllama(t));
    return out;
  }
  if (EMBED_PROVIDER === 'huggingface') {
    return embedManyHf(texts);
  }
  return embedOneBatchDashscope(texts);
}

export async function embedTexts(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const embs = await embedOneBatch(slice);
    for (const e of embs) out.push(e);
  }
  return out;
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\u200b|\ufeff/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeMojibake(text) {
  const s = String(text || '');
  const bad = (s.match(/�/g) || []).length;
  return s.length > 40 && bad / s.length > 0.08;
}

function isLowQualityText(text) {
  const s = String(text || '');
  if (s.length < 20) return true;
  const control = (s.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g) || []).length;
  const replacement = (s.match(/�/g) || []).length;
  const letters = (s.match(/[\p{L}\p{N}]/gu) || []).length;
  return control / s.length > 0.02 || replacement / s.length > 0.02 || letters / s.length < 0.25;
}

function decodeTextBuffer(buffer) {
  let text = buffer.toString('utf8');
  if (text.includes('\u0000')) text = buffer.toString('utf16le');
  if (looksLikeMojibake(text)) {
    const gbk = tryDecodeWithTextDecoder(buffer, 'gb18030');
    if (gbk && !looksLikeMojibake(gbk)) text = gbk;
  }
  return normalizeText(text);
}

function tryDecodeWithTextDecoder(buffer, encoding) {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return '';
  }
}

export function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const t = normalizeText(text);
  if (!t) return [];
  const paragraphs = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const p of paragraphs) {
    if ((current + '\n\n' + p).trim().length <= size) {
      current = (current ? current + '\n\n' : '') + p;
      continue;
    }
    if (current) chunks.push(current);
    if (p.length <= size) {
      current = p;
    } else {
      for (let i = 0; i < p.length; ) {
        chunks.push(p.slice(i, i + size));
        if (i + size >= p.length) break;
        i += Math.max(1, size - overlap);
      }
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => c.trim()).filter((c) => c.length >= 20);
}

function parseMeta(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function uniqueList(values) {
  return [...new Set((values || []).map((v) => String(v || '').trim()).filter(Boolean))];
}

const SKILL_DICTIONARY = [
  {
    skill_id: 'ml',
    standard_name: '机器学习',
    aliases: ['机器学习', '监督学习', '无监督学习', '分类', '分类算法', '回归', '回归算法', '聚类', '统计学习', '统计学习方法'],
    category: 'ml',
    parent_skill: '',
    sub_skills: ['深度学习'],
  },
  {
    skill_id: 'dl',
    standard_name: '深度学习',
    aliases: ['深度学习', '神经网络', 'cnn', 'rnn'],
    category: 'ml',
    parent_skill: '机器学习',
    sub_skills: [],
  },
  {
    skill_id: 'llm',
    standard_name: '大模型',
    aliases: ['大模型', 'llm', '语言模型', 'gpt', 'chatglm', '预训练'],
    category: 'llm',
    parent_skill: '',
    sub_skills: ['Prompt工程', '微调', 'Transformer', 'RLHF', 'LoRA'],
  },
  {
    skill_id: 'transformer',
    standard_name: 'Transformer',
    aliases: ['transformer', 'attention', 'self-attention'],
    category: 'llm',
    parent_skill: '大模型',
    sub_skills: [],
  },
  {
    skill_id: 'prompt',
    standard_name: 'Prompt工程',
    aliases: ['prompt', '提示词', '提示工程', 'few-shot', 'zero-shot', 'cot'],
    category: 'llm',
    parent_skill: '大模型',
    sub_skills: [],
  },
  {
    skill_id: 'finetune',
    standard_name: '微调',
    aliases: ['微调', 'fine-tuning', 'finetuning', 'sft'],
    category: 'llm',
    parent_skill: '大模型',
    sub_skills: ['LoRA', 'RLHF'],
  },
  {
    skill_id: 'lora',
    standard_name: 'LoRA',
    aliases: ['lora', 'qlora', 'adapter-tuning', 'peft'],
    category: 'llm',
    parent_skill: '微调',
    sub_skills: [],
  },
  {
    skill_id: 'rlhf',
    standard_name: 'RLHF',
    aliases: ['rlhf', 'ppo', '强化学习'],
    category: 'llm',
    parent_skill: '微调',
    sub_skills: [],
  },
  {
    skill_id: 'rag',
    standard_name: 'RAG',
    aliases: ['rag', '检索增强', 'retrieval-augmented generation'],
    category: 'rag',
    parent_skill: '',
    sub_skills: ['向量库', 'Rerank'],
  },
  {
    skill_id: 'vector_db',
    standard_name: '向量库',
    aliases: ['向量库', 'embedding', 'embeddings', 'faiss', 'milvus', 'chroma'],
    category: 'rag',
    parent_skill: 'RAG',
    sub_skills: [],
  },
  {
    skill_id: 'rerank',
    standard_name: 'Rerank',
    aliases: ['rerank', '重排'],
    category: 'rag',
    parent_skill: 'RAG',
    sub_skills: [],
  },
  {
    skill_id: 'agent',
    standard_name: 'Agent',
    aliases: ['agent', '智能体', 'multi-agent', 'autonomous agent'],
    category: 'agent',
    parent_skill: '',
    sub_skills: [],
  },
  {
    skill_id: 'pm',
    standard_name: '产品经理',
    aliases: ['产品经理', '需求分析', 'prd'],
    category: 'pm',
    parent_skill: '',
    sub_skills: ['面试'],
  },
  {
    skill_id: 'pm_interview',
    standard_name: '面试',
    aliases: ['面试', '面试题', '高频100题'],
    category: 'pm',
    parent_skill: '产品经理',
    sub_skills: [],
  },
];

const SKILL_ALIAS_INDEX = SKILL_DICTIONARY.flatMap((item) =>
  [item.standard_name, ...(item.aliases || [])].map((alias) => ({
    alias: String(alias || '').toLowerCase(),
    standard_name: item.standard_name,
    category: item.category,
  }))
);

function normalizeSkillName(skill = '') {
  const target = String(skill || '').trim().toLowerCase();
  if (!target) return '';
  const hit = SKILL_ALIAS_INDEX.find((item) => item.alias === target);
  return hit ? hit.standard_name : String(skill || '').trim();
}

function getSkillAliases(skill = '') {
  const normalized = normalizeSkillName(skill);
  const item = SKILL_DICTIONARY.find((entry) => entry.standard_name === normalized);
  return item ? uniqueList([item.standard_name, ...(item.aliases || [])]) : uniqueList([normalized]);
}

function canonicalizeSkills(skills = []) {
  const normalized = [];
  for (const skill of skills || []) {
    const name = normalizeSkillName(skill);
    const item = SKILL_DICTIONARY.find((entry) => entry.standard_name === name);
    if (item) normalized.push(item.standard_name);
  }
  return uniqueList(normalized);
}

function inferCategory(relativePath = '', title = '', content = '') {
  const text = `${relativePath}\n${title}\n${content.slice(0, 2000)}`.toLowerCase();
  for (const item of SKILL_DICTIONARY) {
    for (const alias of [item.standard_name, ...(item.aliases || [])]) {
      const escaped = String(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(escaped, 'i').test(text)) return item.category;
    }
  }
  return 'general';
}

function inferLevel(title = '', content = '') {
  const text = `${title}\n${content.slice(0, 2000)}`;
  if (/(入门|基础|新手|快速入门|必看|指南)/i.test(text)) return 'beginner';
  if (/(进阶|实战|系统|中级|intermediate)/i.test(text)) return 'intermediate';
  if (/(高级|专家|源码|论文|架构设计|分布式|强化学习)/i.test(text)) return 'advanced';
  return 'intermediate';
}

function inferSkills(relativePath = '', title = '', content = '') {
  const text = `${relativePath}\n${title}\n${content.slice(0, 4000)}`;
  const skills = [];
  for (const item of SKILL_DICTIONARY) {
    const aliases = [item.standard_name, ...(item.aliases || [])];
    for (const alias of aliases) {
      const re = new RegExp(String(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (re.test(text)) {
        skills.push(item.standard_name);
        break;
      }
    }
  }
  return canonicalizeSkills(skills);
}

// 去除章节标题行尾的页码 / 省略号 / 点列等目录噪声尾缀
function stripChapterTrailer(line) {
  return line
    .replace(/[·•●]+/g, ' ') // 目录中点列
    .replace(/\.{2,}/g, ' ') // 省略号（2+ 个点）
    .replace(/…{1,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—]\s*\d{1,4}\s*$/, '') // 页码区间尾缀
    .replace(/\s*\d{1,4}\s*$/, '') // 行尾单个页码（页眉/目录页码）
    .replace(/[、，,；;：:.]\s*$/, '') // 行尾顿号/逗号/句点等残留
    .replace(/\s\.\s*$/, '') // 行尾孤立的 " ."
    .replace(/\.$/, '') // 行尾孤立点
    .trim();
}

// 判断一行是否为「目录页 / 页眉 / OCR 噪声」（OCR 扫描书常见）：
//   - 一行内罗列多个章节（"第1章…、第4章…"）
//   - 行尾带页码（"…145" / "… 225"）或页码区间、省略号
//   - 长度过长（正常章节标题 ≤ ~40 字，目录整行可达数百字甚至上千字）
//   - "第X章" 后面紧跟大段正文（被 OCR 粘成一行）
//   - 孤立的页码 / 目录编号 / "目录" 字样
function isChapterNoise(line) {
  if (line.length > 36) return true; // 正常章节标题极短，超长即噪声（目录整行/正文混入）
  if ((line.match(/第.{1,12}[章节篇讲]/g) || []).length >= 2) return true; // 一行出现多个章节
  if (/[、，,]\s*第.{1,12}[章节篇]/.test(line)) return true; // 一行罗列多个章节
  if (/……|\.\.\.|[、，,；;]\s*\d+\s*$/.test(line)) return true; // 行尾页码/省略号
  if (/\d+\s*[-–—]\s*\d+/.test(line)) return true; // 页码区间
  if (/\s\d{1,4}\s*$/.test(line)) return true; // 行尾单个页码（页眉重复打印）
  if (/^(目录|contents?)$/i.test(line)) return true;
  if (/^[\dIVX.\-–—\s]{1,12}$/.test(line)) return true; // 孤立页码/目录编号
  if (/[?？]|https?:\/\/|www\./i.test(line)) return true; // 链接或问句，非章节
  // "第X章" 后面紧跟超过 12 个非标点字符：几乎可以肯定是「章节标题 + 正文」被 OCR / 排版粘成一行
  const m = line.match(/第.{1,12}[章节篇讲][:：\s]*(.*)$/);
  if (m && m[1] && m[1].replace(/[\s，。、；：,.!?！？"'""''（）()【】\[\]]/g, '').length > 12) return true;
  // 明确的正文开头动词/连词：出现即说明这一行是正文段落，而非章节标题
  if (/第.{1,12}[章节篇讲][:：\s]*.*(解释|介绍|阐述|探讨|讲述|主要|基于|通过|我们|模型|该模型|其|如何|本书|本章|下面|首先|例如|包括|从较高|概述|探素|讨论)/.test(line)) return true;
  return false;
}

function looksLikeChapterCandidate(line) {
  return /^第[一二三四五六七八九十百千万0-9]{1,6}[章节篇讲][:：\s]*/.test(line) || /^chapter\s+[0-9ivx]+/i.test(line);
}

// 是否目录页：目录页的典型特征是「章节名 + 点列/省略号 + 页码」，或大量短章节条目罗列。
// 注意：正文章节开头常形如「第5章 使用Transformer处理下游NLP任务 87」（完整长标题 + 末尾页码），
//       这不应被误判为目录页，否则整本文档的 chapter 都会被清空。
function looksLikeTocPage(lines) {
  let candidate = 0;
  let tocStyle = 0; // 符合「目录条目样式」的行数
  for (const ln of lines) {
    if (looksLikeChapterCandidate(ln)) candidate += 1;
    // 真正的目录条目：章节名与页码间有点列/省略号，或整行很短（标题部分 < 14 字符）
    const hasDotLeader = /[·•]\s*\d{1,4}\s*$|[.．。]{2,}\s*\d{1,4}\s*$/.test(ln);
    const titlePart = ln.replace(/第.{1,12}[章节篇讲][:：\s]*/, '').replace(/\s*\d{1,4}\s*$/, '').trim();
    const isShortEntry = titlePart.length > 0 && titlePart.length < 14;
    if (hasDotLeader || isShortEntry) tocStyle += 1;
  }
  // 出现 ≥3 个目录样式条目，才判定为目录页（避免把正文章节开头误杀）
  return candidate >= 2 && tocStyle >= 3;
}

function inferChapter(content = '') {
  const CHAPTER_MAX = 30; // 章节标题硬上限，超过一律视为噪声
  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(0, 30);
  if (lines.length === 0) return '';
  // 目录页：宁可 chapter 为空，也不要保存错误章节
  if (looksLikeTocPage(lines)) return '';
  for (const line of lines) {
    if (!looksLikeChapterCandidate(line)) continue;
    if (isChapterNoise(line)) return '';
    const clean = stripChapterTrailer(line).replace(/第[一二三四五六七八九十百千万0-9]{1,6}[章节篇讲][:：\s]*/, (h) => h.trim());
    const candidate = clean.replace(/[·•●]/g, '').trim();
    if (candidate.length < 2 || candidate.length > CHAPTER_MAX) return ''; // 超长章节名直接丢弃
    if (/[、，,；;]/.test(candidate)) return ''; // 含列表/顿号，非单一章节名
    if (isChapterNoise(candidate)) return ''; // 二次校验
    return candidate.slice(0, CHAPTER_MAX);
  }
  return '';
}

function buildChunkMetadata({ relativePath = '', title = '', fileName = '', ext = '', baseMeta = {}, content = '' } = {}) {
  const chapter = baseMeta.chapter || inferChapter(content);
  const category = baseMeta.category || inferCategory(relativePath, title, content);
  const level = baseMeta.level || inferLevel(title, content);
  const skills = canonicalizeSkills([...(baseMeta.skills || []), ...inferSkills(relativePath, title, content)]);
  return {
    ...baseMeta,
    file: baseMeta.file || fileName || path.basename(relativePath || title || ''),
    fileName: fileName || baseMeta.fileName || '',
    relativePath,
    category,
    level,
    skills,
    chapter,
  };
}

export function getFirstChunkMeta(docId) {
  try {
    const row = callRagSqlite('get_first_chunk_meta', { doc_id: docId }, { sync: true });
    return parseMeta(row?.meta);
  } catch {
    return {};
  }
}

// 按 docId 精确取回该文档全部 chunk（用于学习笔记生成：只取当天所学 PDF，不发送整本）
export function getChunksByDocId(docId) {
  if (!docId) return [];
  try {
    const rows = callRagSqlite('get_chunks', { doc_id: docId }, { sync: true }) || [];
    return rows.map((r) => ({
      content: r.content || '',
      meta: parseMeta(r.meta),
    }));
  } catch {
    return [];
  }
}

export async function ingestDocument({ docId, source, title, content, ref, meta, force = false }) {
  const exist = callRagSqlite('doc_exists', { doc_id: docId }, { sync: true });
  if (exist?.exists && !force) return { docId, skipped: true, chunks: 0 };

  const chunks = chunkText(content);
  if (!chunks.length) return { docId, chunks: 0, skipped: false };
  const embeddings = await embedTexts(chunks);
  const baseMeta = buildChunkMetadata({
    relativePath: ref || meta?.relativePath || '',
    title,
    fileName: meta?.fileName || path.basename(ref || ''),
    ext: meta?.ext || path.extname(ref || '').toLowerCase(),
    baseMeta: meta || {},
    content,
  });

  await callRagSqlite('replace_document', {
    doc_id: docId,
    source,
    title: title || '',
    ref: ref || '',
    chunk_count: chunks.length,
    created_at: Date.now(),
    chunks: chunks.map((c, i) => ({
      content: c,
      embedding: JSON.stringify(embeddings[i]),
      meta: JSON.stringify({
        ...buildChunkMetadata({
          relativePath: ref || baseMeta.relativePath || '',
          title,
          fileName: baseMeta.fileName || path.basename(ref || ''),
          ext: baseMeta.ext || path.extname(ref || '').toLowerCase(),
          baseMeta,
          content: c,
        }),
        chunkIndex: i,
      }),
    })),
  }, { timeout: 300000 });
  return { docId, chunks: chunks.length };
}

export function listDocs() {
  const docs = callRagSqlite('list_docs', {}, { sync: true }) || [];
  return docs.map((doc) => {
    const meta = getFirstChunkMeta(doc.doc_id);
    return {
      ...doc,
      meta,
      status: meta.status || 'indexed',
      fileHash: meta.fileHash || '',
      relativePath: meta.relativePath || '',
    };
  });
}

export function deleteDoc(docId) {
  return callRagSqlite('delete_doc', { doc_id: docId }, { sync: true });
}

export function clearSource(source) {
  return callRagSqlite('clear_source', { source }, { sync: true });
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function stableDocId(relativePath) {
  return 'file:' + createHash('sha1').update(relativePath.replace(/\\/g, '/')).digest('hex');
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function loadDeferredFailures(projectRoot) {
  const counts = new Map();
  const logPath = path.join(projectRoot, 'import_all.log');
  if (!fs.existsSync(logPath)) return counts;
  try {
    const txt = fs.readFileSync(logPath, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      if (!line.startsWith('FAILED [')) continue;
      try {
        const arr = JSON.parse(line.slice('FAILED '.length));
        for (const item of arr) {
          if (!item?.file) continue;
          counts.set(item.file, (counts.get(item.file) || 0) + 1);
        }
      } catch {
        // ignore multiline/partial entries
      }
    }
  } catch {
    // ignore log parse errors
  }
  return counts;
}

function loadDeferredSet(projectRoot) {
  const deferred = new Set();
  const logPath = path.join(projectRoot, 'import_all.log');
  if (!fs.existsSync(logPath)) return deferred;
  try {
    const txt = fs.readFileSync(logPath, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      if (!line.startsWith('DEFERRED ')) continue;
      try {
        const arr = JSON.parse(line.slice('DEFERRED '.length));
        for (const item of arr) {
          if (item?.file) deferred.add(item.file);
        }
      } catch {}
    }
  } catch {}
  return deferred;
}

function shouldDeferFile(relativePath, errorMessage, previousFailures) {
  const message = String(errorMessage || '');
  const failCount = previousFailures.get(relativePath) || 0;
  const looksCorrupt =
    /timeout|超时|mojibake|low quality|quality|乱码|replacement|Unexpected HF embedding|FileNotFoundError|Maximum call stack/i.test(message);
  return looksCorrupt || failCount >= 2;
}

function xmlUnescape(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractZipEntry(buffer, entryName) {
  let offset = 0;
  const target = entryName.replace(/\\/g, '/');
  while (offset < buffer.length - 30) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.slice(nameStart, nameStart + fileNameLength).toString('utf8');
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (name === target) {
      const data = buffer.slice(dataStart, dataEnd);
      if (method === 0) return data.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
      throw new Error(`DOCX 鍘嬬缉鏂瑰紡涓嶆敮鎸侊細${method}`);
    }
    offset = dataEnd;
  }
  return '';
}

function extractDocxText(buffer) {
  const xml = extractZipEntry(buffer, 'word/document.xml');
  if (!xml) throw new Error('DOCX 涓湭鎵惧埌 word/document.xml');
  return normalizeText(
    xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map((line) => xmlUnescape(line).trim())
      .filter(Boolean)
      .join('\n')
  );
}

function extractZipTexts(buffer) {
  const out = [];
  let offset = 0;
  const entries = [];
  while (offset < buffer.length - 30) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.slice(nameStart, nameStart + fileNameLength).toString('utf8');
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    entries.push({ name: name.replace(/\\/g, '/'), method, data: buffer.slice(dataStart, dataEnd) });
    offset = dataEnd;
  }
  for (const e of entries) {
    let data;
    if (e.method === 0) data = e.data;
    else if (e.method === 8) {
      try {
        data = zlib.inflateRawSync(e.data);
      } catch {
        continue;
      }
    } else continue;
    out.push({ name: e.name, text: data.toString('utf8') });
  }
  return out;
}

function extractPptxText(buffer) {
  const zip = extractZipTexts(buffer);
  const slideXmls = zip
    .filter((z) => /^ppt\/slides\/slide\d+\.xml$/i.test(z.name))
    .sort((a, b) => {
      const na = Number((a.name.match(/\d+/) || [0])[0]);
      const nb = Number((b.name.match(/\d+/) || [0])[0]);
      return na - nb;
    });
  const texts = [];
  for (const s of slideXmls) {
    const t = String(s.text || '')
      .replace(/<a:t[^>]*>/g, '\n')
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map((x) => xmlUnescape(x).trim())
      .filter(Boolean);
    if (t.length) texts.push(t.join(' '));
  }
  return normalizeText(texts.join('\n\n'));
}

function execFilePromise(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: opts.timeout || 45000, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || '').trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

async function extractPdfText(filePath) {
  const script = [
    'import sys, io',
    'sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")',
    'path=sys.argv[1]',
    'text=""',
    'try:',
    ' import pdfplumber',
    ' with pdfplumber.open(path) as pdf:',
    '  text="\\n".join([(p.extract_text() or "") for p in pdf.pages])',
    'except Exception:',
    ' try:',
    '  from pypdf import PdfReader',
    '  r=PdfReader(path)',
    '  text="\\n".join([(p.extract_text() or "") for p in r.pages])',
    ' except Exception as e:',
    '  raise SystemExit(str(e))',
    'sys.stdout.write(text)',
  ].join('\n');
  try {
    return normalizeText(await execFilePromise('python', ['-c', script, filePath]));
  } catch (e1) {
    try {
      return normalizeText(await execFilePromise('python3', ['-c', script, filePath]));
    } catch {
      const fallback = extractPdfTextFallback(fs.readFileSync(filePath));
      if (fallback) return fallback;
      throw new Error(`PDF 瑙ｆ瀽澶辫触锛氶渶瑕佸畨瑁?pdfplumber 鎴?pypdf锛涘師濮嬮敊璇細${e1.message}`);
    }
  }
}

function decodePdfString(value) {
  let s = String(value || '');
  if (s.startsWith('<') && s.endsWith('>')) {
    const hex = s.slice(1, -1).replace(/\s+/g, '');
    try {
      return Buffer.from(hex, 'hex').toString('utf8');
    } catch {
      return '';
    }
  }
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\[0-7]{1,3}/g, ' ');
}

function extractPdfTextFallback(buffer) {
  const raw = buffer.toString('latin1');
  const streamRe = /<<(?:.|\n|\r)*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const parts = [];
  let match;
  while ((match = streamRe.exec(raw))) {
    const objectText = match[0].slice(0, Math.min(1000, match[0].indexOf('stream')));
    let data = Buffer.from(match[1], 'latin1');
    if (/FlateDecode/.test(objectText)) {
      try {
        data = zlib.inflateSync(data);
      } catch {
        continue;
      }
    }
    const text = data.toString('latin1');
    const tokens = [];
    const tokenRe = /(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>)\s*Tj|\[(.*?)\]\s*TJ/gs;
    let token;
    while ((token = tokenRe.exec(text))) {
      if (token[1]) {
        tokens.push(decodePdfString(token[1]));
      } else if (token[2]) {
        const innerRe = /\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>/g;
        const arr = token[2].match(innerRe) || [];
        tokens.push(arr.map(decodePdfString).join(''));
      }
    }
    if (tokens.length) parts.push(tokens.join(' '));
  }
  const text = normalizeText(parts.join('\n'));
  return isLowQualityText(text) ? '' : text;
}

export async function extractFileText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') return decodeTextBuffer(buffer);
  if (ext === '.docx') return extractDocxText(buffer);
  if (ext === '.pptx') return extractPptxText(buffer);
  if (ext === '.pdf') return extractPdfText(filePath);
  throw new Error(`鏆備笉鏀寔鐨勬枃浠剁被鍨嬶細${ext || '(鏃犳墿灞曞悕)'}`);
}

export async function importRagSources({ sourceDir = DEFAULT_SOURCE_DIR, force = false, onProgress = null, maxFiles = Infinity, skipIndexed = true, onlyFiles = null } = {}) {
  const root = path.resolve(sourceDir || DEFAULT_SOURCE_DIR);
  if (!root.startsWith(PROJECT_ROOT)) {
    throw new Error('鍙兘瀵煎叆椤圭洰鐩綍鍐呯殑 rag_sources 璧勬枡');
  }
  if (!fs.existsSync(root)) {
    return { ok: true, sourceDir: root, total: 0, success: 0, skipped: 0, failed: 0, items: [] };
  }

  let files = walkFiles(root).filter((file) => SUPPORTED_EXTS.has(path.extname(file).toLowerCase()));

  // 锘烘湰淇锛氭寜鐩稿璺緞鍏抽敭瀛楁敼瀛樺崟涓笂浼犳枃浠讹纴閬垮厤鍏ㄩ噺閲嶈窇
  if (onlyFiles && Array.isArray(onlyFiles) && onlyFiles.length) {
    const kws = onlyFiles.map((k) => String(k));
    files = files.filter((file) => {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      return kws.some((k) => rel.includes(k) || file.includes(k));
    });
  }

  // 鎻愰€燂細璺宠繃宸叉垚鍔熷叆搴撶殑鏂囦欢锛岄伩鍏嶉噸澶嶈鍙?璁＄畻hash/鍔犺浇妯″瀷
  if (skipIndexed && !force) {
    const indexed = new Set();
    try {
      const all = listDocs();
      for (const d of all) {
        const m = getFirstChunkMeta(d.doc_id);
        if (m && m.relativePath) indexed.add(m.relativePath);
      }
    } catch {}
    if (indexed.size) {
      files = files.filter((file) => {
        const rel = path.relative(root, file).replace(/\\/g, '/');
        return !indexed.has(rel);
      });
    }
  }

  const deferredFailures = loadDeferredFailures(PROJECT_ROOT);
  const deferredSet = force ? new Set() : loadDeferredSet(PROJECT_ROOT);
  const activeFiles = [];
  const parkedFiles = [];
  for (const filePath of files) {
    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    if (deferredSet.has(rel)) parkedFiles.push(filePath);
    else activeFiles.push(filePath);
  }
  files = [...activeFiles, ...parkedFiles];
  files.sort((a, b) => {
    const relA = path.relative(root, a).replace(/\\/g, '/');
    const relB = path.relative(root, b).replace(/\\/g, '/');
    const failA = deferredFailures.get(relA) || 0;
    const failB = deferredFailures.get(relB) || 0;
    if (failA !== failB) return failA - failB;
    return relA.localeCompare(relB, 'zh-CN');
  });

  const items = [];
  const deferredItems = [];
  let success = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  for (const filePath of files) {
    const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
    const docId = stableDocId(relativePath);
    const title = path.basename(filePath, path.extname(filePath));
    if (onProgress) onProgress({ file: relativePath, phase: 'start' });
    try {
      const buffer = fs.readFileSync(filePath);
      const fileHash = hashBuffer(buffer);
      const previousMeta = getFirstChunkMeta(docId);
      if (!force && previousMeta.fileHash === fileHash) {
        skipped += 1;
        items.push({ file: relativePath, docId, status: 'skipped', reason: 'unchanged' });
        if (onProgress) onProgress({ file: relativePath, phase: 'skip' });
        continue;
      }

      // 鍗曟枃浠惰秴鏃剁啍鏂細閬垮厤瓒呭ぇ/寮傚父 PDF 鍗℃鏁存壒
      const withTimeout = (p, ms, label) =>
        Promise.race([
          p,
          new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 瓒呮椂(' + ms + 'ms)')), ms)),
        ]);

      const content = await withTimeout(extractFileText(filePath), EXTRACT_TIMEOUT_MS, '鏂囨湰鎻愬彇');
      if (!content || content.length < 20) throw new Error('鏈彁鍙栧埌瓒冲鏂囨湰鍐呭');
      const result = await withTimeout(
        ingestDocument({
          docId,
          source: 'file',
          title,
          content,
          ref: relativePath,
          force: true,
          meta: {
            status: 'indexed',
            sourceType: 'rag_sources',
            fileHash,
            fileName: path.basename(filePath),
            relativePath,
            ext: path.extname(filePath).toLowerCase(),
            indexedAt: Date.now(),
          },
        }),
        INGEST_TIMEOUT_MS,
        '向量化入库'
      );
      success += 1;
      items.push({ file: relativePath, docId, status: previousMeta.fileHash ? 'reindexed' : 'indexed', chunks: result.chunks });
      if (onProgress) onProgress({ file: relativePath, phase: 'ok', chunks: result.chunks });
    } catch (e) {
      if (!force && shouldDeferFile(relativePath, e?.message, deferredFailures)) {
        skipped += 1;
        const item = { file: relativePath, docId, status: 'deferred', error: e.message };
        deferredItems.push(item);
        items.push(item);
        if (onProgress) onProgress({ file: relativePath, phase: 'deferred', error: e.message });
      } else {
        failed += 1;
        items.push({ file: relativePath, docId, status: 'failed', error: e.message });
        if (onProgress) onProgress({ file: relativePath, phase: 'fail', error: e.message });
      }
    }
    processed += 1;
    if (processed >= maxFiles) {
      items.push({ file: '(batch limit reached)', docId: '', status: 'batch-stop' });
      break;
    }
  }

  return { ok: true, sourceDir: root, total: files.length, success, skipped, failed, deferred: deferredItems.length, items };
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

// 历史入库数据的 rag_chunks.title 多为 NULL，导致前端无法显示资料出处。
// 这里按 title -> meta.title -> meta.file/fileName -> relativePath 文件名 逐级兜底，并去掉扩展名。
function resolveTitle(rawTitle, meta = {}) {
  const direct = (rawTitle || meta.title || '').trim();
  if (direct) return direct;
  const fromFile = (meta.file || meta.fileName || '').trim();
  const base = fromFile || path.basename((meta.relativePath || meta.ref || '').trim());
  if (!base) return '';
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

export async function retrieve(query, { topK = 6, source = null, job = null } = {}) {
  if (!query || !query.trim()) return [];
  const qEmb = (await embedTexts([query]))[0];
  // 把查询向量传给 Python 侧，由它在库内计算余弦相似度并返回 topK，避免全量回传导致缓冲区溢出
  const rows = await callRagSqlite('get_chunks', { source, job: job || undefined, query_embedding: qEmb, top_k: Math.max(1, Math.min(40, Number(topK) || 6)) }, { timeout: 180000 });
  if (!rows || !rows.length) return [];
  return rows
    .map((r) => {
      const meta = parseMeta(r.meta);
      return {
        id: r.id,
        docId: r.doc_id,
        source: r.source,
        title: resolveTitle(r.title, meta),
        content: r.content,
        meta,
        score: typeof r.score === 'number' ? r.score : 0,
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, Math.min(20, Number(topK) || 6)));
}

// 面经检索：默认按"高频面试题"做向量检索，不限定具体公司/几面。
// 仅当明确传入 company/role/round 时才做精确元数据过滤；否则纯向量相似度（通用高频题）。
export async function retrieveInterview({ company, role, round, query, topK = 8 } = {}) {
  const useQuery = query && String(query).trim();
  const payload = {
    source: 'interview',
    top_k: Math.max(1, Math.min(40, Number(topK) || 8)),
  };
  // 仅在都明确传入时才作为精确过滤条件传入，避免把通用高频题过滤掉
  if (company) payload.company = company;
  if (role) payload.role = role;
  if (round) payload.round = round;
  if (useQuery) {
    payload.query_embedding = (await embedTexts([String(query)]))[0];
  }
  const rows = await callRagSqlite('get_chunks', payload, { timeout: 180000 });
  if (!rows || !rows.length) return [];
  return rows
    .map((r) => {
      const meta = parseMeta(r.meta);
      return {
        id: r.id,
        docId: r.doc_id,
        source: r.source,
        title: resolveTitle(r.title, meta),
        content: r.content,
        meta,
        score: typeof r.score === 'number' ? r.score : 0,
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, Math.min(20, Number(topK) || 8)));
}

export async function retrieveWithFilters(query, { topK = 6, source = null, skill = '', level = '', category = '' } = {}) {
  if (!query || !query.trim()) return [];
  const qEmb = (await embedTexts([query]))[0];
  const normalizedSkill = normalizeSkillName(skill);
  // 类目仅在「调用方明确指定 category」或「能由 skill 精确映射」时才用于硬过滤。
  // 未指定技能时不要用 inferCategory 的兜底值（'general'）过滤，否则会把全库滤空。
  let inferredCategory = category || '';
  if (!inferredCategory && normalizedSkill) {
    inferredCategory =
      SKILL_DICTIONARY.find((item) => item.standard_name === normalizedSkill)?.category ||
      inferCategory(normalizedSkill, normalizedSkill, normalizedSkill);
  }
  if (inferredCategory === 'general') inferredCategory = '';
  const rows = await callRagSqlite('get_chunks', {
    source,
    query_embedding: qEmb,
    top_k: Math.max(20, Math.min(200, (Number(topK) || 6) * 12)),
    category: inferredCategory,
  }, { timeout: 180000 });
  if (!rows || !rows.length) return [];
  return rows.map((r) => {
    const meta = parseMeta(r.meta);
    let finalScore = typeof r.score === 'number' ? r.score : 0;
    if (normalizedSkill && (meta.skills || []).includes(normalizedSkill)) finalScore += 0.25;
    if (inferredCategory && meta.category === inferredCategory) finalScore += 0.12;
    if (level) {
      if (meta.level === level) finalScore += 0.08;
      else if (level === 'intermediate' && meta.level === 'beginner') finalScore += 0.03;
    }
    return {
      id: r.id,
      docId: r.doc_id,
      source: r.source,
      title: resolveTitle(r.title, meta),
      content: r.content,
      meta,
      // file 保留扩展名，前端据此判断是 PDF 还是 MD
      file: meta.file || meta.fileName || path.basename(meta.relativePath || meta.ref || '') || r.title || '',
      chapter: meta.chapter || '',
      score: finalScore,
    };
  }).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(20, Number(topK) || 6)));
}

export async function backfillChunkMetadata({ limit = Infinity } = {}) {
  let offset = 0;
  const batchSize = 200;
  let touched = 0;
  let updated = 0;
  while (touched < limit) {
    const rows = await callRagSqlite('list_chunk_rows', {
      limit: Math.min(batchSize, Math.max(1, limit - touched)),
      offset,
    }, { timeout: 180000 });
    if (!rows || !rows.length) break;
    const updates = {};
    for (const row of rows) {
      const meta = parseMeta(row.meta);
      const nextMeta = buildChunkMetadata({
        relativePath: meta.relativePath || '',
        title: row.title || '',
        fileName: meta.fileName || meta.file || path.basename(meta.relativePath || row.title || ''),
        ext: meta.ext || path.extname(meta.relativePath || '').toLowerCase(),
        baseMeta: meta,
        content: row.content || '',
      });
      const changed =
        JSON.stringify(uniqueList(meta.skills || [])) !== JSON.stringify(nextMeta.skills || []) ||
        (meta.category || '') !== (nextMeta.category || '') ||
        (meta.level || '') !== (nextMeta.level || '') ||
        (meta.chapter || '') !== (nextMeta.chapter || '') ||
        (meta.file || '') !== (nextMeta.file || '');
      if (!changed) continue;
      updates[row.id] = nextMeta;
    }
    if (Object.keys(updates).length) {
      const result = await callRagSqlite('update_chunk_meta', { updates }, { timeout: 300000 });
      updated += Number(result?.updated || 0);
    }
    touched += rows.length;
    offset += rows.length;
  }
  return { ok: true, updated, scanned: touched };
}

export async function getSkillStats() {
  let offset = 0;
  const batchSize = 500;
  const skills = new Map();
  const categories = new Map();
  const levels = new Map();
  while (true) {
    const rows = await callRagSqlite('list_chunk_rows', { limit: batchSize, offset }, { timeout: 180000 });
    if (!rows || !rows.length) break;
    for (const row of rows) {
      const meta = parseMeta(row.meta);
      for (const skill of meta.skills || []) {
        skills.set(skill, (skills.get(skill) || 0) + 1);
      }
      const category = meta.category || 'unknown';
      categories.set(category, (categories.get(category) || 0) + 1);
      const level = meta.level || 'unknown';
      levels.set(level, (levels.get(level) || 0) + 1);
    }
    offset += rows.length;
  }
  return {
    dictionary: SKILL_DICTIONARY,
    skills: [...skills.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    categories: [...categories.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    levels: [...levels.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
  };
}
