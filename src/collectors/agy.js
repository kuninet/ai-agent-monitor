import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newCursor, readAppended, readJson } from '../jsonl.js';
import { agyProcesses, paneKeyOf } from '../proc.js';
import { pendingTextQuestion } from '../textQuestion.js';

const HOME = os.homedir();
const ROOTS = [path.join(HOME, '.gemini', 'antigravity-cli'), path.join(HOME, '.gemini', 'antigravity')];
const STATUSLINE_INPUT = path.join(ROOTS[0], 'last_statusline_input.json');
const SAVE_DIR = path.join(HOME, '.ai-status', 'agy');

const RUNNING_GRACE_MS = 90_000;
const ACTIVE_MTIME_MS = 60_000;
const DENIED_RE = /user denied|rejected|denied permission/i;

// transcript ファイルごとの {cursor, state, mtimeMs, size}
const fileCache = new Map();
// task.md: path → {mtimeMs, tasks}
const taskCache = new Map();
// `${pid}:${プロセス開始時刻}` → ORCA_PANE_KEY
const paneKeyCache = new Map();

// step_index → そのステップの解釈結果。同じ step_index が再出力されることがあるので後勝ちで上書きする
function newState() {
  return { steps: new Map(), extra: 0, derived: null };
}

function toMs(ts) {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

// JSON エンコード済み文字列を最大 n 回ほどく
function decode(v, n = 2) {
  for (let i = 0; i < n && typeof v === 'string'; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      break;
    }
  }
  return v;
}

function requestTitle(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(/<USER_REQUEST>([\s\S]*?)(<\/USER_REQUEST>|$)/);
  const body = (m ? m[1] : content).trim();
  const line = body.split('\n').find((l) => l.trim());
  return line ? line.trim().slice(0, 60) : null;
}

// ツール呼び出しの実行結果として数えないステップ
const NON_EXEC = new Set([
  'PLANNER_RESPONSE',
  'USER_INPUT',
  'SYSTEM_MESSAGE',
  'CHECKPOINT',
  'CONVERSATION_HISTORY',
  'ERROR_MESSAGE',
  'ASK_QUESTION',
]);

function parseAsk(c) {
  const qs = decode(c.args?.questions);
  if (!Array.isArray(qs)) return null;
  return qs.map((q) => {
    const opts = decode(q?.options, 1);
    return {
      text: String(decode(q?.question, 1) ?? ''),
      options: (Array.isArray(opts) ? opts : []).map((o) => String(typeof o === 'string' ? o : o?.label ?? o?.text ?? '')),
    };
  });
}

// 1 行を必要な情報だけのレコードにして step_index に紐付ける
function ingest(st, x) {
  const step = typeof x.step_index === 'number' ? x.step_index : null;
  const rec = {
    step: step ?? -1,
    ts: toMs(x.created_at),
    type: x.type ?? '?',
    source: x.source ?? null,
    status: x.status ?? null,
    error: typeof x.error === 'string' ? x.error.slice(0, 500) : null,
    calls: null,
    asks: null,
    text: null,
  };
  if (x.type === 'USER_INPUT' && x.source === 'USER_EXPLICIT') {
    rec.text = requestTitle(x.content);
  } else if (x.type === 'PLANNER_RESPONSE') {
    rec.calls = (x.tool_calls ?? []).map((c) => c?.name ?? '?');
    rec.asks = (x.tool_calls ?? []).filter((c) => c?.name === 'ask_question').map(parseAsk).filter(Boolean).flat();
    if (typeof x.content === 'string' && x.content.trim()) rec.text = x.content;
  }
  // step_index の無い行は上書き対象にしない
  st.steps.set(step ?? `x${st.extra++}`, rec);
  st.derived = null;
}

