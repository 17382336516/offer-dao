import { useState, useMemo, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import SkillTreeMap from './SkillTreeMap';
import { getAiPmSkillTree } from '../lib/api';
import { ExternalLink, Bookmark, Heart, X, ChevronRight, Sparkles, Image, Target, Calendar, CalendarClock, Trash2, Plus, Pencil, Check, RefreshCw, Info, Loader2, PlayCircle, Github } from 'lucide-react';
import { getXhsPostDetail, getXhsPosts, openXhsPost, getIntegratedPlan, getProfile, getSavedIntegratedPlan, saveProfile, saveTargetDate, saveStartDate, generateDailyPlan, deleteIntegratedPlan, saveIntegratedPlan, getBossRequirements, getBossSession, saveBossSession, refreshBossLibrary, getBossLibraryStatus, getXhsQrcode, getXhsStatus, bindXhs } from '../lib/api';
import { parseResourceInfo } from '../lib/resources';

// 学习计划中的 PDF 列表：默认只展示前 3 条，点击「展开」才显示剩余，避免长列表刷屏。
function PdfList({ pdfs }) {
  const [expanded, setExpanded] = useState(false);
  if (!pdfs || pdfs.length === 0) return null;
  const visible = expanded ? pdfs : pdfs.slice(0, 3);
  return (
    <div className="mt-2 space-y-1.5">
      <p className="text-xs text-emerald-700 font-medium">📄 知识库真实 PDF 文档</p>
      {visible.map((p, pi) => (
        <div key={pi} className="flex items-center justify-between gap-3 bg-emerald-50/70 rounded-lg px-3 py-1.5 border border-emerald-100">
          <span className="text-xs text-gray-700 truncate">📘 {p.title}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => window.open(p.link || ('/api/rag/file?docId=' + encodeURIComponent(p.docId)), '_blank')}
              className="text-xs px-2 py-0.5 rounded-button bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
            >
              查看
            </button>
          </div>
        </div>
      ))}
      {pdfs.length > 3 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs px-2.5 py-1 rounded-button bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors"
        >
          {expanded ? '收起 PDF' : `展开剩余 ${pdfs.length - 3} 个 PDF`}
        </button>
      )}
    </div>
  );
}

// 与 Login.jsx 保持一致的岗位方向字典（用于把多选方向 id 映射为中文名，作为搜索关键词）
const PRODUCT_DIRECTIONS = [
  { id: 'c端', name: 'C端产品' },
  { id: 'b端', name: 'B端产品' },
  { id: 'ai', name: 'AI产品' },
  { id: 'data', name: '数据产品' },
  { id: 'strategy', name: '策略产品' },
  { id: 'growth', name: '增长产品' },
];
const directionName = (id) => PRODUCT_DIRECTIONS.find((d) => d.id === id)?.name || id;

const fmtDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 中文短日期：2026-08-11 -> 8月11
const fmtCnDate = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return `${d.getMonth() + 1}月${d.getDate()}`;
};

// 由学习结束日计算学习时长（天）：当前日期到结束日
const computeDaysFromEnd = (dateStr) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(dateStr);
  end.setHours(0, 0, 0, 0);
  return Math.max(1, Math.ceil((end - today) / 86400000));
};

