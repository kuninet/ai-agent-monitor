import { AGENT_DEFS, AGENT_IDS, agentDef } from './agents.js';
import { enabledAgents } from './config.js';
import { orcaTerminals } from './proc.js';

export const RANGES = ['today', '24h', '7d', '30d', 'all'];
export const AGENTS = ['all', ...AGENT_IDS];

const STATUS_ORDER = { running: 0, question: 1, waiting: 2, ended: 3 };
const TASK_ORDER = { in_progress: 0, pending: 1, completed: 2 };
const SUBAGENT_ORDER = { running: 0, idle: 1, done: 2, ended: 3 };
const TERMINAL_TTL_MS = 10_000;

let terminalCache = { at: 0, list: [] };
// 直近の収集結果(agent:id → セッション)。/api/jump の解決に使う
let lastSessions = new Map();

export function sinceOf(range, now = Date.now()) {
  switch (range) {
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case '24h':
      return now - 24 * 3600_000;
    case '7d':
      return now - 7 * 24 * 3600_000;
    case '30d':
      return now - 30 * 24 * 3600_000;
    default:
      return 0;
  }
}

async function terminals() {
  const now = Date.now();
  if (now - terminalCache.at > TERMINAL_TTL_MS) terminalCache = { at: now, list: await orcaTerminals() };
  return terminalCache.list;
}

// セッションに対応する Orca 端末の handle。見つからなければ null
function resolveHandle(s, list) {
  const key = s.terminal?.paneKey;
  if (key) {
    const t = list.find((t) => `${t.tabId}:${t.leafId}` === key);
    if (t) return t.handle;
  }
  if (!key && s.live && s.cwd) {
    const identity = agentDef(s.agent)?.identity;
    const hits = list.filter((t) => t.worktreePath === s.cwd && t.agentIdentity === identity);
    if (hits.length === 1) return hits[0].handle;
  }
  return null;
}

// サブエージェントの表示用。費用とツール数は期間内のイベントだけで数える。
// 完了/中断で期間より前に更新が止まったものは出さない(動作中・待機は期間に関係なく残す)
function subagentRows(s, inRange, since) {
  const visible = (s.subagents ?? []).filter(
    (a) => a.status === 'running' || a.status === 'idle' || (a.updatedAt ?? 0) >= since,
  );
  const rows = visible.map((a) => {
    let cost = null;
    for (const u of a.events.usage.filter(inRange)) if (u.costUSD != null) cost = (cost ?? 0) + u.costUSD;
    let calls = 0;
    let errors = 0;
    for (const t of a.events.tools.filter(inRange)) {
      if (t.denied) continue;
      calls++;
      if (t.error) errors++;
    }
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      model: a.model,
      description: a.description,
      isFork: a.isFork,
      isTeammate: a.isTeammate,
      status: a.status,
      startedAt: a.startedAt,
      updatedAt: a.updatedAt,
      lastTool: a.lastTool,
      costUSD: agentDef(s.agent)?.priced ? (cost ?? 0) : null,
      toolCalls: calls,
      toolErrors: errors,
    };
  });
  rows.sort(
    (a, b) => SUBAGENT_ORDER[a.status] - SUBAGENT_ORDER[b.status] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  return rows;
}

function rate(num, den) {
  return den > 0 ? num / den : null;
}

// 有効なエージェントのコレクタだけを並列に呼ぶ。1 つが失敗しても他は出す
async function collectAll(since, enabled) {
  const errors = [];
  const defs = AGENT_DEFS.filter((d) => enabled.includes(d.id));
  const results = await Promise.allSettled(defs.map((d) => d.collect({ since })));
  const quota = Object.fromEntries(AGENT_IDS.map((id) => [id, null]));
  const all = [];
  defs.forEach((d, i) => {
    const r = results[i];
    if (r.status === 'rejected') {
      errors.push(`${d.id}: ${r.reason?.message ?? r.reason}`);
      return;
    }
    for (const e of r.value.errors ?? []) errors.push(e);
    quota[d.id] = r.value.quota ?? null;
    all.push(...r.value.sessions);
  });
  lastSessions = new Map(all.map((s) => [`${s.agent}:${s.id}`, s]));
  return { all, quota, errors };
}