// step_index 順に並べ直して、イベントや質問候補を組み立てる
function derive(st) {
  if (st.derived) return st.derived;
  const d = {
    title: null,
    startedAt: null,
    updatedAt: null,
    tools: [],
    compact: [],
    auto: [],
    asks: [], // {step, ts, questions}
    lastExplicitStep: -1,
    lastAskDoneStep: -1, // 回答済み(完了した)ASK_QUESTION ステップ
    lastHumanTs: null,
    finalResponse: null, // tool_calls の無い最後の PLANNER_RESPONSE {ts, text}。その後にツール呼び出しがあれば null
  };
  const recs = [...st.steps.values()].sort((a, b) => a.step - b.step);
  // 直前の PLANNER_RESPONSE が出したツール呼び出しのうち、実行ステップがまだ来ていないもの
  let queue = [];
  const flush = () => {
    for (const q of queue) d.tools.push({ ts: q.ts, name: q.name, error: false, denied: false });
    queue = [];
  };
  for (const r of recs) {
    const { ts, step } = r;
    if (ts != null) {
      if (d.startedAt == null || ts < d.startedAt) d.startedAt = ts;
      if (d.updatedAt == null || ts > d.updatedAt) d.updatedAt = ts;
    }
    if (r.type === 'USER_INPUT') {
      if (r.source === 'USER_EXPLICIT') {
        if (ts != null) d.lastHumanTs = ts;
        if (step > d.lastExplicitStep) d.lastExplicitStep = step;
        if (!d.title && r.text) d.title = r.text;
      } else {
        d.auto.push({ ts, kind: String(r.source ?? 'unknown').toLowerCase() });
      }
    } else if (r.type === 'SYSTEM_MESSAGE') {
      d.auto.push({ ts, kind: 'system' });
    } else if (r.type === 'PLANNER_RESPONSE') {
      flush();
      for (const name of r.calls) {
        // ask_question は ASK_QUESTION ステップで完結するので、実行ステップの対応付けから外す
        if (name === 'ask_question') d.tools.push({ ts, name, error: false, denied: false });
        else queue.push({ ts, name });
      }
      if (r.asks?.length) d.asks.push({ step, ts, questions: r.asks });
      if (r.calls.length) d.finalResponse = null;
      else if (r.text) d.finalResponse = { ts, text: r.text };
    } else if (r.type === 'ASK_QUESTION') {
      // ask_question への回答は USER_INPUT ではなくこのステップの完了として記録される
      if (r.status !== 'RUNNING' && r.status !== 'PENDING' && step > d.lastAskDoneStep) d.lastAskDoneStep = step;
    } else if (r.type === 'CHECKPOINT') {
      d.compact.push({ ts, droppedTokens: null });
    }

    if (!NON_EXEC.has(r.type)) {
      // 権限拒否は Claude 側の denied と同じ扱いにする
      const denied = r.status === 'CANCELED' || (r.status === 'ERROR' && DENIED_RE.test(r.error ?? ''));
      const error = r.status === 'ERROR' && !denied;
      const q = queue.shift();
      if (q) d.tools.push({ ts: ts ?? q.ts, name: q.name, error, denied });
      else if (error || denied) d.tools.push({ ts, name: r.type.toLowerCase(), error, denied });
    }
  }
  flush();
  st.derived = d;
  return d;
}

