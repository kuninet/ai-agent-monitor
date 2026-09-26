import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newCursor, readAppended } from '../jsonl.js';
import { codexProcesses } from '../proc.js';

const HOME = os.homedir();
const CODEX = path.join(HOME, '.codex');
const SESSIONS = path.join(CODEX, 'sessions');

const TURN_RUNNING_MS = 10 * 60_000;
const WAITING_MS = 30 * 60_000;
// quota を拾うため、期間に関係なく毎回読む新しいファイルの数
const ALWAYS_READ = 3;

// 会話記録ファイルごとの {cursor, state, mtimeMs, size}
const fileCache = new Map();

function newState() {
  return {
    id: null,
    cwd: null,
    branch: null,
    source: null,
    parentId: null, // session_meta から分かる親スレッド
    nickname: null,
    role: null,
    excluded: false, // guardian など、表示しないスレッド
    model: null,
    startedAt: null,
    updatedAt: null,
    // フォークした子の記録は、先頭に親の履歴を(時刻を付け替えて)コピーしている。
    // 親子をまとめるときに重複を除けるよう、usage / compact / ターン / 人間の発話には判定用の key を持たせる
    usage: [], // {key, ts, ...usage}
    lastTotal: null, // 直前の token_count の total_tokens(同じ値の繰り返しを数えないため)
    context: { usedTokens: null, windowTokens: null },
    windowTokens: null,
    tools: new Map(), // call_id → {ts, name, error, denied}
    asks: new Map(), // request_user_input の call_id → {ts, questions}
    answered: new Set(),
    tasks: [],
    compact: [], // {key, ts}
    turns: new Map(), // turn_id → {ts, human, completedAt}
    turnSeq: 0,
    openTurn: null, // 完了していないターンの key
    humans: [], // {key, ts, text}
    lastHumanTs: null,
    lastAssistant: null, // {ts, text}
    rateLimits: null, // {ts, rl}
  };
}

