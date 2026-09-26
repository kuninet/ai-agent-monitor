import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newCursor, readAppended, readJson } from '../jsonl.js';
import { costOf } from '../pricing.js';
import { pidAlive, paneKeyOf, procStarts } from '../proc.js';

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const SESSIONS = path.join(HOME, '.claude', 'sessions');
const TASKS = path.join(HOME, '.claude', 'tasks');
const STATUSLINE = path.join(HOME, '.ai-status', 'claude');

const RUNNING_GRACE_MS = 90_000;
const SUBAGENT_RUNNING_MS = 10 * 60_000;
// stop_reason が null で tool_use も無い状態は、応答の生成途中(thinking / text を書いた直後)でも起きる。
// この時間以上更新が無ければ完了とみなす
const SUBAGENT_SETTLE_MS = 45_000;
const DENIED_RE = /interrupted|rejected|denied|doesn't want/i;

// transcript ファイルごとの {cursor, state, mtimeMs}
const fileCache = new Map();
// `${pid}:${procStart}` → ORCA_PANE_KEY(プロセスの環境変数は変わらないのでプロセス単位で覚える)
const paneKeyCache = new Map();

function newState() {
  return {
    sessionId: null,
    aiTitle: null,
    customTitle: null,
    firstHumanText: null,
    cwd: null,
    branch: null,
    model: null,
    startedAt: null,
    updatedAt: null,
    usage: new Map(), // message.id → {ts, model, usage}
    tools: new Map(), // tool_use id → {ts, name, error, denied}
    compact: [],
    auto: [],
    asks: new Map(), // tool_use id → {ts, questions: [{text, options}]}
    answered: new Set(), // tool_result 済みの tool_use id
    pendingCreates: new Map(), // TaskCreate の tool_use id → {subject, activeForm}
    pendingUpdates: new Map(), // TaskUpdate の tool_use id → input(tool_result が成功したら反映)
    tasks: new Map(), // task id → {id, title, status, blockedBy, activeForm}
    lastAssistant: null, // {ts, text}
    lastHumanTs: null,
    // サブエージェントの状態判定用
    lastModel: null,
    lastTool: null, // {name, ts}
    lastMsgId: null,
    lastStop: null, // 最後の assistant メッセージの stop_reason(null のまま書かれることがある)
    lastHasToolUse: false, // 最後の assistant メッセージ(同じ id の全行)に tool_use があるか
    userAfterAssistant: false,
    idleHook: false, // 最後の行が TeammateIdle フック
    stopHook: false, // 最後の行が SubagentStop フック(チームメイトはこの後に TeammateIdle が続く)
  };
}

function toMs(ts) {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text ?? '' : ''))
    .join('\n');
}

function applyTaskUpdate(st, input) {
  const id = input?.taskId != null ? String(input.taskId) : null;
  if (!id) return;
  if (input.status === 'deleted') {
    st.tasks.delete(id);
    return;
  }
  const t = st.tasks.get(id) ?? { id, title: '', status: 'pending', blockedBy: [], activeForm: undefined };
  if (input.status) t.status = input.status;
  if (input.subject) t.title = input.subject;
  if (input.activeForm) t.activeForm = input.activeForm;
  for (const b of input.addBlockedBy ?? []) {
    const bid = String(b);
    if (!t.blockedBy.includes(bid)) t.blockedBy.push(bid);
  }
  for (const b of input.addBlocks ?? []) {
    const bid = String(b);
    const other = st.tasks.get(bid);
    if (other && !other.blockedBy.includes(id)) other.blockedBy.push(id);
  }
  st.tasks.set(id, t);
}

// 同じ message.id の usage は、stop_reason が確定した行(final)を優先し、無ければ output_tokens が最大の行を採る。
// ストリーミング途中の行やフォーク側のコピーには途中の値が入っていることがある
function betterUsage(a, b) {
  if (a.final !== b.final) return a.final;
  if (a.final) return true; // 確定した行どうしなら後の行
  return (a.usage.output_tokens ?? 0) >= (b.usage.output_tokens ?? 0);
}