function refresh(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    fileCache.delete(file);
    return null;
  }
  let c = fileCache.get(file);
  if (c && c.mtimeMs === stat.mtimeMs && c.size === stat.size) return c;
  if (!c) {
    c = { cursor: newCursor(), state: newState(), mtimeMs: 0, size: 0 };
    fileCache.set(file, c);
  }
  try {
    let rows = readAppended(file, c.cursor);
    if (rows === null) {
      c.cursor = newCursor();
      c.state = newState();
      rows = readAppended(file, c.cursor) ?? [];
    }
    for (const x of rows) ingest(c.state, x);
  } catch {
    return c;
  }
  c.mtimeMs = stat.mtimeMs;
  c.size = stat.size;
  return c;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statOf(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// convId → {transcript, size, mtimeMs, taskFile, taskMtime}
function scanBrains() {
  const out = new Map();
  for (const root of ROOTS) {
    const brain = path.join(root, 'brain');
    for (const e of safeReaddir(brain)) {
      if (!e.isDirectory()) continue;
      const id = e.name;
      const cur = out.get(id) ?? { transcript: null, size: -1, mtimeMs: 0, taskFile: null, taskMtime: 0 };
      const tf = path.join(brain, id, '.system_generated', 'logs', 'transcript.jsonl');
      const ts = statOf(tf);
      if (ts && ts.size > cur.size) {
        cur.transcript = tf;
        cur.size = ts.size;
        cur.mtimeMs = ts.mtimeMs;
      }
      const md = path.join(brain, id, 'task.md');
      const ms = statOf(md);
      if (ms && ms.mtimeMs > cur.taskMtime) {
        cur.taskFile = md;
        cur.taskMtime = ms.mtimeMs;
      }
      out.set(id, cur);
    }
  }
  return out;
}

function decodeUri(u) {
  if (typeof u !== 'string') return null;
  try {
    return u.startsWith('file://') ? decodeURIComponent(new URL(u).pathname) : u;
  } catch {
    return u;
  }
}

// 両ルートの conversation_summaries.db を読む。同じ会話は新しい方を優先し、空のタイトルは補完する
function summaries(errors) {
  const out = new Map();
  for (const root of ROOTS) {
    const file = path.join(root, 'conversation_summaries.db');
    if (!fs.existsSync(file)) continue;
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const rows = db
        .prepare(
          'SELECT conversation_id, title, status, last_modified_time, workspace_uris, not_fully_idle, parent_conversation_id, agent_name FROM conversation_summaries',
        )
        .all();
      for (const r of rows) {
        let uris = [];
        try {
          uris = JSON.parse(r.workspace_uris || '[]');
        } catch {}
        const row = {
          title: r.title || '',
          status: r.status || '',
          lastModified: toMs(String(r.last_modified_time ?? '').replace(' ', 'T')) ?? 0,
          cwd: decodeUri(uris[0]) ?? null,
          notFullyIdle: !!r.not_fully_idle,
          parentId: r.parent_conversation_id || null,
          agentName: r.agent_name || null,
        };
        const prev = out.get(r.conversation_id);
        if (!prev) {
          out.set(r.conversation_id, row);
          continue;
        }
        const [newer, older] = row.lastModified > prev.lastModified ? [row, prev] : [prev, row];
        out.set(r.conversation_id, {
          ...newer,
          title: newer.title || older.title,
          cwd: newer.cwd ?? older.cwd,
          parentId: newer.parentId ?? older.parentId,
          agentName: newer.agentName ?? older.agentName,
        });
      }
    } catch (e) {
      errors.push(`agy: ${file} を開けません: ${e.message}`);
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
  return out;
}

// last_statusline_input.json を会話ごとに ~/.ai-status/agy/<convId>.json へ蓄積する
function captureStatusline(errors) {
  const st = statOf(STATUSLINE_INPUT);
  if (!st) return null;
  const input = readJson(STATUSLINE_INPUT);
  const id = input?.conversation_id;
  if (!id || !/^[\w-]+$/.test(id)) return input ? { input, mtimeMs: st.mtimeMs } : null;
  const dest = path.join(SAVE_DIR, `${id}.json`);
  const saved = readJson(dest);
  if (!saved || saved.capturedAt !== Math.round(st.mtimeMs)) {
    try {
      fs.mkdirSync(SAVE_DIR, { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      // 個人情報(アカウントのメールアドレス)は保存しない
      const { email, ...rest } = input;
      fs.writeFileSync(tmp, JSON.stringify({ ...rest, capturedAt: Math.round(st.mtimeMs) }));
      fs.renameSync(tmp, dest);
    } catch (e) {
      errors.push(`agy: statusline の保存に失敗: ${e.message}`);
    }
  }
  return { input, mtimeMs: st.mtimeMs };
}

function savedStatusline(id) {
  return readJson(path.join(SAVE_DIR, `${id}.json`));
}

// task.md のチェックボックス行をタスクにする。インデントで階層化し id は 1, 1.2 のような番号
export function parseTaskMd(text) {
  const tasks = [];
  const stack = []; // {indent, id, children}
  let top = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^(\s*)[-*+]\s+\[([ xX/])\]\s+(.*)$/);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '    ').length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    let id;
    if (stack.length) {
      const parent = stack[stack.length - 1];
      parent.children += 1;
      id = `${parent.id}.${parent.children}`;
    } else {
      top += 1;
      id = String(top);
    }
    stack.push({ indent, id, children: 0 });
    const mark = m[2];
    tasks.push({
      id,
      title: m[3].replace(/\*\*/g, '').replace(/`/g, '').trim(),
      status: mark === ' ' ? 'pending' : mark === '/' ? 'in_progress' : 'completed',
      blockedBy: [],
    });
  }
  return tasks;
}

function tasksOf(file, mtimeMs) {
  if (!file) return [];
  const c = taskCache.get(file);
  if (c && c.mtimeMs === mtimeMs) return c.tasks;
  let tasks = [];
  try {
    tasks = parseTaskMd(fs.readFileSync(file, 'utf8'));
  } catch {}
  taskCache.set(file, { mtimeMs, tasks });
  return tasks;
}

function limitOf(q, now) {
  if (!q || typeof q.remaining_fraction !== 'number') return null;
  const resetsAt = toMs(q.reset_time);
  return {
    pct: Math.round((1 - q.remaining_fraction) * 1000) / 10,
    resetsAt,
    stale: resetsAt != null && resetsAt < now,
  };
}

// 子会話(サブエージェント)1 件分
function buildChild(id, brain, cache, sum, now) {
  const st = derive(cache?.state ?? newState());
  const mtimeMs = Math.round(brain?.mtimeMs ?? 0);
  const running = /RUNNING/.test(sum?.status ?? '') || (mtimeMs > 0 && now - mtimeMs <= ACTIVE_MTIME_MS);
  const last = st.tools.reduce((a, t) => (!a || (t.ts ?? 0) >= (a.ts ?? 0) ? t : a), null);
  return {
    id,
    name: sum?.agentName ?? id,
    type: sum?.agentName ?? null,
    model: null,
    description: sum?.title || st.title || '',
    isFork: false,
    isTeammate: false,
    status: running ? 'running' : 'done',
    startedAt: st.startedAt,
    updatedAt: Math.max(st.updatedAt ?? 0, mtimeMs, sum?.lastModified ?? 0) || null,
    lastTool: last ? { name: last.name, ts: last.ts } : null,
    events: { usage: [], tools: [...st.tools] },
    // 親の指標に合算する分
    extra: { compact: st.compact, auto: st.auto },
  };
}

function buildSession(id, brain, cache, sum, pid, now, children = []) {
  const st = derive(cache?.state ?? newState());
  const sl = savedStatusline(id);
  const live = pid != null;
  const mtimeMs = Math.round(brain?.mtimeMs ?? 0);

  const pendingAsks = st.asks.filter((a) => a.step > st.lastExplicitStep && a.step > st.lastAskDoneStep);

  let status;
  const active = /RUNNING/.test(sum?.status ?? '') || sum?.notFullyIdle || now - mtimeMs <= ACTIVE_MTIME_MS;
  if (live && pendingAsks.length) status = 'question';
  else if (live && active) status = 'running';
  else if (live) status = 'waiting';
  else status = now - mtimeMs <= RUNNING_GRACE_MS ? 'running' : 'ended';

  const questions = [];
  if (status !== 'ended') {
    for (const a of pendingAsks) {
      for (const q of a.questions) {
        questions.push({ ts: a.ts, kind: 'ask', level: 'question', text: q.text, options: q.options, matched: [] });
      }
    }
    // 本文中の質問は、実行中でないときだけ見る
    if (status !== 'running') {
      const q = pendingTextQuestion(st.finalResponse, st.lastHumanTs);
      if (q) {
        questions.push(q);
        if (q.level === 'question') status = 'question';
      }
    }
  }

  const usage = [];
  let context = { usedTokens: null, windowTokens: null, pct: null };
  const cw = sl?.context_window;
  if (sl && cw) {
    const cu = cw.current_usage;
    // 累計値(total_*)は cache read を含むかどうか不明なので、直近 1 回分の current_usage を使う
    if (cu) {
      usage.push({
        ts: sl.capturedAt,
        model: sl.model?.display_name ?? null,
        costUSD: null,
        input: cu.input_tokens ?? 0,
        output: cu.output_tokens ?? 0,
        cacheRead: cu.cache_read_input_tokens ?? 0,
        cacheWrite: cu.cache_creation_input_tokens ?? 0,
      });
    }
    context = {
      usedTokens: cu ? (cu.input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0) : null,
      windowTokens: cw.context_window_size ?? null,
      pct: typeof cw.used_percentage === 'number' ? Math.round(cw.used_percentage * 10) / 10 : null,
    };
  }

  const cwd = sum?.cwd ?? sl?.workspace?.current_dir ?? sl?.cwd ?? '';
  const updatedAt =
    Math.max(st.updatedAt ?? 0, mtimeMs, sum?.lastModified ?? 0, ...children.map((c) => c.updatedAt ?? 0)) || null;
  return {
    agent: 'agy',
    id,
    title: sum?.title || st.title || sl?.conversation_title || '',
    cwd,
    project: cwd ? path.basename(cwd) : '',
    branch: null,
    model: sl?.model?.display_name ?? null,
    startedAt: st.startedAt ?? updatedAt,
    updatedAt,
    status,
    live,
    pid: pid ?? null,
    context,
    events: {
      usage,
      tools: [...st.tools, ...children.flatMap((c) => c.events.tools)],
      compact: [...st.compact, ...children.flatMap((c) => c.extra.compact)],
      auto: [...st.auto, ...children.flatMap((c) => c.extra.auto)],
    },
    subagents: children.map(({ extra, ...c }) => c),
    tasks: tasksOf(brain?.taskFile, brain?.taskMtime).map((t) => ({ ...t, blockedBy: [...t.blockedBy] })),
    questions,
    terminal: { paneKey: null },
  };
}

export async function collect({ since = 0 } = {}) {
  const now = Date.now();
  const errors = [];
  const procs = await agyProcesses();
  const livePid = new Map();
  const pidStart = new Map(); // pid → プロセス開始時刻(ms)
  for (const p of procs) {
    if (p.conversationId) livePid.set(p.conversationId, p.pid);
    pidStart.set(p.pid, p.startedAt);
  }

  // ここから先はキャッシュを触るので await を挟まない
  const latest = captureStatusline(errors);
  const sums = summaries(errors);
  const brains = scanBrains();

  // 子会話は、祖先をたどって最初に「表示される会話」の下にぶら下げる(独立したセッションとしては出さない)。
  // 表示される会話 = transcript があるか live で、かつ自分がどこにもぶら下がらないもの。
  // 祖先がどれも表示されない子は、独立セッションとして出す
  const targetMemo = new Map();
  const displayable = (id) => !!brains.get(id)?.transcript || livePid.has(id);
  const targetOf = (id, depth = 0) => {
    if (targetMemo.has(id)) return targetMemo.get(id);
    let target = null;
    const seen = new Set([id]);
    let cur = sums.get(id)?.parentId;
    while (cur && !seen.has(cur) && depth < 20) {
      seen.add(cur);
      if (displayable(cur) && targetOf(cur, depth + 1) === null) {
        target = cur;
        break;
      }
      cur = sums.get(cur)?.parentId;
    }
    targetMemo.set(id, target);
    return target;
  };
  const childrenOf = new Map();
  const childIds = new Set();
  for (const id of sums.keys()) {
    const target = targetOf(id);
    if (!target) continue;
    childIds.add(id);
    if (!childrenOf.has(target)) childrenOf.set(target, []);
    childrenOf.get(target).push(id);
  }
  const isChild = (id) => childIds.has(id);

  const sessions = [];
  const seenFiles = new Set();
  const load = (b) => {
    if (!b?.transcript) return null;
    seenFiles.add(b.transcript);
    return refresh(b.transcript);
  };
  const ids = new Set([...brains.keys()].filter((id) => brains.get(id).transcript));
  for (const id of livePid.keys()) ids.add(id);
  for (const id of ids) {
    if (isChild(id)) continue;
    const b = brains.get(id);
    const live = livePid.has(id);
    const sum = sums.get(id);
    const kids = childrenOf.get(id) ?? [];
    const newest = Math.max(
      b?.mtimeMs ?? 0,
      b?.taskMtime ?? 0,
      sum?.lastModified ?? 0,
      ...kids.map((k) => Math.max(brains.get(k)?.mtimeMs ?? 0, sums.get(k)?.lastModified ?? 0)),
    );
    const cached = [id, ...kids].some((k) => brains.get(k)?.transcript && fileCache.has(brains.get(k).transcript));
    if (!live && newest < since && !cached) continue;
    const children = kids.map((k) => buildChild(k, brains.get(k), load(brains.get(k)), sums.get(k), now));
    sessions.push(buildSession(id, b, load(b), sum, livePid.get(id), now, children));
  }

  // 今回列挙されなかったファイルのキャッシュは捨てる
  for (const k of fileCache.keys()) if (!seenFiles.has(k)) fileCache.delete(k);
  const taskFiles = new Set([...brains.values()].map((b) => b.taskFile).filter(Boolean));
  for (const k of taskCache.keys()) if (!taskFiles.has(k)) taskCache.delete(k);

  // pid の再利用に備えて、キーにプロセス開始時刻を含める。取れなかった null はキャッシュしない
  const liveKeys = new Set();
  await Promise.all(
    sessions
      .filter((s) => s.live && s.pid)
      .map(async (s) => {
        const key = `${s.pid}:${pidStart.get(s.pid) ?? ''}`;
        liveKeys.add(key);
        if (!paneKeyCache.has(key)) {
          const pk = await paneKeyOf(s.pid);
          if (pk) paneKeyCache.set(key, pk);
        }
        s.terminal.paneKey = paneKeyCache.get(key) ?? null;
      }),
  );
  for (const k of paneKeyCache.keys()) if (!liveKeys.has(k)) paneKeyCache.delete(k);

  const q = latest?.input?.quota;
  const quota = latest?.input
    ? {
        plan: latest.input.plan_tier ?? null,
        gemini5h: limitOf(q?.['gemini-5h'], now),
        geminiWeekly: limitOf(q?.['gemini-weekly'], now),
        thirdParty5h: limitOf(q?.['3p-5h'], now),
        thirdPartyWeekly: limitOf(q?.['3p-weekly'], now),
        updatedAt: Math.round(latest.mtimeMs),
      }
    : null;

  return { sessions, quota, errors };
}