function toMs(ts) {
  if (!ts) return null;
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

function parseJson(s) {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
}

// session_meta / threads の source を解釈する
//   'vscode' / 'cli' → 通常の会話
//   {subagent: {thread_spawn: {parent_thread_id, ...}}} や {subagent: 'review'} → サブエージェント
//   {subagent: {other: 'guardian'}} など → 表示しない
function parseSource(src) {
  const s = typeof src === 'string' && src.startsWith('{') ? parseJson(src) : src;
  const sub = s && typeof s === 'object' ? s.subagent : undefined;
  if (sub === undefined) return { subagent: false, excluded: false, parentId: null, nickname: null, role: null };
  if (sub && typeof sub === 'object' && 'other' in sub) {
    return { subagent: true, excluded: true, parentId: null, nickname: null, role: null };
  }
  const spawn = sub && typeof sub === 'object' ? sub.thread_spawn : null;
  return {
    subagent: true,
    excluded: false,
    parentId: spawn?.parent_thread_id ?? null,
    nickname: spawn?.agent_nickname ?? null,
    role: spawn?.agent_role ?? (typeof sub === 'string' ? sub : null),
  };
}

const EXIT_RE = /Process exited with code (-?\d+)/;
const EXIT_LINE_RE = /^Exit code: (-?\d+)/m;
const FAILED_RE = /^(exec_command failed|write_stdin failed|apply_patch verification failed|collab spawn failed|invalid agent id)/;
// 承認の拒否は「exec_command failed ...: CreateProcess { message: "Rejected(\"rejected by user\")" }」の形で返る
const REJECTED_RE = /Rejected\(\\?"/;

// ツールの出力からエラー / 拒否を判定する
//   拒否: 承認の拒否(Rejected("rejected by user") など)と、ユーザーによる中断(aborted by user)
//   エラー: 終了コードが 0 以外、または実行・検証に失敗した出力(サンドボックスによる拒否を含む)
export function classifyOutput(output) {
  const s = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  if (/^aborted by user/.test(s) || (FAILED_RE.test(s) && REJECTED_RE.test(s))) return { error: false, denied: true };
  const m = s.match(EXIT_RE) ?? s.match(EXIT_LINE_RE);
  if (m) return { error: Number(m[1]) !== 0, denied: false };
  const js = parseJson(s);
  if (js && typeof js === 'object' && js.metadata && 'exit_code' in js.metadata) {
    return { error: js.metadata.exit_code !== 0, denied: false };
  }
  return { error: FAILED_RE.test(s), denied: false };
}

function ingest(st, x) {
  const ts = toMs(x.timestamp);
  if (ts != null) {
    if (st.startedAt == null || ts < st.startedAt) st.startedAt = ts;
    if (st.updatedAt == null || ts > st.updatedAt) st.updatedAt = ts;
  }
  const p = x.payload ?? {};

  if (x.type === 'session_meta') {
    if (st.id) return; // 先頭の session_meta がこのスレッド自身
    st.id = p.id ?? null;
    st.cwd = p.cwd ?? null;
    st.branch = p.git?.branch ?? null;
    const src = parseSource(p.source);
    st.source = src;
    st.excluded = src.excluded;
    st.parentId = src.subagent ? (src.parentId ?? p.parent_thread_id ?? p.forked_from_id ?? null) : null;
    st.nickname = src.nickname ?? p.agent_nickname ?? null;
    st.role = src.role ?? p.agent_role ?? null;
    return;
  }
  if (x.type === 'turn_context') {
    if (p.model) st.model = p.model;
    return;
  }
  if (x.type === 'compacted') {
    st.compact.push({ key: hash(JSON.stringify(p)), ts });
    return;
  }

  if (x.type === 'event_msg') {
    switch (p.type) {
      case 'task_started': {
        const key = p.turn_id ?? `seq:${st.turnSeq++}`;
        if (!st.turns.has(key)) st.turns.set(key, { ts, human: false, completedAt: null });
        st.openTurn = key;
        if (p.model_context_window) st.windowTokens = p.model_context_window;
        break;
      }
      case 'task_complete': {
        const t = st.turns.get(p.turn_id ?? st.openTurn);
        if (t && t.completedAt == null) t.completedAt = ts;
        st.openTurn = null;
        if (typeof p.last_agent_message === 'string' && p.last_agent_message.trim()) {
          st.lastAssistant = { ts, text: p.last_agent_message };
        }
        break;
      }
      case 'turn_aborted':
        st.openTurn = null;
        break;
      case 'user_message':
        human(st, ts, null, p.message);
        break;
      case 'item_completed':
        if (p.item?.type === 'UserMessage') human(st, ts, p.item.id, textOf(p.item.content));
        break;
      case 'token_count': {
        const rl = p.rate_limits;
        // 使用枠はモデル別などの枠(limit_id が codex 以外)を除く
        if (rl && (rl.limit_id == null || rl.limit_id === 'codex') && (rl.primary || rl.secondary)) {
          if (!st.rateLimits || (ts ?? 0) >= (st.rateLimits.ts ?? 0)) st.rateLimits = { ts, rl };
        }
        const info = p.info;
        if (!info) break;
        const last = info.last_token_usage ?? {};
        const total = info.total_token_usage?.total_tokens;
        if (info.model_context_window) st.windowTokens = info.model_context_window;
        st.context = { usedTokens: last.input_tokens ?? null, windowTokens: st.windowTokens };
        // 同じ値の token_count が繰り返し出るので、累計が増えたときだけ 1 リクエストとして数える
        if (typeof total === 'number' && (st.lastTotal == null || total > st.lastTotal)) {
          const cached = last.cached_input_tokens ?? 0;
          st.usage.push({
            key: JSON.stringify(info.total_token_usage),
            ts,
            model: st.model,
            costUSD: null,
            input: Math.max(0, (last.input_tokens ?? 0) - cached),
            output: last.output_tokens ?? 0,
            cacheRead: cached,
            cacheWrite: last.cache_write_input_tokens ?? 0,
          });
        }
        if (typeof total === 'number') st.lastTotal = total;
        break;
      }
    }
    return;
  }

  if (x.type === 'response_item') {
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      if (!p.call_id || st.tools.has(p.call_id)) return;
      st.tools.set(p.call_id, { ts, name: p.name ?? '?', error: false, denied: false });
      const args = parseJson(p.arguments);
      if (p.name === 'update_plan' && Array.isArray(args?.plan)) {
        st.tasks = args.plan.map((s, i) => ({
          id: String(i + 1),
          title: String(s?.step ?? ''),
          status: ['pending', 'in_progress', 'completed'].includes(s?.status) ? s.status : 'pending',
          blockedBy: [],
        }));
      } else if (p.name === 'request_user_input' && Array.isArray(args?.questions)) {
        st.asks.set(p.call_id, {
          ts,
          questions: args.questions.map((q) => ({
            text: String(q?.question ?? ''),
            options: (q?.options ?? []).map((o) => String(typeof o === 'string' ? o : o?.label ?? '')),
          })),
        });
      }
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      if (!p.call_id) return;
      st.answered.add(p.call_id);
      const t = st.tools.get(p.call_id);
      if (t) Object.assign(t, classifyOutput(p.output));
    } else if (p.type === 'message' && p.role === 'assistant') {
      const text = textOf(p.content);
      if (text.trim()) st.lastAssistant = { ts, text };
    }
  }
}

function hash(s) {
  return createHash('sha1').update(s).digest('hex');
}

// VS Code 拡張からの発話は「# Context from my IDE …」で始まり、本文は「## My request for Codex:」の後ろにある
const IDE_REQUEST = '## My request for Codex:';

function human(st, ts, itemId, text) {
  if (ts != null) st.lastHumanTs = ts;
  const turn = st.turns.get(st.openTurn);
  if (turn) turn.human = true;
  let body = typeof text === 'string' ? text.trim() : '';
  const i = body.indexOf(IDE_REQUEST);
  if (i >= 0) body = body.slice(i + IDE_REQUEST.length).trim();
  st.humans.push({ key: itemId ?? `${st.openTurn}|${hash(body)}`, ts, text: body });
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
  if (c && c.mtimeMs === stat.mtimeMs && c.size === stat.size) return c.state;
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
    return c.state;
  }
  c.mtimeMs = stat.mtimeMs;
  c.size = stat.size;
  return c.state;
}