export async function buildSnapshot({ range = 'today', agent = 'all' } = {}) {
  const enabled = enabledAgents();
  if (!RANGES.includes(range)) range = 'today';
  if (agent !== 'all' && !enabled.includes(agent)) agent = 'all';
  const now = Date.now();
  const since = sinceOf(range, now);

  const { all, quota, errors } = await collectAll(since, enabled);
  const list = await terminals();

  const picked = all.filter(
    (s) => (agent === 'all' || s.agent === agent) && (s.live || (s.updatedAt ?? 0) >= since),
  );
  const inRange = (e) => (e.ts ?? 0) >= since;

  // agy の usage は直近 1 回分のスナップショットで、リクエストごとの値とは性質が違う。
  // tokens / cacheReadRate は agent=all のとき累計に使えるエージェント(Claude・Codex)だけで集計し、
  // エージェント指定時はそのエージェントの値にする
  const countsTokens = (id) => (agent === 'all' ? !!agentDef(id)?.cumulativeUsage : id === agent);
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const byAgent = Object.fromEntries(AGENT_IDS.map((id) => [id, { cost: 0, cr: 0, den: 0 }]));
  const unpriced = new Set();
  const errTools = new Map();
  let toolCalls = 0;
  let toolErrors = 0;
  let toolDenied = 0;
  let compactions = 0;
  let droppedTokens = 0;
  let autoContinues = 0;
  const taskCount = { open: 0, inProgress: 0, blocked: 0, completed: 0 };
  const sessCount = { total: picked.length, running: 0, question: 0, waiting: 0 };

  const sessions = [];
  const tasks = [];
  const questions = [];

  for (const s of picked) {
    let cost = null;
    let sIn = 0;
    let sCr = 0;
    for (const u of s.events.usage.filter(inRange)) {
      if (countsTokens(s.agent)) {
        tokens.input += u.input;
        tokens.output += u.output;
        tokens.cacheRead += u.cacheRead;
        tokens.cacheWrite += u.cacheWrite;
      }
      sIn += u.input + u.cacheRead + u.cacheWrite;
      sCr += u.cacheRead;
      if (u.costUSD != null) cost = (cost ?? 0) + u.costUSD;
      else if (agentDef(s.agent)?.priced && u.model) unpriced.add(u.model);
    }
    const ag = byAgent[s.agent];
    ag.cr += sCr;
    ag.den += sIn;
    if (cost != null) ag.cost += cost;

    let sCalls = 0;
    let sErrors = 0;
    for (const t of s.events.tools.filter(inRange)) {
      if (t.denied) {
        toolDenied++;
        continue;
      }
      const e = errTools.get(t.name) ?? { name: t.name, errors: 0, calls: 0 };
      sCalls++;
      e.calls++;
      if (t.error) {
        sErrors++;
        e.errors++;
      }
      errTools.set(t.name, e);
    }
    toolCalls += sCalls;
    toolErrors += sErrors;

    const comp = s.events.compact.filter(inRange);
    compactions += comp.length;
    for (const c of comp) droppedTokens += c.droppedTokens ?? 0;
    const autos = s.events.auto.filter(inRange).length;
    autoContinues += autos;

    if (s.status in sessCount) sessCount[s.status]++;

    // 未完了タスクの KPI は、終了したセッションの放置タスクを除いて数える
    const active = s.status !== 'ended';
    let openTasks = 0;
    for (const t of s.tasks) {
      if (t.status === 'completed') taskCount.completed++;
      else {
        openTasks++;
        if (active) {
          taskCount.open++;
          if (t.status === 'in_progress') taskCount.inProgress++;
          if (t.blockedBy.length) taskCount.blocked++;
        }
      }
      tasks.push({
        agent: s.agent,
        sessionId: s.id,
        sessionTitle: s.title,
        sessionStatus: s.status,
        project: s.project,
        id: t.id,
        title: t.title,
        status: t.status,
        blockedBy: t.blockedBy,
        activeForm: t.activeForm ?? null,
        _updatedAt: s.updatedAt ?? 0,
      });
    }

    for (const q of s.questions) {
      questions.push({
        agent: s.agent,
        sessionId: s.id,
        sessionTitle: s.title,
        project: s.project,
        ts: q.ts,
        kind: q.kind,
        text: q.text,
        options: q.options,
      });
    }

    const subagents = subagentRows(s, inRange, since);
    sessions.push({
      agent: s.agent,
      id: s.id,
      title: s.title,
      project: s.project,
      cwd: s.cwd,
      branch: s.branch,
      model: s.model,
      status: s.status,
      live: s.live,
      updatedAt: s.updatedAt,
      startedAt: s.startedAt,
      costUSD: agentDef(s.agent)?.priced ? cost : null,
      cacheReadRate: rate(sCr, sIn),
      toolCalls: sCalls,
      toolErrors: sErrors,
      compactions: comp.length,
      autoContinues: autos,
      context: s.context,
      openTasks,
      questions: s.questions.length,
      canJump: resolveHandle(s, list) != null,
      subagents,
      subagentSummary: { total: subagents.length, running: subagents.filter((a) => a.status === 'running').length },
    });
  }

  sessions.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  tasks.sort(
    (a, b) =>
      TASK_ORDER[a.status] - TASK_ORDER[b.status] ||
      b._updatedAt - a._updatedAt ||
      a.sessionId.localeCompare(b.sessionId) ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
  for (const t of tasks) delete t._updatedAt;
  questions.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  // 費用は単価の分かるエージェント(Claude)だけ。無効なエージェントや絞り込みの対象外は null
  const costByAgent = Object.fromEntries(
    AGENT_DEFS.map((d) => [
      d.id,
      d.priced && enabled.includes(d.id) && (agent === 'all' || agent === d.id) ? byAgent[d.id].cost : null,
    ]),
  );
  const costs = Object.values(costByAgent).filter((c) => c != null);
  const totalCost = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  const topErrorTools = [...errTools.values()]
    .filter((e) => e.errors > 0)
    .sort((a, b) => b.errors - a.errors || b.calls - a.calls)
    .slice(0, 5);

  return {
    generatedAt: now,
    range,
    agent,
    enabledAgents: enabled,
    quota,
    kpis: {
      costUSD: totalCost,
      costByAgent,
      unpricedModels: [...unpriced].sort(),
      tokens,
      cacheReadRate: rate(tokens.cacheRead, tokens.input + tokens.cacheRead + tokens.cacheWrite),
      cacheReadRateByAgent: Object.fromEntries(AGENT_IDS.map((id) => [id, rate(byAgent[id].cr, byAgent[id].den)])),
      toolCalls,
      toolErrors,
      toolDenied,
      toolErrorRate: rate(toolErrors, toolCalls),
      topErrorTools,
      compactions,
      droppedTokens,
      autoContinues,
      tasks: taskCount,
      questions: questions.length,
      sessions: sessCount,
    },
    sessions,
    tasks,
    questions,
    errors,
  };
}

// /api/jump 用: セッションから Orca 端末の handle をサーバー側で解決する
export async function jumpHandle(agent, id) {
  let s = lastSessions.get(`${agent}:${id}`);
  if (!s) {
    await collectAll(0, enabledAgents());
    s = lastSessions.get(`${agent}:${id}`);
  }
  if (!s) return null;
  return resolveHandle(s, await terminals());
}
