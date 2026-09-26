import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_DEFS, AGENT_IDS } from './agents.js';

const CONFIG_DIR = path.join(os.homedir(), '.ai-status');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// 起動オプション --agents で指定された値。指定があれば保存した設定より優先し、変更を受け付けない
let override = null;

// 未知の値を除き、重複を除いて一覧の順に並べる
export function normalizeAgents(list) {
  if (!Array.isArray(list)) return null;
  const set = new Set(list.filter((v) => typeof v === 'string'));
  return AGENT_IDS.filter((id) => set.has(id));
}

export function setOverride(list) {
  override = normalizeAgents(list);
}

function detected(def) {
  return def.dataDirs.some((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

const PLAN_MAX_USD = 10000;

// プランの月額(USD)。0 より大きく上限以下の有限の数値だけを有効とし、小数第 2 位で丸める。それ以外は null
export function normalizePlanUSD(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > PLAN_MAX_USD) return null;
  const rounded = Math.round(v * 100) / 100;
  return rounded > 0 ? rounded : null;
}

// 設定ファイルの中身。無い・壊れているときは空のオブジェクト
function readFile() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  } catch {
    return {};
  }
}

// 設定ファイルに agents が無い・壊れているときは、データのあるエージェントすべて
function savedAgents(cfg = readFile()) {
  return normalizeAgents(cfg.agents) ?? AGENT_DEFS.filter(detected).map((d) => d.id);
}

export function planMonthlyUSD() {
  return normalizePlanUSD(readFile().claudePlanMonthlyUSD);
}

export function getConfig() {
  const cfg = readFile();
  return {
    agents: override ?? savedAgents(cfg),
    available: AGENT_DEFS.map((d) => ({ id: d.id, label: d.label, detected: detected(d) })),
    locked: override !== null,
    claudePlanMonthlyUSD: normalizePlanUSD(cfg.claudePlanMonthlyUSD),
  };
}

export function enabledAgents() {
  return override ?? savedAgents();
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// 本文 { agents?, claudePlanMonthlyUSD? } で部分更新し、新しい設定を返す。含まれないキーは今の値を保つ。
// 不正な値は例外(code: 'INVALID')。--agents で固定されているときに agents を変えようとしたら例外(code: 'LOCKED')
export function saveConfig(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw fail('INVALID', '本文は { agents, claudePlanMonthlyUSD } の形のオブジェクトで指定してください');
  }
  const hasAgents = 'agents' in patch;
  const hasPlan = 'claudePlanMonthlyUSD' in patch;
  if (!hasAgents && !hasPlan) throw fail('INVALID', 'agents か claudePlanMonthlyUSD を指定してください');

  const cfg = readFile();
  if (hasAgents) {
    if (override !== null) throw fail('LOCKED', '起動オプション --agents で指定されているため変更できません');
    const agents = normalizeAgents(patch.agents);
    if (!agents || agents.length === 0) {
      throw fail('INVALID', 'agents には監視するエージェントを 1 つ以上、文字列の配列で指定してください');
    }
    cfg.agents = agents;
  }
  if (hasPlan) {
    const v = patch.claudePlanMonthlyUSD;
    const plan = v === null ? null : normalizePlanUSD(v);
    if (v !== null && plan === null) {
      throw fail('INVALID', `claudePlanMonthlyUSD は 0 より大きく ${PLAN_MAX_USD} 以下の数値か、null で指定してください`);
    }
    cfg.claudePlanMonthlyUSD = plan;
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, CONFIG_FILE);
  return getConfig();
}