// 由「开始日 + 学习天数」反推结束日（含首尾，days 天 → 开始日 + (days-1)）
const addDays = (dateStr, days) => {
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + Math.max(0, days - 1));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// 小巧的月历：点击具体日期作为学习结束日
function MiniCalendar({ value, onPick }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // 默认视图定位到「已选日期」所在月（若未选则当前月），减少翻页
  const [view, setView] = useState(() => {
    const init = value ? new Date(value) : new Date();
    init.setDate(1);
    return init;
  });
  const y = view.getFullYear();
  const m = view.getMonth();
  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m, d));
  const prevMonth = () => setView(new Date(y, m - 1, 1));
  const nextMonth = () => setView(new Date(y, m + 1, 1));
  return (
    <div className="rounded-xl border border-gray-200 p-3">
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={prevMonth} className="px-2 py-1 text-gray-500 hover:bg-gray-50 rounded transition-colors">‹</button>
        <span className="text-sm font-medium text-gray-700">{y}年{m + 1}月</span>
        <button type="button" onClick={nextMonth} className="px-2 py-1 text-gray-500 hover:bg-gray-50 rounded transition-colors">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-gray-400 mb-1">
        {['日', '一', '二', '三', '四', '五', '六'].map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (!cell) return <div key={i} />;
          const disabled = cell < today;
          const selected = value === fmtDate(cell);
          return (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => onPick(fmtDate(cell))}
              className={`h-8 rounded-lg text-sm transition-colors ${
                disabled
                  ? 'text-gray-300 cursor-not-allowed'
                  : selected
                    ? 'bg-mint text-white'
                    : 'text-gray-700 hover:bg-mint/10'
              }`}
            >
              {cell.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 把后端返回的清晰技能要求（Markdown 文本）渲染成易读的段落/分组，不使用孤立标签
function renderRequirements(text) {
  if (!text) return null;
  return text.split('\n').map((line, idx) => {
    const t = line.trimEnd();
    if (!t) return null;
    if (t.startsWith('## ')) return <h3 key={idx} className="text-base font-bold text-gray-800 mt-4 mb-2">{t.replace('## ', '')}</h3>;
    if (t.startsWith('### ')) return <h4 key={idx} className="text-sm font-semibold text-gray-700 mt-3 mb-1">{t.replace('### ', '')}</h4>;
    if (t.startsWith('• ') || t.startsWith('- ')) return (
      <p key={idx} className="text-sm text-gray-700 leading-relaxed mb-1.5 pl-4 relative">
        <span className="absolute left-1 text-mint">•</span>
        {t.replace(/^[•\-]\s*/, '')}
      </p>
    );
    if (/^[1-9][0-9]?\. /.test(t)) return <p key={idx} className="text-sm text-gray-700 leading-relaxed mb-1.5">{t}</p>;
    if (t.startsWith('**') && t.endsWith('**')) return <p key={idx} className="text-sm font-semibold text-gray-800 mb-1">{t.replace(/\*\*/g, '')}</p>;
    return <p key={idx} className="text-sm text-gray-700 leading-relaxed mb-2">{t}</p>;
  });
}

function PlanBoard() {
  const location = useLocation();
  const stateData = location.state || {};

  const savedJobInfo = useMemo(() => {
    try {
      const saved = localStorage.getItem('offerToJobInfo');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  }, []);

  // 以本地保存的目标岗位 / 目标日期为默认值（不再打开页面自动拉取）
  // 多岗位方向优先：从保存的 directions 推导 jobName，保证「目标学习岗位」与用户选择的目标岗位完全一致
  const initialDirections = savedJobInfo.directions && savedJobInfo.directions.length
    ? savedJobInfo.directions
    : [];
  const initialJobName = initialDirections.length > 1
    ? initialDirections.map(directionName).join('、')
    : (stateData.jobName || savedJobInfo.jobName || '策略产品经理');
  const [jobName, setJobName] = useState(initialJobName);
  const [days, setDays] = useState(stateData.days || savedJobInfo.days || 60);
  const [planCreatedAt, setPlanCreatedAt] = useState(null); // 当前计划创建时间，用于进度条
  const [selectedDirections, setSelectedDirections] = useState(initialDirections); // 后端多选岗位方向

  // 调整计划弹窗相关状态
  const [showAdjust, setShowAdjust] = useState(false);
  const [showStartAdjust, setShowStartAdjust] = useState(false);
  const [showJobConfirm, setShowJobConfirm] = useState(false);
  // 删除学习部分确认弹窗
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingDeleteIdx, setPendingDeleteIdx] = useState(null);
  // 覆盖已有学习计划确认弹窗（数据库已存在保存的计划时，每次点击生成都需二次确认）
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);
  const [pendingOverwriteOpts, setPendingOverwriteOpts] = useState(null);
  // 数据库是否已有保存的学习计划（仅据此决定是否弹「覆盖确认」，与前端是否已渲染无关）
  const [dbHasPlan, setDbHasPlan] = useState(false);

  // 编辑学习部分状态
  const [editingIdx, setEditingIdx] = useState(null);
  const [editDraft, setEditDraft] = useState({ title: '', link: '', content: '' });
  const [draftDirections, setDraftDirections] = useState(() => (selectedDirections && selectedDirections.length ? [selectedDirections[0]] : []));
  const [endDate, setEndDate] = useState(savedJobInfo.targetDate || null);
  const [startDate, setStartDate] = useState(savedJobInfo.startDate || null);
  // 调整计划弹窗内的临时编辑值（点保存才生效，取消则丢弃）
  const [draftEnd, setDraftEnd] = useState(null);
  const [draftStart, setDraftStart] = useState(null);
  const [draftDays, setDraftDays] = useState(null); // 调整计划弹窗内「学习天数」临时值
  // 保存二次确认弹窗
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);

  const [planData, setPlanData] = useState(null);
  // 用户是否已主动点击「生成学习路线」：为 false 时不展示「第 n 部分 + 学习链接」与「小红书参考资料」
  const [hasGenerated, setHasGenerated] = useState(false);

  // Boss 直聘真实技能要求（从首页学习目标页移入学习计划）
  const [bossCity, setBossCity] = useState('');
  const [bossData, setBossData] = useState(null);
  const [bossLoading, setBossLoading] = useState(false);
  const [bossError, setBossError] = useState('');
  const [bossCookieInput, setBossCookieInput] = useState('');
  const [bossSessionBound, setBossSessionBound] = useState(false);
  const [bossSessionSaving, setBossSessionSaving] = useState(false);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [bossLibraryRefreshing, setBossLibraryRefreshing] = useState(false);
  const [bossLibraryMeta, setBossLibraryMeta] = useState(null);

  // 固定能力技能地图（板块 → 技能 → 搜索词），来自 /api/skill-tree
  const [treeData, setTreeData] = useState(null);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState('');

  const fetchBoss = async (city) => {
    setBossLoading(true);
    setBossError('');
    try {
      const data = await getBossRequirements(jobName, city);
      setBossData(data);
    } catch (e) {
      setBossError(e.message || '获取失败');
    } finally {
      setBossLoading(false);
    }
  };

  const loadBossSessionState = async () => {
    try {
      const data = await getBossSession();
      setBossSessionBound(!!data.connected);
    } catch {
      setBossSessionBound(false);
    }
  };

  const loadBossLibraryMeta = async () => {
    try {
      const data = await getBossLibraryStatus();
      setBossLibraryMeta(data);
    } catch {
      setBossLibraryMeta(null);
    }
  };

  const bindBossSession = async () => {
    setBossSessionSaving(true);
    setBossError('');
    try {
      await saveBossSession(bossCookieInput);
      setBossSessionBound(!!bossCookieInput.trim());
      if (bossCookieInput.trim()) {
        await fetchBoss(bossCity.trim() || '全国');
      }
    } catch (e) {
      setBossError(e.message || '绑定失败');
    } finally {
      setBossSessionSaving(false);
    }
  };

  const handleRefreshBossLibrary = async () => {
    setBossLibraryRefreshing(true);
    setBossError('');
    try {
      await refreshBossLibrary();
      await fetchBoss(bossCity.trim() || '全国');
      await loadBossLibraryMeta();
    } catch (e) {
      setBossError(e.message || '刷新失败');
    } finally {
      setBossLibraryRefreshing(false);
    }
  };

  useEffect(() => {
    fetchBoss('全国');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobName]);

  // 挂载即加载固定能力技能地图（板块 → 技能 → 搜索词）
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await getAiPmSkillTree(jobName);
        if (active && data && data.stages) setTreeData(data);
        else if (active) setTreeError('未返回技能树数据');
      } catch (e) {
        if (active) setTreeError(e?.message || '技能树加载失败');
      } finally {
        if (active) setTreeLoading(false);
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobName]);

  // 调整弹窗内单选目标岗位方向（与注册时「选择岗位方向」一致，仅可选 1 个）
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const profile = await getProfile();
        if (!active) return;
        const admin = profile?.role === 'admin';
        setIsAdminUser(admin);
        if (admin) {
          await loadBossSessionState();
          await loadBossLibraryMeta();
        }
      } catch {
        if (active) {
          setIsAdminUser(false);
          setBossSessionBound(false);
          setBossLibraryMeta(null);
        }
      }
    })();
    return () => { active = false; };
  }, []);

  const bossExampleJobs = (bossData?.jobs || []).slice(0, 5);

  const toggleDraftDirection = (id) => {
    // 单选：再次点击已选项则取消，否则替换为新选项
    setDraftDirections((prev) => (prev.includes(id) ? [] : [id]));
  };

  // 修改计划学习天数（仅本地派生展示用；真源永远是 targetDate）
  const updateDays = (next) => {
    const v = Math.max(1, Math.min(365, Math.round(next) || 1));
    setDays(v);
    try {
      const base = JSON.parse(localStorage.getItem('offerToJobInfo') || '{}');
      localStorage.setItem('offerToJobInfo', JSON.stringify({ ...base, days: v }));
    } catch { /* 忽略存储异常 */ }
  };

  // 选择学习结束日：以 targetDate 为唯一真源，写后端 + 同步三处 localStorage，
  // days 自动派生，从而「调整计划 / 注册日历 / 今日计划」三处彻底统一。
  const applyEndDate = async (dateStr) => {
    setEndDate(dateStr);
    try {
      const { days: d } = await saveTargetDate(dateStr);
      setDays(d);
      updateDays(d);
      // 联动：目标日变化后，重新生成每日学习计划（daily_learning_tasks），
      // 后端会按新的 target_date 自动推导天数，无需前端传入。
      // 失败必须明确提示用户，绝不能静默吞掉导致页面显示过时的旧每日计划。
      generateDailyPlan({})
        .then(() => { /* 重算成功，下一轮轮询会刷新今日计划 */ })
        .catch((e) => {
          console.error('每日计划联动重算失败:', e.message);
          setPlanError('每日学习计划重算失败：' + (e.message || '未知错误') + '，请点击重试。');
        });
    } catch (e) {
      console.warn('保存目标日失败（仅本地生效）：', e.message);
      const d = computeDaysFromEnd(dateStr);
      updateDays(d);
    }
    setShowAdjust(false);
  };

  // 选择学习开始日：写后端 profiles.start_date（真源）。
  // 后端会按 start_date 自动计算每条每日任务的真实日期 task_date，并联动重算每日计划。
  const applyStartDate = async (dateStr) => {
    setStartDate(dateStr);
    try {
      await saveStartDate(dateStr);
      // 开始日变化后，重新生成每日学习计划，让每条任务带上真实 task_date
      generateDailyPlan({})
        .then(() => { /* 重算成功，下一轮轮询会刷新每日计划 */ })
        .catch((e) => {
          console.error('每日计划联动重算失败:', e.message);
          setPlanError('每日学习计划重算失败：' + (e.message || '未知错误') + '，请点击重试。');
        });
    } catch (e) {
      console.warn('保存开始日失败（仅本地生效）：', e.message);
    }
    setShowStartAdjust(false);
  };

  // 确认更改目标岗位：旧学习计划将被清除，并用新目标岗位重新查询小红书生成学习计划；
  // 仅调整时间（applyEndDate）时计划内容不变，这里才需要重新生成。
  // 抽成可复用函数：既供「更改目标岗位」确认弹窗调用，也供「调整计划」保存时调用。
  // opts.daysOverride 允许「调整计划」保存时一并带入新的学习天数（基于新区间推导）。
  const confirmJobChange = async (overrideDirs, opts = {}) => {
    const newDirs = (overrideDirs && overrideDirs.length ? overrideDirs : draftDirections).slice(0, 1);
    if (!newDirs.length) {
      setShowJobConfirm(false);
      return;
    }
    const newJob = directionName(newDirs[0]);
    const effectiveDays = opts.daysOverride != null ? opts.daysOverride : days;

    // 岗位切换「立即生效 + 立即持久化」：先把岗位名写入内存与 localStorage，
    // 这样即使后续生成学习计划耗时较长（1-3 分钟）用户刷新页面，或生成失败，
    // 重新挂载时 initialJobName 仍会读到新岗位，不会再回退成旧的「AI产品经理」。
    setSelectedDirections(newDirs);
    setJobName(newJob);
    setShowJobConfirm(false);
    setShowAdjust(false);
    try {
      const base = JSON.parse(localStorage.getItem('offerToJobInfo') || '{}');
      localStorage.setItem('offerToJobInfo', JSON.stringify({ ...base, jobName: newJob, directions: newDirs }));
    } catch { /* 忽略 */ }
    try {
      const p = await getProfile();
      await saveProfile({ ...(p || {}), jobName: newJob, directions: newDirs, targetDate: p?.targetDate || endDate });
    } catch { /* 忽略 */ }

    // 以新目标岗位重新生成学习计划（查询小红书 + 后续链路），计划内容随之更新。
    // 注意：岗位名已先行切换并持久化；若 LLM/接口失败（如额度耗尽），
    // 仅保留旧 planData 并提示，岗位名保持新值，避免「岗位名变了却没新计划」的不一致。
    setIntegrated(true);
    setPlanLoading(true);
    setPlanError('');
    try {
      // 不传 days：学习天数真源统一为 profile.target_date/start_date（后端 deriveDays 含首尾）
      const data = await getIntegratedPlan(xhsKeyword, null, { autoFetch: true, count: 3 });
      // 后端响应结构为 {plan, created_at, days, keyword}，需取 data.plan（与挂载时 GET 一致）
      setPlanData(data.plan);
      setPlanCreatedAt(Date.now());
      setHasGenerated(true);
      if (data.llmFallback) {
        setGenNotice('本次大模型接口暂时不可用，学习计划已使用规则兜底生成。你可以稍后重新生成，以获得大模型优化后的路线。');
        setShowGenModal(true);
      }
    } catch (e) {
      setPlanError((e.message || '生成失败') + '（岗位已切换，但学习计划暂未更新，可稍后重试）');
      setIntegrated(false);
      setPlanLoading(false);
      return;
    }
    setPlanLoading(false);
    // 目标岗位变更后，自动抓取契合的 Boss 真实岗位（校招/应届优先、大厂优先），无需手动刷新
    fetchBoss(bossCity.trim() || '全国');
  };

  // 挂载时同步后端数据：已保存帖子内容 + 多选岗位方向（用于「一个方向一篇」）
  useEffect(() => {
    let active = true;
    getProfile()
      .then((p) => {
        if (!active || !p) return;
        if (Array.isArray(p.directions) && p.directions.length) {
          setSelectedDirections(p.directions);
        }
      })
      .catch(() => {});
    // 登录/刷新后自动渲染上次生成并保存的学习计划（点击「重新生成」前保持一致）
    getSavedIntegratedPlan()
      .then(({ plan, createdAt, days: savedDays }) => {
        if (!active || !plan) return;
        setPlanData(plan);
        setIntegrated(plan.source === 'integrated');
        // 已存在保存的学习计划：标记「已生成」并自动渲染，避免每次打开都需重新生成
        setHasGenerated(true);
        // 数据库已有计划：后续点击「生成学习计划」每次都弹覆盖确认（用户要求）
        setDbHasPlan(true);
        if (createdAt) setPlanCreatedAt(createdAt);
        // 注意：用户在「调整计划」中改过「距离目标日」时，新值已写入 localStorage(offerToJobInfo.days)，
        // 不要再被后端生成计划时保存的旧 days 覆盖，否则切页后会回退到设定值。
        if (savedDays && !savedJobInfo.days) updateDays(savedDays);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  // 多选岗位方向（>1）时，每个方向作为独立搜索目标；否则退回单一 jobName
  const targetJobs = useMemo(() => {
    if (selectedDirections.length > 1) {
      return selectedDirections.map((d) => directionName(d));
    }
    return [];
  }, [selectedDirections]);
  const isMultiJob = targetJobs.length > 1;
  // 系统固定单目标岗位：jobName 即唯一目标岗位，作为所有推导的真相来源
  const targetLabel = jobName;
  // 小红书搜索关键词：必须是「目标岗位 + 学习路线」，而不是裸岗位名
  const xhsKeyword = useMemo(() => `${jobName} 学习路线`, [jobName]);
  // 单岗位：取 3 篇作为探针/参考源
  const sourceCount = 3;

  // 总学习天数 = 结束日 − 开始日（含首尾）；若未设置开始日则用 days（剩余天数）兜底
  const totalStudyDays = useMemo(() => {
    if (startDate && endDate) {
      return Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1);
    }
    return days;
  }, [startDate, endDate, days]);

  // 距离目标日（剩余天数）：与「今日任务」页完全一致，用实时今天对结束日取 ceil 差值，
  // 避免学习计划页读 localStorage 里陈旧的 days 导致两页数字不一致。
  const remainDays = useMemo(() => {
    if (endDate) return computeDaysFromEnd(endDate);
    return days;
  }, [endDate, days]);

  // 学习进度：以「学习开始日」为起点（若设置），否则回退到计划创建时间；
  // 总天数 = 总学习天数（target - start，含首尾）；已进行天数 = 今天 - 开始日。
  const progressInfo = useMemo(() => {
    if (!days) return null;
    const totalStudy = totalStudyDays || days;
    let elapsed;
    if (startDate) {
      const s = new Date(startDate); s.setHours(0, 0, 0, 0);
      elapsed = Math.max(0, Math.floor((Date.now() - s.getTime()) / 86400000));
    } else if (planCreatedAt) {
      elapsed = Math.max(0, Math.floor((Date.now() - planCreatedAt) / 86400000));
    } else {
      elapsed = 0;
    }
    const pct = Math.min(100, Math.max(0, (elapsed / totalStudy) * 100));
    return { elapsed, total: totalStudy, pct: Math.round(pct), done: pct >= 100 };
  }, [planCreatedAt, days, startDate, totalStudyDays]);

  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState('');
  const [selectedPost, setSelectedPost] = useState(null);
  const [postDetailLoading, setPostDetailLoading] = useState(false);
  const [ocrMerged, setOcrMerged] = useState(false); // 是否已把图片文字并入正文
  const [ocrNotice, setOcrNotice] = useState(''); // 按钮操作反馈
  const [integrated, setIntegrated] = useState(false); // 当前计划是否为整合路线
  const [genProgress, setGenProgress] = useState(0); // 生成中进度条（0-100）

  // 生成学习计划时驱动进度条动画：从 8% 缓慢增长至 95%，生成结束归零
  useEffect(() => {
    if (!planLoading) {
      setGenProgress(0);
      return;
    }
    setGenProgress(8);
    const timer = setInterval(() => {
      setGenProgress((p) => (p < 95 ? p + Math.max(1, (95 - p) / 12) : p));
    }, 600);
    return () => clearInterval(timer);
  }, [planLoading]);

  // 点击「查看详情」：先弹出，再懒加载正文（搜索列表不含正文，按需拉取）
  const openPostDetail = async (post) => {
    setSelectedPost(post);
    setOcrMerged(false);
    setOcrNotice('');
    setPostDetailLoading(true);
    try {
      // 优先用帖子 id；旧数据可能缺 id，则从 link（/explore/{id}?xsec_token=...）中兜底解析
      let feedId = post.id || post.xsecToken || '';
      if (!feedId && post.link) {
        const m = String(post.link).match(/explore\/([A-Za-z0-9]+)/);
        feedId = m ? m[1] : '';
      }
      const d = await getXhsPostDetail(feedId, post.xsecToken);
      setSelectedPost((prev) => ({
        ...prev,
        content: d.content || prev.content || '',
        images: d.images || [],
        ocrText: d.ocrText || '',
        ocrMissingKey: d.ocrMissingKey || false,
        detailError: d.error || '',
      }));
    } catch (e) {
      setSelectedPost((prev) => ({ ...prev, detailError: e.message || '加载失败' }));
    } finally {
      setPostDetailLoading(false);
    }
  };

  // 把帖子配图识别出的文字并入正文内部（与详情弹窗里展示的 ocrText 同源）
  const addOcrToContent = async () => {
    let post = selectedPost;
    let ocr = post?.ocrText || '';
    // 若还没识别出文字但可能有配图，重新拉取详情以触发 OCR（后端按 id 缓存，不会重复识别）
    if (!ocr && !post?.ocrMissingKey && post?.images?.length) {
      try {
        const d = await getXhsPostDetail(post.id, post.xsecToken);
        ocr = d.ocrText || '';
        setSelectedPost((prev) => ({ ...prev, ocrText: ocr, ocrMissingKey: d.ocrMissingKey || false, detailError: d.error || '' }));
        post = { ...post, ocrText: ocr };
      } catch (e) {
        setOcrNotice('重新识别失败：' + (e.message || '未知错误'));
        return;
      }
    }
    if (!ocr) {
      setOcrNotice(post?.ocrMissingKey ? '未配置 OCR API Key，无法识别图片文字。' : '该笔记图片中未识别出文字。');
      return;
    }
    setSelectedPost((prev) => ({
      ...prev,
      content: (prev.content ? prev.content + '\n\n' : '') + '## 图片中的文字\n' + ocr,
    }));
    setOcrMerged(true);
    setOcrNotice('已将图片中的文字加入正文。');
  };

  // 生成整合学习路线：点击后后端自动搜索 3 篇小红书帖子 → 抓取正文 + 图片转文字 → 交给大模型，
  // 返回「第 n 部分 + 学习链接」板块；下方同时展示这几篇小红书帖子。
  // 生成整合学习路线的三种模式统一入口
  const runGenerate = async (opts) => {
    const force = !!(opts && opts.force);
    // 允许外部覆盖天数（调整计划保存时传入最新推导值），避免闭包读到旧 days
    const effectiveDays = (opts && opts.daysOverride) ? opts.daysOverride : days;
    // 前端拦截「覆盖确认」：仅当数据库已有保存的计划（dbHasPlan）时，点击生成先弹框确认，
    // 避免误覆盖旧计划与进度。后端 /api/plan/integrated 已默认强制覆盖（不再返回 409），
    // 确认后通过 opts.confirmed=true 放行真正生成。
    if (dbHasPlan && !(opts && opts.confirmed)) {
      setPendingOverwriteOpts(opts || {});
      setShowOverwriteConfirm(true);
      return;
    }
    setPlanLoading(true);
    setPlanError('');
    setIntegrated(true);
    setShowGenModal(false);
    setShowOverwriteConfirm(false);
    setQrImage('');
    setQrChecking(false);
    try {
      // 注意：不再向 /api/plan/integrated 传 days 参数 —— 学习天数真源统一为
      // profiles.target_date / start_date（后端 deriveDays 含首尾），避免前端闭包里的旧 days 覆盖真源造成 ±1 漂移。
      const data = await getIntegratedPlan(xhsKeyword, null, {
        autoFetch: true,
        skipXhs: !!(opts && opts.skipXhs),
        count: 3,
        force,
      });
      // 后端响应结构为 {plan, created_at, days, keyword}，需取 data.plan（与挂载时 GET 一致）
      setPlanData(data.plan);
      setPlanCreatedAt(Date.now()); // 新计划以当前时间为起点计算进度
      setHasGenerated(true);
      setDbHasPlan(true); // 已成功生成并落库，后续点击生成都需覆盖确认
      if (data.xhsNeedLogin || data.loginStatus === false) {
        setXhsLoggedIn(false);
        setGenNotice('小红书登录状态已失效，请重新扫码登录后再生成学习路线。');
        setShowGenModal(true);
      }
      if (!data.xhsNeedLogin && data.loginStatus !== false) {
        setGenNotice(data.xhsSearchStatus && data.xhsSearchStatus !== 'success'
          ? '小红书账号已登录，但本次未获取到相关帖子，将使用 RAG 知识库和B站资源生成学习计划。'
          : (data.xhsSkipped ? data.sourceNote : ''));
      }
      // 生成学习路线成功后自动落库：按当前推导的天数（effectiveDays）写入 daily_learning_tasks，
      // 与「调整目标日」走同一落库入口，确保页面与数据库一致；失败明确提示，不静默吞掉。
      // 显式把天数传给后端，避免依赖可能缺失的 target_date 兜底写死 30 天。
      generateDailyPlan({ days: effectiveDays })
        .then(() => { /* 落库成功，下一轮今日计划轮询会刷新 */ })
        .catch((e) => {
          console.error('生成学习路线后自动落库失败:', e.message);
          setPlanError('学习路线已生成，但每日计划落库失败：' + (e.message || '未知错误') + '，请点击「重新生成学习路线」重试。');
        });
      // 注：小红书帖子录入 RAG 已由后端 /api/plan/integrated 在生成学习路线时统一完成
      // （把进入计划的帖子逐篇 ingestDocument，docId 幂等），无需前端重复触发。
      // 整体计划切分落库 + 小红书录入 RAG 均已触发：广播「今日任务已更新」事件，
      // 并弹出提示框，让今日任务页（Dashboard）重新拉取最新切分计划。
      window.dispatchEvent(new CustomEvent('plan-daily-updated'));
      setShowDailyUpdated(true);
    } catch (e) {
      // 注：当前后端 /api/plan/integrated 已默认强制覆盖，不再返回 409，
      // 覆盖确认改由前端 runGenerate 入口主动拦截（见上方 hasGenerated 分支）。
      setPlanError(e.message || '生成失败');
      setIntegrated(false);
    } finally {
      setPlanLoading(false);
    }
  };

  // 用户在弹框中确认「覆盖旧计划」后，放行真正生成（后端已默认强制覆盖，这里带 confirmed=true 越过前端拦截）
  const confirmOverwrite = async () => {
    setShowOverwriteConfirm(false);
    await runGenerate({ ...(pendingOverwriteOpts || {}), confirmed: true });
  };
  // 点「生成学习路线」：已授权（后端按当前用户确认）则直接生成；否则弹出模式选择弹窗
  const startGenerate = async () => {
    // 检查期间只设明确的加载态（按钮转圈/禁用），不要写静态提示文字，
    // 否则检查完成后若未清掉，弹窗里会一直残留「正在检查…」让用户误以为卡住。
    setGenChecking(true);
    setQrImage('');
    setQrError('');
    setQrChecking(false);
    setQrLoading(false);
    setGenNotice(''); // 关键：清空任何残留提示，避免弹窗里显示旧的检查文案
    // 每次点击都重新向后端确认当前用户的绑定记录和 cookie/token，避免使用过期的前端状态。
    let st = null;
    try {
      // 检查登录态是轻量请求，加独立短超时（8s）避免 MCP 无头检查慢时界面一直转圈。
      st = await Promise.race([
        getXhsStatus({ check: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('check-timeout')), 8000)),
      ]);
    } catch {
      // 探测失败或超时：st 保持 null，下面统一按未授权处理，退化为弹框让用户选择
    } finally {
      setGenChecking(false);
      setGenNotice(''); // 检查结束后务必清空「正在检查…」类提示，弹窗自带介绍文案
    }
    const usable = !!(st && st.bound && st.cookieValid && st.mcpLoggedIn);
    setXhsLoggedIn(usable);
    if (usable) {
      setQrLoading(false);
      // 接口和 Cookie 可用后直接进入生成入口；runGenerate 会先检查已有学习计划。
      await runGenerate({ skipXhs: false });
      return;
    }
    // 明确未授权（含超时/失败）：弹出模式选择弹窗，不再一直转圈
    setShowGenModal(true);
  };

  // 选择「不登录小红书，使用知识库预测」：直接基于 RAG + 大模型预测生成
  const chooseSkipXhs = async () => {
    await runGenerate({ skipXhs: true });
  };

  // 选择「扫码绑定自己的小红书」：拉取二维码并在弹窗内展示，扫码成功后落盘到当前用户隔离文件 + 记录绑定
  let qrTimer = null;
  let qrPollCount = 0;
  const pollXhsLogin = async () => {
    try {
      // 轮询当前用户是否已完成绑定（bound），或本机已扫码成功（canBind）；
      // 不把本机/他人 cookie 当作已登录。
      const st = await getXhsStatus({ bind: true, check: true });
      // 唯一标准：后端 loginStatus 为真（bound && cookieValid && mcpLoggedIn 三者同时满足），
      // 历史 xhs_bound=1 但 cookie 已失效时 loginStatus 为 false，绝不显示假已登录。
      // 本机已扫码成功、后端已检测到可绑定（canBind）：优先于「已扫描待确认」处理，
      // 立即 bindXhs 把全局 cookie 落到该用户隔离文件 + 写绑定记录。
      // 注意：canBind 必须在 scanned 之前判定，否则登录成功后 scanned 误判会卡死；
      // 也不能限制 !st.bound —— 历史 xhs_bound=1 但隔离 cookie 文件失效的用户，
      // 正是 canBind=true 却 bound=true 导致被所有分支跳过、永远「没反应」的死锁场景。
      if (st && st.canBind) {
        setQrLocked(true);
        setQrError('');
        setQrChecking(true);
        setGenNotice('✅ 扫码成功，正在完成账号绑定…');
        try {
          await bindXhs();
          // 绑定成功后以真实后端状态收尾：重新探测，确认 loginStatus 为真才关闭轮询与弹窗。
          // 修复此前 bindXhs 后只 return false、后端 canBind 仍为 true 导致反复重绑、永远卡在
          // 「正在完成绑定…」无法进入 loginStatus 分支关弹窗的死循环。
          const after = await getXhsStatus({ bind: true, check: true });
          if (after && after.loginStatus) {
            if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
            setXhsLoggedIn(true);
            setQrChecking(false);
            setQrImage('');
            setQrLocked(false);
            persistXhsLoggedIn(true);
            // 扫码成功即静默关闭绑定弹窗，不再额外弹「登录成功」提示（避免用户体感上「还多跳一次提示」）
            setGenNotice('');
            setShowGenModal(false);
            return true;
          }
          // 后端尚未真正落盘有效绑定：停止重试，给出明确提示，避免死循环。
          if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
          setQrChecking(false);
          setQrError('本机登录会话未成功落盘有效 Cookie（MCP 未真正登录）。请关闭弹窗，重新点击「扫码绑定」并用小红书 App 扫码确认。');
          return false;
        } catch (e) {
          console.error('[XHS] bindXhs failed:', e);
          if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
          setQrChecking(false);
          setQrError('绑定失败：' + (e?.message || '未知错误') + '，请重试');
        }
        return false;
      }
      // 手机已扫码、等待用户在手机上点「确认登录」的中间态：
      // 锁定二维码（遮罩 + 提示），避免用户误以未扫上而重复扫码，并即时给出反馈。
      if (st && st.scanned && !st.loginStatus) {
        setQrLocked(true);
        setQrError('');
        setQrChecking(true);
        setGenNotice('📱 ' + (st.scannedMessage || '已扫描，请在手机上点击「确认登录」'));
        return false;
      }
      if (st && st.loginStatus) {
        setQrLocked(false);
        if (qrTimer) clearInterval(qrTimer);
        qrTimer = null;
        setXhsLoggedIn(true);
        setQrChecking(false);
        const probe = await getXhsPosts(xhsKeyword, 1, 3).catch(() => ({ posts: [] }));
        if (Array.isArray(probe?.posts) && probe.posts.length > 0) {
          if (qrTimer) clearInterval(qrTimer);
          qrTimer = null;
          setXhsLoggedIn(true);
          setQrChecking(false);
          return true;
        }
        setXhsLoggedIn(false);
        setQrChecking(false);
        setQrError('小红书已登录，但当前未找到相关帖子，将使用 RAG 知识库生成学习计划。');
        return false;
      }
      if (st && st.loginStatus) {
        setQrChecking(false);
        setQrError('');
        if (qrTimer) clearInterval(qrTimer);
        qrTimer = null;
        // 绑定成功即视为「已登录就绪」，无论本次能否搜到帖子都要给绿色成功态，
        // 否则帖子探针偶发返回 0 篇时会 return false 导致反复轮询、永远不显示已绑定（用户感觉「没反应」）。
        persistXhsLoggedIn(true);
        setQrImage('');
        const probe = await getXhsPosts(xhsKeyword, 1, 3).catch(() => ({ posts: [] }));
        const hasPosts = Array.isArray(probe?.posts) && probe.posts.length > 0;
        setGenNotice(
          hasPosts
            ? '✅ 你已绑定自己的小红书账号，数据采集已就绪。点击下方按钮即可抓取 3 篇真实学习帖子并生成学习路线。'
            : '✅ 你已绑定自己的小红书账号。当前未搜到相关帖子，将使用本地 RAG 知识库兜底生成学习计划。'
        );
        return true;
      }
      // 超时保护：持续轮询约 75s（30 次 × 2.5s）仍未检测到扫码成功，停止轮询并给出明确指引，
      // 避免静默卡住让用户误以为系统故障。fail to login 通常是小红书侧（手机未确认/账号风控/码过期）。
      qrPollCount += 1;
      if (qrPollCount >= 30) {
        if (qrTimer) clearInterval(qrTimer);
        qrTimer = null;
        setQrChecking(false);
        setQrError('未在手机上检测到登录确认。请确认：① 已用小红书 App 扫码；② 在手机上点击了「确认登录」；③ 二维码未过期。若仍失败，关闭弹窗重新点击「扫码绑定」重试（小红书可能因账号风控临时拒绝）。');
      }
      return false;
    } catch {
      return false;
    }
  };
  // 辅助函数：自动重试获取二维码（MCP Playwright 浏览器已打开 XHS 登录页，
  // 只是截图暂时失败；重试不需要从头重开浏览器，仅重新调用 getXhsQrcode 即可）。
  const retryGetQrCode = async (maxRetries = 3, baseDelayMs = 2000) => {
    let lastError = null;
    for (let i = 0; i < maxRetries; i++) {
      try {
        if (i > 0) {
          setGenNotice(`正在重新获取二维码（第 ${i + 1}/${maxRetries} 次）…`);
          await new Promise(r => setTimeout(r, baseDelayMs * (i + 1)));
        }
        const d = await Promise.race([
          getXhsQrcode(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000)),
        ]);
        if (d && d.image) return d;
        if (d && d.alreadyLoggedIn) return d;
        // browserLogin 或无图像：继续重试
        lastError = d && d.browserLogin ? '二维码图片暂不可用' : '未获取到二维码';
      } catch (e) {
        lastError = e.message || '网络异常';
      }
    }
    throw new Error(lastError || '多次重试仍无法获取二维码');
  };

  const chooseLoginXhs = async () => {
    // 无论二维码接口是否成功，扫码流程都必须保持在当前弹窗内，便于展示错误和重试。
    setShowGenModal(true);
    setQrLoading(true);
    setQrError('');
    qrPollCount = 0;
    try {
      // 优先尝试自动重试获取二维码（MCP 浏览器已打开 XHS 登录页，
      // 截图失败大多为瞬时问题，重试即可恢复），避免走入 browserLogin 死胡同。
      const data = await retryGetQrCode(3, 2000);
      if (data && data.image) {
        setQrImage(data.image);
        setQrLocked(false);
        setQrLoading(false);
        setGenNotice('请用小红书 App 扫描上方二维码，绑定【你自己的】账号（仅采集学习路线数据，不影响其他用户）。');
        if (qrTimer) clearInterval(qrTimer);
        qrTimer = setInterval(async () => {
          setQrChecking(true);
          const ok = await pollXhsLogin();
          if (ok) {
            setQrChecking(false);
            if (qrTimer) clearInterval(qrTimer);
            qrTimer = null;
          }
        }, 2500);
        return;
      }
      if (data && data.alreadyLoggedIn) {
        // 本机已有一个待绑定的登录会话（如用户刚扫码成功，全局 cookie 已就绪），
        // 直接把它绑定到当前用户，无需再出码。
        setQrImage('');
        setQrLoading(false);
        setQrChecking(true);
        try {
          await bindXhs();
          const after = await getXhsStatus({ bind: true, check: true });
          if (after && after.loginStatus) {
            persistXhsLoggedIn(true);
            setQrChecking(false);
            setGenNotice('✅ 已确认小红书登录态（Cookie 已落盘且 MCP 校验通过），数据采集就绪。点击下方按钮即可抓取真实学习帖子并生成学习路线。');
            return;
          } else {
            setQrChecking(false);
            setQrError('本机登录会话未成功落盘有效 Cookie（MCP 未真正登录）。请关闭弹窗，重新点击「扫码绑定」并用小红书 App 扫码确认。');
          }
        } catch (err) {
          setQrChecking(false);
          setQrError('绑定当前登录会话失败：' + (err.message || '') + '，请重新点击「扫码绑定」重试。');
        }
        return;
      }
      if (data && data.loggedIn) {
        setQrImage('');
        setQrLoading(false);
        setQrError('小红书当前仍处于登录态，正在为你重置采集会话，请稍候重新点击「扫码绑定」即可绑定你自己的账号。');
        return;
      }
      // retryGetQrCode 理论上不会到这（超时会 throw），但兜底：回到选择弹窗让用户重试
      throw new Error('未获取到有效二维码');
    } catch (e) {
      // 所有自动重试失败：展示清晰的重试入口，绝不开外部浏览器窗口（会切断 MCP 会话导致永无法绑定）
      setQrImage('');
      setQrLoading(false);
      setQrChecking(false);
      setQrError('二维码获取失败（' + (e.message || 'MCP 暂不可用') + '）。请检查后台 MCP 服务是否正常运行，然后点击下方按钮重试或跳过。');
      setGenNotice('');
    }
  };

  // 将增删后的学习计划持久化到后端（覆盖 data，不重新生成），切页/刷新后依然保留
  const persistPlan = async (nextPlan) => {
    try {
      await saveIntegratedPlan(nextPlan, days);
    } catch (e) {
      console.warn('保存学习计划失败（仅本地生效）：', e.message);
    }
  };

  // 点击垃圾桶：弹出确认，避免误删
  const handleDeleteSection = (idx) => {
    setPendingDeleteIdx(idx);
    setShowDeleteConfirm(true);
  };

  // 确认删除：移除该部分并重排「第 n 部分」，然后持久化
  const confirmDeleteSection = async () => {
    const idx = pendingDeleteIdx;
    setShowDeleteConfirm(false);
    setPendingDeleteIdx(null);
    setEditingIdx(null);
    setEditDraft({ title: '', link: '', content: '' });
    if (idx == null || !planData) return;
    const nextSections = (planData?.sections || [])
      .filter((_, i) => i !== idx)
      .map((s, i) => ({ ...s, part: i + 1 }));
    const nextPlan = { ...planData, sections: nextSections };
    setPlanData(nextPlan);
    await persistPlan(nextPlan);
  };

  // 点击「+」：在末尾追加一个与现有格式一致的新部分
  const handleAddSection = async () => {
    if (!planData) return;
    const cur = planData?.sections || [];
    const nextSections = [
      ...cur,
      {
        part: cur.length + 1,
        title: '新学习部分',
        link: '',
        content: '请在此补充本部分的学习内容与安排。',
      },
    ];
    const nextPlan = { ...planData, sections: nextSections };
    setPlanData(nextPlan);
    await persistPlan(nextPlan);
  };

  // 点击铅笔：进入该部分编辑态，预填当前值
  const handleEditSection = (idx) => {
    const sec = planData?.sections?.[idx];
    if (!sec) return;
    setEditingIdx(idx);
    setEditDraft({
      title: sec.title || '',
      link: sec.link || '',
      content: sec.content || '',
    });
  };

  // 保存编辑：回写该部分并重排后持久化
  const confirmEditSection = async () => {
    const idx = editingIdx;
    if (idx == null || !planData) return;
    const title = (editDraft.title || '').trim() || '新学习部分';
    const nextSections = (planData?.sections || []).map((s, i) =>
      i === idx
        ? { ...s, title, link: (editDraft.link || '').trim(), content: editDraft.content }
        : s
    );
    const nextPlan = { ...planData, sections: nextSections };
    setPlanData(nextPlan);
    setEditingIdx(null);
    setEditDraft({ title: '', link: '', content: '' });
    await persistPlan(nextPlan);
  };

  // 取消编辑
  const cancelEditSection = () => {
    setEditingIdx(null);
    setEditDraft({ title: '', link: '', content: '' });
  };

  // ---- 小红书帖子：生成后自动展示（来自 planData?.xhsPosts） ----
  const [xhsOpenMsg, setXhsOpenMsg] = useState(''); // 在小红书客户端打开的反馈
  const [showGenModal, setShowGenModal] = useState(false); // 生成学习路线前的模式选择弹窗
  const [qrImage, setQrImage] = useState(''); // 小红书登录二维码
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState('');
  const [qrChecking, setQrChecking] = useState(false); // 轮询登录态中
  const [qrLocked, setQrLocked] = useState(false); // 已扫码待确认：锁定二维码防重复扫码
  // 已处于小红书登录态：每个用户独立授权，默认未登录，以「后端按当前用户」返回为准
  const [xhsLoggedIn, setXhsLoggedIn] = useState(false);
  const [genNotice, setGenNotice] = useState(''); // 弹窗内底部提示
  const [genChecking, setGenChecking] = useState(false); // 「生成学习路线」点击后检查登录态中的加载态
  const [showDailyUpdated, setShowDailyUpdated] = useState(false); // 生成+落库完成后「今日任务已更新」提示框

  // 设置小红书登录态标记（仅前端 UI 记忆；真实绑定记录在后端 users.xhs_bound）
  const persistXhsLoggedIn = (v) => {
    setXhsLoggedIn(v);
  };

  // 挂载时探测后端真实绑定态：仅当当前用户自己已绑定小红书（bound）才视为已授权，绝不把本机/他人 cookie 当作已登录。
  useEffect(() => {
    let active = true;
    getXhsStatus()
      .then((st) => {
        if (!active) return;
        persistXhsLoggedIn(!!(st && st.bound));
      })
      .catch(() => { /* 探测失败不阻断页面 */ });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 在已登录的小红书客户端（服务端 Playwright 浏览器）中打开笔记，
  // 这样用户扫码登录后即可正常查看，避免"该笔记无法查看"。
  const openInXhs = async (post) => {
    setXhsOpenMsg('正在小红书客户端打开…');
    try {
      await openXhsPost(post.id, post.xsecToken);
      setXhsOpenMsg('✅ 已在你登录的小红书客户端打开（请查看弹出的浏览器窗口）。若未弹出窗口，请先点击导航栏「登录小红书」扫码登录。');
    } catch (e) {
      setXhsOpenMsg('⚠️ 打开失败：' + (e.message || '') + '。可手动复制下方链接在已登录浏览器中打开。');
    }
  };

  return (
    <div className="min-h-screen bg-warm-white p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        {/* 顶部：目标岗位 + 周计划生成 */}
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-800">🗺️ 我的学习计划</h1>
              <p className="text-sm text-gray-500 mt-1">
                {planData
                  ? (planData?.xhsSkipped
                      ? `本地知识库 + 大模型预测规划 · ${targetLabel}`
                      : `小红书真实帖子 + 本地知识库 · 已整合 ${sourceCount} 篇 · ${targetLabel}`)
                  : planLoading
                    ? '正在规划…'
                    : (startDate && endDate
                        ? `目标岗位：${jobName} · 共 ${totalStudyDays} 天（${startDate} → ${endDate}）· 距离目标日 ${remainDays} 天`
                        : `目标岗位：${jobName} · 距离目标日 ${remainDays} 天`)}
              </p>
            </div>
            <button
              onClick={startGenerate}
              disabled={planLoading || qrLoading || genChecking}
              className="flex items-center gap-1 px-3 py-2 rounded-lg bg-sky-50 text-sky-600 text-sm font-medium hover:bg-sky-100 transition-colors disabled:opacity-60"
            >
              <Sparkles className={`w-4 h-4 ${planLoading || genChecking ? 'animate-spin' : ''}`} />
              {genChecking ? '检查登录态…' : '生成学习路线'}
            </button>
          </div>

        </div>

        {planLoading && (
          <div className="py-10">
            <div className="max-w-md mx-auto">
              <p className="text-sm text-gray-600 text-center mb-4 leading-relaxed">
                {integrated
                  ? `正在整合 ${sourceCount} 篇帖子素材与目标岗位通用知识，交由千问归纳学习路线…（约 1-3 分钟）`
                  : `正在从小红书搜索「${jobName}」学习路线，并交由千问制定周计划…（约 1-2 分钟）`}
              </p>
              <div className="h-2.5 w-full rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-mint to-sky-400 transition-all duration-500 ease-out"
                  style={{ width: `${Math.round(genProgress)}%` }}
                />
              </div>
              <p className="text-xs text-gray-400 text-center mt-2">
                生成中 {Math.round(genProgress)}%
                <Loader2 className="inline-block w-3 h-3 ml-1 animate-spin align-[-1px]" />
              </p>
            </div>
          </div>
        )}

        {planError && !planLoading && (
          <div className="py-4 text-center">
            <p className="text-sm text-red-500 mb-4">{planError}</p>
            <button
              onClick={startGenerate}
              disabled={planLoading}
              className="inline-flex items-center gap-1 px-4 py-2.5 rounded-xl bg-[#FF2442] text-white text-sm font-medium hover:bg-[#FF2442]/90 transition-colors disabled:opacity-60"
            >
              <RefreshCw className={`w-4 h-4 ${planLoading ? 'animate-spin' : ''}`} />
              重新生成学习路线
            </button>
          </div>
        )}

        {!planLoading && !planData && !planError && !jobName && (
          <div className="text-center py-10 card">
            <p className="text-sm text-gray-500 mb-5 max-w-md mx-auto leading-relaxed">
              请先在上方选择目标学习岗位，然后点击「生成学习路线」。可以选择
              <b className="text-gray-700 font-medium">扫码登录小红书</b>（自动抓取 3 篇真实学习帖子并结合知识库生成），
              也可以<b className="text-gray-700 font-medium">暂不登录</b>，由系统基于本地知识库 + 大模型预测分析规划路线。
            </p>
          </div>
        )}



        {jobName && (
          <>
            {planLoading && (
              <div className="mb-6 flex items-center gap-2 rounded-xl border border-mint/30 bg-mint/5 px-4 py-3 text-sm text-mint">
                <Loader2 className="w-4 h-4 animate-spin" />
                正在生成学习计划，以下基础板块将保持不变…
              </div>
            )}
            {planData && planData?.xhsSkipped && !xhsLoggedIn && (
              <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <Info className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-700 leading-relaxed">
                  当前未连接小红书，已基于<b>本地知识库 + 大模型预测分析</b>规划学习路线。如需更贴合真实经验，可点击右上角「生成学习路线」并扫码登录小红书，系统将自动抓取 3 篇真实学习帖子重新生成。
                </p>
              </div>
            )}
            {/* 目标学习岗位 + 距离目标日 + 学习进度计划（并列指标）+ 调整计划（仿「今日任务」指标卡样式） */}
            <div className="card mb-6">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-6 flex-wrap">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-mint/10 text-mint flex items-center justify-center">
                      <Target className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">目标学习岗位</p>
                      <p className="text-lg font-bold text-gray-800">{targetLabel}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-sky-100 text-sky-600 flex items-center justify-center shrink-0">
                      <Calendar className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs text-gray-500 whitespace-nowrap">距离目标日</p>
                      <p className="text-lg font-bold text-gray-800 whitespace-nowrap">{days} 天</p>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setDraftDirections((selectedDirections && selectedDirections.length ? [selectedDirections[0]] : [])); setDraftEnd(endDate); const d = new Date(); const td = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; setDraftStart(td); setDraftDays(days); setShowAdjust(true); }}
                  className="flex items-center gap-1 px-3 py-2 rounded-lg bg-mint/10 text-mint text-sm font-medium hover:bg-mint/20 transition-colors"
                >
                  <CalendarClock className="w-4 h-4" />
                  ⚙️ 调整计划
                </button>
              </div>
            </div>

            {/* 真实抓取说明：仅当用户登录小红书并主动生成了学习路线时显示 */}
            {hasGenerated && planData && !planData?.xhsSkipped && planData?.source === 'integrated' && (
              <div className="mb-6 flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
                <Info className="w-5 h-5 text-sky-500 mt-0.5 shrink-0" />
                <p className="text-sm text-sky-700 leading-relaxed">
                  这份路线为你<b>量身定制</b>：已抓取并解析 {sourceCount || 3} 篇小红书真实学习帖（含正文与图片文字），结合本地知识库，由大模型提炼出契合「{targetLabel}」目标岗位的阶段性学习路径。想看原始经验，可下滑至下方「小红书参考资料」。
                </p>
              </div>
            )}

            {planData?.ragReferences && planData?.ragReferences.length > 0 && (
              <div className="card mb-6 bg-indigo-50/60 border border-indigo-100">
                <p className="text-sm text-indigo-800 font-medium mb-2">🧠 RAG 知识库参考（本次检索到 {planData?.ragReferences.length} 段最相关片段）</p>
                <div className="space-y-2">
                  {planData?.ragReferences.slice(0, 4).map((r, i) => (
                    <div key={i} className="text-xs">
                      <span className="text-indigo-600 font-medium">[{r.source === 'xhs' ? '小红书' : '文档'}] {r.title}</span>
                      <span className="text-gray-400 ml-2">相似度 {(r.score || 0).toFixed(3)}</span>
                      <p className="text-gray-500 mt-0.5 line-clamp-2">{r.content}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {planData?.ragDocs && planData?.ragDocs.length > 0 && (
              <div className="card mb-6 bg-emerald-50/60 border border-emerald-100">
                <p className="text-sm text-emerald-800 font-medium mb-3">📄 知识库原始文档（可查看，共 {planData?.ragDocs.length} 篇）</p>
                <div className="space-y-2">
                  {planData?.ragDocs.map((d) => (
                    <div key={d.docId} className="flex items-center justify-between gap-3 bg-white/70 rounded-lg px-3 py-2 border border-emerald-100">
                      <span className="text-sm text-gray-700 truncate">📘 {d.title}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => window.open('/api/rag/file?docId=' + encodeURIComponent(d.docId), '_blank')}
                          className="text-xs px-2.5 py-1 rounded-button bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
                        >
                          查看
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {planData?.xhsNeedLogin && (
              <p className="text-sm text-amber-600 mb-4">
                ⚠️ 小红书未登录，未获取到真实学习路线，已基于通用知识规划。请在小红书 MCP 中扫码登录后重新生成。
              </p>
            )}

            {/* ── XMind 风格固定能力地图（板块 → 技能）── */}
            <SkillTreeMap stages={treeData?.stages} loading={treeLoading} />

            {/* ── 课程与 PDF 列表（保留原排版）── */}
            <div className="space-y-4 mb-8">
              {hasGenerated && planData?.sections && planData?.sections.length > 0 ? (
                <>
                  {planData?.sections.map((sec, i) => {
                    const isGithub = sec.platform === 'github' || /github\.com/i.test(sec.link || '');
                    const PlatformIcon = isGithub ? Github : PlayCircle;
                    const platformLabel = isGithub ? 'GitHub' : 'B站';
                    const partNo = sec.part || i + 1;
                    const isEditing = editingIdx === i;
                    return (
                      <div key={i} className="card overflow-hidden">
                        <div className="p-4">
                          {isEditing ? (
                            <div className="space-y-3">
                              <div className="flex items-center gap-2 mb-1">
                                <div className="w-9 h-9 rounded-full bg-mint/10 text-mint flex items-center justify-center font-bold shrink-0">
                                  {partNo}
                                </div>
                                <span className="font-bold text-gray-800">第 {partNo} 部分 · 编辑中</span>
                              </div>
                              <div>
                                <label className="text-xs text-gray-500">标题</label>
                                <input
                                  value={editDraft.title}
                                  onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
                                  placeholder="部分标题"
                                  className="w-full p-2 rounded-xl border border-gray-200 bg-warm-white/50 focus:outline-none focus:border-mint transition-colors text-gray-700 text-sm"
                                />
                              </div>
                              <div>
                                <label className="text-xs text-gray-500">学习链接（可选）</label>
                                <input
                                  value={editDraft.link}
                                  onChange={(e) => setEditDraft((d) => ({ ...d, link: e.target.value }))}
                                  placeholder="https://..."
                                  className="w-full p-2 rounded-xl border border-gray-200 bg-warm-white/50 focus:outline-none focus:border-mint transition-colors text-gray-700 text-sm"
                                />
                              </div>
                              <div>
                                <label className="text-xs text-gray-500">学习内容</label>
                                <textarea
                                  value={editDraft.content}
                                  onChange={(e) => setEditDraft((d) => ({ ...d, content: e.target.value }))}
                                  rows={4}
                                  placeholder="请补充本部分的学习内容与安排"
                                  className="w-full p-2 rounded-xl border border-gray-200 bg-warm-white/50 focus:outline-none focus:border-mint transition-colors text-gray-700 text-sm resize-none"
                                />
                              </div>
                              <div className="flex justify-end gap-2 pt-1">
                                <button
                                  type="button"
                                  onClick={cancelEditSection}
                                  className="px-3 py-1.5 rounded-button border border-gray-200 text-gray-600 text-sm hover:bg-gray-50 transition-colors"
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  onClick={confirmEditSection}
                                  className="flex items-center gap-1 px-3 py-1.5 rounded-button bg-mint text-white text-sm hover:bg-mint/90 transition-colors"
                                >
                                  <Check className="w-4 h-4" />
                                  保存
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start gap-3">
                              <div className="w-9 h-9 rounded-full bg-mint/10 text-mint flex items-center justify-center font-bold shrink-0">
                                {partNo}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-start justify-between gap-2">
                                  <h3 className="font-bold text-gray-800 mb-1">第 {partNo} 部分 · {sec.title}</h3>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => handleEditSection(i)}
                                      title="编辑本部分"
                                      className="p-1.5 rounded-lg text-gray-400 hover:text-mint hover:bg-mint/10 transition-colors"
                                    >
                                      <Pencil className="w-4 h-4" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteSection(i)}
                                      title="删除本部分"
                                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </div>
                                </div>
                                {sec.link && (
                                  <a
                                    href={sec.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-sm text-sky-600 hover:underline mb-2 break-all"
                                  >
                                    <PlatformIcon className="w-4 h-4 shrink-0" />
                                    <span>{platformLabel} · {sec.link}</span>
                                  </a>
                                )}
                                {sec.content && (
                                  <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">{sec.content}</p>
                                )}
                                <PdfList pdfs={parseResourceInfo(sec.pdfs).pdfs} />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {/* 最后一部分右下角：新增学习部分 */}
                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      onClick={handleAddSection}
                      className="flex items-center gap-1 px-3 py-2 rounded-lg bg-mint/10 text-mint text-sm font-medium hover:bg-mint/20 transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      添加学习部分
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-sm text-gray-400 text-center py-8">
                  暂无学习板块。点击上方「生成学习路线」，系统会自动搜索小红书帖子并整理成学习计划。
                </p>
              )}
            </div>

            {/* 小红书学习帖子：自动抓取，展示在「生成学习路线」(sections) 下方 */}
            {planData?.xhsPosts && planData?.xhsPosts.length > 0 && hasGenerated && (
              <div className="card mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-base font-bold text-gray-800">📕 小红书参考资料</h2>
                  <span className="text-sm text-gray-500">已自动抓取 {planData?.xhsPosts.length} 篇 · 含正文与图片文字</span>
                </div>
                <div className="space-y-4">
                  {planData?.xhsPosts.map((post, i) => (
                    <div key={post.id || i} className="bg-warm-white/40 rounded-lg p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <h3 className="text-sm font-medium text-gray-800 mb-1 leading-snug">{post.title}</h3>
                          <div className="flex items-center gap-3 text-xs text-gray-400">
                            {post.author && <span>👤 {post.author}</span>}
                            {post.engagement && <span>❤️ {post.engagement}</span>}
                          </div>
                          {post.content && (
                            <p className="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap mt-1.5 line-clamp-3">
                              {post.content.split('\n').slice(0, 3).join('\n')}
                              {post.content.split('\n').length > 3 ? '…' : ''}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-col gap-2 ml-4 whitespace-nowrap">
                          <button
                            onClick={() => openPostDetail(post)}
                            className="flex items-center gap-1 px-3 py-2 bg-mint/10 text-mint rounded-lg hover:bg-mint/20 transition-colors text-sm"
                          >
                            <ChevronRight className="w-4 h-4" />
                            查看详情
                          </button>
                          <a
                            href={post.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 px-3 py-2 border border-[#FF2442]/30 text-[#FF2442] rounded-lg hover:bg-[#FF2442]/5 transition-colors text-sm"
                          >
                            <ExternalLink className="w-4 h-4" />
                            在小红书查看
                          </a>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* 调整计划弹窗：设置学习结束日（日历）/ 更改目标岗位 */}
        {showAdjust && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
            onClick={() => setShowAdjust(false)}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-gray-800">调整计划</h3>
                <button
                  type="button"
                  onClick={() => setShowAdjust(false)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>

              {/* 学习区间：开始日固定为当天自然日 - 结束日可调整 */}
              <div className="mb-6">
                <p className="text-sm font-medium text-gray-700 mb-1">📅 设置学习区间</p>
                <p className="text-xs text-gray-500 mb-3">开始日固定为「今天（当个自然日）」，无需调整；仅需选择结束日，系统将基于区间重新规划学习计划并联动首页「距离目标日」。</p>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={draftStart || ''}
                    readOnly
                    disabled
                    title="开始日固定为今天，不可调整"
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-400 cursor-not-allowed"
                  />
                  <span className="text-gray-400 font-medium">—</span>
                  <input
                    type="date"
                    value={draftEnd || ''}
                    onChange={(e) => setDraftEnd(e.target.value || null)}
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-mint"
                  />
                </div>
                {/* 合并后的区间展示：8月11 - 8月22 */}
                <p className="text-sm text-mint mt-2">
                  {draftStart && draftEnd
                    ? `${fmtCnDate(draftStart)} - ${fmtCnDate(draftEnd)}`
                    : draftStart
                      ? `${fmtCnDate(draftStart)} - ？`
                      : draftEnd
                        ? `？ - ${fmtCnDate(draftEnd)}`
                        : '未选择区间'}
                  {draftStart && draftEnd && (
                    <span className="ml-2 text-gray-500">
                      总学习天数：{Math.max(1, Math.round((new Date(draftEnd) - new Date(draftStart)) / 86400000) + 1)} 天
                    </span>
                  )}
                </p>
              </div>

              {/* 学习天数：直接输入 N 天（与选结束日二选一，都驱动每日计划重切） */}
              <div className="mb-6">
                <p className="text-sm font-medium text-gray-700 mb-1">⏱️ 或直接设置学习天数</p>
                <p className="text-xs text-gray-500 mb-3">填入天数后，系统会基于「今天」自动推算结束日并重新切片每日学习计划。若同时选了结束日，以结束日为准。</p>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={draftDays || ''}
                    onChange={(e) => {
                      const n = e.target.value ? Math.max(1, parseInt(e.target.value, 10)) : null;
                      setDraftDays(n);
                      // 输入天数时同步反推结束日，保证区间展示与目标日一致
                      if (n && draftStart) {
                        const end = addDays(draftStart, n);
                        setDraftEnd(end);
                      }
                    }}
                    placeholder="例如 30"
                    className="w-32 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-mint"
                  />
                  <span className="text-sm text-gray-500">天</span>
                  {draftStart && draftDays && (
                    <span className="text-xs text-mint">
                      推算结束日：{fmtCnDate(addDays(draftStart, draftDays))}
                    </span>
                  )}
                </div>
              </div>

              {/* 目标岗位：单选（与注册「选择岗位方向」一致，只能选 1 个） */}
              <div className="pt-4 border-t border-gray-100">
                <p className="text-sm font-medium text-gray-700 mb-1">🎯 更改目标岗位（单选，仅 1 个）</p>
                <p className="text-xs text-gray-500 mb-3">选项与注册时一致，选择后系统将基于所选方向重新规划学习计划。</p>
                <div className="grid grid-cols-2 gap-2">
                  {PRODUCT_DIRECTIONS.map((dir) => {
                    const on = draftDirections.includes(dir.id);
                    const disabled = !on && draftDirections.length >= 1;
                    return (
                      <button
                        key={dir.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => toggleDraftDirection(dir.id)}
                        className={`p-3 rounded-xl border text-sm font-medium transition-all duration-200 text-left ${
                          on
                            ? 'border-mint bg-mint/5 text-mint'
                            : disabled
                              ? 'border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed'
                              : 'border-gray-200 text-gray-700 hover:border-mint/30'
                        }`}
                      >
                        {dir.name}
                        {on && <span className="ml-1 font-bold">✓</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 底部操作：取消 / 保存 */}
              <div className="flex gap-3 pt-4 mt-2 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setShowAdjust(false)}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50 transition-colors"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => setShowSaveConfirm(true)}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-mint text-white text-sm font-medium hover:bg-mint/90 transition-colors"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 更改目标岗位确认弹窗 */}
        {showJobConfirm && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
            onClick={() => setShowJobConfirm(false)}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-4xl mb-3">⚠️</div>
              <h3 className="text-lg font-bold text-gray-800 mb-2">确认更改目标岗位？</h3>
              <p className="text-sm text-gray-600 leading-relaxed mb-6">
                更改目标岗位后，当前学习计划与学习记录将被覆盖，且无法恢复。确定要更换为「{draftDirections.map(directionName).join('、')}」并重新规划吗？
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowJobConfirm(false)}
                  className="flex-1 px-4 py-2 rounded-button border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={confirmJobChange}
                  className="btn-primary flex-1"
                >
                  确定更改
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 调整计划保存二次确认弹窗 */}
        {showSaveConfirm && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
            onClick={() => setShowSaveConfirm(false)}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-4xl mb-3">⚠️</div>
              <h3 className="text-lg font-bold text-gray-800 mb-2">确定要修改吗？</h3>
              <p className="text-sm text-gray-600 leading-relaxed mb-6">
                修改后整体学习计划将重新变动，当前学习计划与学习记录不会被保存（将无法恢复）。确定要保存新的开始日 / 结束日吗？
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowSaveConfirm(false)}
                  className="flex-1 px-4 py-2 rounded-button border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  再想想
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setShowSaveConfirm(false);
                    // 1) 先把开始日/结束日写入后端（真源），days 自动派生
                    try {
                      if (draftEnd) {
                        const r = await saveTargetDate(draftEnd);
                        if (r && r.days) { setDays(r.days); updateDays(r.days); }
                      }
                    } catch (e) { console.warn('保存结束日失败:', e.message); }
                    try { if (draftStart) await saveStartDate(draftStart); } catch (e) { console.warn('保存开始日失败:', e.message); }

                    // 2) 若本次在「调整计划」里改动了目标岗位，则按新岗位重新生成学习计划（岗位名同步切换）。
                    //    注意：必须用最新的 draftDirections 与天数，避免闭包读到旧值。
                    const jobChanged = draftDirections.length > 0 &&
                      (selectedDirections.length !== draftDirections.length ||
                        draftDirections.some((d) => !selectedDirections.includes(d)));
                    // 天数输入框已同步反推 draftEnd，故统一以结束日（含首尾）推导天数；
                    // 若未选结束日则回退当前 days
                    const newDays = draftEnd ? computeDaysFromEnd(draftEnd) : days;
                    if (jobChanged) {
                      setShowAdjust(false);
                      await confirmJobChange(draftDirections, { daysOverride: newDays });
                    } else {
                      // 仅改了日期区间：重新生成整体学习计划并入库 + 切分每日计划 + 灌 RAG（用最新区间推导的天数）
                      setShowAdjust(false);
                      toast('正在根据新的学习区间重新生成学习计划…');
                      runGenerate({ confirmed: true, skipXhs: false, daysOverride: newDays });
                    }
                  }}
                  className="btn-primary flex-1"
                >
                  确定保存
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 删除学习部分确认弹窗 */}
        {/* 覆盖已有学习计划确认弹窗（数据库已存在保存的计划时，每次点击生成都触发） */}
        {showOverwriteConfirm && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
            onClick={() => setShowOverwriteConfirm(false)}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-4xl mb-3">⚠️</div>
              <h3 className="text-lg font-bold text-gray-800 mb-2">覆盖原有学习计划？</h3>
              <p className="text-sm text-gray-600 leading-relaxed mb-6">
                你已有一份保存的学习计划，重新生成将覆盖旧计划与学习进度，且无法恢复。确定要重新生成吗？
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowOverwriteConfirm(false)}
                  className="flex-1 px-4 py-2 rounded-button border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={confirmOverwrite}
                  className="btn-primary flex-1"
                >
                  确定覆盖
                </button>
              </div>
            </div>
          </div>
        )}

        {showDeleteConfirm && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
            onClick={() => setShowDeleteConfirm(false)}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-4xl mb-3">🗑️</div>
              <h3 className="text-lg font-bold text-gray-800 mb-2">确认删除该学习部分？</h3>
              <p className="text-sm text-gray-600 leading-relaxed mb-6">
                删除后该部分将无法恢复。确定要删除「第 {pendingDeleteIdx != null ? pendingDeleteIdx + 1 : ''} 部分」吗？
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 px-4 py-2 rounded-button border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={confirmDeleteSection}
                  className="flex-1 px-4 py-2 rounded-button bg-red-500 text-white hover:bg-red-600 transition-colors"
                >
                  确认删除
                </button>
              </div>
            </div>
          </div>
        )}

        {selectedPost && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
              <div className="flex items-center justify-between p-4 border-b">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-mint/20 flex items-center justify-center">
                    <span className="text-lg">📕</span>
                  </div>
                  <div>
                    <h3 className="font-bold text-gray-800">{selectedPost.title}</h3>
                    <p className="text-sm text-gray-500">来源：小红书 · {selectedPost.author || '未知'}</p>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedPost(null)}
                  className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-gray-500" />
                </button>
              </div>

              <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
                {postDetailLoading ? (
                  <div className="py-10 flex items-center justify-center">
                    <span className="w-8 h-8 border-2 border-mint border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : selectedPost.detailError ? (
                  <p className="text-sm text-red-500 mb-4">{selectedPost.detailError}</p>
                ) : selectedPost.summary ? (
                  <div>
                    <p className="text-sm text-gray-400 mb-2 font-medium">📌 内容概要</p>
                    <p className="text-gray-700 leading-relaxed whitespace-pre-wrap">{selectedPost.summary}</p>
                  </div>
                ) : selectedPost.content ? (
                  <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">{selectedPost.content.slice(0, 240)}{selectedPost.content.length > 240 ? '…' : ''}</p>
                ) : (
                  <p className="text-sm text-gray-400">暂无可展示的笔记内容。</p>
                )}
                {selectedPost.ocrText && !ocrMerged ? (
                  <div className="mt-4 p-3 bg-sky-50/70 rounded-lg border border-sky-100">
                    <p className="text-sm font-medium text-sky-700 mb-1">🖼️ 图片中的文字</p>
                    <p className="text-sm text-gray-600 whitespace-pre-wrap leading-relaxed">{selectedPost.ocrText.slice(0, 300)}{selectedPost.ocrText.length > 300 ? '…' : ''}</p>
                  </div>
                ) : selectedPost.ocrMissingKey ? (
                  <p className="text-xs text-gray-400 mt-3">未配置千帆 API Key，图片内文字未识别。</p>
                ) : null}
                {selectedPost.tags && selectedPost.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-4">
                    {selectedPost.tags.slice(0, 5).map((tag, index) => (
                      <span key={index} className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded-full">{tag}</span>
                    ))}
                  </div>
                )}
              </div>

              <div className="p-4 border-t">
                <div className="flex items-center justify-between">
                  <div className="flex gap-2">
                    <button className="flex items-center gap-1 px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                      <Bookmark className="w-4 h-4 text-gray-500" />
                      收藏
                    </button>
                    <button className="flex items-center gap-1 px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                      <Heart className="w-4 h-4 text-gray-500" />
                      点赞
                    </button>
                    <button
                      onClick={addOcrToContent}
                      disabled={ocrMerged}
                      className={`flex items-center gap-1 px-4 py-2 border rounded-lg transition-colors ${ocrMerged ? 'border-gray-200 text-gray-400 cursor-not-allowed' : 'border-gray-200 hover:bg-gray-50'}`}
                    >
                      <Image className="w-4 h-4 text-gray-500" />
                      {ocrMerged ? '已加入正文' : '图片转文字'}
                    </button>
                  </div>
                  <button
                    onClick={() => openInXhs(selectedPost)}
                    className="flex items-center gap-1 px-4 py-2 bg-mint text-white rounded-lg hover:bg-mint/90 transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    在小红书查看
                  </button>
                </div>
                {ocrNotice && (
                  <p className="text-xs text-gray-400 mt-2">{ocrNotice}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 生成学习路线完成 · 今日任务已更新提示框 */}
        {showDailyUpdated && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
            onClick={() => setShowDailyUpdated(false)}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-gray-800">今日任务已更新</h3>
                <button onClick={() => setShowDailyUpdated(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <p className="text-sm text-gray-500 mb-5 leading-relaxed">
                学习路线已生成，整体计划与每日任务已切分并录入数据库。前往「今日任务」即可查看最新的学习计划。
              </p>
              <button
                onClick={() => setShowDailyUpdated(false)}
                className="w-full py-2.5 rounded-xl bg-[#FF2442] text-white text-sm font-semibold hover:bg-[#e01e3c] transition-colors"
              >
                知道了
              </button>
            </div>
          </div>
        )}

        {/* 生成学习路线 · 模式选择弹窗（扫码登录小红书 / 不登录知识库预测） */}
        {showGenModal && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50"
            onClick={() => setShowGenModal(false)}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-gray-800">生成学习路线</h3>
                <button onClick={() => setShowGenModal(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <p className="text-sm text-gray-500 mb-5 leading-relaxed">
                两种方式都可以生成学习计划。登录小红书能抓取真实帖子更贴合经验；不登录则基于本地知识库 + 大模型预测分析。
              </p>

              <div className="grid grid-cols-1 gap-3">
                <button
                  onClick={chooseLoginXhs}
                  disabled={qrLoading || planLoading}
                  className="flex items-center gap-3 p-4 rounded-xl border border-[#FF2442]/30 bg-[#FF2442]/5 hover:bg-[#FF2442]/10 transition-colors text-left disabled:opacity-60"
                >
                  <span className="text-2xl">📕</span>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-gray-800">扫码登录小红书（推荐）</p>
                    <p className="text-xs text-gray-500 mt-0.5">自动抓取 3 篇真实学习帖子，结合知识库生成</p>
                  </div>
                </button>

                <button
                  onClick={chooseSkipXhs}
                  disabled={planLoading}
                  className="flex items-center gap-3 p-4 rounded-xl border border-gray-200 hover:bg-gray-50 transition-colors text-left disabled:opacity-60"
                >
                  <span className="text-2xl">🤖</span>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-gray-800">暂不登录，使用知识库预测</p>
                    <p className="text-xs text-gray-500 mt-0.5">基于本地 RAG 知识库 + 大模型预测分析规划</p>
                  </div>
                </button>
              </div>

              {qrLoading && (
                <p className="text-sm text-gray-500 mt-4 text-center">正在获取登录二维码…</p>
              )}

              {/* 已检测到小红书登录态：展示提示 + 确认生成按钮（不静默跳转） */}
              {!qrLoading && xhsLoggedIn && (
                <div className="mt-5 flex flex-col items-center">
                  <div className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    ✅ 你已绑定自己的小红书账号（数据采集已就绪）
                  </div>
                  <p className="text-xs text-gray-500 mt-3 text-center leading-relaxed">
                    点击下方按钮，即可用你绑定的账号抓取 3 篇真实学习帖子并结合知识库生成学习路线。
                  </p>
                  <button
                    onClick={() => { setShowGenModal(false); runGenerate({ skipXhs: false }); }}
                    disabled={planLoading}
                    className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#FF2442] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#e51e3c] transition-colors disabled:opacity-60"
                  >
                    {planLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    开始生成学习路线
                  </button>
                </div>
              )}

              {/* 未登录：展示二维码并轮询登录态 */}
              {!qrLoading && !xhsLoggedIn && qrImage && (
                <div className="mt-4 flex flex-col items-center">
                  <div className="relative w-44 h-44">
                    <img src={qrImage} alt="小红书登录二维码" className={'w-44 h-44 rounded-lg border border-gray-200 transition' + (qrLocked ? ' blur-sm opacity-40' : '')} />
                    {qrLocked && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center rounded-lg bg-white/70 text-center px-2">
                        <span className="text-2xl">📱</span>
                        <span className="text-xs text-gray-700 mt-1 font-medium">已扫描</span>
                        <span className="text-[11px] text-gray-500 mt-0.5">请在手机上确认登录</span>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-2 text-center">
                    {qrLocked
                      ? '✅ 二维码已锁定，请勿重复扫码，等待手机确认即可'
                      : `请用小红书 App 扫码登录${qrChecking ? ' · 正在确认登录状态…' : ''}`}
                  </p>
                </div>
              )}

              {!qrLoading && !xhsLoggedIn && qrError && (
                <div className="mt-3 flex flex-col items-center gap-2">
                  <p className="text-xs text-red-500 text-center">{qrError}</p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => chooseLoginXhs()}
                      className="text-xs px-4 py-1.5 rounded-lg bg-[#FF2442] text-white hover:bg-[#e51e3c] transition-colors"
                    >
                      重试获取二维码
                    </button>
                    <button
                      onClick={chooseSkipXhs}
                      className="text-xs px-4 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      跳过，使用知识库
                    </button>
                  </div>
                </div>
              )}

              {!xhsLoggedIn && genNotice && (
                <p className="text-xs text-gray-500 mt-3 text-center leading-relaxed">{genNotice}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default PlanBoard;
