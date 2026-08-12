// Boss 直聘接入：通过 mcp-jobs（MCP Server）真实爬取 Boss 直聘岗位，
// 解析岗位摘要并从真实语料中提炼“目标岗位的学习要求/技能”。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(__dirname, '../node_modules/mcp-jobs/dist/mcp.js');

// 读取项目根目录 .env（若存在），注入环境变量，避免硬编码密钥
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
  } catch { /* 忽略解析错误 */ }
}
loadDotEnv();

const CACHE_TTL = 60 * 60 * 1000; // 1 小时缓存，避免频繁爬取 Boss
const cache = new Map();           // key -> { ts, data }
const inflight = new Map();        // key -> Promise（防止并发重复爬取）
const TARGET_REAL_SAMPLE_COUNT = 5;
const MAX_SEARCH_PAGES = 1;
const BOSS_JOBLIST_API = 'https://www.zhipin.com/wapi/zpgeek/search/joblist.json';
const BOSS_DEFAULT_CITY_CODE = '100010000';

let clientPromise = null;
async function getClient() {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [ENTRY],
      env: { ...process.env, CRAWLER_HEADLESS: 'true' },
    });
    const client = new Client(
      { name: 'offerdao-boss', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    return client;
  })();
  // 若启动失败，清空以便下次重试
  clientPromise.catch(() => { clientPromise = null; });
  return clientPromise;
}

async function searchRaw(keyword, city, page = 1, workYear) {
  let client;
  try {
    client = await getClient();
  } catch (e) {
    clientPromise = null;
    throw new Error('Boss MCP 启动失败: ' + e.message);
  }
  const args = { keyword, city: city || '全国', page };
  // workYear 透传给 mcp-jobs（映射到 Boss 经验筛选：应届生 e_102 / 实习生 e_108 / 1年以下 e_103）
  if (workYear) args.workYear = workYear;
  const res = await client.callTool({
    name: 'mcp_search_job',
    arguments: args,
  });
  const text = res?.content?.[0]?.text || '{}';
  let data;
  try { data = JSON.parse(text); } catch {
    return [];
  }
  const items = Array.isArray(data.jobs) ? data.jobs : [];
  // mcp-jobs 每条岗位是 { content: "..." } 对象，提取文本后再解析
  return items.map((it) => (typeof it === 'string' ? it : it?.content)).filter(Boolean);
}

function normalizeBossCookie(cookie) {
  return typeof cookie === 'string' ? cookie.trim() : '';
}

function hasBossCookie(cookie) {
  return /(?:__zp_stoken__|wt2|wbg|zp_token)/i.test(normalizeBossCookie(cookie));
}

function resolveBossCityCode(city) {
  const raw = String(city || '').trim();
  if (!raw || raw === '全国') return BOSS_DEFAULT_CITY_CODE;
  if (/^\d+$/.test(raw)) return raw;
  return BOSS_DEFAULT_CITY_CODE;
}

function buildLoggedInRaw(job) {
  const title = job.jobName || job.positionName || job.title || '';
  const company = job.brandName || job.companyName || '';
  const city = job.cityName || job.city || '';
  const district = job.areaDistrict || job.district || '';
  const salary = job.salaryDesc || job.salary || '';
  const experience = job.jobExperience || job.experienceName || job.experience || '';
  const education = job.jobDegree || job.degreeName || job.education || '';
  const postTime = job.timeDesc || job.postTime || '';
  return [title, company, city, district, salary, experience, education, postTime].filter(Boolean).join(' | ');
}

function parseLoggedInJob(job) {
  const title = job.jobName || job.positionName || job.title || '';
  if (!title) return null;
  return {
    title,
    company: job.brandName || job.companyName || '',
    city: job.cityName || job.city || '',
    district: job.areaDistrict || job.district || '',
    salary: job.salaryDesc || job.salary || '',
    experience: job.jobExperience || job.experienceName || job.experience || '',
    education: job.jobDegree || job.degreeName || job.education || '',
    postTime: job.timeDesc || job.postTime || '',
    raw: buildLoggedInRaw(job),
  };
}