// 1 行分を state に反映する。sub=true はサブエージェント(usage と tools だけ拾う)
function ingest(st, x, sub) {
  const ts = toMs(x.timestamp);
  if (ts != null) {
    if (st.startedAt == null || ts < st.startedAt) st.startedAt = ts;
    if (st.updatedAt == null || ts > st.updatedAt) st.updatedAt = ts;
  }
  st.idleHook = x.attachment?.hookEvent === 'TeammateIdle';
  st.stopHook = x.attachment?.hookEvent === 'SubagentStop';
  const side = sub || x.isSidechain === true;
  if (!side) {
    if (x.sessionId && !st.sessionId) st.sessionId = x.sessionId;
    if (x.cwd) st.cwd = x.cwd;
    if (x.gitBranch) st.branch = x.gitBranch;
  }

  if (x.type === 'ai-title' && !side) {
    if (x.aiTitle) st.aiTitle = x.aiTitle;
    return;
  }
  if (x.type === 'custom-title' && !side) {
    if (x.customTitle) st.customTitle = x.customTitle;
    return;
  }

  if (x.type === 'assistant') {
    const msg = x.message ?? {};
    const synthetic = msg.model === '<synthetic>' || x.isApiErrorMessage;
    if (!synthetic && msg.id && msg.usage) {
      const prev = st.usage.get(msg.id);
      const cand = { ts: prev?.ts ?? ts, model: msg.model ?? prev?.model ?? null, usage: msg.usage, final: msg.stop_reason != null };
      if (!prev || betterUsage(cand, prev)) st.usage.set(msg.id, cand);
    }
    if (!synthetic && msg.model && !side) st.model = msg.model;
    if (!synthetic && msg.model) st.lastModel = msg.model;
    // ストリーミングで同じ id が複数行に出るので、stop_reason は確定した値だけ採る
    if (msg.id !== st.lastMsgId) {
      st.lastMsgId = msg.id ?? null;
      st.lastStop = msg.stop_reason ?? null;
      st.lastHasToolUse = false;
    } else if (msg.stop_reason) {
      st.lastStop = msg.stop_reason;
    }
    if (Array.isArray(msg.content) && msg.content.some((b) => b?.type === 'tool_use')) st.lastHasToolUse = true;
    st.userAfterAssistant = false;
    if (!Array.isArray(msg.content)) return;
    for (const b of msg.content) {
      if (b?.type === 'tool_use' && b.id) {
        if (st.tools.has(b.id)) continue;
        st.tools.set(b.id, { ts, name: b.name ?? '?', error: false, denied: false });
        st.lastTool = { name: b.name ?? '?', ts };
        if (side) continue;
        const input = b.input ?? {};
        if (b.name === 'AskUserQuestion') {
          const qs = (input.questions ?? []).map((q) => ({
            text: String(q?.question ?? ''),
            options: (q?.options ?? []).map((o) => String(typeof o === 'string' ? o : o?.label ?? '')),
          }));
          st.asks.set(b.id, { ts, questions: qs });
        } else if (b.name === 'TaskCreate') {
          st.pendingCreates.set(b.id, {
            subject: input.subject ?? '',
            activeForm: input.activeForm,
          });
        } else if (b.name === 'TaskUpdate') {
          st.pendingUpdates.set(b.id, input);
        } else if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
          st.tasks.clear();
          input.todos.forEach((t, i) => {
            const id = String(i + 1);
            st.tasks.set(id, {
              id,
              title: String(t?.content ?? ''),
              status: t?.status ?? 'pending',
              blockedBy: [],
              activeForm: t?.activeForm,
            });
          });
        }
      } else if (b?.type === 'text' && !side && b.text?.trim()) {
        st.lastAssistant = { ts, text: b.text };
      }
    }
    return;
  }

  if (x.type === 'user') {
    st.userAfterAssistant = true;
    const content = x.message?.content;
    const results = Array.isArray(content) ? content.filter((b) => b?.type === 'tool_result') : [];
    if (results.length) {
      for (const r of results) {
        const id = r.tool_use_id;
        if (!id) continue;
        st.answered.add(id);
        const t = st.tools.get(id);
        const isErr = r.is_error === true;
        const denied = !!x.toolDenialKind || (isErr && DENIED_RE.test(textOf(r.content)));
        if (t) {
          t.error = isErr && !denied;
          t.denied = denied;
        }
        if (side) continue;
        const pu = st.pendingUpdates.get(id);
        if (pu) {
          st.pendingUpdates.delete(id);
          if (!isErr) applyTaskUpdate(st, pu);
        }
        const pc = st.pendingCreates.get(id);
        if (pc) {
          st.pendingCreates.delete(id);
          const tid = x.toolUseResult?.task?.id;
          if (tid != null && !isErr) {
            const key = String(tid);
            const cur = st.tasks.get(key);
            st.tasks.set(key, {
              id: key,
              title: pc.subject || cur?.title || String(x.toolUseResult.task.subject ?? ''),
              status: cur?.status ?? 'pending',
              blockedBy: cur?.blockedBy ?? [],
              activeForm: pc.activeForm ?? cur?.activeForm,
            });
          }
        }
      }
      return;
    }
    if (side) return;
    if (x.origin?.kind && x.origin.kind !== 'human') {
      st.auto.push({ ts, kind: x.origin.kind });
    } else if (!x.isMeta && !x.isCompactSummary) {
      if (ts != null) st.lastHumanTs = ts;
      if (!st.firstHumanText) {
        const text = textOf(content).trim();
        if (text && !text.startsWith('<')) st.firstHumanText = text.replace(/\s+/g, ' ').slice(0, 60);
      }
    }
    return;
  }

  if (x.type === 'system' && x.subtype === 'compact_boundary' && !side) {
    const m = x.compactMetadata;
    const dropped = m && typeof m.preTokens === 'number' && typeof m.postTokens === 'number' ? m.preTokens - m.postTokens : null;
    st.compact.push({ ts, droppedTokens: dropped });
  }
}

