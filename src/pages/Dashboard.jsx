import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Check, Trophy, Calendar, Target, Zap, PartyPopper } from 'lucide-react';
import { generateDailyTasks, daysFromTarget, checkinDailyTask, uncheckinDailyTask, getTodayDailyTask, generateLearningNote, getLearningNote, submitCheckIn, getCheckinStats, getStageProgress, generateStageNote, getStageNote, applyDailyPlanAdjust, reschedulePlan, rescheduleWithinStage, getDailySettlement, getTestMode, setTestDate, getCurrentDate, setCurrentDate, simulateDay, testSettle24, testDailySettle } from '../lib/api';
// 注：今日任务只负责「独立打卡子任务」+「生成今日学习笔记」（笔记生成仅基于已完成资源，每天最多2次）

const typeConfig = {
  read: { emoji: '📖', label: '阅读' },
  video: { emoji: '▶️', label: '视频' },
  code: { emoji: '💻', label: '代码' },
  homework: { emoji: '✍️', label: '作业' },
};

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function Dashboard() {
  const location = useLocation();
  const navigate = useNavigate();
  const stateData = location.state || {};

  const savedJobInfo = useMemo(() => {
    try {
      const saved = localStorage.getItem('offerToJobInfo');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  }, []);

  const jobName = stateData.jobName || savedJobInfo.jobName || 'AI产品经理';
  // 测试模式：是否开启 + 当前模拟日期（仅 TEST_MODE 后端开启时生效，前端不主动开启）
  const [testMode, setTestMode] = useState(false);
  const [testDate, setTestDateState] = useState(null); // 模拟「今天」的日期，null 表示真实日期
  // 常驻：网站认为的「当前日期」覆盖（独立于测试模式，任何环境可用）。null 表示真实日期。
  const [currentDate, setCurrentDateState] = useState(null);
  // 当前「查看日期」：测试模式用 testDate、日期覆盖用 currentDate、否则真实今天。
  // 与 loadToday 内的 targetDate 保持一致，使「距离目标日」随日期切换实时变化。
  const viewDate = testDate || currentDate || todayStr();
  // 距离目标日：以「当前查看日期」为基准（而非系统真实今天），这样切换日历/测试日期时同步变化
  const daysFromView = (targetDate, base) => {
    if (!targetDate || !base) return null;
    const t = new Date(targetDate); t.setHours(0, 0, 0, 0);
    const b = new Date(base); b.setHours(0, 0, 0, 0);
    return Math.max(0, Math.ceil((t - b) / 86400000));
  };
  const days = daysFromView(savedJobInfo.targetDate, viewDate) ?? stateData.days ?? savedJobInfo.days ?? 60;

  const [tasks, setTasks] = useState([]);
  const [todayDate] = useState(todayStr());
  const [today, setToday] = useState(null); // 完整 today 接口返回（含 risk/settlement/stage）
  const [planIndex] = useState(null);
  const [loading, setLoading] = useState(false);
  const [genLoading, setGenLoading] = useState(false);
  const [noPlan, setNoPlan] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const [showToast, setShowToast] = useState('');
  // 真实打卡统计：连续打卡（streak）+ 累计学习（totalStudyDays 由学习开始日→今天，含两端）
  const [streak, setStreak] = useState(0);
  const [totalStudyDays, setTotalStudyDays] = useState(null);
  const [checkedToday, setCheckedToday] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  // 学习笔记板块 ref：生成笔记成功后平滑滚动到该板块
  const notesSectionRef = useRef(null);

  // 今日学习笔记（生成仅基于已完成资源，每天最多 2 次）
  const [note, setNote] = useState(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteProgress, setNoteProgress] = useState(0);
  const [noteGenCount, setNoteGenCount] = useState(0);
  const [noteCanGenerate, setNoteCanGenerate] = useState(false);
  const [noteError, setNoteError] = useState('');
  // 动态计划调整：今日任务是否已根据昨日进度重新安排（规则八：展示延期提示）
  const [adjustment, setAdjustment] = useState(null); // { needed, reason, adjustments, applied }
  const [adjustLoading, setAdjustLoading] = useState(false);
  // 生成过程分阶段提示：'' | 'video' | 'pdf' | 'ai' | 'incremental'
  const [notePhase, setNotePhase] = useState('');
  // NovaForge 阶段知识沉淀
  const [stages, setStages] = useState([]);
  const [stageNote, setStageNote] = useState(null);
  const [stageLoading, setStageLoading] = useState('');
  const [stageError, setStageError] = useState('');

  // 上次成功加载的日期：用于检测「日期自然跳转到新的一天」，触发当前板块内自动重排
  const lastLoadedDateRef = useRef(null);

  // 动态计划调整系统：结算结论（只读展示，不提供主动调整入口）
  const [settlement, setSettlement] = useState(null); // 每日结算结论
  const [stageProgressData, setStageProgressData] = useState(null); // Stage 阶段进度
  // 连续三天未完成 → 提示修改目标日期的轻量弹窗
  const [showThreeDayTip, setShowThreeDayTip] = useState(false);
  // 切换日期（前一日有未完成）→ 提示「已启动重排」
  const [showReschedTip, setShowReschedTip] = useState(false);
  const [tipTargetDate, setTipTargetDate] = useState(savedJobInfo.targetDate || '');
  const [tipLoading, setTipLoading] = useState(false);
  const [tipMsg, setTipMsg] = useState('');
  // 进入下一天但当日任务有未完成 → 提示「后续每日任务已更新」
  const [showNextDayTip, setShowNextDayTip] = useState(false);
  // 模拟结算按钮 loading 态
  const [settleLoading, setSettleLoading] = useState(false);
  const [settle24Loading, setSettle24Loading] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      // 预留：此处可用于挂载时拉取其他一次性数据
    })();
    return () => { active = false; };
  }, []);

  // 拉取真实打卡统计（连续打卡 + 累计学习 + 当天是否已打卡），供按钮文案判断。
  // 统计口径跟随「当前查看日期」（后端 todayDateStr 已含 currentDateOverride），
  // 因此切日期后需重新调用以刷新 checkedToday（避免 8/8 仍显示系统今天的「更新」）。
  const refreshStats = useCallback(() => {
    getCheckinStats()
      .then((s) => {
        setStreak(s.streak || 0);
        setTotalStudyDays(s.totalStudyDays != null ? s.totalStudyDays : null);
        setCheckedToday(!!s.checkedToday);
      })
      .catch(() => { /* 忽略统计失败 */ });
  }, []);

  useEffect(() => {
    refreshStats();
    const handler = () => refreshStats();
    window.addEventListener('checkin-updated', handler);
    return () => { window.removeEventListener('checkin-updated', handler); };
  }, [refreshStats]);

  // 把后端 /api/daily-task/today 的 tasks 映射为前端渲染结构
  const mapTodayToTasks = (today) => {
    const list = (today && today.tasks) || [];
    return list.map((t) => {
      const r = t.resource || {};
      const isVideo = t.type === 'video';
      const chapters = isVideo
        ? (r.part ? [r.part] : [])
        : (r.section || r.range || r.chapter ? [r.section || r.range || r.chapter] : []);
      return {
        id: t.id,                                   // 编码后的子任务 id：dayTaskId__kind__index
        name: t.title,
        type: t.type,
        completed: t.status === 'completed',
        checked: t.status === 'completed', // 本地勾选态：默认与后端完成态一致；提交打卡后才真正 completed
        detail: r.title || '',
        link: isVideo ? (r.url || '') : (r.link || ''),
        chapters,
        pdf: r,
        resource: r,                                // 完整资源指纹（url/part/docId/chapter），供打卡接口精确匹配子任务
        duration: '',
      };
    });
  };

  // 拉取今日任务 + 笔记状态（任务、完成数、笔记可生成标记）
  // options.fromDate：切换前的日期（用于触发「当前板块内按剩余规划日自动重排」），
  //   任何日期切换都按自然日跨天处理，把切换前日期作为 fromDate。
  // options.targetDate：显式指定即将加载的日期（避免 React state 异步更新的竞态）。
  const loadToday = async (options = {}) => {
    // 测试模式：优先拉取状态（必须在 early return 之前，否则今日无任务时控制条不显示）
    try {
      const tm = await getTestMode();
      if (tm && tm.testMode) {
        setTestMode(true);
        const saved = (typeof localStorage !== 'undefined') ? localStorage.getItem('offerdao_testDate') : null;
        if (saved && !tm.testDate) {
          try { const r = await setTestDate(saved); setTestDateState(r.testDate); }
          catch { setTestDateState(tm.testDate || null); }
        } else {
          setTestDateState(tm.testDate || null);
        }
      }
    } catch { /* 生产环境无此接口，忽略 */ }

    // 常驻：同步网站当前日期覆盖（任何环境可用，不抛错）
    try {
      const cd = await getCurrentDate();
      setCurrentDateState(cd && cd.currentDate ? cd.currentDate : null);
    } catch { /* 忽略 */ }

    // 确定「即将加载的日期」：显式传入优先，否则测试模式用 testDate，真实模式用今天
    const targetDate = options.targetDate || testDate || todayStr();
    // 检测日期跳转到新的一天（自然跳转 or 明确传入 fromDate），触发当前板块内自动重排
    let fromDate = options.fromDate || null;
    if (!fromDate && !testDate) {
      // 真实日期场景：用 localStorage 持久化上次加载的真实日期，跨刷新检测自然跳转
      const persisted = (typeof localStorage !== 'undefined') ? localStorage.getItem('offerdao_lastLoadedDate') : null;
      if (persisted && persisted < targetDate) fromDate = persisted;
    }
    if (!fromDate && lastLoadedDateRef.current && lastLoadedDateRef.current < targetDate) {
      fromDate = lastLoadedDateRef.current; // 同会话内自然跳转到新的一天
    }
    // 标记本次切换是否真的触发了重排，供 shiftTestDate 决定是否用「已切换」覆盖提示
    let didResched = false;
    if (fromDate && fromDate !== targetDate) {
      try {
        const r = await rescheduleWithinStage(fromDate);
        // 需求：只要前一日有未完成任务，切换日期时就弹出「已启动重排」（不论重排是否实际改动内容）。
        // 后端在 /daily-task/today 已自动按当前 stage 内重排写库，这里弹提示仅作告知，可×关闭。
        didResched = true;
        setShowReschedTip(true);
        window.setTimeout(() => setShowReschedTip(false), 4000);
      } catch { /* 重排失败不影响加载今日任务 */ }
    }

    try {
      const today = await getTodayDailyTask();
      if (!today || !today.tasks) { setTasks([]); return null; }
      lastLoadedDateRef.current = today.date || targetDate;
      // 真实日期场景：持久化上次加载日期，供跨刷新检测自然跳转
      if (!testDate && typeof localStorage !== 'undefined') {
        localStorage.setItem('offerdao_lastLoadedDate', today.date || targetDate);
      }
      setToday(today);
      setSettlement(today.settlement || null);
      // 连续三天未完成任务 → 自动弹出「建议调整目标日」卡片（仅建议，不强制改，可×关闭）
      if (today.settlement?.risk?.type === 'three_day_incomplete') {
        setShowThreeDayTip(true);
      }
      setStageProgressData(today.stage || null);
      setTasks(mapTodayToTasks(today));
      setNoteGenCount(today.noteGenerateCount || 0);
      setNoteCanGenerate(!!today.canGenerateNote);
      // 动态计划调整探测：后端仅 dry-run，不修改状态；前端展示延期提示并提供「应用」按钮
      setAdjustment(today.adjustment && today.adjustment.needed ? today.adjustment : null);
      // 若当天已有笔记，加载展示（覆盖式，仅最新一份）
      if (today.noteGenerateCount > 0) {
        try {
          const nr = await getLearningNote(today.date);
          if (nr && nr.note) setNote(nr.note);
        } catch { /* 暂无笔记则忽略 */ }
      }
      // 阶段进度：判断是否有已完成阶段可触发 NovaForge
      try {
        const sp = await getStageProgress();
        setStages(Array.isArray(sp?.stages) ? sp.stages : []);
      } catch { /* 忽略 */ }
    } catch { /* 忽略 */ }
    return { today, didResched };
  };

  // 生成学习路线后（PlanBoard 落库切分完成）广播事件：重新拉取最新切分计划
  const refreshToday = () => {
    loadToday();
    setShowToast('今日任务已更新');
    window.setTimeout(() => setShowToast(''), 2600);
  };

  useEffect(() => {
    const handler = () => refreshToday();
    window.addEventListener('plan-daily-updated', handler);
    return () => window.removeEventListener('plan-daily-updated', handler);
  }, [todayDate]);

  // 测试模式：调整模拟日期并重新加载今日任务（offset: -1 上一天 / +1 下一天 / 0 回到真实日期）
  const shiftTestDate = async (offset) => {
    try {
      let next = testDate;
      if (offset === 0) next = null; // 当前日期 = 清除模拟，恢复真实
      else {
        const base = testDate || new Date().toISOString().slice(0, 10);
        const d = new Date(base + 'T00:00:00');
        d.setDate(d.getDate() + offset);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const da = String(d.getDate()).padStart(2, '0');
        next = `${y}-${m}-${da}`;
      }
      const r = await setTestDate(next);
      setTestDateState(r.testDate || null);
      if (typeof localStorage !== 'undefined') {
        if (r.testDate) localStorage.setItem('offerdao_testDate', r.testDate);
        else localStorage.removeItem('offerdao_testDate');
      }
      // 把「切换模拟日期」完全当成自然日跨天：无论 ±1 还是跳天，都把切换前的日期作为
      // fromDate 传给 loadToday，触发当前板块内「今天及之前未完成 + 之后原本任务」整体重排。
      // 例：模拟停在 8/8 未完成任务、切到 8/9 → fromDate=8/8、targetDate=8/9，
      // 8/8 未完成项与 8/9、8/10 原本任务一并重排到 8/9、8/10 两天，避免断层。
      const prevDate = testDate || todayStr();
      const { today, didResched } = await loadToday({ fromDate: prevDate, targetDate: next });
      // 进入下一天：若当日任务有未完成项，弹出「后续每日任务已更新」提示
      if (offset === 1 && today && Array.isArray(today.tasks)) {
        const tasks = today.tasks || [];
        const done = tasks.filter((t) => t.status === 'completed').length;
        if (tasks.length > 0 && done < tasks.length) {
          setShowNextDayTip(true);
        }
      }
      // 若本次切换真的触发了重排，loadToday 内部已弹「已重排」提示，这里不要再覆盖；
      // 仅当未发生重排时，才提示单纯的日期切换结果。
      if (!didResched) {
        setShowToast(offset === 0 ? '已恢复真实日期' : `已切换到 ${r.testDate}`);
        window.setTimeout(() => setShowToast(''), 2400);
      }
    } catch (e) {
      setShowToast('切换测试日期失败：' + (e.message || e));
      window.setTimeout(() => setShowToast(''), 2600);
    }
  };

  // 模拟每日结算（需求十五/十六）：分析当天完成情况，若当天有未完成任务，
  // 则按「当前 stage 内部重排」规则重新规划剩余任务（优先当前 stage、禁止跳章节、视频PDF同stage）
  const simulateDailySettle = async () => {
    if (settleLoading) return;
    setSettleLoading(true);
    try {
      const r = await testDailySettle();
      await loadToday();
      const msg = r?.changed
        ? `模拟每日结算完成：已按当前 stage 内重排剩余任务（${r.reason || ''}）`
        : `模拟每日结算完成：${r?.reason || '当天任务已完成，无需重排'}`;
      setShowToast(msg);
      window.setTimeout(() => setShowToast(''), 3000);
    } catch (e) {
      setShowToast('模拟每日结算失败：' + (e.message || e));
      window.setTimeout(() => setShowToast(''), 3000);
    } finally {
      setSettleLoading(false);
    }
  };

  // 模拟 24 点结算（需求十四）：自动补全当天「已勾选完成但未提交打卡」的子任务，
  // 并自动生成当天学习笔记（仅含当天完成任务，不消耗每日 2 次手动生成额度）
  const simulateSettle24 = async () => {
    if (settle24Loading) return;
    setSettle24Loading(true);
    try {
      const r = await testSettle24();
      await loadToday();
      const parts = [];
      if (r?.addedCheckins) parts.push(`自动补打卡 ${r.addedCheckins} 项`);
      if (r?.note) parts.push('已自动生成当天学习笔记');
      setShowToast('模拟24点结算完成：' + (parts.length ? parts.join('，') : '当日无已完成任务'));
      window.setTimeout(() => setShowToast(''), 3000);
    } catch (e) {
      setShowToast('模拟24点结算失败：' + (e.message || e));
      window.setTimeout(() => setShowToast(''), 3000);
    } finally {
      setSettle24Loading(false);
    }
  };

  // 进入页面：读取今天的每日任务（同时拉取测试模式开关 → 控制条）
  // 注意：必须走 loadToday()（内部先 getTestMode() 再 getTodayDailyTask()），
  // 否则首次进入页面不会调用 getTestMode()，测试模式控制条将永不显示。
  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        await loadToday();
      } catch {
        if (active) setTasks([]);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [todayDate]);

  // 生成今天的每日任务（从学习计划派生）
  const handleGenerate = async () => {
    setGenLoading(true);
    setNoPlan(false);
    try {
      await generateDailyTasks({ planIndex });
      await loadToday();
    } catch (e) {
      if (e.code === 'NO_PLAN') setNoPlan(true);
      setShowToast(e.message || '生成失败');
      window.setTimeout(() => setShowToast(''), 2600);
    } finally {
      setGenLoading(false);
    }
  };

  const completedCount = tasks.filter((t) => t.checked).length; // 用户勾选数（提交后才真正 completed）
  const totalCount = tasks.length;
  const progressPercent = totalCount ? (completedCount / totalCount) * 100 : 0;

  const sortedTasks = useMemo(
    () =>
      [...tasks].sort((a, b) => {
        if (a.completed === b.completed) return 0;
        return a.completed ? 1 : -1;
      }),
    [tasks]
  );

  const handleToggle = (taskId) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    // 已完成的任务：点击即「取消完成」（撤销后端 done 与完成日志，解除勾选/划掉）。
    if (task.completed) {
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, completed: false, checked: false } : t)));
      uncheckinDailyTask(taskId, task.resource).catch((e) => {
        console.error('取消完成失败:', taskId, e);
        setShowToast('取消完成失败');
        window.setTimeout(() => setShowToast(''), 2200);
        loadToday(); // 失败回滚：以服务端真实状态为准
      });
      return;
    }
    // 未完成任务：仅切换本地勾选态（checked），不直接标记完成/调后端。
    // 真正变灰/写入完成是在「提交今日打卡」时，由 handleCheckIn 统一提交勾选项。
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, checked: !t.checked } : t)));
  };

  // 应用动态计划调整：把前序日未完成内容延期到今日（纯代码规则，不调大模型/不新增资源）
  const handleApplyAdjust = async () => {
    if (!adjustment) return;
    setAdjustLoading(true);
    try {
      const r = await applyDailyPlanAdjust(todayDate, 'reschedule');
      if (r && r.changed) {
        setAdjustment({ ...adjustment, applied: true });
        setShowToast('已整体重排剩余计划（未完成内容 + 后续任务已重新规划）');
        await loadToday();
      } else {
        setAdjustment(null);
      }
    } catch (e) {
      setShowToast(e.message || '重新安排失败');
    } finally {
      setAdjustLoading(false);
      window.setTimeout(() => setShowToast(''), 2600);
    }
  };

  // 点击「生成今日学习笔记」→ 跳转到「学习笔记」模块（/notes），由该页面负责进度条与生成
  // 即便今日生成次数已用完也允许跳转（过去查看/保存已生成笔记）
  const handleGenerateNote = () => {
    navigate(`/notes?generate=1&date=${encodeURIComponent(viewDate)}`);
  };

  // 生成阶段知识总结（NovaForge）：输入为该阶段的每日笔记
  const handleGenerateStageNote = async (stageId) => {
    setStageLoading(stageId);
    setStageError('');
    try {
      const r = await generateStageNote(stageId);
      if (r && r.stageNote) {
        setStageNote(r.stageNote);
        setStages((prev) => prev.map((s) => (s.stageId === stageId ? { ...s, hasStageNote: true } : s)));
      } else {
        setStageError('阶段总结生成失败，请稍后重试');
      }
    } catch (e) {
      setStageError(e.message || '生成阶段知识总结失败');
    } finally {
      setStageLoading('');
    }
  };

  const handleViewStageNote = async (stageId) => {
    setStageError('');
    try {
      const r = await getStageNote(stageId);
      if (r && r.stageNote) setStageNote(r.stageNote);
    } catch (e) {
      setStageError(e.message || '读取阶段总结失败');
    }
  };

  const handleCheckIn = async () => {
    // 提交今日打卡：把「所有已勾选」的任务一次性提交给后端（含已完成的，幂等安全）。
    // 根治：后端 checkin 已改为增量写入，多次提交不会互相覆盖；
    // 前端提交全部 checked，保证用户勾选的内容都能落库到 daily_task_completions。
    const pending = tasks.filter((t) => t.checked);
    if (pending.length === 0) {
      setShowToast('请先勾选今天要完成的任务');
      window.setTimeout(() => setShowToast(''), 1800);
      return;
    }
    setCheckingIn(true);
    try {
      // 1) 逐个提交：成功才标记 completed；失败则收集并提示（不再假装成功）
      const failed = [];
      for (const t of pending) {
        try {
          await checkinDailyTask(t.id, t.resource);
          // 乐观更新：本地立即标记完成（变绿/变灰），随后 loadToday 会用后端真实状态校正
          setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, completed: true, checked: true } : x)));
        } catch (e) {
          console.error('任务打卡失败:', t.id, e);
          failed.push(t);
        }
      }

      // 2) 记录当日打卡（连续打卡 +累计学习天数）
      // 显式传入 viewDate（含测试/日期覆盖），保证打卡归属日期与前端查看日期一致
      await submitCheckIn(viewDate);
      setCheckedToday(true);
      refreshStats();
      // 3) 重新拉取今日状态：后端已写入完成态，刷新让状态与数据库一致
      await loadToday();
      setShowCelebration(true);
      window.setTimeout(() => setShowCelebration(false), 1500);
      window.dispatchEvent(new CustomEvent('checkin-updated'));

      if (failed.length) {
        setShowToast(`有 ${failed.length} 个任务打卡失败，请重试`);
        window.setTimeout(() => setShowToast(''), 2200);
      }
    } catch (e) {
      setShowToast('打卡提交失败：' + (e.message || '未知错误'));
      window.setTimeout(() => setShowToast(''), 2200);
    } finally {
      setCheckingIn(false);
    }
  };

  return (
    <div className="min-h-screen bg-warm-white p-4 md:p-6">
      {showCelebration && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-card-white rounded-2xl p-8 text-center animate-bounce-light">
            <PartyPopper className="w-16 h-16 text-cream mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-gray-800 mb-2">打卡成功</h2>
          </div>
        </div>
      )}

      {showToast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-6 py-3 rounded-full text-sm z-50 animate-check">
          {showToast}
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🎯</span>
          <h1 className="text-xl font-bold text-gray-800">Offer到</h1>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-cream/30 flex items-center justify-center">
              <Zap className="w-5 h-5 text-[#E67E22]" />
            </div>
            <div>
              <p className="text-xs text-gray-500">连续打卡</p>
              <p className="text-xl font-bold text-gray-800">{streak}天</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-mint/20 flex items-center justify-center">
              <Trophy className="w-5 h-5 text-mint" />
            </div>
            <div>
              <p className="text-xs text-gray-500">累计学习</p>
              <p className="text-xl font-bold text-gray-800">{totalStudyDays != null ? `${totalStudyDays}天` : '—'}</p>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#FFE4E6] flex items-center justify-center">
              <Calendar className="w-5 h-5 text-[#EF4444]" />
            </div>
            <div className="flex-1">
              <p className="text-xs text-gray-500">距离目标日</p>
              <p className="text-xl font-bold text-gray-800">{days}天</p>
            </div>
            <button
              type="button"
              onClick={() => setShowThreeDayTip(true)}
              className="self-center px-3 py-1.5 text-sm rounded-lg bg-mint/10 text-mint hover:bg-mint/20 transition"
            >修改目标日期</button>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#E8F5F2] flex items-center justify-center">
              <Target className="w-5 h-5 text-mint" />
            </div>
            <div>
              <p className="text-xs text-gray-500">目标岗位</p>
              <p className="text-sm font-bold text-gray-800">{jobName}</p>
            </div>
          </div>
        </div>
      </div>

      {/* 测试模式：模拟日期控制条（仅 TEST_MODE 开启时显示，不修改服务器真实时间） */}
      {testMode && (
        <div className="card mb-6 border-amber-200 bg-amber-50">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-amber-700">🧪 测试模式</span>
            <span className="text-xs text-amber-600">
              模拟日期：<b>{testDate || '（真实日期）'}</b>
            </span>
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={() => shiftTestDate(-1)}
                className="px-3 py-1 text-sm rounded bg-white border border-amber-300 text-amber-700 hover:bg-amber-100"
              >← 上一天</button>
              <button
                type="button"
                onClick={() => shiftTestDate(0)}
                className="px-3 py-1 text-sm rounded bg-white border border-amber-300 text-amber-700 hover:bg-amber-100"
              >当前日期</button>
              <button
                type="button"
                onClick={() => shiftTestDate(1)}
                className="px-3 py-1 text-sm rounded bg-white border border-amber-300 text-amber-700 hover:bg-amber-100"
              >下一天 →</button>
            </div>
          </div>
          <p className="text-[11px] text-amber-500 mt-1">
            切换日期将重新拉取该天的「今日任务 / 打卡 / 笔记生成」，用于模拟用户跨天登录。不改变服务器真实时间，刷新页面后会从本地恢复。
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t border-amber-200">
            <span className="text-xs text-amber-600">模拟结算：</span>
            <button
              type="button"
              onClick={simulateDailySettle}
              disabled={settleLoading}
              className="px-3 py-1 text-sm rounded bg-white border border-amber-300 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
            >{settleLoading ? '结算中…' : '模拟每日结算'}</button>
            <button
              type="button"
              onClick={simulateSettle24}
              disabled={settle24Loading}
              className="px-3 py-1 text-sm rounded bg-white border border-amber-300 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
            >{settle24Loading ? '结算中…' : '模拟24点结算'}</button>
          </div>
        </div>
      )}


      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-800">今日任务</h2>
          <span className="text-sm text-gray-500">
            今日进度
            <span className="inline-block w-24 h-2 bg-gray-100 rounded-full mx-2 overflow-hidden align-middle">
              <span className="inline-block h-full bg-mint rounded-full transition-all duration-500" style={{ width: `${progressPercent}%` }} />
            </span>
            {completedCount}/{totalCount} 完成
          </span>
        </div>

        {/* 动态计划调整系统：仅当用户「连续三天未完成当日所有任务」时，提示建议延长学习日期。
            其余进度落后 / 负荷超能力 / 低完成率类风险横幅不再展示，避免每日任务无意义地越来越重。 */}
        {settlement?.risk?.type === 'three_day_incomplete' && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200">
            <p className="text-sm text-red-800 font-medium mb-1">
              连续未完成当日任务，建议延长学习日期
            </p>
            <p className="text-xs text-red-700">{settlement.risk.message}</p>
          </div>
        )}

        {/* 规则八：动态计划调整提示（延期任务已并入今日） —— 按需求整个板块不显示 */}

        {/* Stage 阶段进度展示（文档八-3） —— 按需求整体前端隐藏 */}

      {/* 连续三天未完成任务 → 提示修改目标日期（不强制，默认不顺延、仅建议，可×关闭） */}
      {showThreeDayTip && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-5 w-full max-w-sm shadow-xl relative">
            <button
              onClick={() => setShowThreeDayTip(false)}
              className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              aria-label="关闭"
            >×</button>
            <h3 className="text-lg font-bold text-gray-800 mb-2 pr-6">修改目标日期</h3>
            <p className="text-xs text-gray-500 mb-3">
              修改目标日期后将根据新的目标日期重新规划剩余任务不改变原计划。
            </p>
            <input
              type="date"
              value={tipTargetDate}
              onChange={(e) => setTipTargetDate(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3"
            />
            {tipMsg && <p className="text-xs text-amber-600 mb-2">{tipMsg}</p>}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowThreeDayTip(false)}
                className="px-3 py-1.5 rounded-button bg-gray-100 text-gray-600 text-sm hover:bg-gray-200"
              >
                暂不改
              </button>
              <button
                onClick={async () => {
                  if (!tipTargetDate) { setTipMsg('请选择目标日期'); return; }
                  setTipLoading(true); setTipMsg('');
                  try {
                    const r = await reschedulePlan(tipTargetDate, '连续三天未完成，用户确认修改目标日期', 'keep_target_date');
                    setShowThreeDayTip(false);
                    if (r?.changed) {
                      setShowToast(r.reason || '已根据新目标日期调整计划');
                      try {
                        const saved = JSON.parse(localStorage.getItem('offerToJobInfo') || '{}');
                        saved.targetDate = tipTargetDate;
                        localStorage.setItem('offerToJobInfo', JSON.stringify(saved));
                      } catch { /* ignore */ }
                      window.location.reload?.();
                    } else {
                      setShowToast(r?.reason || '无需调整');
                    }
                  } catch (e) {
                    setTipMsg(e.message || '调整失败');
                  } finally {
                    setTipLoading(false);
                    window.setTimeout(() => setShowToast(''), 2600);
                  }
                }}
                disabled={tipLoading}
                className="px-3 py-1.5 rounded-button bg-[#EF4444] text-white text-sm font-semibold hover:bg-red-600 disabled:opacity-60"
              >
                {tipLoading ? '调整中…' : '去修改'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 切换日期（前一日有未完成）→ 提示「已启动重排」，可×关闭 */}
      {showReschedTip && (
        <div className="fixed top-24 right-4 z-[60] max-w-xs">
          <div className="bg-white rounded-xl shadow-lg border border-blue-100 p-4 relative">
            <button
              onClick={() => setShowReschedTip(false)}
              className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              aria-label="关闭"
            >×</button>
            <div className="flex items-start gap-2 pr-6">
              <span className="text-blue-500 text-lg leading-none mt-0.5">↻</span>
              <div>
                <p className="text-sm font-semibold text-gray-800">已启动重排</p>
                <p className="text-xs text-gray-500 mt-1">
                  已根据当前 stage 内进度，将昨日未完成任务归入后续日程重新规划。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 进入下一天但当日任务有未完成 → 提示「后续每日任务已更新」 */}
      {showNextDayTip && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-800 p-6 shadow-xl">
            <h3 className="text-base font-semibold text-gray-800 dark:text-white mb-2">后续每日任务已更新</h3>
            <p className="text-sm text-gray-600 dark:text-white/70 mb-5">
              已切换到下一天，当日仍有未完成的任务。请继续完成今日任务后再生成学习笔记。
            </p>
            <div className="flex justify-end">
              <button
                onClick={() => setShowNextDayTip(false)}
                className="px-4 py-2 rounded-button bg-[#E67E22] text-white text-sm font-medium hover:bg-[#d9701a]"
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {loading && <p className="text-sm text-gray-400 py-4 text-center">加载今日任务中…</p>}

          {!loading && noPlan && (
            <div className="text-center py-6">
              <p className="text-sm text-gray-500 mb-3">尚未生成学习计划，无法派生每日任务。</p>
              <a href="/plan" className="text-mint underline text-sm">前往学习计划页生成</a>
            </div>
          )}

          {!loading && !noPlan && tasks.length === 0 && (
            <div className="text-center py-6">
              <p className="text-sm text-gray-500 mb-4">今天还没有任务，点击生成今日学习计划任务。</p>
              <button
                onClick={handleGenerate}
                disabled={genLoading}
                className="px-5 py-2.5 rounded-button bg-mint text-white font-medium hover:bg-[#5EB5A1] transition-all disabled:opacity-50"
              >
                {genLoading ? '生成中…' : '生成今日任务'}
              </button>
            </div>
          )}

          {!loading && tasks.length > 0 && sortedTasks.map((task) => (
            <div
              key={task.id}
              className={`flex items-start gap-3 p-3 rounded-xl transition-all duration-300 ${
                task.completed ? 'bg-gray-50' : 'bg-warm-white/50 hover:bg-warm-white'
              }`}
            >
              <button
                onClick={() => handleToggle(task.id)}
                className={`mt-0.5 w-5 h-5 rounded-lg border-2 flex items-center justify-center transition-all duration-200 shrink-0 ${
                  task.checked ? 'bg-mint border-mint' : 'border-gray-200 hover:border-mint'
                }`}
              >
                {task.checked && <Check className="w-3 h-3 text-white animate-check" />}
              </button>
              <div className="flex-1">
                <p className={`font-medium ${task.completed ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                  {task.name}
                </p>
                {task.detail && (
                  <p className={`text-xs mt-0.5 ${task.completed ? 'text-gray-300' : 'text-gray-500'}`}>{task.detail}</p>
                )}
                {task.chapters && task.chapters.length > 0 && (
                  <div className={`text-xs mt-1 ${task.completed ? 'text-gray-300' : 'text-gray-500'}`}>
                    <span className="font-medium text-gray-500">章节/P：</span>
                    <span className="whitespace-pre-line">{task.chapters.join('\n')}</span>
                  </div>
                )}
                {task.link && (
                  <a
                    href={task.type === 'pdf' && task.pdf?.docId ? `/api/rag/file?docId=${encodeURIComponent(task.pdf.docId)}` : task.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1 mt-1.5 text-xs text-mint hover:text-[#5EB5A1] hover:underline ${task.completed ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    {task.type === 'pdf' ? (
                      <>
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM8 13h8v2H8v-2zm0 4h8v2H8v-2zm0-8h4v2H8V9z"/></svg>
                        {/* PDF 任务：走知识库文件接口打开，而非 B站视频 */}
                        {(() => {
                          const pages = task.pdf?.pages;
                          return pages ? `打开 PDF · 第 ${pages} 页` : '打开 PDF';
                        })()}
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>
                        {/* 链接已带 ?p=N（分P）或 ?t=秒（时间点），提示用户会直接定位到今天要看的位置 */}
                        {(() => {
                          const mp = /[?&]p=(\d+)/.exec(task.link);
                          if (mp) return `打开 B站视频 · 直达 P${mp[1]}`;
                          const mt = /[?&]t=(\d+)/.exec(task.link);
                          if (mt) {
                            const s = Number(mt[1]);
                            const hh = Math.floor(s / 3600);
                            const mm = Math.floor((s % 3600) / 60);
                            return `打开 B站视频 · 从 ${hh ? hh + '小时' : ''}${mm}分 开始`;
                          }
                          return '打开 B站视频';
                        })()}
                      </>
                    )}
                  </a>
                )}
              </div>
              <span className={`text-sm shrink-0 ${task.completed ? 'text-gray-300' : 'text-gray-400'}`}>{task.duration}</span>
            </div>
          ))}
        </div>

        {tasks.length > 0 && (
          <button
            onClick={handleCheckIn}
            className={`w-full mt-5 py-3 rounded-button font-medium transition-all duration-200 ${
              tasks.length === 0 || checkingIn
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-mint text-white hover:bg-[#5EB5A1] active:animate-scale'
            }`}
            disabled={tasks.length === 0 || checkingIn}
          >
            {checkedToday
              ? '更新今日打卡（提交）'
              : '提交今日打卡'}
          </button>
        )}
        </div>{/* /今日任务 card */}

        {/* 学习笔记：与今日任务平级，按「月份 → 日期」两层分组 */}
        <div className="card mt-6" ref={notesSectionRef}>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-2xl">📚</span>
            <h2 className="text-lg font-bold text-gray-800">学习笔记</h2>
            <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
              今日已生成 {noteGenCount}/2 次
            </span>
          </div>

          {/* 生成「今日学习笔记」：点击后跳转到「学习笔记」模块（/notes），进度条在该页面显示 */}
          {completedCount === 0 ? (
            <p className="text-sm text-gray-400 text-center py-3">完成至少 1 个今日任务后即可生成笔记</p>
          ) : (
            <button
              onClick={handleGenerateNote}
              className="w-full py-2.5 rounded-button font-medium transition-all duration-200 bg-[#E67E22] text-white hover:bg-[#d9701a] active:animate-scale"
            >
              {noteGenCount >= 2 ? '今日生成次数已用完'
                : (noteGenCount > 0 ? '更新今日笔记（增量）' : '生成今日学习笔记')}
            </button>
          )}

          {/* 进度条与生成结果展示迁移至「学习笔记」模块（/notes）页面 */}

        {/* 阶段知识沉淀（NovaForge）：仅在阶段全部完成后出现，输入为该阶段每日笔记 */}
        {stages.some((s) => s.finished) && (
          <div className="card mt-6">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-2xl">🎉</span>
              <h2 className="text-lg font-bold text-gray-800">已完成阶段学习</h2>
            </div>

            <div className="space-y-3">
              {stages.filter((s) => s.finished).map((s) => (
                <div key={s.stageId} className="p-3 rounded-lg bg-gray-50 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-800 truncate">{s.stageTitle}</p>
                    <p className="text-xs text-gray-500">
                      已完成 {s.completedDays}/{s.totalDays} 天 · {s.dailyNoteCount} 篇每日笔记
                    </p>
                  </div>
                  {s.hasStageNote ? (
                    <button
                      onClick={() => handleViewStageNote(s.stageId)}
                      className="shrink-0 px-3 py-1.5 rounded-button text-sm bg-white border border-gray-200 text-gray-600 hover:bg-gray-100"
                    >
                      查看阶段总结
                    </button>
                  ) : (
                    <button
                      onClick={() => handleGenerateStageNote(s.stageId)}
                      disabled={!s.canGenerateStageNote || stageLoading === s.stageId}
                      className={`shrink-0 px-3 py-1.5 rounded-button text-sm font-medium ${
                        !s.canGenerateStageNote || stageLoading === s.stageId
                          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                          : 'bg-[#8E44AD] text-white hover:bg-[#7d3b99]'
                      }`}
                    >
                      {stageLoading === s.stageId ? 'NovaForge 整理知识体系…' : '生成阶段知识总结'}
                    </button>
                  )}
                </div>
              ))}
            </div>

            {stageError && <p className="text-sm text-red-500 py-3 text-center">{stageError}</p>}

            {stageNote && (
              <div className="mt-4 space-y-3 text-sm border-t border-gray-100 pt-4">
                <h3 className="text-base font-semibold text-gray-800">{stageNote.title}</h3>
                {stageNote.content?.overview && (
                  <p className="text-gray-600 leading-relaxed">{stageNote.content.overview}</p>
                )}
                {stageNote.knowledgeTree?.length > 0 && (
                  <div>
                    <p className="font-medium text-gray-700 mb-1">知识树</p>
                    <StageTree nodes={stageNote.knowledgeTree} />
                  </div>
                )}
                {stageNote.content?.concepts?.length > 0 && (
                  <div>
                    <p className="font-medium text-gray-700 mb-1">核心概念</p>
                    <ul className="list-disc list-inside text-gray-600 space-y-0.5">
                      {stageNote.content.concepts.map((c, i) => (
                        <li key={i}>{c.name}{c.definition ? ` — ${c.definition}` : ''}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {stageNote.content?.connections?.length > 0 && (
                  <div>
                    <p className="font-medium text-gray-700 mb-1">概念关联</p>
                    <ul className="list-disc list-inside text-gray-600 space-y-0.5">
                      {stageNote.content.connections.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                )}
                {stageNote.sourceNotes?.length > 0 && (
                  <p className="text-xs text-gray-400 pt-2 border-t border-gray-100">
                    本总结聚合自 {stageNote.sourceNotes.length} 篇每日笔记：{stageNote.sourceNotes.map((n) => n.date).join('、')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

// 知识树递归渲染
function StageTree({ nodes, depth = 0 }) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  return (
    <ul className={depth === 0 ? 'space-y-1' : 'ml-4 mt-0.5 space-y-0.5'}>
      {nodes.map((n, i) => (
        <li key={i} className="text-gray-600">
          <span className={depth === 0 ? 'font-medium text-gray-700' : ''}>
            {depth === 0 ? '├── ' : '│   '.repeat(depth) + '└── '}{n.name}
          </span>
          <StageTree nodes={n.children} depth={depth + 1} />
        </li>
      ))}
    </ul>
  );
}