// ~/.codex/sessions 以下の rollout-*.jsonl を再帰で列挙する
function listFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        try {
          out.push({ file: p, mtimeMs: fs.statSync(p).mtimeMs });
        } catch {}
      }
    }
  };
  walk(SESSIONS);
  return out;
}

// state_<n>.sqlite のうち番号が最大のもの
function stateDbPath() {
  let best = null;
  let bestN = -1;
  try {
    for (const name of fs.readdirSync(CODEX)) {
      const m = name.match(/^state_(\d+)\.sqlite$/);
      if (m && Number(m[1]) > bestN) {
        bestN = Number(m[1]);
        best = path.join(CODEX, name);
      }
    }
  } catch {}
  return best;
}

// スレッド一覧と親子関係。開けなければ空(会話記録だけで出す)
function readDb(errors) {
  const threads = new Map();
  const edges = new Map(); // child → parent
  const file = stateDbPath();
  if (!file) return { threads, edges };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        'SELECT id, rollout_path, title, name, model, cwd, git_branch, archived, source, agent_nickname, agent_role, updated_at_ms FROM threads',
      )
      .all();
    for (const r of rows) threads.set(r.id, r);
    for (const e of db.prepare('SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges').all()) {
      edges.set(e.child_thread_id, e.parent_thread_id);
    }
  } catch (e) {
    errors.push(`codex: ${path.basename(file)} を開けません: ${e.message}`);
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return { threads, edges };
}

