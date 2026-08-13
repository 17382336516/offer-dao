import { useState, useEffect, useRef } from 'react';
import { ChevronDown, BarChart3, Settings, Check, Clock, PlayCircle, FileText, BookOpen, PlaySquare, AlertCircle, AlertTriangle, X } from 'lucide-react';
import {
  generateMvpPlan,
  getSavedLearningPlan,
  getXhsStatus,
  getXhsQrcode,
  bindXhs,
} from '../lib/api';

// MVP 阶段默认岗位占位（仅作为输入框初始值，不参与任何计划内容生成）
const DEFAULT_JOB = 'AI产品经理';

// 把后端 MVP 返回的 stages 归一为组件使用的字段名。
// 后端结构：stage.resources = { pdf: [], videos: [] }（均为代码回填的真实资源）
function normalizeStages(data) {
  const stages = Array.isArray(data?.stages) ? data.stages : [];
  return stages.map((s) => ({
    ...s,
    pdf_resources: s.resources?.pdf || [],
    video_resources: (s.resources?.videos || []).map((v) => ({ ...v, link: v.url || v.link })),
  }));
}

const statusConfig = {
  completed: { dot: '🟢', label: '已完成', className: 'bg-green-100 text-green-700' },
  'in-progress': { dot: '🟡', label: '进行中', className: 'bg-yellow-100 text-yellow-700' },
  pending: { dot: '⚪', label: '未开始', className: 'bg-gray-100 text-gray-500' },
};

