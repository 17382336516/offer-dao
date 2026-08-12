import fs from 'node:fs';
import path from 'node:path';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function like(value, pattern) {
  const escaped = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(String(value ?? ''));
}

class JsonDatabaseSync {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this.load();
  }

  load() {
    if (fs.existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        return {
          counters: parsed.counters || { users: 0, email_accounts: 0, rag_chunks: 0 },
          tables: {
            // —— 业务库（offerdao.db）只保存业务数据 ——
            users: parsed.tables?.users || [],
            sessions: parsed.tables?.sessions || [],
            profiles: parsed.tables?.profiles || [],
            learning_plans: parsed.tables?.learning_plans || [],
            boss_snapshots: parsed.tables?.boss_snapshots || [],
            direction_configs: parsed.tables?.direction_configs || [],
            email_accounts: parsed.tables?.email_accounts || [],
            interview_events: parsed.tables?.interview_events || [],
            interview_schedules: parsed.tables?.interview_schedules || [],
            daily_tasks: parsed.tables?.daily_tasks || [],
            study_notes: parsed.tables?.study_notes || [],
            daily_learning_tasks: parsed.tables?.daily_learning_tasks || [],
            learning_notes: parsed.tables?.learning_notes || [],
            interview_sessions: parsed.tables?.interview_sessions || [],
            interview_sources: parsed.tables?.interview_sources || [],
            interview_questions: parsed.tables?.interview_questions || [],
            // 增量去重：记录某 session 已消费过的小红书 post_id / rag 问题文本，避免重复追加
            interview_source_ids: parsed.tables?.interview_source_ids || [],
            // 【面试结构化知识层】Interview Question Cache：沉淀高价值结构化面试问题资产。
            // 不进 RAG sqlite，由 JsonDatabaseSync 管理；BGE-M3 仅用于语义去重，不做在线检索。
            interview_question_cache: parsed.tables?.interview_question_cache || [],
            daily_task_completions: parsed.tables?.daily_task_completions || [],
            note_generation_records: parsed.tables?.note_generation_records || [],
            stage_notes: parsed.tables?.stage_notes || [],
            matched_resources: parsed.tables?.matched_resources || [],
            learning_plan_adjustments: parsed.tables?.learning_plan_adjustments || [],
            // 全局热门项目（GitHub Trending 每日快照）：所有用户共享一份，不按用户隔离
            github_trending: parsed.tables?.github_trending || [],
            // 【RAG 边界】rag_docs / rag_chunks 仅作为兼容保留字段。
            // PDF 正文、chunk、向量检索的真实来源一律是独立的 rag.sqlite3（rag.mjs），
            // 业务库严禁将其 rag_chunks 当作真实数据源。以下两行保留仅为兼容旧库文件结构，不再被业务代码主动写入/查询。
            rag_docs: parsed.tables?.rag_docs || [],
            rag_chunks: parsed.tables?.rag_chunks || [],
            // 小红书账号绑定表（用户级隔离，user_id 唯一），兼容旧库。
            xhs_accounts: parsed.tables?.xhs_accounts || [],
            // B站资源/搜索缓存 & 小红书趋势词 & 学习预算（资源匹配链路与 Learning Budget 用，JsonDatabaseSync 兼容分支在下方 JsonStatement）
            bilibili_search_cache: parsed.tables?.bilibili_search_cache || [],
            bilibili_resource_cache: parsed.tables?.bilibili_resource_cache || [],
            xhs_trend_keywords: parsed.tables?.xhs_trend_keywords || [],
            learning_budget: parsed.tables?.learning_budget || [],
          },
        };
      } catch {}
    }
    return {
      counters: { users: 0, email_accounts: 0, rag_chunks: 0 },
      tables: {
        users: [],
        sessions: [],
        profiles: [],
        learning_plans: [],
        boss_snapshots: [],
        direction_configs: [],
        email_accounts: [],
        interview_events: [],
        interview_schedules: [],
        daily_tasks: [],
        study_notes: [],
          daily_learning_tasks: [],
          learning_notes: [],
          interview_sessions: [],
          interview_sources: [],
          interview_questions: [],
          interview_source_ids: [],
          // 【面试结构化知识层】Interview Question Cache（BGE-M3 仅语义去重，不做在线检索）
          interview_question_cache: [],
          daily_task_completions: [],
          note_generation_records: [],
          stage_notes: [],
          matched_resources: [],
          learning_plan_adjustments: [],
          // 全局热门项目（GitHub Trending 每日快照）：所有用户共享一份，不按用户隔离
          github_trending: [],
        // 【RAG 边界】兼容保留字段，见上方说明。
        rag_docs: [],
        rag_chunks: [],
        // 小红书账号绑定表（用户级隔离，user_id 唯一）。
        xhs_accounts: [],
        // B站资源/搜索缓存 & 小红书趋势词 & 学习预算（JsonDatabaseSync 兼容分支）
        bilibili_search_cache: [],
        bilibili_resource_cache: [],
        xhs_trend_keywords: [],
        learning_budget: [],
      },
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }

  nextId(table) {
    this.state.counters[table] = Number(this.state.counters[table] || 0) + 1;
    return this.state.counters[table];
  }

  exec(_sql) {
    return;
  }

  prepare(sql) {
    return new JsonStatement(this, sql);
  }

  // JsonDatabaseSync 是单线程内存库，没有真正的事务。兼容 node:sqlite 的
  // db.transaction(fn) 用法：返回一个函数，调用时直接同步执行 fn（遇到异常
  // 不自动回滚，但 JSON 模式本就无跨语句原子性需求）。无此方法时 plan.mjs
  // 的 upsertXhsTrendKeywords 会抛 "db.transaction is not a function"。
  transaction(fn) {
    return (...args) => fn(...args);
  }
}

class JsonStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.n = normalizeSql(sql);
  }

  run(...args) {
    const t = this.db.state.tables;
    const n = this.n;

    if (n.startsWith('INSERT INTO users (username, password_hash, password_salt, role, tier, created_at) VALUES')) {
      const [username, password_hash, password_salt, role, tier, created_at] = args;
      const existing = t.users.find((u) => u.username === username);
      if (existing) throw new Error('UNIQUE constraint failed: users.username');
      const id = this.db.nextId('users');
      t.users.push({ id, username, password_hash, password_salt, role, tier, created_at, xhs_bound: 0 });
      this.db.save();
      return { lastInsertRowid: id, changes: 1 };
    }

    if (n === 'UPDATE users SET xhs_bound = ? WHERE id = ?' || /^UPDATE users SET xhs_bound = \d+ WHERE id = \?$/.test(n)) {
      const id = args[args.length - 1];
      // 值可能来自占位符参数(args[0])，也可能已内联进字面量 SQL（如 = 1 / = 0），需同时兼容
      const m = n.match(/xhs_bound = (\d+)/);
      const xhs_bound = (m ? parseInt(m[1], 10) : parseInt(args[0], 10)) || 0;
      const row = t.users.find((u) => u.id === id);
      if (!row) return { changes: 0 };
      row.xhs_bound = xhs_bound;
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'UPDATE users SET role = ?, tier = ? WHERE username = ?') {
      const [role, tier, username] = args;
      const row = t.users.find((u) => u.username === username);
      if (!row) return { changes: 0 };
      row.role = role;
      row.tier = tier;
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'UPDATE users SET role = ?, tier = ? WHERE id = ?') {
      const [role, tier, id] = args;
      const row = t.users.find((u) => u.id === id);
      if (!row) return { changes: 0 };
      row.role = role;
      row.tier = tier;
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)') {
      const [token, user_id, expires_at] = args;
      t.sessions = t.sessions.filter((s) => s.token !== token);
      t.sessions.push({ token, user_id, expires_at });
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'DELETE FROM sessions WHERE token = ?') {
      const [token] = args;
      const before = t.sessions.length;
      t.sessions = t.sessions.filter((s) => s.token !== token);
      this.db.save();
      return { changes: before - t.sessions.length };
    }

    if (n.startsWith('INSERT INTO profiles (user_id, job_name, company, direction, subfield, target_date, start_date, jd_text, directions, boss_cookie, xhs_posts, updated_at) VALUES')) {
      const [user_id, job_name, company, direction, subfield, target_date, start_date, jd_text, directions, boss_cookie, xhs_posts, updated_at] = args;
      const existing = t.profiles.find((p) => p.user_id === user_id);
      if (existing) {
        existing.job_name = job_name;
        existing.company = company;
        existing.direction = direction;
        existing.subfield = subfield;
        existing.target_date = target_date;
        existing.start_date = start_date ?? existing.start_date;
        existing.jd_text = jd_text;
        existing.directions = directions;
        existing.boss_cookie = boss_cookie ?? existing.boss_cookie;
        existing.xhs_posts = xhs_posts;
        existing.updated_at = updated_at;
      } else {
        t.profiles.push({ user_id, job_name, company, direction, subfield, target_date, start_date: start_date ?? null, jd_text, directions, boss_cookie, xhs_posts, xhs_post_contents: null, updated_at });
      }
      this.db.save();
      return { changes: 1 };
    }

    if (n.startsWith('INSERT INTO profiles (user_id, boss_cookie, updated_at) VALUES')) {
      const [user_id, boss_cookie, updated_at] = args;
      const existing = t.profiles.find((p) => p.user_id === user_id);
      if (existing) {
        existing.boss_cookie = boss_cookie;
        existing.updated_at = updated_at;
      } else {
        t.profiles.push({ user_id, job_name: null, company: null, direction: null, subfield: null, target_date: null, jd_text: null, directions: null, boss_cookie, xhs_posts: null, xhs_post_contents: null, updated_at });
      }
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'UPDATE profiles SET checkin_dates = ?, updated_at = ? WHERE user_id = ?') {
      const [checkin_dates, updated_at, user_id] = args;
      const row = t.profiles.find((p) => p.user_id === user_id);
      if (row) {
        row.checkin_dates = checkin_dates;
        row.updated_at = updated_at;
      } else {
        t.profiles.push({ user_id, job_name: null, company: null, direction: null, subfield: null, target_date: null, jd_text: null, directions: null, boss_cookie: null, xhs_posts: null, xhs_post_contents: null, checkin_dates, updated_at });
      }
      this.db.save();
      return { changes: 1 };
    }
    if (n === 'UPDATE profiles SET xhs_posts = ?, updated_at = ? WHERE user_id = ?') {
      const [xhs_posts, updated_at, user_id] = args;
      const row = t.profiles.find((p) => p.user_id === user_id);
      if (row) {
        row.xhs_posts = xhs_posts;
        row.updated_at = updated_at;
        this.db.save();
      }
      return { changes: row ? 1 : 0 };
    }

    if (n === 'UPDATE profiles SET xhs_post_contents = ?, updated_at = ? WHERE user_id = ?') {
      const [xhs_post_contents, updated_at, user_id] = args;
      const row = t.profiles.find((p) => p.user_id === user_id);
      if (row) {
        row.xhs_post_contents = xhs_post_contents;
        row.updated_at = updated_at;
        this.db.save();
      }
      return { changes: row ? 1 : 0 };
    }
    if (n === 'UPDATE profiles SET target_date = ?, updated_at = ? WHERE user_id = ?') {
      const [target_date, updated_at, user_id] = args;
      const row = t.profiles.find((p) => p.user_id === user_id);
      if (row) {
        row.target_date = target_date;
        row.updated_at = updated_at;
        this.db.save();
      }
      return { changes: row ? 1 : 0 };
    }
    if (n === 'UPDATE profiles SET last_reschedule_date = ? WHERE user_id = ?') {
      const [last_reschedule_date, user_id] = args;
      const row = t.profiles.find((p) => p.user_id === user_id);
      if (row) {
        row.last_reschedule_date = last_reschedule_date;
        this.db.save();
      } else {
        t.profiles.push({ user_id, last_reschedule_date });
        this.db.save();
      }
      return { changes: 1 };
    }

    if (n.startsWith('INSERT INTO learning_plans')) {
      // 兼容不同列组合：(user_id, job, data, progress, created_at, updated_at)
      // 或 (user_id, job, data, days, progress, created_at, updated_at)
      const [user_id, job, data, a3, a4, a5, a6] = args;
      let days = 0, progress = 0, created_at = a3, updated_at = a4;
      // 7 参数形态：user_id, job, data, days, progress, created_at, updated_at
      if (args.length >= 7) {
        days = a3; progress = a4; created_at = a5; updated_at = a6;
      } else if (args.length === 6) {
        // 6 参数形态：user_id, job, data, progress, created_at, updated_at
        progress = a3; created_at = a4; updated_at = a5;
      }
      const existing = t.learning_plans.find((p) => p.user_id === user_id);
      if (existing) {
        // ON CONFLICT DO UPDATE：保留原 created_at，其余覆盖
        Object.assign(existing, { job, data, days: days || existing.days || 0, progress, updated_at });
      } else {
        t.learning_plans.push({ user_id, job, data, days: days || 0, progress, created_at, updated_at });
      }
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'UPDATE learning_plans SET progress = ?, updated_at = ? WHERE user_id = ?') {
      const [progress, updated_at, user_id] = args;
      const row = t.learning_plans.find((p) => p.user_id === user_id);
      if (!row) return { changes: 0 };
      row.progress = progress;
      row.updated_at = updated_at;
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'DELETE FROM learning_plans WHERE user_id = ?') {
      const [user_id] = args;
      const before = t.learning_plans.length;
      t.learning_plans = t.learning_plans.filter((p) => p.user_id !== user_id);
      this.db.save();
      return { changes: before - t.learning_plans.length };
    }

    if (n === 'DELETE FROM daily_learning_tasks WHERE user_id = ?') {
      const [user_id] = args;
      const before = t.daily_learning_tasks.length;
      t.daily_learning_tasks = t.daily_learning_tasks.filter((r) => r.user_id !== user_id);
      this.db.save();
      return { changes: before - t.daily_learning_tasks.length };
    }

    if (n === 'DELETE FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ?') {
      const [user_id, plan_id] = args;
      const before = t.daily_learning_tasks.length;
      t.daily_learning_tasks = t.daily_learning_tasks.filter((r) => !(r.user_id === user_id && r.plan_id === plan_id));
      this.db.save();
      return { changes: before - t.daily_learning_tasks.length };
    }

    if (n === 'DELETE FROM daily_tasks WHERE user_id = ?') {
      const [user_id] = args;
      const before = t.daily_tasks.length;
      t.daily_tasks = t.daily_tasks.filter((d) => d.user_id !== user_id);
      this.db.save();
      return { changes: before - t.daily_tasks.length };
    }

    if (n.startsWith('INSERT INTO daily_learning_tasks (')) {
      // 兼容 15/20/22 列签名（22 列含 estimated_minutes/reschedule_count/adjust_reason/adjust_reason_type/adjust_reason_detail）。
      const [user_id, plan_id, day_number, stage, skill_id, skill_name, skill_category, skill_level, focus, video_info, pdf_info, estimated_time, status, created_at, task_date, original_day, adjusted_day, estimated_minutes, reschedule_count, adjust_reason, adjust_reason_type, adjust_reason_detail] = args;
      // 唯一键 (user_id, plan_id, day_number)：已存在则覆盖
      const existing = t.daily_learning_tasks.find((r) => r.user_id === user_id && r.plan_id === plan_id && r.day_number === day_number);
      const row = {
        user_id, plan_id, day_number, stage, skill_id, skill_name, skill_category, skill_level, focus,
        video_info, pdf_info, estimated_time, status, created_at, task_date: task_date ?? null,
        original_day: (original_day ?? day_number) ?? null,
        adjusted_day: (adjusted_day ?? day_number) ?? null,
        estimated_minutes: estimated_minutes ?? 0,
        reschedule_count: reschedule_count ?? 0,
        adjust_reason: adjust_reason ?? null,
        adjust_reason_type: adjust_reason_type ?? null,
        adjust_reason_detail: adjust_reason_detail ?? null,
      };
      if (existing) {
        Object.assign(existing, row);
      } else {
        row.id = this.db.nextId('daily_learning_tasks');
        t.daily_learning_tasks.push(row);
      }
      this.db.save();
      return { changes: 1, lastInsertRowid: row.id };
    }

    // learning_plan_adjustments：记录目标日/动态调整原因（含 adjust_type 枚举）
    if (n.startsWith('INSERT INTO learning_plan_adjustments (')) {
      const [user_id, old_target_date, new_target_date, adjust_type, adjust_reason, created_at] = args;
      const row = {
        user_id,
        old_target_date: old_target_date ?? null,
        new_target_date: new_target_date ?? null,
        adjust_type: adjust_type ?? null,
        adjust_reason: adjust_reason ?? null,
        created_at: created_at ?? Date.now(),
      };
      row.id = this.db.nextId('learning_plan_adjustments');
      t.learning_plan_adjustments.push(row);
      this.db.save();
      return { changes: 1, lastInsertRowid: row.id };
    }
    if (n === 'SELECT * FROM learning_plan_adjustments WHERE user_id = ? ORDER BY created_at DESC') {
      const [user_id] = args;
      return t.learning_plan_adjustments.filter((r) => r.user_id === user_id).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    }

    // learning_notes：按 (user_id, task_id) 唯一，重复插入覆盖
    if (n === 'DELETE FROM learning_notes WHERE user_id = ? AND task_id = ?') {
      const [user_id, task_id] = args;
      const before = t.learning_notes.length;
      t.learning_notes = t.learning_notes.filter((r) => !(r.user_id === user_id && r.task_id === task_id));
      this.db.save();
      return { changes: before - t.learning_notes.length };
    }
    // —— 新增：每日独立资源完成记录（真实学习行为日志）——
    if (n.startsWith('INSERT OR IGNORE INTO daily_task_completions (') || n.startsWith('INSERT INTO daily_task_completions (')) {
      const [user_id, task_id, date, resource_type, resource_key, resource_info, completed_at] = args;
      // 同一用户、同一学习日、同一资源才算重复；同一资源跨日期重新学习应允许记录。
      const exists = t.daily_task_completions.find((r) => r.user_id === user_id && r.task_id === task_id && r.date === date && r.resource_key === resource_key);
      if (!exists) {
        t.daily_task_completions.push({
          id: this.db.nextId('daily_task_completions'),
          user_id, task_id, date, resource_type, resource_key, resource_info, completed_at,
        });
        this.db.save();
      }
      return { changes: exists ? 0 : 1, lastInsertRowid: exists ? (exists.id || 0) : t.daily_task_completions[t.daily_task_completions.length - 1].id };
    }
    // —— 新增：每日完成记录按天整体覆盖前清理（DELETE）——
    if (n === 'DELETE FROM daily_task_completions WHERE user_id = ? AND date = ? AND task_id = ?') {
      const [user_id, date, task_id] = args;
      const before = t.daily_task_completions.length;
      t.daily_task_completions = t.daily_task_completions.filter(
        (r) => !(r.user_id === user_id && r.date === date && r.task_id === task_id)
      );
      this.db.save();
      return { changes: before - t.daily_task_completions.length };
    }
    // —— 新增：每日笔记生成次数限制记录 ——
    if (n.startsWith('INSERT OR IGNORE INTO note_generation_records (') || n.startsWith('INSERT INTO note_generation_records (')) {
      const [user_id, note_date, generation_index, created_at] = args;
      const exists = t.note_generation_records.find((r) => r.user_id === user_id && r.note_date === note_date && r.generation_index === generation_index);
      if (!exists) {
        t.note_generation_records.push({
          id: this.db.nextId('note_generation_records'),
          user_id, note_date, generation_index, created_at,
        });
        this.db.save();
      }
      return { changes: exists ? 0 : 1, lastInsertRowid: exists ? (exists.id || 0) : t.note_generation_records[t.note_generation_records.length - 1].id };
    }
    // —— 新增：stage_notes（NovaForge 阶段知识沉淀），一个 stage 对应一份 ——
    if (n.startsWith('INSERT INTO stage_notes (')) {
      const [user_id, plan_id, stage_id, stage_title, title, content, knowledge_tree, source_notes, created_at, updated_at] = args;
      const existing = t.stage_notes.find((r) => r.user_id === user_id && r.stage_id === stage_id);
      if (existing) {
        Object.assign(existing, { plan_id, stage_title, title, content, knowledge_tree, source_notes, updated_at });
        this.db.save();
        return { changes: 1, lastInsertRowid: existing.id };
      }
      const row = { id: this.db.nextId('stage_notes'), user_id, plan_id, stage_id, stage_title, title, content, knowledge_tree, source_notes, created_at, updated_at };
      t.stage_notes.push(row);
      this.db.save();
      return { changes: 1, lastInsertRowid: row.id };
    }

    // —— 新增：learning_notes 扩展写入（含 note_date/generation_count/source_tasks/stage_id 等列）——
    // 注意：SQL 中 stage / skill_id / skill_name 三列写死为 ''，因此占位符只有 12 个。
    if (n.startsWith('INSERT INTO learning_notes (user_id, task_id, stage, skill_id, skill_name, title, content, created_at, updated_at, note_date, month, day, generation_count, source_tasks, stage_id)')) {
      const [user_id, task_id, title, content, created_at, updated_at, note_date, month, day, generation_count, source_tasks, stage_id] = args;
      const row = { id: this.db.nextId('learning_notes'), user_id, task_id, stage: '', skill_id: '', skill_name: '', title, content, created_at, updated_at, note_date, month, day, generation_count, source_tasks, stage_id };
      t.learning_notes.push(row);
      this.db.save();
      return { changes: 1, lastInsertRowid: row.id };
    }
    if (n.startsWith('UPDATE learning_notes SET title = ?, content = ?, generation_count = ?, source_tasks = ?, updated_at = ?, month = ?, day = ?, stage_id = ?')) {
      const [title, content, generation_count, source_tasks, updated_at, month, day, stage_id, id] = args;
      const existing = t.learning_notes.find((r) => r.id === id);
      if (existing) {
        Object.assign(existing, { title, content, generation_count, source_tasks, updated_at, month, day, stage_id });
        this.db.save();
        return { changes: 1 };
      }
      return { changes: 0 };
    }
    if (n.startsWith('INSERT INTO learning_notes (user_id, task_id, stage, skill_id, skill_name, title, content, created_at, updated_at, note_date, month, day, generation_count, source_tasks)')) {
      const [user_id, task_id, title, content, created_at, updated_at, note_date, month, day, generation_count, source_tasks] = args;
      const row = { id: this.db.nextId('learning_notes'), user_id, task_id, stage: '', skill_id: '', skill_name: '', title, content, created_at, updated_at, note_date, month, day, generation_count, source_tasks };
      t.learning_notes.push(row);
      this.db.save();
      return { changes: 1, lastInsertRowid: row.id };
    }
    if (n.startsWith('UPDATE learning_notes SET title = ?, content = ?, generation_count = ?, source_tasks = ?, updated_at = ?, month = ?, day = ?')) {
      const [title, content, generation_count, source_tasks, updated_at, month, day, id] = args;
      const existing = t.learning_notes.find((r) => r.id === id);
      if (existing) {
        Object.assign(existing, { title, content, generation_count, source_tasks, updated_at, month, day });
        this.db.save();
        return { changes: 1 };
      }
      return { changes: 0 };
    }
    if (n.startsWith('INSERT INTO learning_notes (')) {
      const [user_id, task_id, stage, skill_id, skill_name, title, content, created_at] = args;
      const existing = t.learning_notes.find((r) => r.user_id === user_id && r.task_id === task_id);
      const row = { user_id, task_id, stage, skill_id, skill_name, title, content, created_at };
      if (existing) {
        Object.assign(existing, row);
        row.id = existing.id;
      } else {
        row.id = this.db.nextId('learning_notes');
        t.learning_notes.push(row);
      }
      this.db.save();
      return { changes: 1, lastInsertRowid: row.id };
    }
    if (n.startsWith('UPDATE learning_notes SET ')) {
      const [stage, skill_id, skill_name, title, content, created_at, id] = args;
      const existing = t.learning_notes.find((r) => r.id === id);
      if (existing) {
        Object.assign(existing, { stage, skill_id, skill_name, title, content, created_at });
      }
      this.db.save();
      return { changes: existing ? 1 : 0, lastInsertRowid: id };
    }
    // —— matched_resources（资源缓存层）：每位用户按 plan_id 唯一；重存前先清空 ——
    if (n === 'DELETE FROM matched_resources WHERE plan_id = ?') {
      const [plan_id] = args;
      const before = t.matched_resources.length;
      t.matched_resources = t.matched_resources.filter((r) => r.plan_id !== plan_id);
      if (t.matched_resources.length !== before) this.db.save();
      return { changes: before - t.matched_resources.length };
    }
    if (n.startsWith('INSERT INTO matched_resources (')) {
      const [plan_id, skill_id, resource_type, title, url, doc_id, duration, author, parts, metadata, created_at] = args;
      // 唯一键 (plan_id, skill_id, resource_type, doc_id, url)：已存在则覆盖
      const existing = t.matched_resources.find((r) =>
        r.plan_id === plan_id && r.skill_id === skill_id && r.resource_type === resource_type &&
        r.doc_id === doc_id && r.url === url);
      const row = { plan_id, skill_id, resource_type, title, url, doc_id, duration, author, parts, metadata, created_at };
      if (existing) {
        Object.assign(existing, row);
        row.id = existing.id;
      } else {
        row.id = this.db.nextId('matched_resources');
        t.matched_resources.push(row);
      }
      this.db.save();
      return { changes: 1, lastInsertRowid: row.id };
    }
    if (n === "UPDATE daily_learning_tasks SET status = 'completed' WHERE id = ?") {
      const [id] = args;
      const r = t.daily_learning_tasks.find((x) => x.id === id);
      if (!r) return { changes: 0 };
      r.status = 'completed';
      this.db.save();
      return { changes: 1 };
    }
    if (n === "UPDATE daily_learning_tasks SET status = 'pending' WHERE id = ?") {
      const [id] = args;
      const r = t.daily_learning_tasks.find((x) => x.id === id);
      if (!r) return { changes: 0 };
      r.status = 'pending';
      this.db.save();
      return { changes: 1 };
    }
    // 子任务打卡：写回 video_info / pdf_info 的 done 标记
    if (n === 'UPDATE daily_learning_tasks SET video_info = ? WHERE id = ?'
        || n === 'UPDATE daily_learning_tasks SET pdf_info = ? WHERE id = ?') {
      const col = n.includes('video_info') ? 'video_info' : 'pdf_info';
      const [val, id] = args;
      const r = t.daily_learning_tasks.find((x) => x.id === id);
      if (!r) return { changes: 0 };
      r[col] = val;
      this.db.save();
      return { changes: 1 };
    }
    // 今日任务重排预览写回：同步视频/PDF/阶段到今日行，使展示与打卡定位一致
    if (n === 'UPDATE daily_learning_tasks SET video_info = ?, pdf_info = ?, stage = ? WHERE id = ?') {
      const [video_info, pdf_info, stage, id] = args;
      const r = t.daily_learning_tasks.find((x) => x.id === id);
      if (!r) return { changes: 0 };
      r.video_info = video_info;
      r.pdf_info = pdf_info;
      if (stage != null) r.stage = stage;
      this.db.save();
      return { changes: 1 };
    }
    // 动态计划调整：整体更新某 day 行（含调整原因类型/详情）
    if (n === 'UPDATE daily_learning_tasks SET stage = ?, skill_id = ?, skill_name = ?, skill_category = ?, skill_level = ?, focus = ?, video_info = ?, pdf_info = ?, estimated_time = ?, status = ?, updated_at = ?, original_day = ?, adjusted_day = ?, estimated_minutes = ?, reschedule_count = ?, adjust_reason = ?, adjust_reason_type = ?, adjust_reason_detail = ? WHERE user_id = ? AND plan_id = ? AND day_number = ?') {
      const [stage, skill_id, skill_name, skill_category, skill_level, focus, video_info, pdf_info, estimated_time, status, updated_at, original_day, adjusted_day, estimated_minutes, reschedule_count, adjust_reason, adjust_reason_type, adjust_reason_detail, user_id, plan_id, day_number] = args;
      const r = t.daily_learning_tasks.find((x) => x.user_id === user_id && x.plan_id === plan_id && x.day_number === day_number);
      if (!r) return { changes: 0 };
      Object.assign(r, { stage, skill_id, skill_name, skill_category, skill_level, focus, video_info, pdf_info, estimated_time, status, updated_at, original_day, adjusted_day, estimated_minutes, reschedule_count, adjust_reason, adjust_reason_type, adjust_reason_detail });
      this.db.save();
      return { changes: 1 };
    }

    if (n.startsWith('INSERT INTO boss_snapshots (')) {
      const [keyword, direction_id, total, big_tech_count, campus_count, jobs_json, requirements, summary, source, warning, fetched_at, fetched_date] = args;
      const existing = t.boss_snapshots.find((r) => r.keyword === keyword);
      const row = { keyword, direction_id, total, big_tech_count, campus_count, jobs_json, requirements, summary, source, warning, fetched_at, fetched_date };
      if (existing) Object.assign(existing, row);
      else t.boss_snapshots.push(row);
      this.db.save();
      return { changes: 1 };
    }

    if (n.startsWith('INSERT INTO direction_configs (')) {
      const [id, name, keyword, enabled, fetch_count, sample_count, sort_order, created_at, updated_at] = args;
      const existing = t.direction_configs.find((d) => d.id === id);
      if (!existing) {
        t.direction_configs.push({ id, name, keyword, enabled, fetch_count, sample_count, sort_order, created_at, updated_at });
        this.db.save();
        return { changes: 1 };
      }
      return { changes: 0 };
    }

    if (n.startsWith('INSERT INTO email_accounts (')) {
      const [user_id, provider, email, auth_code, imap_host, imap_port, smtp_host, smtp_port, enabled, polling_minutes, updated_at] = args;
      const existing = t.email_accounts.find((d) => d.user_id === user_id && d.email === email);
      const row = { user_id, provider, email, auth_code, imap_host, imap_port, smtp_host, smtp_port, enabled, polling_minutes, updated_at };
      if (existing) {
        Object.assign(existing, row);
        if (existing.account_id == null) existing.account_id = this.db.nextId('email_accounts');
      } else {
        row.account_id = this.db.nextId('email_accounts');
        t.email_accounts.push(row);
      }
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'DELETE FROM email_accounts WHERE user_id = ? AND email = ?') {
      const [user_id, email] = args;
      const before = t.email_accounts.length;
      t.email_accounts = t.email_accounts.filter((d) => !(d.user_id === user_id && d.email === email));
      const changed = t.email_accounts.length !== before;
      if (changed) this.db.save();
      return { changes: changed ? 1 : 0 };
    }

    if (n.startsWith('INSERT INTO interview_events (')) {
      const [id, user_id, company, role, sender, subject, event_date, period, event_time, preview, source, status, created_at, updated_at] = args;
      const existing = t.interview_events.find((d) => d.id === id);
      const row = { id, user_id, company, role, sender, subject, event_date, period, event_time, preview, source, status, created_at, updated_at };
      if (existing) {
        Object.assign(existing, row, { created_at: existing.created_at || created_at, status: existing.status || status });
      } else {
        t.interview_events.push(row);
      }
      this.db.save();
      return { changes: 1 };
    }

    if (n.startsWith('INSERT INTO interview_schedules (')) {
      const [id, user_id, event_id, company, role, event_date, period, event_time, status, created_at, updated_at] = args;
      const existing = t.interview_schedules.find((d) => d.id === id);
      const row = { id, user_id, event_id, company, role, event_date, period, event_time, status, created_at, updated_at };
      if (existing) Object.assign(existing, row);
      else t.interview_schedules.push(row);
      this.db.save();
      return { changes: 1 };
    }
    if (n.startsWith('INSERT INTO interview_sessions (')) {
      const [id, user_id, company, role, round, created_at] = args;
      const existing = t.interview_sessions.find((d) => d.id === id);
      const row = { id, user_id, company, role, round, created_at };
      if (existing) Object.assign(existing, row);
      else t.interview_sessions.push(row);
      this.db.save();
      return { changes: 1 };
    }
    if (n === 'UPDATE interview_sessions SET updated_at = ? WHERE id = ?') {
      const [updated_at, id] = args;
      const row = t.interview_sessions.find((d) => d.id === id);
      if (row) { row.updated_at = updated_at; this.db.save(); return { changes: 1 }; }
      return { changes: 0 };
    }
    if (n.startsWith('INSERT INTO interview_sources (')) {
      const [session_id, source_type, content, metadata, created_at] = args;
      t.interview_sources.push({ id: `ivs_${Date.now()}_${t.interview_sources.length}`, session_id, source_type, content, metadata, created_at });
      this.db.save();
      return { changes: 1 };
    }
    if (n.startsWith('INSERT INTO interview_questions (')) {
      const [session_id, question, type, answer, answer_framework, prepare_direction, created_at] = args;
      t.interview_questions.push({ id: `ivq_${Date.now()}_${t.interview_questions.length}`, session_id, question, type, answer, answer_framework, prepare_direction, created_at });
      this.db.save();
      return { changes: 1 };
    }
    if (n.startsWith('INSERT INTO interview_source_ids (')) {
      const [session_id, source_type, ref_id, created_at] = args;
      t.interview_source_ids.push({ id: `ivsrc_${Date.now()}_${t.interview_source_ids.length}`, session_id, source_type, ref_id, created_at });
      this.db.save();
      return { changes: 1 };
    }
    // ===== Interview Question Cache（结构化面试问题资产层）=====
    if (n.startsWith('INSERT INTO interview_question_cache (')) {
      const [question, normalized_question, question_type, answer, source_chunk_id, company, position, round, source, question_embedding, hit_count, created_time] = args;
      t.interview_question_cache.push({
        id: `iqc_${Date.now()}_${t.interview_question_cache.length}`,
        question, normalized_question, question_type, answer,
        source_chunk_id: source_chunk_id ?? '[]',
        company: company ?? null, position: position ?? null, round: round ?? null,
        source: source ?? null, question_embedding: question_embedding ?? null,
        hit_count: hit_count ?? 0, created_time: created_time ?? Date.now(),
      });
      this.db.save();
      return { changes: 1, lastInsertRowid: t.interview_question_cache[t.interview_question_cache.length - 1].id };
    }
    if (n.startsWith('SELECT id, normalized_question, question_embedding FROM interview_question_cache')) {
      const rows = (t.interview_question_cache || []).map((r) => ({ id: r.id, normalized_question: r.normalized_question, question_embedding: r.question_embedding }));
      return { rows, changes: 0, raw: () => rows };
    }
    if (n.startsWith('SELECT id, source_chunk_id, hit_count, created_time FROM interview_question_cache WHERE normalized_question = ? AND company = ? AND position = ? AND round = ?')) {
      const [nq, c, p, r] = args;
      const rows = (t.interview_question_cache || []).filter((x) => x.normalized_question === nq && (x.company ?? null) === c && (x.position ?? null) === p && (x.round ?? null) === r);
      return { rows, changes: 0, raw: () => rows };
    }
    if (n.startsWith('SELECT id, question, question_type, answer, source, hit_count, created_time FROM interview_question_cache WHERE company = ? AND position = ? AND round = ?')) {
      const [c, p, r] = args;
      const rows = (t.interview_question_cache || [])
        .filter((x) => (x.company ?? null) === c && (x.position ?? null) === p && (x.round ?? null) === r)
        .sort((a, b) => (b.hit_count ?? 0) - (a.hit_count ?? 0) || (b.created_time ?? 0) - (a.created_time ?? 0));
      return { rows, changes: 0, raw: () => rows };
    }
    if (n.startsWith('SELECT id, question, question_type, answer, source, hit_count, created_time FROM interview_question_cache WHERE position = ? AND (company IS NULL OR company = ?)')) {
      const [p, c] = args;
      const rows = (t.interview_question_cache || [])
        .filter((x) => (x.position ?? null) === p && ((x.company ?? null) === null || (x.company ?? null) === c))
        .sort((a, b) => (b.hit_count ?? 0) - (a.hit_count ?? 0) || (b.created_time ?? 0) - (a.created_time ?? 0));
      return { rows, changes: 0, raw: () => rows };
    }
    if (n.startsWith('SELECT id, question, question_type, answer, source, hit_count, created_time FROM interview_question_cache WHERE company IS NULL AND position IS NULL')) {
      const rows = (t.interview_question_cache || [])
        .filter((x) => (x.company ?? null) === null && (x.position ?? null) === null)
        .sort((a, b) => (b.hit_count ?? 0) - (a.hit_count ?? 0) || (b.created_time ?? 0) - (a.created_time ?? 0));
      return { rows, changes: 0, raw: () => rows };
    }
    if (n.startsWith('SELECT id, source_chunk_id, hit_count, created_time FROM interview_question_cache WHERE id = ?')) {
      const [id] = args;
      const row = (t.interview_question_cache || []).find((x) => x.id === id);
      const rows = row ? [{ id: row.id, source_chunk_id: row.source_chunk_id, hit_count: row.hit_count || 0, created_time: row.created_time || 0 }] : [];
      return { rows, changes: 0, raw: () => rows };
    }
    if (n.startsWith('UPDATE interview_question_cache SET source_chunk_id = ?, hit_count = ? WHERE id = ?')) {
      const [scid, hit, id] = args;
      const row = (t.interview_question_cache || []).find((x) => x.id === id);
      if (row) { row.source_chunk_id = scid; row.hit_count = hit; this.db.save(); return { changes: 1 }; }
      return { changes: 0 };
    }
    if (n.startsWith('UPDATE interview_question_cache SET source_chunk_id = ?, source = ?, hit_count = ? WHERE id = ?')) {
      const [scid, src, hit, id] = args;
      const row = (t.interview_question_cache || []).find((x) => x.id === id);
      if (row) { row.source_chunk_id = scid; row.source = src; row.hit_count = hit; this.db.save(); return { changes: 1 }; }
      return { changes: 0 };
    }
    if (n.startsWith('UPDATE interview_question_cache SET hit_count = hit_count + 1 WHERE id IN')) {
      // args: [id1, id2, ...]
      const ids = args;
      let changes = 0;
      for (const x of (t.interview_question_cache || [])) {
        if (ids.includes(x.id)) { x.hit_count = (x.hit_count ?? 0) + 1; changes++; }
      }
      if (changes) this.db.save();
      return { changes };
    }
    if (n.startsWith('UPDATE interview_question_cache SET hit_count = hit_count + 1 WHERE id = ?')) {
      const [id] = args;
      const row = (t.interview_question_cache || []).find((x) => x.id === id);
      if (row) { row.hit_count = (row.hit_count ?? 0) + 1; this.db.save(); return { changes: 1 }; }
      return { changes: 0 };
    }

    if (n.startsWith('UPDATE direction_configs SET name = ?, keyword = ?, enabled = ?, fetch_count = ?, sample_count = ?, sort_order = ?, updated_at = ? WHERE id = ?')) {
      const [name, keyword, enabled, fetch_count, sample_count, sort_order, updated_at, id] = args;
      const row = t.direction_configs.find((d) => d.id === id);
      if (!row) return { changes: 0 };
      Object.assign(row, { name, keyword, enabled, fetch_count, sample_count, sort_order, updated_at });
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'UPDATE interview_events SET status = ?, updated_at = ? WHERE id = ?') {
      const [status, updated_at, id] = args;
      const row = t.interview_events.find((d) => d.id === id);
      if (!row) return { changes: 0 };
      row.status = status;
      row.updated_at = updated_at;
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'DELETE FROM rag_chunks WHERE doc_id = ?') {
      const [doc_id] = args;
      const before = t.rag_chunks.length;
      t.rag_chunks = t.rag_chunks.filter((r) => r.doc_id !== doc_id);
      this.db.save();
      return { changes: before - t.rag_chunks.length };
    }

    if (n === 'DELETE FROM rag_docs WHERE doc_id = ?') {
      const [doc_id] = args;
      const before = t.rag_docs.length;
      t.rag_docs = t.rag_docs.filter((r) => r.doc_id !== doc_id);
      this.db.save();
      return { changes: before - t.rag_docs.length };
    }

    if (n === 'DELETE FROM rag_chunks WHERE source = ?') {
      const [source] = args;
      const before = t.rag_chunks.length;
      t.rag_chunks = t.rag_chunks.filter((r) => r.source !== source);
      this.db.save();
      return { changes: before - t.rag_chunks.length };
    }

    if (n === 'DELETE FROM rag_docs WHERE source = ?') {
      const [source] = args;
      const before = t.rag_docs.length;
      t.rag_docs = t.rag_docs.filter((r) => r.source !== source);
      this.db.save();
      return { changes: before - t.rag_docs.length };
    }

    if (n === 'INSERT INTO rag_docs (doc_id, source, title, ref, chunk_count, created_at) VALUES (?,?,?,?,?,?)') {
      const [doc_id, source, title, ref, chunk_count, created_at] = args;
      t.rag_docs.push({ doc_id, source, title, ref, chunk_count, created_at });
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'INSERT INTO rag_chunks (doc_id, source, title, content, embedding, meta) VALUES (?,?,?,?,?,?)') {
      const [doc_id, source, title, content, embedding, meta] = args;
      const id = this.db.nextId('rag_chunks');
      t.rag_chunks.push({ id, doc_id, source, title, content, embedding, meta });
      this.db.save();
      return { lastInsertRowid: id, changes: 1 };
    }

    if (n.startsWith('INSERT INTO daily_tasks (user_id, task_date, plan_index, keyword, tasks, created_at, updated_at) VALUES')) {
      const [user_id, task_date, plan_index, keyword, tasks, created_at, updated_at] = args;
      const existing = t.daily_tasks.find((d) => d.user_id === user_id && d.task_date === task_date);
      if (existing) {
        Object.assign(existing, { plan_index, keyword, tasks, updated_at });
      } else {
        t.daily_tasks.push({ id: this.db.nextId('daily_tasks'), user_id, task_date, plan_index, keyword, tasks, created_at, updated_at });
      }
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'UPDATE daily_tasks SET plan_index = ?, keyword = ?, tasks = ?, updated_at = ? WHERE id = ?') {
      const [plan_index, keyword, tasks, updated_at, id] = args;
      const row = t.daily_tasks.find((d) => d.id === id);
      if (!row) return { changes: 0 };
      Object.assign(row, { plan_index, keyword, tasks, updated_at });
      this.db.save();
      return { changes: 1 };
    }

    if (n === 'UPDATE daily_tasks SET tasks = ?, updated_at = ? WHERE user_id = ? AND task_date = ?') {
      const [tasks, updated_at, user_id, task_date] = args;
      const row = t.daily_tasks.find((d) => d.user_id === user_id && d.task_date === task_date);
      if (!row) return { changes: 0 };
      row.tasks = tasks;
      row.updated_at = updated_at;
      this.db.save();
      return { changes: 1 };
    }

    if (n.startsWith('INSERT INTO study_notes (user_id, title, skill, category, level, content, source, created_at, updated_at) VALUES')) {
      const [user_id, title, skill, category, level, content, source, created_at, updated_at] = args;
      const id = this.db.nextId('study_notes');
      t.study_notes.push({ id, user_id, title, skill, category, level, content, source, created_at, updated_at });
      this.db.save();
      return { lastInsertRowid: id, changes: 1 };
    }

    if (n === 'DELETE FROM study_notes WHERE user_id = ? AND id = ?') {
      const [user_id, id] = args;
      const before = t.study_notes.length;
      t.study_notes = t.study_notes.filter((d) => !(d.user_id === user_id && d.id === id));
      if (t.study_notes.length !== before) this.db.save();
      return { changes: before - t.study_notes.length };
    }

    // —— B站资源/搜索缓存 & 小红书趋势词 & 学习预算（资源匹配链路与 Learning Budget）——
    if (n.startsWith('INSERT INTO bilibili_resource_cache')) {
      const [bvid, title, url, author, skill, search_keyword, score_json, score_version, subtitle_status, duration, checked_time] = args;
      const row = { bvid, title, url, author, skill, search_keyword, score_json, score_version, subtitle_status, duration, checked_time };
      const existing = t.bilibili_resource_cache.find((r) => r.bvid === bvid && r.skill === skill);
      if (existing) Object.assign(existing, row);
      else t.bilibili_resource_cache.push(row);
      this.db.save();
      return { changes: 1 };
    }
    if (n === 'UPDATE bilibili_resource_cache SET title=?, url=?, author=?, search_keyword=?, score_json=?, score_version=?, subtitle_status=?, duration=?, checked_time=? WHERE bvid=? AND skill=?') {
      const [title, url, author, search_keyword, score_json, score_version, subtitle_status, duration, checked_time, bvid, skill] = args;
      const row = t.bilibili_resource_cache.find((r) => r.bvid === bvid && r.skill === skill);
      if (!row) return { changes: 0 };
      Object.assign(row, { title, url, author, search_keyword, score_json, score_version, subtitle_status, duration, checked_time });
      this.db.save();
      return { changes: 1 };
    }
    if (n.startsWith('INSERT INTO bilibili_search_cache')) {
      const [keyword, results, checked_time] = args;
      const existing = t.bilibili_search_cache.find((r) => r.keyword === keyword);
      if (existing) { existing.results = results; existing.checked_time = checked_time; }
      else t.bilibili_search_cache.push({ keyword, results, checked_time });
      this.db.save();
      return { changes: 1 };
    }
    if (n === 'UPDATE bilibili_search_cache SET results=?, checked_time=? WHERE keyword=?') {
      const [results, checked_time, keyword] = args;
      const row = t.bilibili_search_cache.find((r) => r.keyword === keyword);
      if (!row) return { changes: 0 };
      row.results = results; row.checked_time = checked_time;
      this.db.save();
      return { changes: 1 };
    }
    if (n.startsWith('INSERT INTO xhs_trend_keywords')) {
      const [keyword, skill, total_count, recent_count, last_seen, relevance_score, trend_score, source, created_at] = args;
      const row = { keyword, skill, total_count, recent_count, last_seen, relevance_score, trend_score, source, created_at };
      const existing = t.xhs_trend_keywords.find((r) => r.keyword === keyword && r.skill === skill);
      if (existing) Object.assign(existing, row);
      else t.xhs_trend_keywords.push(row);
      this.db.save();
      return { changes: 1 };
    }
    if (n === 'UPDATE xhs_trend_keywords SET total_count=?, recent_count=?, last_seen=?, relevance_score=?, trend_score=?, source=? WHERE keyword=? AND skill=?') {
      const [total_count, recent_count, last_seen, relevance_score, trend_score, source, keyword, skill] = args;
      const row = t.xhs_trend_keywords.find((r) => r.keyword === keyword && r.skill === skill);
      if (!row) return { changes: 0 };
      Object.assign(row, { total_count, recent_count, last_seen, relevance_score, trend_score, source });
      this.db.save();
      return { changes: 1 };
    }
    if (n.startsWith('INSERT INTO learning_budget')) {
      const [user_id, plan_id, days, daily_minutes, total_minutes, budget_json, created_at] = args;
      const row = { user_id, plan_id, days, daily_minutes, total_minutes, budget_json, created_at };
      const existing = t.learning_budget.find((r) => r.user_id === user_id && r.plan_id === plan_id);
      if (existing) Object.assign(existing, row);
      else t.learning_budget.push(row);
      this.db.save();
      return { changes: 1 };
    }
    if (n === 'UPDATE learning_budget SET days=?, daily_minutes=?, total_minutes=?, budget_json=?, created_at=? WHERE user_id=? AND plan_id=?') {
      const [days, daily_minutes, total_minutes, budget_json, created_at, user_id, plan_id] = args;
      const row = t.learning_budget.find((r) => r.user_id === user_id && r.plan_id === plan_id);
      if (!row) return { changes: 0 };
      Object.assign(row, { days, daily_minutes, total_minutes, budget_json, created_at });
      this.db.save();
      return { changes: 1 };
    }

    throw new Error(`Unsupported SQL run: ${this.sql}`);
  }

  get(...args) {
    const rows = this.all(...args);
    // all() 可能返回数组（多行查询）或单行/undefined（SELECT * ... 查单条语句直接返回行）
    if (Array.isArray(rows)) return rows[0] || undefined;
    return rows;
  }

  all(...args) {
    const t = this.db.state.tables;
    const n = this.n;

    // ===== Interview Question Cache 查询分支（与 exec/run 中的写入分支配对）=====
    if (n.startsWith('SELECT id, normalized_question, question_embedding FROM interview_question_cache /*semantic-scan*/')) {
      return (t.interview_question_cache || []).map((r) => ({ id: r.id, normalized_question: r.normalized_question, question_embedding: r.question_embedding }));
    }
    if (n.startsWith('SELECT id, source_chunk_id, hit_count, created_time FROM interview_question_cache WHERE normalized_question = ? AND company = ? AND position = ? AND round = ?')) {
      const [nq, c, p, r] = args;
      return (t.interview_question_cache || []).filter((x) => x.normalized_question === nq && (x.company ?? null) === c && (x.position ?? null) === p && (x.round ?? null) === r);
    }
    if (n.startsWith('SELECT id, question, question_type, answer, source, hit_count, created_time FROM interview_question_cache WHERE company = ? AND position = ? AND round = ?')) {
      const [c, p, r] = args;
      return (t.interview_question_cache || [])
        .filter((x) => (x.company ?? null) === c && (x.position ?? null) === p && (x.round ?? null) === r)
        .sort((a, b) => (b.hit_count ?? 0) - (a.hit_count ?? 0) || (b.created_time ?? 0) - (a.created_time ?? 0));
    }
    if (n.startsWith('SELECT id, question, question_type, answer, source, hit_count, created_time FROM interview_question_cache WHERE position = ? AND (company IS NULL OR company = ?)')) {
      const [p, c] = args;
      return (t.interview_question_cache || [])
        .filter((x) => (x.position ?? null) === p && ((x.company ?? null) === null || (x.company ?? null) === c))
        .sort((a, b) => (b.hit_count ?? 0) - (a.hit_count ?? 0) || (b.created_time ?? 0) - (a.created_time ?? 0));
    }
    if (n.startsWith('SELECT id, question, question_type, answer, source, hit_count, created_time FROM interview_question_cache WHERE company IS NULL AND position IS NULL')) {
      return (t.interview_question_cache || [])
        .filter((x) => (x.company ?? null) === null && (x.position ?? null) === null)
        .sort((a, b) => (b.hit_count ?? 0) - (a.hit_count ?? 0) || (b.created_time ?? 0) - (a.created_time ?? 0));
    }
    if (n.startsWith('SELECT * FROM interview_question_cache')) {
      return (t.interview_question_cache || []).map((r) => ({ ...r }));
    }
    if (n.startsWith('SELECT id, source_chunk_id, hit_count, created_time FROM interview_question_cache WHERE id = ?')) {
      const [id] = args;
      const row = (t.interview_question_cache || []).find((x) => x.id === id);
      return row ? [row] : [];
    }

    if (n === 'SELECT id FROM users WHERE username = ?') {
      const [username] = args;
      return t.users.filter((u) => u && u.username === username).map((u) => ({ id: u.id }));
    }
    if (n === 'SELECT id, username, role, tier FROM users WHERE id = ?') {
      const [id] = args;
      return t.users.filter((u) => u && u.id === id).map((u) => ({ id: u.id, username: u.username, role: u.role, tier: u.tier }));
    }
    if (n === 'SELECT id, username, password_hash, password_salt, role, tier FROM users WHERE username = ?') {
      const [username] = args;
      return t.users.filter((u) => u && u.username === username).map(clone);
    }
    if (n === 'SELECT user_id, expires_at FROM sessions WHERE token = ?') {
      const [token] = args;
      return t.sessions.filter((s) => s.token === token).map((s) => ({ user_id: s.user_id, expires_at: s.expires_at }));
    }
    if (n === 'SELECT id FROM users WHERE username = ?') {
      const [username] = args;
      return t.users.filter((u) => u.username === username).map((u) => ({ id: u.id }));
    }
    if (n === 'SELECT id FROM users WHERE username = ?') {
      const [username] = args;
      return t.users.filter((u) => u.username === username).map((u) => ({ id: u.id }));
    }
    if (n === 'SELECT job_name, company, direction, subfield, target_date, start_date, jd_text, directions, boss_cookie, xhs_posts, xhs_post_contents FROM profiles WHERE user_id = ?') {
      const [user_id] = args;
      return t.profiles.filter((p) => p.user_id === user_id).map((p) => ({
        job_name: p.job_name, company: p.company, direction: p.direction, subfield: p.subfield, target_date: p.target_date, start_date: p.start_date,
        jd_text: p.jd_text, directions: p.directions, boss_cookie: p.boss_cookie, xhs_posts: p.xhs_posts, xhs_post_contents: p.xhs_post_contents,
      }));
    }
    if (n === 'SELECT checkin_dates FROM profiles WHERE user_id = ?') {
      const [user_id] = args;
      return t.profiles.filter((p) => p.user_id === user_id).map((p) => ({
        checkin_dates: p.checkin_dates,
      }));
    }
    if (n === 'SELECT checkin_dates, start_date FROM profiles WHERE user_id = ?') {
      const [user_id] = args;
      return t.profiles.filter((p) => p.user_id === user_id).map((p) => ({
        checkin_dates: p.checkin_dates, start_date: p.start_date,
      }));
    }
    if (n === 'SELECT last_reschedule_date FROM profiles WHERE user_id = ?') {
      const [user_id] = args;
      return t.profiles.filter((p) => p.user_id === user_id).map((p) => ({
        last_reschedule_date: p.last_reschedule_date,
      }));
    }
    if (n === 'SELECT boss_cookie FROM profiles WHERE user_id = ?') {
      const [user_id] = args;
      return t.profiles.filter((p) => p.user_id === user_id).map((p) => ({ boss_cookie: p.boss_cookie }));
    }
    if (n === 'SELECT * FROM boss_snapshots WHERE keyword = ?') {
      const [keyword] = args;
      return t.boss_snapshots.filter((r) => r.keyword === keyword).map(clone);
    }
    if (n === 'SELECT keyword, direction_id, total, fetched_at, fetched_date, source FROM boss_snapshots ORDER BY keyword') {
      return clone(t.boss_snapshots)
        .sort((a, b) => String(a.keyword).localeCompare(String(b.keyword), 'zh-CN'))
        .map(({ keyword, direction_id, total, fetched_at, fetched_date, source }) => ({ keyword, direction_id, total, fetched_at, fetched_date, source }));
    }
    if (n === 'SELECT id FROM direction_configs WHERE id = ?') {
      const [id] = args;
      return t.direction_configs.filter((d) => d.id === id).map((d) => ({ id: d.id }));
    }
    if (n.includes('FROM direction_configs')) {
      return clone(t.direction_configs)
        .sort((a, b) => (a.sort_order - b.sort_order) || (a.created_at - b.created_at))
        .map(({ id, name, keyword, enabled, fetch_count, sample_count, sort_order, created_at, updated_at }) => ({
          id, name, keyword, enabled, fetch_count, sample_count, sort_order, created_at, updated_at,
        }));
    }
    if (n.includes('FROM email_accounts')) {
      const [user_id, email] = args;
      return clone(t.email_accounts)
        .filter((d) => (user_id == null || d.user_id === user_id) && (!email || d.email === email))
        .map(({ account_id, provider, email, auth_code, imap_host, imap_port, smtp_host, smtp_port, enabled, polling_minutes, updated_at }) => ({
          account_id, provider, email, auth_code, imap_host, imap_port, smtp_host, smtp_port, enabled, polling_minutes, updated_at,
        }));
    }
    if (n.includes('FROM interview_events')) {
      const [user_id] = args;
      return clone(t.interview_events)
        .filter((d) => d.user_id === user_id)
        .sort((a, b) => {
          const ak = `${a.event_date || ''} ${a.event_time || ''}`;
          const bk = `${b.event_date || ''} ${b.event_time || ''}`;
          return ak.localeCompare(bk) || b.created_at - a.created_at;
        })
        .map(({ id, company, role, sender, subject, event_date, period, event_time, preview, source, status, created_at, updated_at }) => ({
          id, company, role, sender, subject, event_date, period, event_time, preview, source, status, created_at, updated_at,
        }));
    }
    if (n.includes('FROM interview_schedules')) {
      const [user_id] = args;
      return clone(t.interview_schedules)
        .filter((d) => d.user_id === user_id)
        .sort((a, b) => {
          const ak = `${a.event_date || ''} ${a.event_time || ''}`;
          const bk = `${b.event_date || ''} ${b.event_time || ''}`;
          return ak.localeCompare(bk) || b.created_at - a.created_at;
        })
        .map(({ id, event_id, company, role, event_date, period, event_time, status, created_at, updated_at }) => ({
          id, event_id, company, role, event_date, period, event_time, status, created_at, updated_at,
        }));
    }
    if (n === 'SELECT id, company, role, round, created_at FROM interview_sessions WHERE user_id = ? AND company = ? AND role = ? AND round = ? LIMIT 1') {
      const [user_id, company, role, round] = args;
      const row = t.interview_sessions.find((d) => d.user_id === user_id && d.company === company && d.role === role && d.round === round);
      return row ? [{ id: row.id, company: row.company, role: row.role, round: row.round, created_at: row.created_at }] : [];
    }
    if (n === 'SELECT id, company, role, round, created_at FROM interview_sessions WHERE id = ? AND user_id = ?') {
      const [id, user_id] = args;
      const row = t.interview_sessions.find((d) => d.id === id && d.user_id === user_id);
      return row ? [{ id: row.id, company: row.company, role: row.role, round: row.round, created_at: row.created_at }] : [];
    }
    if (n.includes('FROM interview_sessions')) {
      const user_id = args[0];
      return clone(t.interview_sessions)
        .filter((d) => d.user_id === user_id)
        .sort((a, b) => b.created_at - a.created_at)
        .map(({ id, company, role, round, created_at }) => ({ id, company, role, round, created_at }));
    }
    if (n.includes('FROM interview_questions')) {
      const [session_id] = args;
      return clone(t.interview_questions)
        .filter((d) => d.session_id === session_id)
        .map(({ id, question, type, answer, answer_framework, prepare_direction, created_at }) => ({ id, question, type, answer, answer_framework, prepare_direction, created_at }));
    }
    if (n === 'SELECT COUNT(*) AS c FROM interview_sources WHERE session_id = ? AND source_type = ?') {
      const [session_id, source_type] = args;
      return { c: t.interview_sources.filter((d) => d.session_id === session_id && d.source_type === source_type).length };
    }
    if (n.includes('FROM interview_sources')) {
      const [session_id] = args;
      if (n.includes('COUNT(*)')) {
        const source_type = args[1];
        return { c: t.interview_sources.filter((d) => d.session_id === session_id && (!source_type || d.source_type === source_type)).length };
      }
      return clone(t.interview_sources)
        .filter((d) => d.session_id === session_id)
        .map(({ id, source_type, content, metadata, created_at }) => ({ id, source_type, content, metadata, created_at }));
    }
    if (n.includes('FROM interview_source_ids')) {
      const [session_id] = args;
      return clone(t.interview_source_ids)
        .filter((d) => d.session_id === session_id)
        .map(({ ref_id }) => ({ ref_id }));
    }
    if (n.includes('FROM users u LEFT JOIN profiles p ON p.user_id = u.id')) {
      return clone(t.users)
        .sort((a, b) => ((a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1)) || (b.created_at - a.created_at))
        .map((u) => {
          const p = t.profiles.find((x) => x.user_id === u.id) || {};
          return {
            id: u.id, username: u.username, role: u.role, tier: u.tier, created_at: u.created_at,
            job_name: p.job_name, company: p.company, updated_at: p.updated_at,
          };
        });
    }
    if (n === 'SELECT id, username FROM users WHERE id = ?') {
      const [id] = args;
      return t.users.filter((u) => u.id === id).map((u) => ({ id: u.id, username: u.username }));
    }
    if (n === 'SELECT xhs_bound FROM users WHERE id = ?') {
      const [id] = args;
      return t.users.filter((u) => u.id === id).map((u) => ({ xhs_bound: u.xhs_bound }));
    }
    if (n === 'SELECT DISTINCT user_id FROM daily_learning_tasks') {
      const set = new Set(t.daily_learning_tasks.map((x) => x.user_id).filter(Boolean));
      return [...set].map((user_id) => ({ user_id }));
    }
    if (n === 'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? ORDER BY day_number ASC') {
      const [user_id, plan_id] = args;
      return t.daily_learning_tasks
        .filter((r) => r.user_id === user_id && r.plan_id === plan_id)
        .sort((a, b) => a.day_number - b.day_number)
        .map(clone);
    }
    // GET /api/plan/integrated 注入资源时用的列选择模板
    if (n === 'SELECT day_number, video_info, pdf_info FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ?') {
      const [user_id, plan_id] = args;
      return t.daily_learning_tasks
        .filter((r) => r.user_id === user_id && r.plan_id === plan_id)
        .map((r) => ({ day_number: r.day_number, video_info: r.video_info, pdf_info: r.pdf_info }));
    }
    // 动态计划调整：按 day_number 定位单条（用于 upsert 判断）
    if (n === 'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? AND day_number = ?') {
      const [user_id, plan_id, day_number] = args;
      const r = t.daily_learning_tasks.find((x) => x.user_id === user_id && x.plan_id === plan_id && x.day_number === day_number);
      return r ? clone(r) : undefined;
    }
    // learning_plans：兼容多种列组合，统一返回完整字段集（含 keyword/days/job/data/progress）
    if (n.includes('FROM learning_plans')) {
      const [user_id] = args;
      return t.learning_plans
        .filter((p) => (user_id == null || p.user_id === user_id))
        .map((p) => {
          // learning_plans 本身即学习路线真源：keyword 来自 job 列或 data.keyword 顶层
          let keyword = p.job || p.keyword || '';
          if (!keyword && p.data) {
            try { keyword = (JSON.parse(p.data).keyword) || ''; } catch { /* ignore */ }
          }
          return {
            user_id: p.user_id,
            job: p.job,
            keyword,
            data: p.data,
            days: p.days,
            progress: p.progress,
            created_at: p.created_at,
            updated_at: p.updated_at,
          };
        });
    }
    if (n === 'SELECT doc_id FROM rag_docs WHERE doc_id = ?') {
      const [doc_id] = args;
      return t.rag_docs.filter((r) => r.doc_id === doc_id).map((r) => ({ doc_id: r.doc_id }));
    }
    if (n === 'SELECT doc_id, source, title, ref, chunk_count, created_at FROM rag_docs ORDER BY created_at DESC') {
      return clone(t.rag_docs)
        .sort((a, b) => b.created_at - a.created_at)
        .map(({ doc_id, source, title, ref, chunk_count, created_at }) => ({ doc_id, source, title, ref, chunk_count, created_at }));
    }
    if (n === 'SELECT meta FROM rag_chunks WHERE doc_id = ? LIMIT 1') {
      const [doc_id] = args;
      return t.rag_chunks.filter((r) => r.doc_id === doc_id).slice(0, 1).map((r) => ({ meta: r.meta }));
    }
    // 按 doc_id 取出全部分块的 meta（用于聚合真实章节，供每日计划 PDF 切片使用）
    if (n === 'SELECT meta FROM rag_chunks WHERE doc_id = ?') {
      const [doc_id] = args;
      return t.rag_chunks.filter((r) => r.doc_id === doc_id).map((r) => ({ meta: r.meta }));
    }
    // getPdfChunks 使用：按 doc_id 取分块内容与 meta
    if (n === 'SELECT content, meta FROM rag_chunks WHERE doc_id = ?') {
      const [doc_id] = args;
      return t.rag_chunks.filter((r) => r.doc_id === doc_id).map((r) => ({ content: r.content, meta: r.meta }));
    }
    if (n === 'SELECT doc_id FROM rag_docs WHERE source = ?') {
      const [source] = args;
      return t.rag_docs.filter((r) => r.source === source).map((r) => ({ doc_id: r.doc_id }));
    }
    if (n === 'SELECT id, doc_id, source, title, content, embedding, meta FROM rag_chunks WHERE source = ?') {
      const [source] = args;
      return t.rag_chunks.filter((r) => r.source === source).map(clone);
    }
    if (n === 'SELECT id, doc_id, source, title, content, embedding, meta FROM rag_chunks') {
      return clone(t.rag_chunks);
    }
    if (n === 'SELECT plan_index, keyword, tasks, created_at FROM daily_tasks WHERE user_id = ? AND task_date = ?') {
      const [user_id, task_date] = args;
      return t.daily_tasks.filter((d) => d.user_id === user_id && d.task_date === task_date).map((d) => ({
        plan_index: d.plan_index, keyword: d.keyword, tasks: d.tasks, created_at: d.created_at,
      }));
    }
    if (n === 'SELECT COUNT(*) AS c FROM daily_tasks WHERE user_id = ?') {
      const [user_id] = args;
      return [{ c: t.daily_tasks.filter((d) => d.user_id === user_id).length }];
    }
    if (n === 'SELECT id FROM daily_tasks WHERE user_id = ? AND task_date = ?') {
      const [user_id, task_date] = args;
      return t.daily_tasks.filter((d) => d.user_id === user_id && d.task_date === task_date).map((d) => ({ id: d.id }));
    }
    if (n === 'SELECT id, title, skill, category, level, source, created_at FROM study_notes WHERE user_id = ? ORDER BY created_at DESC') {
      const [user_id] = args;
      return clone(t.study_notes)
        .filter((d) => d.user_id === user_id)
        .sort((a, b) => b.created_at - a.created_at)
        .map(({ id, title, skill, category, level, source, created_at }) => ({ id, title, skill, category, level, source, created_at }));
    }
    if (n === 'SELECT id, title, skill, category, level, content, source, created_at FROM study_notes WHERE user_id = ? AND id = ?') {
      const [user_id, id] = args;
      return t.study_notes.filter((d) => d.user_id === user_id && d.id === id).map(clone);
    }
    if (n === 'SELECT * FROM daily_learning_tasks WHERE id = ? AND user_id = ?') {
      const [id, user_id] = args;
      const r = t.daily_learning_tasks.find((x) => x.id === id && x.user_id === user_id);
      return r ? clone(r) : undefined;
    }
    if (n === 'SELECT * FROM daily_learning_tasks WHERE id = ?') {
      const [id] = args;
      const r = t.daily_learning_tasks.find((x) => x.id === id);
      return r ? clone(r) : undefined;
    }
    if (n === 'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? AND status = ? ORDER BY day_number ASC LIMIT 1') {
      const [user_id, plan_id, status] = args;
      const r = t.daily_learning_tasks
        .filter((x) => x.user_id === user_id && x.plan_id === plan_id && x.status === status)
        .sort((a, b) => a.day_number - b.day_number)[0];
      return r ? clone(r) : undefined;
    }
    if (n === 'SELECT * FROM daily_learning_tasks WHERE user_id = ? AND plan_id = ? AND day_number = 0 LIMIT 1') {
      const [user_id, plan_id] = args;
      const r = t.daily_learning_tasks.find(
        (x) => x.user_id === user_id && x.plan_id === plan_id && x.day_number === 0
      );
      return r ? clone(r) : undefined;
    }
    if (n === 'SELECT * FROM learning_notes WHERE user_id = ? AND task_id = ?') {
      const [user_id, task_id] = args;
      const r = t.learning_notes.find((x) => x.user_id === user_id && x.task_id === task_id);
      return r ? clone(r) : undefined;
    }
    // —— 新增：按日期查询已完成资源（今日学习笔记来源）——
    if (n === 'SELECT * FROM daily_task_completions WHERE user_id = ? AND date = ? ORDER BY completed_at ASC') {
      const [user_id, date] = args;
      return t.daily_task_completions.filter((r) => r.user_id === user_id && r.date === date).sort((a, b) => a.completed_at - b.completed_at).map(clone);
    }
    if (n === 'SELECT COUNT(*) AS c FROM note_generation_records WHERE user_id = ? AND note_date = ?') {
      const [user_id, note_date] = args;
      const c = t.note_generation_records.filter((r) => r.user_id === user_id && r.note_date === note_date).length;
      return { c };
    }
    if (n === 'SELECT * FROM learning_notes WHERE user_id = ? AND note_date = ?') {
      const [user_id, note_date] = args;
      const r = t.learning_notes.find((x) => x.user_id === user_id && x.note_date === note_date);
      return r ? clone(r) : undefined;
    }
    // —— 新增：阶段总结相关查询 ——
    // 取某阶段全部每日笔记（NovaForge 的唯一输入来源）
    if (n === 'SELECT * FROM learning_notes WHERE user_id = ? AND stage_id = ? ORDER BY note_date ASC') {
      const [user_id, stage_id] = args;
      return t.learning_notes
        .filter((x) => x.user_id === user_id && String(x.stage_id) === String(stage_id))
        .sort((a, b) => String(a.note_date || '').localeCompare(String(b.note_date || '')))
        .map(clone);
    }
    if (n === 'SELECT * FROM stage_notes WHERE user_id = ? AND stage_id = ?') {
      const [user_id, stage_id] = args;
      const r = t.stage_notes.find((x) => x.user_id === user_id && String(x.stage_id) === String(stage_id));
      return r ? clone(r) : undefined;
    }
    // —— 新增：按主键读取单条学习笔记 ——
    if (n === 'SELECT * FROM learning_notes WHERE user_id = ? AND id = ?') {
      const [user_id, id] = args;
      const r = t.learning_notes.find((x) => x.user_id === user_id && Number(x.id) === Number(id));
      return r ? clone(r) : undefined;
    }
    // —— 新增：学习笔记归档，按 user_id 查全部笔记（按月 → 日期两层分组在前端完成）——
    if (n === 'SELECT * FROM learning_notes WHERE user_id = ? ORDER BY note_date DESC, id DESC') {
      const [user_id] = args;
      return t.learning_notes
        .filter((x) => x.user_id === user_id)
        .sort((a, b) => {
          const d = String(b.note_date || '').localeCompare(String(a.note_date || ''));
          return d !== 0 ? d : Number(b.id) - Number(a.id);
        })
        .map(clone);
    }
    if (n === 'SELECT * FROM stage_notes WHERE user_id = ? ORDER BY created_at ASC') {
      const [user_id] = args;
      return t.stage_notes.filter((x) => x.user_id === user_id).sort((a, b) => a.created_at - b.created_at).map(clone);
    }
    if (n === 'SELECT * FROM matched_resources WHERE plan_id = ?') {
      const [plan_id] = args;
      return t.matched_resources.filter((r) => r.plan_id === plan_id).map(clone);
    }
    if (n === 'SELECT * FROM matched_resources WHERE plan_id = ? AND skill_id = ?') {
      const [plan_id, skill_id] = args;
      return t.matched_resources.filter((r) => r.plan_id === plan_id && r.skill_id === skill_id).map(clone);
    }

    // —— B站资源/搜索缓存 & 小红书趋势词 & 学习预算（资源匹配链路与 Learning Budget）——
    if (n === 'SELECT * FROM bilibili_resource_cache WHERE bvid = ? AND skill = ? ORDER BY checked_time DESC LIMIT 1') {
      const [bvid, skill] = args;
      const r = t.bilibili_resource_cache
        .filter((x) => x.bvid === bvid && x.skill === skill)
        .sort((a, b) => Number(b.checked_time || 0) - Number(a.checked_time || 0))[0];
      return r ? clone(r) : undefined;
    }
    if (n === 'SELECT id FROM bilibili_resource_cache WHERE bvid = ? AND skill = ? LIMIT 1') {
      const [bvid, skill] = args;
      return t.bilibili_resource_cache.filter((x) => x.bvid === bvid && x.skill === skill).slice(0, 1).map(() => ({ id: 1 }));
    }
    if (n === 'SELECT keyword, results, checked_time FROM bilibili_search_cache WHERE keyword = ? LIMIT 1') {
      const [keyword] = args;
      const r = t.bilibili_search_cache.find((x) => x.keyword === keyword);
      return r ? clone(r) : undefined;
    }
    if (n === 'SELECT id FROM bilibili_search_cache WHERE keyword = ? LIMIT 1') {
      const [keyword] = args;
      return t.bilibili_search_cache.filter((x) => x.keyword === keyword).slice(0, 1).map(() => ({ id: 1 }));
    }
    if (n === 'SELECT keyword, skill, total_count, recent_count, last_seen, relevance_score, source FROM xhs_trend_keywords') {
      return t.xhs_trend_keywords.map((x) => ({
        keyword: x.keyword, skill: x.skill, total_count: x.total_count, recent_count: x.recent_count,
        last_seen: x.last_seen, relevance_score: x.relevance_score, source: x.source,
      }));
    }
    if (n === 'SELECT id FROM xhs_trend_keywords WHERE keyword = ? AND skill = ? LIMIT 1') {
      const [keyword, skill] = args;
      return t.xhs_trend_keywords.filter((x) => x.keyword === keyword && x.skill === skill).slice(0, 1).map(() => ({ id: 1 }));
    }
    if (n === 'SELECT * FROM learning_budget WHERE plan_id = ? LIMIT 1') {
      const [plan_id] = args;
      const r = t.learning_budget.find((x) => x.plan_id === plan_id);
      return r ? clone(r) : undefined;
    }
    if (n === 'SELECT * FROM learning_budget WHERE user_id = ? ORDER BY created_at DESC LIMIT 1') {
      const [user_id] = args;
      const r = t.learning_budget.filter((x) => x.user_id === user_id)
        .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0];
      return r ? clone(r) : undefined;
    }
    if (n === 'SELECT id FROM learning_budget WHERE user_id = ? AND plan_id = ? LIMIT 1') {
      const [user_id, plan_id] = args;
      return t.learning_budget.filter((x) => x.user_id === user_id && x.plan_id === plan_id).slice(0, 1).map(() => ({ id: 1 }));
    }

    throw new Error(`Unsupported SQL all/get: ${this.sql}`);
  }
}

function shouldUseJsonDatabase(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8').trimStart();
    return head.startsWith('{') || head.startsWith('[');
  } catch {
    return true;
  }
}

let NativeDatabaseSync = null;
try {
  const mod = await import('node:sqlite');
  if (mod?.DatabaseSync) NativeDatabaseSync = mod.DatabaseSync;
} catch {}

class DatabaseSync {
  constructor(filePath, ...args) {
    const Impl = NativeDatabaseSync && !shouldUseJsonDatabase(filePath)
      ? NativeDatabaseSync
      : JsonDatabaseSync;
    return new Impl(filePath, ...args);
  }
}

export { DatabaseSync };

// 单例：全进程共享同一个数据库实例，避免多实例各自 load/save 相互覆盖业务数据。
// index.mjs 与 questionCache.mjs 等模块统一从此处 import { db }，不要各自 new DatabaseSync。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dbDir = dirname(fileURLToPath(import.meta.url));
export const db = new DatabaseSync(join(__dbDir, 'offerdao.db'));
