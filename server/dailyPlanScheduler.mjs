// server/dailyPlanScheduler.mjs
// 每日学习结算调度器（文档一/四/七）
// 职责：
//   - 每日检查：完成率、未完成任务、当前 stage 状态、剩余目标日期
//   - 输出是否需要调整（不自动修改计划，交由用户确认）
// 触发：每天 23:59 或 00:00（由 index.mjs 中的定时器调用 runDailySettlement）
import { dailySettlement, stageProgress, computeRisk } from './dailyPlanAdjuster.mjs';

// 计算剩余目标天数
function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a + 'T00:00:00'); const db = new Date(b + 'T00:00:00');
  if (isNaN(da) || isNaN(db)) return null;
  const diff = Math.round((db - da) / 86400000);
  return diff;
}

// 触发每日结算：基于 daily_learning_tasks 与可选 completions，产出分析结论
// 参数：{ tasks, today, completions, dailyCapacityMinutes, targetDate }
// 返回：{ needAdjust, reason, risk, stage, reminders, summary }
export async function runDailySettlement({ tasks, today, completions, dailyCapacityMinutes = 120, targetDate, startDate }) {
  const tDay = today || new Date().toISOString().slice(0, 10);

  const settlement = dailySettlement({
    tasks,
    today: tDay,
    completions,
    dailyCapacityMinutes,
    targetDate,
    startDate,
  });

  const sp = settlement.stage || stageProgress({ tasks });
  const tRemDays = targetDate ? daysBetween(tDay, targetDate) : null;

  const summary = {
    date: tDay,
    completionRate: settlement.reason,
    currentStage: sp.currentStage,
    currentStageProgress: sp.currentProgress,
    remainingTargetDays: tRemDays,
    blockedNextStage: sp.blockedNextStage,
    needAdjust: settlement.needAdjust,
    hasRisk: !!settlement.risk,
  };

  return {
    ...settlement,
    summary,
  };
}

// 由 index.mjs 在定时器（23:59/00:00）调用：仅做分析并（可选）持久化调整记录，不自动改写任务
export function scheduleDailyCheck({ tasks, today, dailyCapacityMinutes, targetDate }) {
  // 占位：实际"是否触发定时器重排"由产品策略决定；当前只产出结算结论
  return runDailySettlement({ tasks, today, dailyCapacityMinutes, targetDate });
}

export default { runDailySettlement, scheduleDailyCheck };
