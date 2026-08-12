import { useEffect, useState, useRef, useLayoutEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, FileText, Copy, RefreshCw, Save, Trash2, Plus } from 'lucide-react';
import {
  saveStudyNote,
  getStudyNotes,
  deleteStudyNote,
  getLearningNoteHistory,
  generateLearningNote,
  getLearningNotes,
  deleteLearningNote,
  getTestMode,
  getCurrentDate,
  saveLearningNote,
  getNoteProgress,
} from '../lib/api';

// 生成链路耗时单行展示（毫秒 → 秒，过长标红提示瓶颈）
function TimingRow({ label, ms }) {
  const s = (ms || 0) / 1000;
  const slow = s >= 20; // 单模块超 20s 视为瓶颈，标红
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-gray-500">{label}</span>
      <span className={slow ? 'text-red-500 font-medium' : 'text-gray-700'}>{s.toFixed(1)}s</span>
    </div>
  );
}

// 「我的学习笔记」双层文件夹：月份 → 日期 → 当日笔记
function NoteTree({ notes, selectedId, onSelect, onDelete, confirmId }) {
  const [openMonths, setOpenMonths] = useState({});
  const [openDays, setOpenDays] = useState({});

  // 按 月份(YYYY-MM) → 日期(note_date) 分组（无 note_date 的旧笔记不纳入双层目录）
  const byMonth = {};
  for (const n of notes) {
    if (!n.note_date) continue;
    const month = n.note_date.slice(0, 7);
    const day = n.note_date;
    (byMonth[month] = byMonth[month] || {});
    (byMonth[month][day] = byMonth[month][day] || []).push(n);
  }
  const monthLabel = (m) => {
    if (m && m.includes('-')) {
      const [y, mo] = m.split('-');
      return `${y}年${Number(mo)}月`;
    }
    return `${m}月`;
  };
  const dayLabel = (d) => {
    const [, mo, da] = d.split('-');
    const dt = new Date(d + 'T00:00:00');
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dt.getDay()];
    return `${mo}-${da} ${wd}`;
  };

  return (
    <div className="space-y-2">
      {Object.keys(byMonth).sort().reverse().map((month) => {
        const days = byMonth[month];
        const monthOpen = openMonths[month] !== false; // 默认展开
        return (
          <div key={month}>
            <button
              onClick={() => setOpenMonths((p) => ({ ...p, [month]: !monthOpen }))}
              className="flex items-center gap-1 w-full text-left font-semibold text-stone-700 py-1 px-1 hover:text-sage transition"
            >
              {monthOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <span>{monthLabel(month)}</span>
            </button>
            {monthOpen && (
              <div className="ml-3 space-y-1 border-l border-gray-100 pl-2">
                {Object.keys(days).sort().reverse().map((day) => {
                  const dayOpen = openDays[`${month}/${day}`] !== false; // 默认展开
                  return (
                    <div key={day}>
                      <button
                        onClick={() => setOpenDays((p) => ({ ...p, [`${month}/${day}`]: !dayOpen }))}
                        className="flex items-center gap-1 w-full text-left text-sm text-gray-500 py-1 px-1 hover:text-gray-700 transition"
                      >
                        {dayOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        <span>📁 {dayLabel(day)}</span>
                      </button>
                      {dayOpen && (
                        <div className="ml-3 space-y-1">
                          {days[day].map((n) => (
                            <div
                              key={n.id}
                              className={`flex items-center gap-1 w-full text-left py-1 px-2 rounded-md text-sm group ${
                                selectedId === n.id ? 'bg-sage/10 text-sage' : 'text-stone-500 hover:bg-stone-100'
                              }`}
                            >
                              <button
                                onClick={() => onSelect(n.id)}
                                className="flex items-center gap-2 flex-1 min-w-0 text-left"
                              >
                                <FileText className="w-3 h-3 shrink-0" />
                                <span className="truncate">{n.title}</span>
                              </button>
                              <button
                                onClick={() => onDelete(n.id)}
                                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition"
                                title="删除"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============ 知识脑图：XMind 风格横向知识树 ============
// 结构：KnowledgeMap(容器) → KnowledgeRoot(中心节点) → KnowledgeBranch(一级) → KnowledgeLeaf(二级)
// 连接线：SVG 三次贝塞尔曲线（圆润 S 形，接近 React Flow bezier / XMind 柔和连接），按真实 DOM 高度测量绘制。

// 一级模块极低饱和辅助色（浅底 + 浅描边 + 对应文字色，不高亮）
const BRANCH_STYLES = [
  { card: 'bg-violet-50/80 border-violet-200/60', text: 'text-violet-700' },   // Transformer：浅紫
  { card: 'bg-sky-50/80 border-sky-200/60',       text: 'text-sky-700' },       // LLM：浅蓝
  { card: 'bg-orange-50/80 border-orange-200/60', text: 'text-orange-700' },    // 核心开发：浅橙
  { card: 'bg-emerald-50/80 border-emerald-200/60', text: 'text-emerald-700' }, // 优化：浅绿
  { card: 'bg-indigo-50/80 border-indigo-200/60', text: 'text-indigo-700' },    // API：浅蓝紫
];

// 固定尺寸（整体缩小为原来的 1/3，便于嵌入笔记正文不占过多空间）
const ROOT_W = 112, ROOT_H = 36;
const BR_W = 108, BR_H = 32, BR_FS = 10;
const LEAF_FS = 10;
const GAP_ROOT_BR = 19;   // Root -> 一级 水平
const GAP_BR_LEAF = 13;   // 一级 -> 二级 水平
const GAP_BR = 12;        // 一级之间垂直
const GAP_LEAF = 4;       // 二级之间垂直

// 圆润贝塞尔连接器：从父中心 (0, rootY) 平滑弯曲接入各子节点中心 (W, cy)
function BezierConnector({ rootY, childCenters, width, color = '#cbd5e1' }) {
  const cx = Math.max(18, width * 0.5); // 控制点水平偏移，决定弯曲程度
  const paths = childCenters.map(
    (cy) => `M 0 ${rootY} C ${cx} ${rootY}, ${width - cx} ${cy}, ${width} ${cy}`
  );
  return (
    <svg width={width} height="100%" className="absolute inset-0 overflow-visible pointer-events-none">
      {paths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      ))}
    </svg>
  );
}

// 二级节点：高度自适应、文字完整、近白底、弱边框、无阴影（XMind 叶子感）
function KnowledgeLeaf({ node, textClass, innerRef }) {
  const label = node?.name || node?.root || '';
  if (!label) return null;
  return (
    <div
      ref={innerRef}
      className={`rounded-md bg-stone-50/40 border border-stone-200/60 px-2 py-1 w-[118px] font-normal ${textClass} leading-tight text-left break-words overflow-hidden`}
      style={{ fontSize: LEAF_FS, minHeight: 25, maxHeight: 42 }}
    >
      {label}
    </div>
  );
}

// 一级节点：根据 children 真实高度自动垂直居中（flex items-center）；连接线按实测高度绘制
function KnowledgeBranch({ node, index = 0 }) {
  const label = node?.name || node?.root || '';
  const children = Array.isArray(node?.children) ? node.children : [];
  const style = BRANCH_STYLES[index % BRANCH_STYLES.length];
  const n = children.length;

  const connectorRef = useRef(null);
  const leafRefs = useRef([]);
  const [geom, setGeom] = useState({ rootY: 0, centers: [] });

  useLayoutEffect(() => {
    const conn = connectorRef.current;
    if (!conn) return;
    const h = conn.clientHeight;
    const centers = leafRefs.current.map((el) =>
      el ? el.offsetTop + el.offsetHeight / 2 : 0
    );
    setGeom({ rootY: h / 2, centers });
  }, [n, JSON.stringify(children)]);

  return (
    <div className="flex items-center">
      {/* 一级节点卡片 */}
      <div
        className={`shrink-0 rounded-lg ${style.card} border flex items-center justify-center px-2 py-1 text-[10px] font-semibold text-gray-900 text-center leading-tight shadow-sm break-words whitespace-normal`}
        style={{ width: BR_W, minHeight: BR_H, height: 'auto' }}
      >
        {label}
      </div>
      {n > 0 && (
        <div ref={connectorRef} className="relative" style={{ width: GAP_BR_LEAF + 56 }}>
          <BezierConnector rootY={geom.rootY} childCenters={geom.centers} width={GAP_BR_LEAF + 56} />
          <div
            className="flex flex-col"
            style={{ gap: GAP_LEAF, paddingLeft: GAP_BR_LEAF + 56 }}
          >
            {children.map((c, i) => (
              <KnowledgeLeaf
                key={i}
                node={c}
                textClass={style.text}
                innerRef={(el) => (leafRefs.current[i] = el)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// 一级节点中心/子中心实测（Root -> 一级 连接线）
function KnowledgeRoot({ node }) {
  const label = node?.root || node?.name || '';
  const children = Array.isArray(node?.children) ? node.children : [];
  const m = children.length;

  const connectorRef = useRef(null);
  const branchRefs = useRef([]);
  const [geom, setGeom] = useState({ rootY: 0, centers: [] });

  useLayoutEffect(() => {
    const conn = connectorRef.current;
    if (!conn) return;
    const h = conn.clientHeight;
    const centers = branchRefs.current.map((el) =>
      el ? el.offsetTop + el.offsetHeight / 2 : 0
    );
    setGeom({ rootY: h / 2, centers });
  }, [m, JSON.stringify(children)]);

  return (
    <div className="flex items-center">
      {/* Root 节点卡片 */}
      <div
        className="shrink-0 rounded-lg bg-white border border-sage/40 flex items-center justify-center px-2 text-[11px] font-semibold text-gray-900 text-center leading-tight shadow-sm break-words overflow-hidden"
        style={{ width: ROOT_W, height: ROOT_H }}
      >
        {label}
      </div>
      {m > 0 && (
        <div ref={connectorRef} className="relative" style={{ width: GAP_ROOT_BR + 48 }}>
          <BezierConnector rootY={geom.rootY} childCenters={geom.centers} width={GAP_ROOT_BR + 48} />
          <div
            className="flex flex-col"
            style={{ gap: GAP_BR, paddingLeft: GAP_ROOT_BR + 48 }}
          >
            {children.map((c, i) => (
              <div key={i} ref={(el) => (branchRefs.current[i] = el)}>
                <KnowledgeBranch node={c} index={i} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function KnowledgeMap({ node }) {
  const data = node && (node.root || node.name) ? node : { root: '', children: [] };
  return (
    <div className="w-full overflow-x-auto overflow-y-visible">
      <div className="min-w-max flex justify-start px-6 py-2" style={{ minWidth: '100%' }}>
        <KnowledgeRoot node={data} />
      </div>
    </div>
  );
}

// 编辑态字段组件（需求十二：内容区域可修改）
function EditField({ label, value, onChange, textarea }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      {textarea ? (
        <textarea
          className="w-full border border-gray-200 rounded-lg p-2 text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-mint"
          rows={3}
          value={value}
          onChange={onChange}
        />
      ) : (
        <input
          className="w-full border border-gray-200 rounded-lg p-2 text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-mint"
          value={value}
          onChange={onChange}
        />
      )}
    </div>
  );
}

export default function Notes() {
  const [notes, setNotes] = useState([]); // 已保存笔记（后端）
  const [loadingList, setLoadingList] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedNote, setSelectedNote] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ title: '', summary: '', keyPoints: '', concepts: '', productInsights: '', examples: '', practice: '', reviewQuestions: '', memory: '' });
  const [savingNote, setSavingNote] = useState(false);
  const [supplementDraft, setSupplementDraft] = useState('');
  const [savingSupplement, setSavingSupplement] = useState(false);

  useEffect(() => {
    setSupplementDraft(selectedNote?.user_note || '');
  }, [selectedNote?.id]);

  // 将 learning_notes 行（content 为 JSON 字符串）归一化为渲染所需对象
  const normalizeNote = (row) => {
    if (!row) return null;
    let parsed = {};
    if (typeof row.content === 'string') {
      try { parsed = JSON.parse(row.content); } catch { parsed = { summary: row.content }; }
    } else if (row.content && typeof row.content === 'object') {
      parsed = row.content;
    }
    return { ...row, ...parsed, title: row.title || parsed.title || '今日学习总结' };
  };

  // 生成区
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [generationNotice, setGenerationNotice] = useState('');
  const [copied, setCopied] = useState(false);
  // 删除二次确认
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const showToast = (msg) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2600);
  };

  // 自动生成今日学习笔记（由 Dashboard 跳转 ?generate=1 触发；生成后直接归档到「我的学习笔记」左侧树）
  const [searchParams, setSearchParams] = useSearchParams();
  const [autoGenerating, setAutoGenerating] = useState(false);
  const [genPhase, setGenPhase] = useState(''); // 'extract' | 'compose' | ''
  // 生成实时进度（由后端 /api/learning-note/progress 轮询）：percent 0-100、label 阶段文案、timings 各模块耗时
  const [genProgress, setGenProgress] = useState(null); // { stage, percent, label } | null
  const [genTimings, setGenTimings] = useState(null); // 完成后展示：{ prepare, videoExtract, pdfExtract, llmGenerate, save, total }

  // 今日日期：与后端 todayDateStr 口径一致 ——
  // 优先级：网站当前日期(currentDate) > 测试模式日期(testDate) > 服务器真实本地日期。
  // 注意：兜底必须用「本地」日期，不能用 toISOString()（那是 UTC，GMT+8 在 UTC 尚未跨日时会慢一天，
  // 导致生成笔记查到前一天、显示成「7号笔记」而非「今日(8号)」）。
  const getLocalDateStr = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const getTodayDateStr = async () => {
    try {
      const cd = await getCurrentDate();
      if (cd && cd.currentDate) return cd.currentDate;
    } catch { /* ignore */ }
    try {
      const tm = await getTestMode();
      if (tm && tm.testMode && tm.testDate) return tm.testDate;
    } catch { /* ignore */ }
    return getLocalDateStr();
  };

  // 同步防重入锁：避免 ?generate=1 在 React 严格模式下被 effect 双调用、或页面快速重渲染导致并发双发请求
  const generatingRef = useRef(false);
  const autoGenerateToday = async () => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    if (autoGenerating) { generatingRef.current = false; return; }
    setAutoGenerating(true);
    setGenPhase('extract');
    setGenProgress({ stage: 'prepare', percent: 5, label: '准备生成环境…' });
    setGenTimings(null);
    showToast('正在提取字幕与资料…');
    // 进度轮询：后端在生成期间持续写入 /api/learning-note/progress，前端每 800ms 拉取真实进度
    const date = searchParams.get('date') || await getTodayDateStr();
    let pollTimer = null;
    const startPoll = () => {
      pollTimer = setInterval(async () => {
        try {
          const p = await getNoteProgress(date);
          if (p && p.progress) setGenProgress({ stage: p.progress.stage, percent: p.progress.percent, label: p.progress.label });
        } catch { /* 轮询失败忽略，继续下一次 */ }
      }, 800);
    };
    startPoll();
    try {
      // 先让「提取中」旋转态渲染出来，避免与同步请求阻塞同一帧
      await new Promise((r) => setTimeout(r, 60));
      setGenPhase('compose');
      showToast('正在生成学习笔记…');
      const r = await generateLearningNote(date);
      // 生成完成：从响应里取各模块实测耗时，便于定位瓶颈
      if (r && r.timings) {
        setGenTimings({
          prepare: r.timings.prepare,
          videoExtract: r.timings.videoExtract,
          pdfExtract: r.timings.pdfExtract,
          llmGenerate: r.timings.llmGenerate,
          save: r.timings.save,
          total: r.totalElapsedMs,
        });
      }
      setGenProgress({ stage: 'done', percent: 100, label: '笔记已生成' });
      setGenPhase('');
      await loadLearningNotes();
      if (r && r.note) {
        setSelectedId(r.note.id);
        setSelectedNote(normalizeNote(r.note));
        if (r.unchanged) {
          // 笔记已存在且内容无新增：明确告知用户已生成、并提示剩余额度，避免误以为无限制或失败
          const rem = typeof r.remaining === 'number' ? r.remaining : (r.canGenerateAgain ? 1 : 0);
          const msg = rem > 0 ? `今日学习笔记已是最新（今日还可生成 ${rem} 次）` : '今日学习笔记已是最新（今日生成次数已用完）';
          setGenerationNotice(msg);
          showToast(msg);
        } else {
          const rem = typeof r.remaining === 'number' ? r.remaining : (r.canGenerateAgain ? 1 : 0);
          setGenerationNotice(`今日学习笔记已生成并归档${rem > 0 ? `（今日还可生成 ${rem} 次）` : ''}`);
          showToast('今日学习笔记已生成并归档');
        }
      } else if (r && r.warning) {
        setGenerationNotice(r.warning);
        showToast(r.warning);
      } else if (r && r.message) {
        setGenerationNotice(r.message);
        showToast(r.message);
      } else {
        console.warn('[autoGenerateToday] 未知响应:', r);
        setGenerationNotice('笔记生成失败，请稍后重试');
        showToast('笔记生成失败，请稍后重试');
      }
    } catch (e) {
      setGenerationNotice(e.message || '生成今日学习笔记失败');
      showToast(e.message || '生成今日学习笔记失败');
    } finally {
      if (pollTimer) clearInterval(pollTimer);
      setGenPhase('');
      setAutoGenerating(false);
      generatingRef.current = false;
    }
  };

  // 读取「我的学习笔记」（每日学习笔记，按月份/日期归档）
  const loadLearningNotes = async (autoSelectToday = false) => {
    let active = true;
    setLoadingList(true);
    try {
      const data = await getLearningNotes();
      if (!active) return;
      const list = data.notes || [];
      setNotes(list);
      // 进入页面且无选中时，默认展示今日（最新日期）那条笔记，让右侧始终有内容
      if (autoSelectToday && !selectedId && list.length) {
        const today = await getTodayDateStr();
        const todayNote = list.find((n) => n.note_date === today) || list[0];
        setSelectedId(todayNote.id);
        setSelectedNote(normalizeNote(todayNote));
      }
    } catch {
      if (active) setNotes([]);
    } finally {
      if (active) setLoadingList(false);
    }
    return () => { active = false; };
  };


  // 进入页面：读取「我的学习笔记」并默认展示今日笔记
  useEffect(() => {
    loadLearningNotes(true);
  }, []);

  // 进入页面：若带 ?generate=1（由 Dashboard「生成今日学习笔记」跳转而来），自动开始生成
  // 用 launchedRef 防止 React 严格模式 effect 双调用导致重复生成
  const launchedRef = useRef(false);
  useEffect(() => {
    if (searchParams.get('generate') === '1' && !launchedRef.current) {
      launchedRef.current = true;
      setSearchParams({});
      autoGenerateToday();
    }
  }, [searchParams]);


  const handleSelectSaved = async (id) => {
    setSelectedId(id);
    setSelectedNote(null);
    setEditing(false);
    try {
      const data = await getLearningNotes(id);
      setSelectedNote(normalizeNote(data.note || null));
    } catch {
      showToast('读取笔记失败');
    }
  };

  // 进入编辑态：把当前笔记字段填入编辑表单
  const startEdit = () => {
    if (!selectedNote) return;
    const f = selectedNote;
      setEditForm({
        title: f.title || '',
        summary: f.summary || '',
        keyPoints: Array.isArray(f.key_points) ? f.key_points.map((x) => `${x.name || ''}｜${x.definition || ''}｜${(x.core作用 || []).join('、')}｜${(x.product_application || []).join('、')}`).join('\n') : '',
        concepts: '', productInsights: '', examples: '', practice: '', reviewQuestions: '',
        userNote: f.user_note || '',
        memory: JSON.stringify(f.mind_map || { root: f.title || '', children: [] }),
      });
    setEditing(true);
  };

  const handleEditChange = (field) => (e) => setEditForm((p) => ({ ...p, [field]: e.target.value }));

  // 保存：覆盖当天笔记（PUT /api/learning-notes），不增加 generated/saved 状态
  const handleSaveNote = async () => {
    if (!selectedNote) return;
    setSavingNote(true);
    try {
      const contentObj = {
        title: editForm.title,
        subtitle: selectedNote.subtitle || '',
        summary: editForm.summary,
        key_points: editForm.keyPoints.split('\n').map((s) => {
          const [name = '', definition = '', core = '', application = ''] = s.split('｜');
          return { name: name.trim(), definition: definition.trim(), core作用: core.split('、').map((x) => x.trim()).filter(Boolean), product_application: application.split('、').map((x) => x.trim()).filter(Boolean) };
        }).filter((x) => x.name),
        mind_map: (() => { try { return JSON.parse(editForm.memory || '{}'); } catch { return { root: editForm.title, children: [] }; } })(),
        user_note: editForm.userNote || '',
      };
      const contentStr = JSON.stringify(contentObj);
      const r = await saveLearningNote({
        id: selectedNote.id,
        title: editForm.title,
        content: contentStr,
        memory: editForm.memory,
      });
      if (r && r.ok) {
        setSelectedNote(normalizeNote(r.note || { ...selectedNote, title: editForm.title, content: contentStr }));
        setEditing(false);
        showToast('学习笔记已保存');
        await loadLearningNotes();
      } else {
        showToast('保存失败，请重试');
      }
    } catch (e) {
      showToast(e.message || '保存失败');
    } finally {
      setSavingNote(false);
    }
  };

  const handleSaveSupplement = async () => {
    if (!selectedNote) return;
    setSavingSupplement(true);
    try {
      const content = { ...selectedNote, user_note: supplementDraft };
      const r = await saveLearningNote({
        id: selectedNote.id,
        title: selectedNote.title,
        content: JSON.stringify(content),
        memory: JSON.stringify(selectedNote.mind_map || { root: selectedNote.title, children: [] }),
      });
      if (!r || !r.ok) throw new Error('保存补充笔记失败');
      setSelectedNote(normalizeNote({ ...selectedNote, content: JSON.stringify(content), user_note: supplementDraft }));
      await loadLearningNotes();
      showToast('补充笔记已保存');
    } catch (e) {
      showToast(e.message || '保存补充笔记失败');
    } finally {
      setSavingSupplement(false);
    }
  };

  // 点击删除：先弹确认框，不直接删
  const askDelete = (id) => setConfirmDeleteId(id);
  const cancelDelete = () => setConfirmDeleteId(null);
  const confirmDelete = async () => {
    const id = confirmDeleteId;
    if (!id) return;
    try {
      await deleteLearningNote(id);
      setNotes((prev) => prev.filter((n) => n.id !== id));
      if (selectedId === id) {
        setSelectedId(null);
        setSelectedNote(null);
      }
      showToast('已删除');
    } catch {
      showToast('删除失败');
    } finally {
      setConfirmDeleteId(null);
    }
  };

  const handleCopy = () => {
    const src = selectedNote ? buildMarkdown(selectedNote) : '';
    if (src) {
      navigator.clipboard.writeText(src);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const buildMarkdown = (d) => {
    if (!d) return '';
    const lines = [];
    lines.push(`# ${d.title}`);
    if (d.summary) lines.push(`\n> ${d.summary}`);
    lines.push('\n## 一、AI学习总结\n' + (d.summary || ''));
    lines.push('\n## 二、核心知识点');
    (d.key_points || []).forEach((k, i) => {
      lines.push(`\n### ${i + 1}. ${k.name || k}`);
      if (k.definition) lines.push(`\n定义\n${k.definition}`);
      if (k.core作用?.length) lines.push(`\n核心作用\n${k.core作用.map((x) => `- ${x}`).join('\n')}`);
      if (k.product_application?.length) lines.push(`\n产品应用\n${k.product_application.map((x) => `- ${x}`).join('\n')}`);
    });
    lines.push(`\n## 三、知识脑图\n${JSON.stringify(d.mind_map || {}, null, 2)}`);
    lines.push('\n## 四、我的理解与补充\n' + (d.user_note || '请输入你的学习理解、疑问或实际应用案例...'));
    return lines.join('\n');
  };

  const renderNoteBody = (d) => (
    <div className="w-full max-w-none space-y-4">
      {/* AI 学习总结：极浅 sage 背景、压缩纵向密度到约 1/3（字号/行高/间距均缩小，内容不重叠） */}
      {d.summary && (
        <section className="bg-sage/10 rounded-lg px-3 py-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sage/15 text-sage text-[10px] font-medium">AI学习总结</span>
          </div>
          <p className="w-full text-[15px] leading-[1.8] text-gray-900">{d.summary}</p>
        </section>
      )}

      {/* 核心知识点：一级卡片化，二级保持文本结构，避免信息过碎 */}
      <section>
        <h2 className="text-[19px] font-bold text-gray-900 mb-3 tracking-tight">核心知识点</h2>
        <div className="w-full space-y-3">
          {(d.key_points || []).map((k, i) => (
            <section key={i} className="w-full rounded-lg bg-stone-50/70 border border-stone-200/70 px-5 py-4">
              <h3 className="text-[16px] font-semibold text-gray-900 mb-3">{i + 1}. {k.name || k}</h3>
              <div className="space-y-1.5">
                {k.definition && (
                  <div>
                    <div className="text-[12px] font-medium text-gray-900 mb-1">定义</div>
                    <p className="text-[14px] leading-[1.7] text-gray-900">{k.definition}</p>
                  </div>
                )}
                {k.core作用?.length > 0 && (
                  <div>
                    <div className="text-[12px] font-bold text-gray-900 mb-1">核心作用</div>
                    <ul className="space-y-0.5">
                      {k.core作用.map((x, j) => <li key={j} className="text-[14px] leading-[1.7] text-gray-900 flex gap-1.5"><span className="text-gray-400">—</span><span>{x}</span></li>)}
                    </ul>
                  </div>
                )}
                {k.product_application?.length > 0 && (
                  <div>
                    <div className="text-[12px] font-medium text-gray-900 mb-1">产品应用</div>
                    <ul className="space-y-0.5">
                      {k.product_application.map((x, j) => <li key={j} className="text-[14px] leading-[1.7] text-gray-900 flex gap-1.5"><span className="text-gray-400">—</span><span>{x}</span></li>)}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          ))}
          {(d.key_points || []).length === 0 && (
            <p className="text-[11px] text-stone-400">暂无知识点</p>
          )}
        </div>
      </section>

      {/* 知识脑图：XMind 风格横向知识树 */}
      <section>
        <h2 className="text-[19px] font-bold text-gray-900 mb-3 tracking-tight">🧠 知识结构图</h2>
        <div className="w-full rounded-lg bg-white border border-stone-200/60 px-3 py-3 overflow-visible">
          <KnowledgeMap node={d.mind_map || { root: d.title, children: [] }} />
        </div>
      </section>

      {/* 我的理解与补充 */}
      <section>
        <h2 className="text-[19px] font-bold text-gray-900 mb-2 tracking-tight">笔记补充</h2>
        <textarea
          value={supplementDraft}
          onChange={(e) => setSupplementDraft(e.target.value)}
          placeholder="请输入你的笔记补充"
          className="w-full min-h-24 rounded-lg border border-dashed border-stone-300 bg-stone-50/40 px-3 py-2 text-[14px] leading-[1.7] text-gray-900 focus:outline-none focus:ring-2 focus:ring-mint/30"
        />
        <div className="mt-2 flex justify-end">
          <button onClick={handleSaveSupplement} disabled={savingSupplement} className="inline-flex items-center gap-1 rounded-lg bg-mint px-4 py-2 text-sm font-medium text-white hover:bg-mint/90 disabled:opacity-50">
            <Save className="w-4 h-4" /> {savingSupplement ? '保存中…' : '保存补充笔记'}
          </button>
        </div>
      </section>
    </div>
  );

  return (
    <div className="min-h-screen bg-stone-50/60 flex">
      {/* 左侧：已保存笔记目录（按 月份 → 日期 双层文件夹） */}
      <div className="w-64 bg-white border-r border-stone-200/70 hidden md:block">
        <div className="p-4 border-b border-stone-100 flex items-center justify-between">
          <h2 className="font-bold text-stone-800">我的学习笔记</h2>
        </div>
        <div className="p-4 overflow-y-auto" style={{ height: 'calc(100vh - 180px)' }}>
          {loadingList && <p className="text-sm text-gray-400">加载中…</p>}
          {!loadingList && notes.length === 0 && (
            <p className="text-sm text-gray-400">暂无保存的笔记，右侧生成后可自动归档。</p>
          )}
          {!loadingList && notes.length > 0 && (
            <NoteTree
              notes={notes}
              selectedId={selectedId}
              onSelect={handleSelectSaved}
              onDelete={askDelete}
              confirmId={confirmDeleteId}
            />
          )}
        </div>
      </div>

      {/* 右侧：生成 / 查看 */}
      <div className="flex-1 p-4 md:p-8">
        <div className="max-w-5xl mx-auto">
          {/* AI 生成学习笔记面板已移除 */}
          {/* 每日学习笔记归档列表已移除：生成结果直接归档到「我的学习笔记」左侧树 */}

          {/* 内容展示 */}
          {selectedNote ? (
            <article className="bg-white mb-4 px-2 md:px-6 py-3 md:py-5 rounded-2xl border border-stone-200/70 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <h1 className="text-base font-bold text-gray-800">{editing ? '编辑学习笔记' : selectedNote.title}</h1>
                <div className="flex gap-2">
                  {!editing ? (
                    <>
                      <button onClick={startEdit} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm bg-mint/10 text-mint hover:bg-mint/20 transition" title="编辑笔记">
                        <Save className="w-4 h-4" /> 编辑笔记
                      </button>
                      <button onClick={handleCopy} className="p-2 rounded-lg hover:bg-gray-100 transition-colors" title="复制">
                        {copied ? <span className="text-green-500 text-sm">已复制</span> : <Copy className="w-5 h-5 text-gray-500" />}
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={handleSaveNote} disabled={savingNote} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm bg-mint text-white hover:bg-mint/90 disabled:opacity-50 transition">
                        <Save className="w-4 h-4" /> {savingNote ? '保存中…' : '保存学习笔记'}
                      </button>
                      <button onClick={() => setEditing(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100 transition">取消</button>
                    </>
                  )}
                </div>
              </div>

              {editing ? (
                <div className="space-y-3 mt-2">
                  <EditField label="标题" value={editForm.title} onChange={handleEditChange('title')} />
                  <EditField label="摘要" value={editForm.summary} onChange={handleEditChange('summary')} textarea />
                  <EditField label="核心知识点（每行：名称｜定义｜核心作用｜产品应用）" value={editForm.keyPoints} onChange={handleEditChange('keyPoints')} textarea />
                  <EditField label="我的理解与补充" value={editForm.userNote || ''} onChange={handleEditChange('userNote')} textarea />
                  <EditField label="核心概念（每行一条）" value={editForm.concepts} onChange={handleEditChange('concepts')} textarea />
                  <EditField label="产品经理视角（每行一条）" value={editForm.productInsights} onChange={handleEditChange('productInsights')} textarea />
                  <EditField label="应用示例（每行一条）" value={editForm.examples} onChange={handleEditChange('examples')} textarea />
                  <EditField label="练习建议（每行一条）" value={editForm.practice} onChange={handleEditChange('practice')} textarea />
                  <EditField label="复习问题（每行一条）" value={editForm.reviewQuestions} onChange={handleEditChange('reviewQuestions')} textarea />
                  <EditField label="记忆设置（JSON）" value={editForm.memory} onChange={handleEditChange('memory')} textarea />
                </div>
              ) : (
                <div className="mt-2">
                  {renderNoteBody(selectedNote)}
                </div>
              )}

              {selectedNote.note_date && !editing && (
                <div className="mt-3 text-xs text-gray-400">📅 {selectedNote.note_date}</div>
              )}
            </article>
          ) : autoGenerating ? (
            <div className="card text-center py-20">
              <div className="w-16 h-16 rounded-full border-4 border-mint/30 border-t-mint mx-auto mb-4 animate-spin" />
              <h2 className="text-lg font-bold text-gray-800 mb-1">正在生成今日学习笔记…</h2>
              <p className="text-sm text-gray-500">
                {genProgress ? genProgress.label : (genPhase === 'extract' ? '正在提取视频字幕与资料…' : '正在整理与生成笔记内容…')}
              </p>
              {/* 真实进度条：百分比由后端 /api/learning-note/progress 轮询驱动 */}
              <div className="w-72 max-w-full mx-auto mt-4">
                <div className="h-2.5 rounded-full bg-gray-200 overflow-hidden">
                  <div
                    className="h-full bg-mint transition-all duration-500 ease-out"
                    style={{ width: `${genProgress ? genProgress.percent : 10}%` }}
                  />
                </div>
                <div className="text-xs text-gray-400 mt-2">
                  {genProgress ? `${genProgress.percent}%` : '10%'} · 请勿关闭本页面
                </div>
              </div>
            </div>
          ) : (
            <div className="card text-center py-20">
              <div className="w-20 h-20 rounded-2xl bg-mint/20 flex items-center justify-center mx-auto mb-4">
                <FileText className="w-10 h-10 text-mint" />
              </div>
              <h2 className="text-xl font-bold text-gray-800 mb-2">还没有打开的笔记</h2>
              <button
                onClick={autoGenerateToday}
                disabled={autoGenerating}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-mint text-white text-sm font-medium hover:bg-mint/90 disabled:opacity-50 transition mb-3"
              >
                <RefreshCw className="w-4 h-4" /> 生成今日学习笔记
              </button>
              <p className="text-gray-500 mb-1">点击上方按钮，基于今日已完成的任务生成笔记。</p>
              <p className="text-xs text-gray-400">已生成的笔记会自动归档到左侧「我的学习笔记」（按月份/日期）。</p>
            </div>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-sm px-4 py-2 rounded-lg z-50">
          {toast}
        </div>
      )}
      {generationNotice && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 bg-white border border-gray-200 shadow-sm text-gray-700 text-sm px-4 py-2 rounded-lg z-40">
          {generationNotice}
        </div>
      )}

      {/* 生成链路各模块实测耗时：便于定位瓶颈、指导下一步优化。仅在刚生成完成且有数据时展示 */}
      {genTimings && (
        <div className="fixed bottom-5 right-5 bg-white border border-gray-200 shadow-md rounded-xl p-3 z-40 w-64 text-xs">
          <div className="font-semibold text-gray-700 mb-2 flex items-center justify-between">
            <span>生成链路耗时</span>
            <button onClick={() => setGenTimings(null)} className="text-gray-400 hover:text-gray-600">✕</button>
          </div>
          <TimingRow label="准备环境" ms={genTimings.prepare} />
          <TimingRow label="视频字幕提取" ms={genTimings.videoExtract} />
          <TimingRow label="PDF 资料提取" ms={genTimings.pdfExtract} />
          <TimingRow label="LLM 笔记生成" ms={genTimings.llmGenerate} />
          <TimingRow label="保存入库" ms={genTimings.save} />
          <div className="border-t border-gray-100 mt-2 pt-2 flex items-center justify-between font-semibold text-gray-800">
            <span>总耗时</span>
            <span>{(genTimings.total / 1000).toFixed(1)}s</span>
          </div>
        </div>
      )}

      {confirmDeleteId != null && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={cancelDelete}
        >
          <div
            className="bg-white rounded-xl shadow-lg w-[340px] max-w-[90vw] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-gray-800 mb-2">确定删除这条笔记吗？</h3>
            <p className="text-sm text-gray-500 mb-1">
              即将删除：
            </p>
            <p className="text-sm text-gray-700 font-medium mb-4 truncate">
              {notes.find((n) => n.id === confirmDeleteId)?.title || `笔记 #${confirmDeleteId}`}
            </p>
            <p className="text-xs text-gray-400 mb-5">删除后不可恢复。</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={cancelDelete}
                className="px-4 py-2 rounded-lg text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 transition"
              >
                取消
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 rounded-lg text-sm text-white bg-red-500 hover:bg-red-600 transition"
              >
                确定删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