// 差分読み込み。キャッシュが無い/ファイルが置き換わった場合は先頭から読み直す
function refresh(file, sub) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    fileCache.delete(file);
    return null;
  }
  let c = fileCache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.state;
  if (!c) {
    c = { cursor: newCursor(), state: newState(), mtimeMs: 0, size: 0 };
    fileCache.set(file, c);
  }
  let rows;
  try {
    rows = readAppended(file, c.cursor);
    if (rows === null) {
      c.cursor = newCursor();
      c.state = newState();
      rows = readAppended(file, c.cursor) ?? [];
    }
  } catch {
    return c.state;
  }
  for (const x of rows) ingest(c.state, x, sub);
  c.mtimeMs = st.mtimeMs;
  c.size = st.size;
  return c.state;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// procStart("Sat Sep 26 01:35:01 2026" 形式)と ps の開始時刻(ms)が同じプロセスを指すか。
// procStart は UTC で書かれているが、念のためローカル時刻としての解釈も許す
function sameStart(procStart, psMs) {
  if (!procStart || psMs == null) return true; // 比べられないときは生存扱いのまま
  const utc = Date.parse(`${procStart} GMT`);
  const local = Date.parse(procStart);
  return [utc, local].some((t) => !Number.isNaN(t) && Math.abs(t - psMs) < 1500);
}

// sessionId → 生存情報。pid が生きていて、開始時刻も一致するもの(pid の再利用を除く)
async function liveSessions() {
  const cands = [];
  for (const e of safeReaddir(SESSIONS)) {
    if (!e.isFile() || !/^\d+\.json$/.test(e.name)) continue;
    const s = readJson(path.join(SESSIONS, e.name));
    if (s?.sessionId && pidAlive(s.pid)) cands.push(s);
  }
  const starts = await procStarts(cands.map((s) => s.pid));
  const out = new Map();
  for (const s of cands) {
    const psMs = starts.get(s.pid) ?? null;
    if (!sameStart(s.procStart, psMs)) continue;
    const prev = out.get(s.sessionId);
    if (!prev || (s.updatedAt ?? 0) > (prev.updatedAt ?? 0)) out.set(s.sessionId, { ...s, psStart: psMs });
  }
  return out;
}

function taskDirOverlay(sessionId) {
  const dir = path.join(TASKS, `session-${sessionId.slice(0, 8)}`);
  const out = [];
  for (const e of safeReaddir(dir)) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const t = readJson(path.join(dir, e.name));
    if (!t || t.id == null) continue;
    out.push(t);
  }
  return out;
}

// statusline 保存ファイル: sessionId → {data, mtimeMs}。rate_limits 用に最新のものも返す
function statuslines() {
  const bySession = new Map();
  let latestQuota = null;
  for (const e of safeReaddir(STATUSLINE)) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const file = path.join(STATUSLINE, e.name);
    const data = readJson(file);
    if (!data) continue;
    const mtimeMs = mtimeOf(file);
    bySession.set(e.name.slice(0, -5), { data, mtimeMs });
    if (data.rate_limits && (!latestQuota || mtimeMs > latestQuota.mtimeMs)) latestQuota = { data, mtimeMs };
  }
  return { bySession, latestQuota };
}