function oneLine(s, max) {
  if (typeof s !== 'string') return '';
  return s.trim().split('\n')[0].trim().slice(0, max);
}

function lastParagraph(text) {
  const paras = text.trim().split(/\n\s*\n/);
  return paras[paras.length - 1].trim().slice(0, 200);
}

function endsWithQuestion(text) {
  const t = text.replace(/[\s*`]+$/u, '');
  return t.endsWith('?') || t.endsWith('？');
}

function limitOf(r, now) {
  if (!r || typeof r.used_percent !== 'number') return null;
  const resetsAt = typeof r.resets_at === 'number' ? r.resets_at * 1000 : null;
  return { pct: r.used_percent, resetsAt, stale: resetsAt != null && resetsAt < now };
}

function titleOf(th, firstHumanText) {
  return oneLine(th?.name, 80) || oneLine(th?.title, 80) || oneLine(firstHumanText, 60);
}

// 親と子をまとめた家族の中で、各ファイルが「先に現れた分」だけを持つようにする。
// フォークした子は親の履歴を時刻を付け替えてコピーしているので、時刻ではなく内容の key で重複を判定する
//   usage: total_token_usage の JSON / compact: payload のハッシュ / ターン: turn_id / ツール: call_id / 人間の発話: item id
function claimer() {
  const seen = { usage: new Set(), compact: new Set(), turn: new Set(), tool: new Set(), human: new Set() };
  const take = (kind, key) => {
    if (seen[kind].has(key)) return false;
    seen[kind].add(key);
    return true;
  };
  return (s) => {
    const usage = s.usage.filter((u) => take('usage', u.key)).map(({ key, ...u }) => u);
    const compact = s.compact.filter((c) => take('compact', c.key)).map((c) => ({ ts: c.ts, droppedTokens: null }));
    // 人間の発話が無いまま完了したターンは自動続行とみなす(重複を除いた後のターンで判定)
    const auto = [];
    for (const [key, t] of s.turns) {
      if (take('turn', key) && t.completedAt != null && !t.human) auto.push({ ts: t.completedAt, kind: 'system' });
    }
    const tools = [];
    for (const [cid, t] of s.tools) {
      if (take('tool', cid)) tools.push({ ts: t.ts, name: t.name, error: t.error, denied: t.denied });
    }
    const humans = s.humans.filter((h) => take('human', h.key));
    return { usage, compact, auto, tools, firstHumanText: humans.find((h) => h.text)?.text ?? null };
  };
}

// 親セッション 1 件分を組み立てる。親 → 子(開始順)の順に走査し、重複は先に現れたファイルの分とする
function buildSession(node, kids, alive, now) {
  const { st, th } = node;
  const own = claimer();
  const mine = own(st);

  const pendingAsks = [...st.asks.entries()].filter(([cid]) => !st.answered.has(cid)).map(([, a]) => a);
  let status;
  if (st.openTurn) {
    if (pendingAsks.length) status = 'question';
    else if (st.updatedAt != null && now - st.updatedAt <= TURN_RUNNING_MS) status = 'running';
    else status = 'ended';
  } else if (alive && st.updatedAt != null && now - st.updatedAt <= WAITING_MS) {
    status = 'waiting';
  } else {
    status = 'ended';
  }

  const questions = [];
  if (status !== 'ended') {
    if (status === 'question') {
      for (const a of pendingAsks) {
        for (const q of a.questions) questions.push({ ts: a.ts, kind: 'ask', text: q.text, options: q.options });
      }
    }
    const la = st.lastAssistant;
    if (status === 'waiting' && la && (st.lastHumanTs == null || la.ts > st.lastHumanTs) && endsWithQuestion(la.text)) {
      questions.push({ ts: la.ts, kind: 'text', text: lastParagraph(la.text), options: [] });
    }
  }

  const sortedKids = [...kids].sort((a, b) => (a.st.startedAt ?? 0) - (b.st.startedAt ?? 0));
  const subagents = sortedKids.map((k) => {
    const running = !!k.st.openTurn && k.st.updatedAt != null && now - k.st.updatedAt <= TURN_RUNNING_MS;
    let kStatus = running ? 'running' : 'done';
    if (status === 'ended' && kStatus === 'running') kStatus = 'ended';
    const km = own(k.st);
    const last = km.tools.reduce((a, t) => (!a || (t.ts ?? 0) >= (a.ts ?? 0) ? t : a), null);
    return {
      id: k.st.id,
      name: k.st.nickname || k.th?.agent_nickname || k.st.role || k.th?.agent_role || String(k.st.id).slice(0, 8),
      type: k.st.role ?? k.th?.agent_role ?? null,
      model: k.st.model ?? k.th?.model ?? null,
      description: titleOf(k.th, km.firstHumanText),
      isFork: false,
      isTeammate: false,
      status: kStatus,
      startedAt: k.st.startedAt,
      updatedAt: k.st.updatedAt,
      lastTool: last ? { name: last.name, ts: last.ts } : null,
      events: { usage: km.usage, tools: km.tools },
      extra: { compact: km.compact, auto: km.auto },
    };
  });

  const ctx = st.context;
  const cwd = st.cwd ?? th?.cwd ?? '';
  const updatedAt = Math.max(st.updatedAt ?? 0, ...subagents.map((a) => a.updatedAt ?? 0)) || null;
  return {
    agent: 'codex',
    id: st.id,
    title: titleOf(th, mine.firstHumanText),
    cwd,
    project: cwd ? path.basename(cwd) : '',
    branch: st.branch ?? th?.git_branch ?? null,
    model: st.model ?? th?.model ?? null,
    startedAt: st.startedAt,
    updatedAt,
    status,
    live: status !== 'ended',
    pid: null,
    context: {
      usedTokens: ctx.usedTokens,
      windowTokens: ctx.windowTokens,
      pct:
        ctx.usedTokens != null && ctx.windowTokens ? Math.round((ctx.usedTokens / ctx.windowTokens) * 1000) / 10 : null,
    },
    events: {
      usage: [...mine.usage, ...subagents.flatMap((a) => a.events.usage)],
      tools: [...mine.tools, ...subagents.flatMap((a) => a.events.tools)],
      compact: [...mine.compact, ...subagents.flatMap((a) => a.extra.compact)],
      auto: [...mine.auto, ...subagents.flatMap((a) => a.extra.auto)],
    },
    subagents: subagents.map(({ extra, ...a }) => a),
    tasks: st.tasks.map((t) => ({ ...t, blockedBy: [] })),
    questions,
    terminal: { paneKey: null },
  };
}

export async function collect({ since = 0 } = {}) {
  const now = Date.now();
  const errors = [];
  const alive = (await codexProcesses()).length > 0;

  // ここから先はキャッシュを触るので await を挟まない
  const { threads, edges } = readDb(errors);
  const byPath = new Map();
  for (const t of threads.values()) if (t.rollout_path) byPath.set(t.rollout_path, t);

  const files = listFiles();
  const listed = new Set(files.map((f) => f.file));
  for (const k of fileCache.keys()) if (!listed.has(k)) fileCache.delete(k);

  // スレッド id と親子関係は DB から分かる。DB に無いファイルは読んで session_meta から知る
  const nodes = new Map(); // thread id → {file, mtimeMs, th, st?}
  const recent = new Set(
    [...files]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, ALWAYS_READ)
      .map((f) => f.file),
  );
  for (const f of files) {
    const th = byPath.get(f.file);
    let id = th?.id ?? fileCache.get(f.file)?.state.id ?? null;
    if (!id) id = refresh(f.file)?.id ?? null;
    if (!id) continue;
    // DB だけでは親が分からないサブエージェント(source が 'review' など)は、session_meta の親を読む
    if (th && !edges.has(id)) {
      const src = parseSource(th.source);
      if (src.subagent && !src.excluded && !src.parentId) refresh(f.file);
    }
    // 同じスレッドのファイルが複数あれば新しい方
    const prev = nodes.get(id);
    if (!prev || f.mtimeMs > prev.mtimeMs) nodes.set(id, { id, file: f.file, mtimeMs: f.mtimeMs, th });
  }

  // 親子関係: thread_spawn_edges → session_meta / threads.source の親
  const infoOf = (n) => {
    const src = parseSource(n.th?.source ?? fileCache.get(n.file)?.state.source ?? null);
    const st = fileCache.get(n.file)?.state;
    const excluded = src.excluded || !!st?.excluded;
    const subagent = src.subagent || !!st?.source?.subagent;
    const parent = edges.get(n.id) ?? (subagent ? (src.parentId ?? st?.parentId ?? null) : null);
    return { excluded, parent };
  };
  const info = new Map([...nodes.values()].map((n) => [n.id, infoOf(n)]));

  // 祖先をたどって、最初に表示される会話の下にぶら下げる(agy と同じ)
  const memo = new Map();
  const targetOf = (id, depth = 0) => {
    if (memo.has(id)) return memo.get(id);
    let target = null;
    const seen = new Set([id]);
    let cur = info.get(id)?.parent;
    while (cur && !seen.has(cur) && depth < 20) {
      seen.add(cur);
      if (nodes.has(cur) && !info.get(cur)?.excluded && targetOf(cur, depth + 1) === null) {
        target = cur;
        break;
      }
      cur = info.get(cur)?.parent;
    }
    memo.set(id, target);
    return target;
  };
  const kidsOf = new Map();
  const roots = [];
  for (const id of nodes.keys()) {
    if (info.get(id).excluded) continue;
    const t = targetOf(id);
    if (t) {
      if (!kidsOf.has(t)) kidsOf.set(t, []);
      kidsOf.get(t).push(id);
    } else {
      roots.push(id);
    }
  }

  const sessions = [];
  for (const id of roots) {
    const root = nodes.get(id);
    const kids = (kidsOf.get(id) ?? []).map((k) => nodes.get(k));
    const newest = Math.max(root.mtimeMs, ...kids.map((k) => k.mtimeMs));
    const cached = [root, ...kids].some((n) => fileCache.has(n.file));
    // 更新が止まった古い会話は読まない(未完了のターンがあれば 10 分で ended になるので、期間外なら出さなくてよい)
    if (newest < since && !cached) continue;
    const st = refresh(root.file);
    if (!st?.id) continue;
    const kidNodes = kids.map((k) => ({ st: refresh(k.file), th: k.th })).filter((k) => k.st?.id);
    sessions.push(buildSession({ st, th: root.th }, kidNodes, alive, now));
  }

  // 使用枠は、全ファイルのうち timestamp が最新の rate_limits を使う
  for (const f of recent) refresh(f);
  let latest = null;
  for (const c of fileCache.values()) {
    const r = c.state.rateLimits;
    if (r && (!latest || (r.ts ?? 0) > (latest.ts ?? 0))) latest = r;
  }
  let quota = null;
  if (latest) {
    const rl = latest.rl;
    const win = (minutes) =>
      [rl.primary, rl.secondary].find((w) => w && w.window_minutes === minutes) ?? null;
    quota = {
      plan: typeof rl.plan_type === 'string' ? rl.plan_type : null,
      fiveHour: limitOf(win(300), now),
      weekly: limitOf(win(10080), now),
      updatedAt: latest.ts,
    };
  }

  return { sessions, quota, errors };
}