// 单个 PDF 卡片：有章节列章节；无章节显示「全书学习」
function PdfCard({ pdf }) {
  const hasChapters = Array.isArray(pdf.chapters) && pdf.chapters.length > 0;
  // 知识库里除 PDF 外还可能是 md/txt，按真实扩展名显示，避免"打开 PDF"误导
  const ext = (pdf.file || pdf.title || '').split('.').pop()?.toLowerCase() || '';
  const kindLabel = ext === 'pdf' ? '打开 PDF' : ext === 'md' ? '打开文档 (MD)' : ext === 'txt' ? '打开文档 (TXT)' : '打开原文';
  return (
    <div className="flex items-start gap-3 p-3 rounded-xl bg-warm-white/60 border border-gray-100">
      <FileText className="w-4 h-4 text-mint mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium text-gray-800 truncate">{pdf.title}</p>
          {pdf.file && <span className="text-xs text-gray-400 truncate">{pdf.file}</span>}
        </div>
        {hasChapters ? (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {pdf.chapters.map((c, i) => (
              <span key={i} className="tag bg-mint/10 text-mint">{c}</span>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-sm text-gray-500">📖 全书学习（无分章信息，默认全部内容）</p>
        )}
        {pdf.docId && (
          <a href={`/api/rag/file?docId=${encodeURIComponent(pdf.docId)}`} target="_blank" rel="noreferrer" className="text-xs text-blue-500 hover:underline mt-1 inline-block">
            查看
          </a>
        )}
      </div>
    </div>
  );
}

// 阶段卡片：展开后显示 目标/技能/任务/知识库补充(B站+PDF)/缺口
function StageCard({ stage, index, expanded, onToggle }) {
  const isExpanded = expanded === index;
  const status = index === 0 ? statusConfig['in-progress'] : statusConfig.pending;
  const tasks = Array.isArray(stage.tasks) ? stage.tasks : [];

  return (
    <div className="card overflow-hidden">
      <button
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors"
        onClick={() => onToggle(isExpanded ? null : index)}
      >
        <div className="flex items-center gap-4">
          <span className="text-xl">{status.dot}</span>
          <div>
            <h3 className="font-bold text-gray-800">阶段 {index + 1} · {stage.stage}</h3>
            <p className="text-sm text-gray-400">{stage.duration}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`tag ${status.className}`}>
            {status.label}
          </span>
          {isExpanded ? (
            <ChevronDown className="w-5 h-5 text-gray-400" />
          ) : (
            <ChevronDown className="w-5 h-5 text-gray-400 rotate-[-90deg]" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 space-y-4">
          <div className="bg-mint/10 rounded-xl p-4">
            <p className="text-sm text-gray-600">
              <span className="font-medium text-mint">🎯 阶段目标：</span>
              {stage.goal}
            </p>
          </div>

          {stage.skills?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-400 mb-1.5">覆盖技能</p>
              <div className="flex flex-wrap gap-1.5">
                {stage.skills.map((s, i) => (
                  <span key={i} className="tag bg-gray-100 text-gray-600">{s}</span>
                ))}
              </div>
            </div>
          )}

          {tasks.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-400 mb-1.5">实践任务</p>
              <div className="space-y-2">
                {tasks.map((t, i) => (
                  <div key={i} className="flex items-center gap-3 p-2.5 rounded-xl bg-warm-white/50">
                    <PlayCircle className="w-4 h-4 text-gray-300 shrink-0" />
                    <p className="text-sm text-gray-800">{t}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 知识库补充板块 */}
          <div>
            <p className="text-xs font-semibold text-gray-400 mb-1.5 flex items-center gap-1">
              <BookOpen className="w-3.5 h-3.5" /> 知识库补充（PDF 资料）
            </p>
            {stage.pdf_resources?.length > 0 ? (
              <div className="space-y-2">
                {stage.pdf_resources.map((pdf, i) => (
                  <PdfCard key={i} pdf={pdf} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">本阶段暂无 PDF 资料</p>
            )}
          </div>

          {/* B站课程 */}
          {stage.video_resources?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-400 mb-1.5 flex items-center gap-1">
                <PlaySquare className="w-3.5 h-3.5" /> B站课程
              </p>
              <div className="space-y-2">
                {stage.video_resources.map((v, i) => (
                  <a
                    key={i}
                    href={v.link}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 p-3 rounded-xl bg-warm-white/60 border border-gray-100 hover:border-mint transition-colors"
                  >
                    <PlaySquare className="w-4 h-4 text-red-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-800 truncate">{v.title}</p>
                      <p className="text-xs text-gray-400">{v.platform || 'bilibili'}</p>
                    </div>
                    <span className="text-xs text-blue-500">观看 ↗</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* 资源缺口 */}
          {stage.resource_gap && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-100">
              <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-700">{stage.resource_gap}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Plan() {
  const [job, setJob] = useState(DEFAULT_JOB);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedJson, setAdvancedJson] = useState('');
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(0);
  // 异步生成进度（0~100）：提交 /api/mvp/plan 后轮询 /progress，展示进度条
  const [genProgress, setGenProgress] = useState(0);
  const [genStep, setGenStep] = useState('');
  const genTimerRef = useRef(null);

  // 已保存计划相关：用于「是否首次生成」判断与覆盖确认
  const [savedInfo, setSavedInfo] = useState(null); // { exists, job, created_at }
  // 明确的三态：hasExistingPlan / xhsLoggedIn / generationMode
  const hasExistingPlan = !!savedInfo?.exists;
  const [xhsLoggedIn, setXhsLoggedIn] = useState(false);
  const [generationMode, setGenerationMode] = useState(null); // 'xhs_rag' | 'rag_only'
  const [xhsNotice, setXhsNotice] = useState(''); // 小红书降级/未连通提示

  // 三个弹窗，互斥展示：
  const [showOverwrite, setShowOverwrite] = useState(false); // 覆盖确认框（情况二）
  const [showModeChoice, setShowModeChoice] = useState(false); // 生成方式选择框（登录/暂不登录）
  const [showXhsModal, setShowXhsModal] = useState(false); // 小红书扫码框
  const [qrImage, setQrImage] = useState('');
  const [qrLoading, setQrLoading] = useState(false);
  const [qrError, setQrError] = useState('');
  const [qrLocked, setQrLocked] = useState(false); // 已扫码待确认：锁定二维码防重复扫码
  const qrTimerRef = useRef(null);
  const qrPollRef = useRef(0);
  // 覆盖确认态：覆盖确认后进入选择/扫码流程时，最终生成需带 force=true（不影响 generationMode 选择）
  const pendingForceRef = useRef(false);

  // 进入页面：回显已保存的计划，并记录是否已生成过；同时探测小红书登录态
  useEffect(() => {
    let active = true;
    getSavedLearningPlan()
      .then((res) => {
        if (!active || !res) return;
        setSavedInfo(res);
        if (res.exists && res.plan) {
          setPlan(res.plan);
          if (res.job) setJob(res.job);
        }
      })
      .catch(() => { /* 未登录或无计划时忽略 */ });
    // 以「后端按当前用户」返回的登录态为准（每个用户独立授权，不读本地缓存短路）
    getXhsStatus()
      .then((st) => {
        if (active && st && st.loggedIn && !st.notBound) setXhsLoggedIn(true);
        else setXhsLoggedIn(false);
      })
      .catch(() => { if (active) setXhsLoggedIn(false); });
    return () => { active = false; };
  }, []);

  // 组件卸载时清理二维码轮询定时器，避免内存泄漏
  useEffect(() => () => {
    if (qrTimerRef.current) clearInterval(qrTimerRef.current);
    if (genTimerRef.current) clearInterval(genTimerRef.current);
  }, []);

  // 真正执行生成。
  // mode: 'xhs_rag'（小红书数据 + 本地 RAG）| 'rag_only'（仅本地 RAG）
  // force: true 仅代表用户已确认覆盖旧计划，不改变 generationMode
  const runGenerate = async (mode, force = false) => {
    if (mode !== 'xhs_rag' && mode !== 'rag_only') return;
    setGenerationMode(mode);
    setLoading(true);
    setError('');
    setShowOverwrite(false);
    setShowModeChoice(false);
    setXhsNotice(''); // 清空上次的降级提示
    setGenProgress(0);
    setGenStep('提交中');
    try {
      const targetJob = (job || '').trim();
      if (!targetJob) {
        setError('请先填写目标岗位');
        setLoading(false);
        return;
      }
      // 提交任务，立即返回 taskId（后端异步执行，绕开 Render 30s 网关限制）
      const submit = await generateMvpPlan({ job: targetJob, force });
      if (!submit?.taskId) throw new Error('未获取到任务 ID');
      // 轮询进度
      const poll = async () => {
        const p = await getMvpPlanProgress(submit.taskId);
        if (p.status === 'done') {
          clearInterval(genTimerRef.current);
          setGenProgress(100);
          setGenStep('');
          setPlan(p.result);
          setExpanded(0);
          setSavedInfo({ exists: true, job: p.result.job || targetJob, created_at: Date.now() });
          if (p.result?.xhsFallback && mode !== 'rag_only') {
            setXhsNotice(p.result.xhsError || '本次未获取到小红书数据，已使用纯岗位模式生成计划');
          }
          setLoading(false);
          return;
        }
        if (p.status === 'error') {
          clearInterval(genTimerRef.current);
          setGenStep('');
          setError(p.error || '生成失败');
          setLoading(false);
          return;
        }
        setGenProgress(typeof p.progress === 'number' ? p.progress : 0);
        setGenStep(p.step || '生成中');
        // 未结束：继续轮询（interval 已设）
      };
      if (genTimerRef.current) clearInterval(genTimerRef.current);
      genTimerRef.current = setInterval(poll, 2500);
      await poll(); // 立即先查一次
    } catch (e) {
      clearInterval(genTimerRef.current);
      setGenStep('');
      // 后端检测到已有计划：弹出覆盖确认框，由用户决定是否重新生成（同步返回的场景）
      if (e?.code === 'PLAN_EXISTS' || e?.status === 409) {
        setSavedInfo({ exists: true, ...(e.data?.existing || {}) });
        setShowOverwrite(true);
      } else {
        setError(e?.message || '生成失败');
      }
      setLoading(false);
    }
  };

  // 拉取小红书登录二维码并轮询登录状态（仅在用户已选择「登录小红书（推荐）」后调用）
  // force: 透传覆盖确认态（用户此前已确认覆盖旧计划）
  const openXhsLogin = async (force = false) => {
    setShowXhsModal(true);
    setQrLoading(true);
    setQrError('');
    setQrImage('');
    qrPollRef.current = 0;
    // 自动重试获取二维码（MCP Playwright 浏览器已打开 XHS 登录页，
    // 截图失败大多为瞬时问题，重试即可恢复），避免走入 browserLogin 死胡同。
    const retryGetQr = async (maxRetries = 3) => {
      let lastErr = null;
      for (let i = 0; i < maxRetries; i++) {
        try {
          if (i > 0) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
          const d = await getXhsQrcode();
          if (d && d.image) return d;
          if (d && d.alreadyLoggedIn) return d;
          lastErr = d && d.browserLogin ? '二维码图片暂不可用' : '未获取到二维码';
        } catch (e) { lastErr = e.message || '网络异常'; }
      }
      throw new Error(lastErr || '多次重试仍无法获取二维码');
    };
    try {
      const data = await retryGetQr(3);
      if (data.image) {
        setQrImage(data.image);
        setQrLocked(false);
        setQrLoading(false);
      }
      if (qrTimerRef.current) clearInterval(qrTimerRef.current);
      if (data.image) {
        qrTimerRef.current = setInterval(async () => {
          try {
            const st = await getXhsStatus({ bind: true });
            if (st && st.bound) {
              clearInterval(qrTimerRef.current);
              qrTimerRef.current = null;
              setXhsLoggedIn(true);
              setShowXhsModal(false);
              await runGenerate('xhs_rag', force);
              return;
            }
            if (st && st.scanned && !st.canBind) {
              setQrLocked(true);
              setQrError('');
              return;
            }
            if (st && st.canBind) {
              clearInterval(qrTimerRef.current);
              qrTimerRef.current = null;
              await bindXhs().catch(() => {});
              const after = await getXhsStatus({ bind: true });
              if (after && after.bound) {
                setXhsLoggedIn(true);
                setShowXhsModal(false);
                await runGenerate('xhs_rag', force);
              } else {
                setQrError('扫码登录未成功绑定到你的账号（后端无绑定记录）。请重新点击「扫码绑定」重试。');
              }
              return;
            }
            qrPollRef.current += 1;
            if (qrPollRef.current >= 30) {
              clearInterval(qrTimerRef.current);
              qrTimerRef.current = null;
              setQrError('未在手机上检测到登录确认。请确认：① 已用小红书 App 扫码；② 在手机上点击了「确认登录」；③ 二维码未过期。若仍失败，关闭弹窗重新点击「扫码绑定」重试（小红书可能因账号风控临时拒绝）。');
            }
          } catch { /* 轮询失败继续重试 */ }
        }, 2500);
      } else if (data && data.alreadyLoggedIn) {
        // 本机已有一个待绑定的登录会话（如用户刚扫码成功，全局 cookie 已就绪），
        // 直接绑定当前用户并进入 xhs_rag 生成，无需再出码。
        setQrLoading(false);
        await bindXhs().catch(() => {});
        const after = await getXhsStatus({ bind: true });
        if (after && after.bound) {
          setXhsLoggedIn(true);
          setShowXhsModal(false);
          await runGenerate('xhs_rag', force);
        } else {
          setQrError('本机登录会话未成功绑定到你的账号（后端无绑定记录）。请重新点击「扫码绑定」重试。');
        }
      } else if (data && data.loggedIn) {
        // 绑定流程后端已强制只返回二维码（getXhsQrcodeForBind），此分支通常不发生。
        setQrLoading(false);
        await bindXhs().catch(() => {});
        const after2 = await getXhsStatus({ bind: true });
        if (after2 && after2.bound) {
          setXhsLoggedIn(true);
          setShowXhsModal(false);
          await runGenerate('xhs_rag', force);
        } else {
          setQrError('当前登录会话未成功绑定到你的账号（后端无绑定记录）。请重新点击「扫码绑定」重试。');
        }
      } else {
        // 重试后仍无二维码：展示清晰提示，绝不开外部浏览器（会切断 MCP 会话）
        setQrLoading(false);
        setQrError('二维码获取失败（MCP 暂不可用）。请检查后台 MCP 服务是否正常运行，然后关闭弹窗重新选择。');
      }
    } catch (e) {
      setQrLoading(false);
      setQrError('二维码获取失败（' + (e.message || 'MCP 暂不可用') + '）。请关闭弹窗后重新尝试或改用「专注学习模式」。');
    }
  };

  // 关闭二维码弹窗：仅关闭，不触发任何生成（避免绕过选择）
  const closeXhsModal = () => {
    if (qrTimerRef.current) clearInterval(qrTimerRef.current);
    qrTimerRef.current = null;
    setShowXhsModal(false);
    setQrError('');
  };

  // 检测小红书登录态后决定动作（无计划与「覆盖确认后」两条路径共用）
  // force: 仅当已确认覆盖旧计划时传 true
  // 每个用户独立授权：仅当后端返回 loggedIn 且非 notBound（当前用户已绑定）时才视为已授权。
  //   - 已授权 → 直接 xhs_rag 生成（后端实际会去抓小红书帖子）
  //   - 未绑定 / 未登录 / 探测失败 / MCP 未连通 → 弹选择框让用户知情，绝不假装已登录静默生成
  const routeByXhs = async (force = false) => {
    pendingForceRef.current = force;
    try {
      const st = await getXhsStatus();
      if (st && st.bound) {
        setXhsLoggedIn(true);
        // 已绑定自己的账号：直接 xhs_rag 生成，不弹选择框（force 透传覆盖确认）
        await runGenerate('xhs_rag', force);
      } else {
        // 明确未绑定/未登录（或后端返回不可用的真实状态）：弹出生成方式选择框
        setXhsLoggedIn(false);
        setShowModeChoice(true);
      }
    } catch (e) {
      // 探测失败（MCP 未连通/后端异常）：不再「信任后端已登录」直接生成，
      // 而是弹选择框并提示，由用户决定是登录还是用纯岗位模式。
      setXhsLoggedIn(false);
      setXhsNotice('无法连接小红书服务（' + (e?.message || 'MCP 未连通') + '）。请先登录小红书，或选择「专注学习模式」仅基于本地知识库生成。');
      setShowModeChoice(true);
    }
  };

  // 点击「生成学习计划」的统一入口
  const handleGenerate = async () => {
    setError('');
    // 情况二：已有计划 → 必须先弹覆盖确认（无论当前是否登录小红书）
    if (hasExistingPlan) {
      setShowOverwrite(true);
      return;
    }
    // 情况一：无计划 → 检测小红书登录态，决定直接生成或弹选择框
    await routeByXhs(false);
  };

  // 用户在覆盖确认框中确认继续：关闭弹窗后重新检测小红书，再决定链路（force=true 仅代表已确认覆盖）
  const confirmOverwrite = async () => {
    setPlan(null);
    setShowOverwrite(false);
    await routeByXhs(true);
  };

  // 用户在生成方式选择框中选择：登录小红书 or 暂不登录
  const chooseMode = (mode) => {
    setShowModeChoice(false);
    if (mode === 'xhs_rag') {
      // 选择登录：展示二维码，登录成功自动 xhs_rag 生成（保留覆盖确认态）
      openXhsLogin(pendingForceRef.current);
    } else {
      // 选择暂不登录：仅本地 RAG（保留覆盖确认态）
      setXhsNotice('已选择「专注学习模式」：本次仅基于本地知识库生成，未使用小红书数据。');
      runGenerate('rag_only', pendingForceRef.current);
    }
  };

  // MVP：后端返回 stages（阶段级）。兼容历史保存的 learning_plan 结构。
  const stages = plan?.stages ? normalizeStages(plan) : (plan?.learning_plan || []);

  return (
    <div className="min-h-screen bg-warm-white p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        {/* 生成表单 */}
        <div className="card mb-6">
          <h1 className="text-xl font-bold text-gray-800 mb-4">🗺️ 最终学习计划生成</h1>
          <div className="flex flex-col md:flex-row gap-3">
            <input
              value={job}
              onChange={(e) => setJob(e.target.value)}
              placeholder="目标岗位，如 AI产品经理"
              className="flex-1 px-4 py-2.5 rounded-button border border-gray-200 focus:outline-none focus:border-mint"
            />
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="px-6 py-2.5 rounded-button bg-mint text-white font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {loading ? `生成中 ${genProgress}%` : '生成学习计划'}
            </button>
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              disabled={loading}
              className="px-4 py-2.5 rounded-button border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {showAdvanced ? '收起高级' : '高级'}
            </button>
          </div>

          {/* 异步生成进度条：提交后后端后台跑，前端轮询展示实时进度（绕开 Render 30s 网关限制） */}
          {loading && (
            <div className="mt-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full rounded-full bg-mint transition-all duration-500"
                  style={{ width: `${Math.max(genProgress, 5)}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-gray-400">
                {genStep === 'xhs' && '正在采集小红书学习素材…'}
                {genStep === 'skillTree' && '正在分析岗位技能树…'}
                {genStep === 'resources' && '正在匹配真实 PDF / 视频资源…'}
                {genStep === 'stagePlan' && '正在生成阶段学习计划…'}
                {(!genStep || genStep === 'init' || genStep === '提交中') && '正在启动生成任务…'}
              </p>
            </div>
          )}

          {showAdvanced && (
            <div className="mt-3">
              <p className="text-xs text-gray-400 mb-1">
                粘贴 JSON（可选，覆盖示例输入）：{'{ "job": "", "skillTree": {...}, "pdfResources": [...], "videoResources": [...] }'}
              </p>
              <textarea
                value={advancedJson}
                onChange={(e) => setAdvancedJson(e.target.value)}
                rows={6}
                placeholder='{ "skillTree": {...}, "pdfResources": [...], "videoResources": [...] }'
                className="w-full px-3 py-2 rounded-button border border-gray-200 focus:outline-none focus:border-mint font-mono text-xs"
              />
            </div>
          )}

          {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
          {xhsNotice && !error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{xhsNotice}</span>
            </div>
          )}
          {!plan && !loading && !error && (
            <p className="mt-3 text-sm text-gray-400">
              输入目标岗位后点击「生成学习计划」：系统将依次完成 小红书采集 → 技能树抽取 → 技能标准化 → 知识库 PDF 匹配 → B站视频匹配，最终输出阶段级总体学习计划（暂不含每日任务）。
            </p>
          )}
        </div>

        {/* 计划概览 */}
        {plan && (
          <div className="card mb-6">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-gray-800">
                岗位：{plan.job} · 共 {stages.length} 个阶段
              </h2>
              <span className="text-sm text-mint font-medium">总周期 {plan.duration}</span>
            </div>
          </div>
        )}

        {/* 阶段列表 */}
        {plan && (
          <div className="space-y-4">
            {stages.map((stage, i) => (
              <StageCard
                key={i}
                stage={stage}
                index={i}
                expanded={expanded}
                onToggle={setExpanded}
              />
            ))}
          </div>
        )}

        {!plan && !loading && (
          <div className="text-center text-gray-400 py-20">尚未生成学习计划</div>
        )}
      </div>

      {/* 覆盖确认弹框：已生成过学习计划时提示进度将丢失 */}
      {showOverwrite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-50">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-gray-800">确定要重新生成计划吗？</h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-500">
                  新计划会将原本学习计划覆盖，<b className="text-amber-600">原来的学习进度将不会被保存</b>。
                </p>
                {savedInfo?.created_at && (
                  <p className="mt-2 text-xs text-gray-400">
                    当前计划：{savedInfo.job || '未命名岗位'} · 生成于{' '}
                    {new Date(savedInfo.created_at).toLocaleString('zh-CN')}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setShowOverwrite(false)}
                className="rounded-button border border-gray-200 px-5 py-2.5 text-gray-600 transition-colors hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={confirmOverwrite}
                disabled={loading}
                className="rounded-button bg-amber-500 px-5 py-2.5 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {loading ? '生成中…' : '确定重新生成'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 生成方式选择框：未登录小红书时，出现在「覆盖确认之后」或「首次生成时」 */}
      {showModeChoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-gray-800">选择学习计划生成方式</h3>
              <button
                onClick={() => setShowModeChoice(false)}
                className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-gray-500">
              你尚未登录小红书，请选择生成方式。取消将不会生成任何计划。
            </p>

            <div className="mt-5 space-y-3">
              <button
                onClick={() => chooseMode('xhs_rag')}
                className="w-full rounded-button border border-mint bg-mint/5 p-4 text-left transition-colors hover:bg-mint/10"
              >
                <p className="font-medium text-gray-800">🚀 求职增强模式（推荐）</p>
                <p className="mt-1 text-sm text-gray-500">小红书 + 本地知识库：扫码登录后抓取真实学习帖子，让计划贴合一线经验。</p>
              </button>
              <button
                onClick={() => chooseMode('rag_only')}
                className="w-full rounded-button border border-gray-200 p-4 text-left transition-colors hover:bg-gray-50"
              >
                <p className="font-medium text-gray-800">📚 专注学习模式</p>
                <p className="mt-1 text-sm text-gray-500">仅本地知识库：不获取小红书数据，直接基于本地 RAG 生成学习路线。</p>
              </button>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowModeChoice(false)}
                className="rounded-button border border-gray-200 px-5 py-2.5 text-gray-600 transition-colors hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 小红书扫码登录弹框：仅在用户选择「登录小红书（推荐）」后出现 */}
      {showXhsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-gray-800">扫码登录小红书</h3>
              <button
                onClick={closeXhsModal}
                className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-gray-500">
              登录后可抓取真实学习帖子，让计划更贴合一线经验。登录状态会被记住，下次生成不再需要扫码。
            </p>

            <div className="mt-5 flex flex-col items-center">
              {qrLoading && <p className="py-10 text-sm text-gray-400">二维码加载中…</p>}
              {!qrLoading && qrImage && (
                <>
                  <div className="relative h-44 w-44">
                    <img src={qrImage} alt="小红书登录二维码" className={'h-44 w-44 rounded-lg border border-gray-200 transition ' + (qrLocked ? 'blur-sm opacity-40' : '')} />
                    {qrLocked && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center rounded-lg bg-white/70 px-2 text-center">
                        <span className="text-2xl">📱</span>
                        <span className="mt-1 text-xs font-medium text-gray-700">已扫描</span>
                        <span className="mt-0.5 text-[11px] text-gray-500">请在手机上确认登录</span>
                      </div>
                    )}
                  </div>
                  <p className="mt-2 text-center text-xs text-gray-500">
                    {qrLocked ? '✅ 二维码已锁定，请勿重复扫码，等待手机确认即可' : '请用小红书 App 扫码 · 正在等待登录…'}
                  </p>
                </>
              )}
              {!qrLoading && qrError && (
                <div className="py-4 flex flex-col items-center gap-2">
                  <p className="text-center text-xs text-red-500">{qrError}</p>
                  {!qrImage && (
                    <button
                      onClick={() => openXhsLogin(pendingForceRef.current)}
                      className="text-xs px-4 py-1.5 rounded-lg bg-[#FF2442] text-white hover:bg-[#e51e3c] transition-colors"
                    >
                      重试获取二维码
                    </button>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={closeXhsModal}
              className="mt-4 w-full rounded-button border border-gray-200 py-2.5 text-sm text-gray-600 transition-colors hover:bg-gray-50"
            >
              关闭（不登录，暂不生成）
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Plan;