function limitOf(r, now) {
  if (!r || typeof r.used_percentage !== 'number') return null;
  const resetsAt = typeof r.resets_at === 'number' ? r.resets_at * 1000 : null;
  return { pct: r.used_percentage, resetsAt, stale: resetsAt != null && resetsAt < now };
}

function lastParagraph(text) {
  const paras = text.trim().split(/\n\s*\n/);
  return paras[paras.length - 1].trim().slice(0, 200);
}

function endsWithQuestion(text) {
  const t = text.replace(/[\s*`]+$/u, '');
  return t.endsWith('?') || t.endsWith('？');
}

function usageEvent(u) {
  const x = u.usage;
  return {
    ts: u.ts,
    model: u.model,
    costUSD: costOf(u.model, x),
    input: x.input_tokens ?? 0,
    output: x.output_tokens ?? 0,
    cacheRead: x.cache_read_input_tokens ?? 0,
    cacheWrite: x.cache_creation_input_tokens ?? 0,
  };
}

// サブエージェント 1 体分。費用とツールは、親や他のサブエージェントと重複しない id の分だけ数える
function buildSubagent(sub, usageOf, ownMsg, ownTool, parent, parentStatus, now) {
  const { agentId, meta, state: s } = sub;
  const isTeammate = meta?.taskKind === 'in_process_teammate' || !!meta?.teamName;
  let status;
  const settled = s.updatedAt != null && now - s.updatedAt >= SUBAGENT_SETTLE_MS;
  const finished =
    s.lastMsgId != null &&
    !s.userAfterAssistant &&
    (s.lastStop === 'end_turn' || (!s.lastHasToolUse && (s.lastStop != null || settled)));
  // 親 transcript で、このサブエージェントを起動した tool_use に結果が返っていれば完了
  const returned = !isTeammate && !!meta?.toolUseId && parent.answered.has(meta.toolUseId);
  if (s.stopHook) status = 'done';
  else if (s.idleHook) status = 'idle';
  else if (returned) status = 'done';
  else if (finished) status = isTeammate ? 'idle' : 'done';
  else if (s.updatedAt != null && now - s.updatedAt <= SUBAGENT_RUNNING_MS) status = 'running';
  else status = 'ended';
  // 親が終了していれば、動作中は中断、待機は完了とみなす
  if (parentStatus === 'ended') {
    if (status === 'running') status = 'ended';
    else if (status === 'idle') status = 'done';
  }

  const usage = [];
  for (const mid of s.usage.keys()) if (ownMsg.has(mid)) usage.push(usageEvent(usageOf.get(mid)));
  const tools = [];
  for (const [tid, t] of s.tools) {
    if (ownTool.has(tid)) tools.push({ ts: t.ts, name: t.name, error: t.error, denied: t.denied });
  }
  return {
    id: agentId,
    name: meta?.name || meta?.agentType || agentId,
    type: meta?.agentType ?? null,
    // フォークの meta.model は 'inherit' なので、実際に使われたモデルを出す
    model: (meta?.model && meta.model !== 'inherit' ? meta.model : s.lastModel) ?? null,
    description: meta?.description ?? '',
    isFork: meta?.isFork === true,
    isTeammate,
    status,
    startedAt: s.startedAt,
    updatedAt: s.updatedAt,
    lastTool: s.lastTool ? { ...s.lastTool } : null,
    events: { usage, tools },
  };
}

function buildSession(file, st, subs, live, sl, now) {
  const sessionId = st.sessionId ?? path.basename(file, '.jsonl');

  // usage / tools はサブエージェント分も合算する。
  // フォーク型のサブエージェントは親や元のサブエージェントの履歴をコピーして持つので、
  // 親 → フォークでないサブエージェント → フォーク(spawnDepth → 開始時刻の昇順)の順に走査し、
  // message.id / tool_use id は先に出たファイルの所有とする
  const usage = [];
  const tools = [];
  const claimedMsg = new Set();
  const claimedTool = new Set();
  const forks = subs
    .filter((x) => x.meta?.isFork === true)
    .sort(
      (a, b) =>
        (a.meta.spawnDepth ?? 0) - (b.meta.spawnDepth ?? 0) || (a.state.startedAt ?? 0) - (b.state.startedAt ?? 0),
    );
  const ordered = [
    { state: st, own: null },
    ...subs.filter((x) => x.meta?.isFork !== true).map((x) => ({ state: x.state, own: x })),
    ...forks.map((x) => ({ state: x.state, own: x })),
  ];
  // usage の値はどのファイルのコピーかに関係なく、確定した行(無ければ output_tokens 最大)を採る
  const usageOf = new Map();
  for (const { state: s } of ordered) {
    for (const [mid, u] of s.usage) {
      const prev = usageOf.get(mid);
      if (!prev || (u.final !== prev.final ? u.final : !u.final && (u.usage.output_tokens ?? 0) > (prev.usage.output_tokens ?? 0))) {
        usageOf.set(mid, u);
      }
    }
  }
  const owned = new Map(); // サブエージェント → {msg: Set, tool: Set}
  let updatedAt = st.updatedAt;
  let startedAt = st.startedAt;
  for (const { state: s, own } of ordered) {
    const mine = { msg: new Set(), tool: new Set() };
    if (own) owned.set(own, mine);
    for (const mid of s.usage.keys()) {
      if (claimedMsg.has(mid)) continue;
      claimedMsg.add(mid);
      mine.msg.add(mid);
      usage.push(usageEvent(usageOf.get(mid)));
    }
    for (const [tid, t] of s.tools) {
      if (claimedTool.has(tid)) continue;
      claimedTool.add(tid);
      mine.tool.add(tid);
      tools.push({ ts: t.ts, name: t.name, error: t.error, denied: t.denied });
    }
    if (s !== st && s.updatedAt != null && (updatedAt == null || s.updatedAt > updatedAt)) updatedAt = s.updatedAt;
    if (s !== st && s.startedAt != null && (startedAt == null || s.startedAt < startedAt)) startedAt = s.startedAt;
  }
  usage.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  const pendingAsks = [...st.asks.entries()].filter(([id]) => !st.answered.has(id)).map(([, a]) => a);

  let status;
  if (live) {
    if (pendingAsks.length) status = 'question';
    else if (live.status === 'busy') status = 'running';
    else status = 'waiting';
  } else {
    status = updatedAt != null && now - updatedAt <= RUNNING_GRACE_MS ? 'running' : 'ended';
  }

  const questions = [];
  if (status !== 'ended') {
    for (const a of pendingAsks) {
      for (const q of a.questions) questions.push({ ts: a.ts, kind: 'ask', text: q.text, options: q.options });
    }
    const la = st.lastAssistant;
    if (status === 'waiting' && la && (st.lastHumanTs == null || la.ts > st.lastHumanTs) && endsWithQuestion(la.text)) {
      questions.push({ ts: la.ts, kind: 'text', text: lastParagraph(la.text), options: [] });
    }
  }

  // タスク: transcript の復元結果に tasks ディレクトリの内容を上書き
  const tasks = new Map();
  for (const t of st.tasks.values()) tasks.set(t.id, { ...t, blockedBy: [...t.blockedBy] });
  for (const f of taskDirOverlay(sessionId)) {
    const id = String(f.id);
    if (f.status === 'deleted') {
      tasks.delete(id);
      continue;
    }
    const cur = tasks.get(id);
    tasks.set(id, {
      id,
      title: f.subject ?? cur?.title ?? '',
      status: f.status ?? cur?.status ?? 'pending',
      blockedBy: Array.isArray(f.blockedBy) ? f.blockedBy.map(String) : cur?.blockedBy ?? [],
      activeForm: f.activeForm ?? cur?.activeForm,
    });
  }
  for (const t of tasks.values()) {
    t.blockedBy = t.blockedBy.filter((b) => tasks.has(b) && tasks.get(b).status !== 'completed');
  }
  const taskList = [...tasks.values()].sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));

  // context
  let context = { usedTokens: null, windowTokens: null, pct: null };
  const cw = sl?.data?.context_window;
  if (cw && typeof cw.used_percentage === 'number') {
    const win = cw.context_window_size ?? null;
    const cu = cw.current_usage;
    const used = cu
      ? (cu.input_tokens ?? 0) + (cu.cache_read_input_tokens ?? 0) + (cu.cache_creation_input_tokens ?? 0)
      : win
        ? Math.round((cw.used_percentage / 100) * win)
        : null;
    context = { usedTokens: used, windowTokens: win, pct: cw.used_percentage };
  } else {
    // サブエージェントではなく親セッションの最後の usage を使う
    const own = [...st.usage.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)).at(-1);
    if (own) {
      const x = own.usage;
      const used = (x.input_tokens ?? 0) + (x.cache_read_input_tokens ?? 0) + (x.cache_creation_input_tokens ?? 0);
      const model = own.model ?? st.model ?? '';
      const win = /\[1m\]/i.test(model) || used > 200_000 ? 1_000_000 : 200_000;
      context = { usedTokens: used, windowTokens: win, pct: Math.round((used / win) * 1000) / 10 };
    }
  }

  const cwd = st.cwd ?? live?.cwd ?? '';
  return {
    agent: 'claude',
    id: sessionId,
    title: st.customTitle ?? st.aiTitle ?? st.firstHumanText ?? live?.name ?? '',
    cwd,
    project: cwd ? path.basename(cwd) : '',
    branch: st.branch ?? null,
    model: st.model ?? sl?.data?.model?.id ?? null,
    startedAt: startedAt ?? live?.startedAt ?? null,
    updatedAt: updatedAt ?? live?.updatedAt ?? null,
    status,
    live: !!live,
    pid: live?.pid ?? null,
    context,
    events: { usage, tools, compact: [...st.compact], auto: [...st.auto] },
    subagents: subs.map((x) => buildSubagent(x, usageOf, owned.get(x).msg, owned.get(x).tool, st, status, now)),
    tasks: taskList,
    questions,
    terminal: { paneKey: null },
  };
}

// since(epoch ms)より古い transcript は読まない。ただし生存中のセッションと、読んだことのあるファイルは対象にする
export async function collect({ since = 0 } = {}) {
  const now = Date.now();
  const live = await liveSessions();
  const { bySession, latestQuota } = statuslines();

  const sessions = [];
  const seen = new Set();
  const seenFiles = new Set();
  // ファイルの読み込みと解析は同期的に行う(並行呼び出しでキャッシュが混ざらないように)
  for (const p of safeReaddir(PROJECTS)) {
    if (!p.isDirectory()) continue;
    const pdir = path.join(PROJECTS, p.name);
    for (const f of safeReaddir(pdir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const sid = f.name.slice(0, -6);
      const file = path.join(pdir, f.name);
      const subDir = path.join(pdir, sid, 'subagents');
      const subFiles = safeReaddir(subDir)
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => path.join(subDir, e.name));
      seenFiles.add(file);
      for (const sf of subFiles) seenFiles.add(sf);
      const newest = Math.max(mtimeOf(file), ...subFiles.map(mtimeOf));
      if (newest < since && !live.has(sid) && !fileCache.has(file)) continue;

      const st = refresh(file, false);
      if (!st) continue;
      const subs = [];
      for (const sf of subFiles) {
        const state = refresh(sf, true);
        if (!state) continue;
        const base = path.basename(sf, '.jsonl');
        subs.push({
          agentId: base.replace(/^agent-/, ''),
          meta: readJson(path.join(subDir, `${base}.meta.json`)),
          state,
        });
      }
      const id = st.sessionId ?? sid;
      if (seen.has(id)) continue;
      seen.add(id);
      sessions.push(buildSession(file, st, subs, live.get(id), bySession.get(id), now));
    }
  }

  // transcript がまだ無い生存セッション
  for (const [sid, l] of live) {
    if (seen.has(sid)) continue;
    const st = newState();
    st.sessionId = sid;
    st.cwd = l.cwd ?? null;
    sessions.push(buildSession(sid, st, [], l, bySession.get(sid), now));
  }

  // 今回列挙されなかったファイルのキャッシュは捨てる
  for (const k of fileCache.keys()) if (!seenFiles.has(k)) fileCache.delete(k);

  // pid の再利用に備えて、キーにプロセス開始時刻を含める。取れなかった null はキャッシュしない
  const liveKeys = new Set();
  await Promise.all(
    sessions
      .filter((s) => s.live && s.pid)
      .map(async (s) => {
        const key = `${s.pid}:${live.get(s.id)?.psStart ?? ''}`;
        liveKeys.add(key);
        if (!paneKeyCache.has(key)) {
          const pk = await paneKeyOf(s.pid);
          if (pk) paneKeyCache.set(key, pk);
        }
        s.terminal.paneKey = paneKeyCache.get(key) ?? null;
      }),
  );
  for (const k of paneKeyCache.keys()) if (!liveKeys.has(k)) paneKeyCache.delete(k);

  const rl = latestQuota?.data?.rate_limits;
  const quota = rl
    ? { plan: null, fiveHour: limitOf(rl.five_hour, now), weekly: limitOf(rl.seven_day, now), updatedAt: Math.round(latestQuota.mtimeMs) }
    : null;

  return { sessions, quota };
}