async function searchRawWithCookie(keyword, city, page = 1, cookie = '') {
  const sessionCookie = normalizeBossCookie(cookie);
  if (!hasBossCookie(sessionCookie)) return [];
  const qs = new URLSearchParams({
    query: keyword,
    city: resolveBossCityCode(city),
    page: String(page),
    pageSize: String(TARGET_REAL_SAMPLE_COUNT),
  });
  const res = await fetch(`${BOSS_JOBLIST_API}?${qs.toString()}`, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Cookie: sessionCookie,
      Referer: `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  if (!res.ok) throw new Error(`Boss 登录接口请求失败 (${res.status})`);
  const data = await res.json().catch(() => ({}));
  const jobs = data?.zpData?.jobList || data?.jobList || [];
  return Array.isArray(jobs) ? jobs.map(parseLoggedInJob).filter(Boolean) : [];
}

// 将 Boss 返回的单行摘要解析为结构化字段
function parseJob(content) {
  if (!content || typeof content !== 'string') return null;
  const result = { raw: content };
  const dashIdx = content.indexOf('—');
  const head = dashIdx >= 0 ? content.slice(0, dashIdx) : content;
  const tail = dashIdx >= 0 ? content.slice(dashIdx + 1) : '';
  result.title = head.trim();

  const cityM = tail.match(/^([^【]+?)(?=【)/);
  if (cityM) result.city = cityM[1].trim();

  const distM = tail.match(/【([^】]+)】/);
  if (distM) result.district = distM[1].trim();

  const salaryM =
    tail.match(/(\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*k)/i) || tail.match(/(\d+\s*k)/i);
  if (salaryM) result.salary = salaryM[1].replace(/\s/g, '');

  const expM = tail.match(/(\d+\s*-\s*\d+\s*年|\d+\s*年)/);
  if (expM) result.experience = expM[1].replace(/\s/g, '');

  const eduM = tail.match(/(博士|硕士|研究生|本科|大专|高中)/);
  if (eduM) result.education = eduM[1];

  const sizeKw =
    /(互联网|已上市|不需要融资|未融资|0-20人|20-99人|100-499人|500-999人|1000-9999人|10000人以上|创业公司|外企|国企|合资|民营|上市公司|独角兽)/;
  if (eduM) {
    const companyChunk = tail.slice(tail.indexOf(eduM[1]) + eduM[1].length);
    const sizeM = companyChunk.match(sizeKw);
    if (sizeM) {
      const comp = companyChunk.slice(0, sizeM.index).replace(/[·•].*$/, '').trim();
      if (comp) result.company = comp;
    }
  }

  const timeM = tail.match(/(\d+\s*天前|\d+\s*小时前|刚刚|今天|昨天)/);
  if (timeM) result.postTime = timeM[1].replace(/\s/g, '');

  return result;
}

// 大厂（大型互联网 / 科技公司）识别：用于「优先参考大厂岗位要求」
// 大厂（互联网头部公司）识别：用于「优先展示 / 参考大厂岗位」。
// 仅匹配互联网中大厂（如腾讯、字节、阿里、百度等），不再以「10000人以上 / 上市公司 / 独角兽」等规模词泛化匹配，
// 以免把制药、化工、银行、地产、教育等非互联网公司误判为大厂。岗位数据均来自真实的 Boss 直聘搜索结果。
const BIG_TECH_NAMES = [
  '字节跳动', '字节', '抖音', 'tiktok', '今日头条', '飞书',
  '腾讯', '微信', 'qq', '腾讯音乐',
  '阿里巴巴', '阿里', '淘宝', '天猫', '蚂蚁', '支付宝', '闲鱼', '钉钉', '阿里云', '饿了么', '优酷',
  '百度',
  '快手',
  '美团', '大众点评',
  '京东', '京东科技',
  '拼多多',
  '网易', '网易云音乐', '有道',
  '滴滴',
  '小米',
  '哔哩哔哩', 'b站',
  '小红书',
  '携程', '去哪儿',
  '搜狐', '新浪', '微博',
  '360', '奇虎',
  '金山', 'wps',
  '爱奇艺',
  '知乎',
  'shein', '得物', '唯品会',
];

function detectBigTech(job) {
  const hay = `${job.company || ''} ${job.raw || ''}`.toLowerCase();
  return BIG_TECH_NAMES.some((n) => hay.includes(n));
}

// 识别校招 / 应届 / 实习岗位：优先采用面向应届生、在校招季开放的岗位
const CAMPUS_NAMES = ['校招', '校园招聘', '校园招', '应届', '应届生', '毕业生', '实习', '实习生', '管培', '管培生', 'training', 'campus', 'graduate', 'intern'];
function detectCampus(job) {
  const hay = `${job.title || ''} ${job.company || ''} ${job.raw || ''}`.toLowerCase();
  return CAMPUS_NAMES.some((n) => hay.includes(n));
}

// 技能分类（用于规则法把高频关键词整合为清晰的技能要求分组，而非孤立标签）
const SKILL_CATEGORIES = {
  '数据分析与数据驱动': ['数据分析', '数据驱动', 'SQL', 'Python', 'Excel', '埋点', '指标体系', '指标', 'A/B测试', 'AB测试', '数据可视化'],
  '产品与用户研究': ['需求分析', '用户研究', '用户画像', '竞品分析', 'PRD', '产品设计', '原型', 'Axure', 'Figma', 'Sketch', '交互设计', '可用性测试', '问卷', '访谈'],
  '增长与商业化': ['增长', '商业化', '变现', '会员', '拉新', '留存', '转化', '私域', '运营'],
  '策略与AI能力': ['策略', '大模型', '人工智能', 'AI', '机器学习', '深度学习', '推荐', '搜索', '广告'],
  '协作与职业素养': ['项目管理', '敏捷', '跨部门协作', '沟通', '文档', '复盘', '迭代'],
  '业务领域知识': ['电商', '交易', '供应链', '风控', 'B端', 'C端', 'SaaS'],
};

// 规则法：把真实岗位语料中的高频关键词整合成一份清晰的技能要求说明（按分类组织）
function buildRuleRequirements(jobs, keyword, opts = {}) {
  const { bigTechCount = 0, campusCount = 0 } = opts;
  const corpus = jobs.map((j) => `${j.title || ''} ${j.raw || ''}`).join(' ');
  const lines = [];
  lines.push(
    `根据 Boss 直聘 ${jobs.length} 个「${keyword}」真实在招岗位` +
      `${campusCount ? `（优先参考 ${campusCount} 个校招/应届岗位）` : ''}` +
      `${bigTechCount ? `（含 ${bigTechCount} 个大厂岗位）` : ''}，` +
      `该目标岗位需要的技能要求如下：\n`
  );
  let any = false;
  for (const [cat, kws] of Object.entries(SKILL_CATEGORIES)) {
    const matched = kws.filter((kw) => {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      return re.test(' ' + corpus + ' ');
    });
    if (matched.length) {
      any = true;
      lines.push(`• ${cat}：${matched.join('、')}`);
    }
  }
  if (!any) {
    lines.push('• 暂未从岗位中提炼出明确的技能关键词，建议结合下方岗位示例中的真实描述进一步了解。');
  }
  return lines.join('\n');
}

// —— 千问（DashScope OpenAI 兼容模式）整合真实岗位，提炼清晰的目标岗位技能要求 ——
const QWEN_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

async function llmSummarize(jobs, keyword, opts = {}) {
  const { bigTechCount = 0, campusCount = 0 } = opts;
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error('未配置 DASHSCOPE_API_KEY，已回退规则法');
  const model = process.env.QWEN_MODEL || 'qwen-plus';
  const corpus = jobs
    .map((j, i) => `${i + 1}.【${j.company || ''}】${j.title || ''} ${(j.raw || '').slice(0, 240)}`)
    .join('\n');

  const sys =
    '你是资深招聘与职业发展分析师。请根据真实招聘摘要，整合提炼目标岗位一份清晰、结构化的“技能要求”文档。' +
    '只输出 JSON，结构为：' +
    '{"requirements":"使用 Markdown 的清晰技能要求说明，按「①核心硬技能 ②产品/业务能力 ③加分项 ④学历与经验要求」等分组，结合真实岗位描述给出具体技能点，不要使用孤立标签","summary":"一句话总结"}。';

  const notes = [];
  if (campusCount > 0) {
    notes.push(`以上岗位已优先取自 Boss 直聘上的校招 / 应届 / 实习岗位（共 ${campusCount} 个），请重点结合面向应届生与校招的要求来组织技能要求，突出校招看重的通用能力与学习潜力。`);
  }
  if (bigTechCount > 0) {
    notes.push(`其中包含 ${bigTechCount} 个大厂（大型互联网 / 科技公司）岗位，请确保要求与市场一线标杆一致。`);
  }
  const noteText = notes.length ? `\n\n补充说明：\n${notes.join('\n')}` : '';

  const user =
    `目标岗位：${keyword}\n共 ${jobs.length} 个真实在招岗位摘要如下：\n${corpus}${noteText}\n\n` +
    `请整合出一份清晰、可直接用于学习规划的目标岗位技能要求文档（不要技能标签，要成段的清晰说明），并给出一句话总结。`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let text;
  try {
    const res = await fetch(QWEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`千问接口 ${res.status}: ${errText.slice(0, 200)}`);
    }
    const json = await res.json();
    text = json?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }

  const m = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m ? m[0] : text);
  const requirements =
    (typeof parsed.requirements === 'string' && parsed.requirements.trim())
      ? parsed.requirements.trim()
      : `根据 Boss 直聘 ${jobs.length} 个「${keyword}」真实岗位，该目标岗位的核心技能要求可归纳为：数据分析与产品方法论、增长与商业化、策略与 AI 能力、协作与职业素养等方向（详见岗位示例）。`;
  const summary =
    parsed.summary ||
    `根据 Boss 直聘 ${jobs.length} 个「${keyword}」真实在招岗位${campusCount ? `（优先参考 ${campusCount} 个校招/应届岗位）` : ''}${bigTechCount ? `（含 ${bigTechCount} 个大厂岗位）` : ''}，已整合出清晰的目标岗位技能要求，建议按此重点学习。`;
  return { requirements, summary };
}

async function buildMarketFallback(keyword) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return {
      requirements: `当前未能通过 Boss 直聘公开页面取得「${keyword}」岗位样本。建议先重点准备：岗位专业知识、数据分析、需求分析、项目推进、跨团队沟通和结构化表达。`,
      summary: 'Boss 直聘公开页面暂时限制访问，当前展示基础准备建议。',
    };
  }
  const res = await fetch(QWEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.QWEN_MODEL || 'qwen-plus',
      messages: [
        {
          role: 'system',
          content: '你是招聘与职业发展分析师。只输出 JSON，格式为 {"requirements":"Markdown 格式的技能要求","summary":"一句话总结"}。不得声称内容来自 Boss 直聘真实岗位；明确标注这是公开招聘市场通用参考。',
        },
        {
          role: 'user',
          content: `由于 Boss 直聘公开页面触发访问限制，暂时没有取得真实岗位样本。请为「${keyword}」整理一份可用于学习计划的公开招聘市场通用技能要求，包含核心硬技能、产品或业务能力、加分项和面试准备重点。`,
        },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`市场要求生成失败 (${res.status})`);
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse((text.match(/\{[\s\S]*\}/) || [text])[0]);
  return {
    requirements: parsed.requirements || '',
    summary: parsed.summary || '当前展示公开招聘市场通用技能参考。',
  };
}

export async function getBossRequirements(keyword, city, opts = {}) {
  const sessionCookie = normalizeBossCookie(opts.cookie || process.env.BOSS_COOKIE || '');
  if (hasBossCookie(sessionCookie)) cache.delete(`${keyword}|${city || '鍏ㄥ浗'}|campus`);
  const key = `${keyword}|${city || '全国'}|campus`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return { ...cached.data, cached: true };
  }
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    if (hasBossCookie(sessionCookie)) {
      try {
        const cookieJobs = await searchRawWithCookie(keyword, city, 1, sessionCookie);
        if (cookieJobs.length > 0) {
          for (const j of cookieJobs) {
            j.isBigTech = detectBigTech(j);
            j.isCampus = detectCampus(j);
          }
          const campusJobs = cookieJobs.filter((j) => j.isCampus);
          const bigTechJobs = cookieJobs.filter((j) => j.isBigTech);
          const derivationJobs = campusJobs.length >= 3 ? campusJobs : cookieJobs;
          let requirements;
          let summary;
          let source = 'boss_cookie';
          try {
            const llm = await llmSummarize(derivationJobs, keyword, {
              bigTechCount: bigTechJobs.length,
              campusCount: campusJobs.length >= 3 ? campusJobs.length : 0,
            });
            requirements = llm.requirements;
            summary = llm.summary;
          } catch {
            requirements = buildRuleRequirements(derivationJobs, keyword, {
              bigTechCount: bigTechJobs.length,
              campusCount: campusJobs.length >= 3 ? campusJobs.length : 0,
            });
            summary = `已基于 Boss 登录态抓取到 ${cookieJobs.length} 个真实岗位，并完成技能要求整合。`;
            source = 'boss_cookie_rule';
          }
          return {
            keyword,
            city: city || '全国',
            searchMode: 'cookie',
            total: cookieJobs.length,
            bigTechCount: bigTechJobs.length,
            campusCount: campusJobs.length,
            jobs: cookieJobs.slice(0, TARGET_REAL_SAMPLE_COUNT),
            requirements,
            summary,
            source,
            warning: '',
            cached: false,
          };
        }
      } catch {
        // 登录态接口失败时继续回落到公开抓取逻辑
      }
    }
    // 在 Boss 直聘按「职位类型(校招) × 经验(应届生) × 行业」搜索真实岗位：
    //  - 职位类型：校招。mcp-jobs 未暴露 jobType 参数，故以「校招」关键词作为真实搜索约束
    //    （Boss 校招岗位标题多含「校招」），仍是 Boss 直聘真实在招结果，不编造。
    //  - 经验：应届生（映射 Boss 经验代码 e_102）。用户明确要求只看应届生，故不再合并实习生 / 1年以下。
    //  - 行业：互联网 / AI。mcp-jobs 未暴露 industry 参数，故以行业关键词作为真实搜索约束。
    // 兼顾召回率：若「校招 × 应届生 × 行业」无结果，依次回退 校招×应届生(裸关键词) → 仅应届生，保证返回真实数据。
    const EXP = '应届生';     // 经验：应届生（Boss 代码 e_102）
    const CAMPUS = '校招';    // 职位类型：校招
    const collect = async (useIndustry, useCampus, workYear = EXP) => {
      const inds = useIndustry ? ['互联网', 'AI'] : [''];
      const seen = new Set();
      const out = [];
      for (const ind of inds) {
        const baseKw = ind ? `${keyword} ${ind}` : keyword;
        const kw = useCampus ? `${baseKw} ${CAMPUS}` : baseKw;
        for (let pg = 1; pg <= MAX_SEARCH_PAGES; pg++) {
          let lines = [];
          try { lines = await searchRaw(kw, city, pg, workYear); } catch { /* ignore */ }
          for (const line of lines) {
            if (line && !seen.has(line)) {
              seen.add(line);
              out.push(line);
              if (out.length >= TARGET_REAL_SAMPLE_COUNT) return out;
            }
          }
        }
      }
      return out;
    };
    let raw = await collect(true, true);
    let searchMode = 'campus_exp_industry';
    if (raw.length === 0) { raw = await collect(false, true); searchMode = 'campus_exp'; }
    if (raw.length === 0) { raw = await collect(false, false); searchMode = 'exp'; }
    // 最终回退必须移除经验筛选。此前这里仍传入“应届生”，导致当前没有
    // 校招/应届岗位时，即使 Boss 上存在大量真实岗位也会错误显示为 0 条。
    if (raw.length === 0) { raw = await collect(false, false, null); searchMode = 'all'; }
    const jobs = raw.map(parseJob).filter(Boolean);
    if (jobs.length === 0) {
      let fallback;
      try {
        fallback = await buildMarketFallback(keyword);
      } catch {
        fallback = {
          requirements: `当前未能通过 Boss 直聘公开页面取得「${keyword}」岗位样本。建议先重点准备：岗位专业知识、数据分析、需求分析、项目推进、跨团队沟通和结构化表达。`,
          summary: 'Boss 直聘公开页面暂时限制访问，当前展示基础准备建议。',
        };
      }
      const empty = {
        keyword,
        city: city || '全国',
        searchMode,
        total: 0,
        bigTechCount: 0,
        campusCount: 0,
        jobs: [],
        requirements: fallback.requirements,
        summary: fallback.summary,
        source: 'market_fallback',
        warning: 'Boss 直聘公开页面触发访问限制，未取得可验证的真实岗位样本；当前内容不是 Boss 真实岗位统计。',
      };
      cache.set(key, { ts: Date.now(), data: empty });
      return { ...empty, cached: false };
    }
    // 标记大厂 / 校招(应届) 岗位；真实岗位示例优先展示互联网大厂，并要求提炼与大厂目标岗位契合
    for (const j of jobs) {
      j.isBigTech = detectBigTech(j);
      j.isCampus = detectCampus(j);
    }
    jobs.sort((a, b) => (b.isBigTech ? 1 : 0) - (a.isBigTech ? 1 : 0) || (b.isCampus ? 1 : 0) - (a.isCampus ? 1 : 0));
    const campusJobs = jobs.filter((j) => j.isCampus);
    const bigTechJobs = jobs.filter((j) => j.isBigTech);
    // 优先依据校招/应届岗位提炼要求；校招样本不足时退回全部岗位
    const hasEnoughCampus = campusJobs.length >= 3;
    const derivationJobs = hasEnoughCampus ? campusJobs : jobs;

    let requirements, summary, source = 'rule';
    try {
      const llm = await llmSummarize(derivationJobs, keyword, {
        bigTechCount: bigTechJobs.length,
        campusCount: hasEnoughCampus ? campusJobs.length : 0,
      });
      requirements = llm.requirements;
      summary = llm.summary;
      source = 'llm';
    } catch (e) {
      // 千问不可用（无 Key / 超时 / 报错）时回退到规则法
      requirements = buildRuleRequirements(derivationJobs, keyword, {
        bigTechCount: bigTechJobs.length,
        campusCount: hasEnoughCampus ? campusJobs.length : 0,
      });
      summary = jobs.length
        ? `根据 Boss 直聘 ${jobs.length} 个「${keyword}」真实在招岗位${hasEnoughCampus ? `（优先参考 ${campusJobs.length} 个校招/应届岗位）` : ''}${bigTechJobs.length ? `（含 ${bigTechJobs.length} 个大厂岗位）` : ''}，已整合出该目标岗位的核心技能要求。建议优先对齐校招与大厂要求。`
        : `暂未在 Boss 直聘找到「${keyword}」相关岗位，可尝试更换关键词或城市后重试。`;
    }
    const data = {
      keyword,
      city: city || '全国',
      searchMode,
      total: jobs.length,
      bigTechCount: bigTechJobs.length,
      campusCount: campusJobs.length,
      jobs,
      requirements,
      summary,
      source,
    };
    cache.set(key, { ts: Date.now(), data });
    return { ...data, cached: false };
  })();

  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}
