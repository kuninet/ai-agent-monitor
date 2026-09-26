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

// 設定ファイルが無い・壊れているときは、データのあるエージェントすべて
function savedAgents() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const agents = normalizeAgents(cfg?.agents);
    if (agents) return agents;
  } catch {}
  return AGENT_DEFS.filter(detected).map((d) => d.id);
}

export function getConfig() {
  return {
    agents: override ?? savedAgents(),
    available: AGENT_DEFS.map((d) => ({ id: d.id, label: d.label, detected: detected(d) })),
    locked: override !== null,
  };
}

export function enabledAgents() {
  return override ?? savedAgents();
}

// 保存して新しい設定を返す。--agents で固定されているときは例外(code: 'LOCKED')
export function saveConfig(list) {
  if (override !== null) {
    const e = new Error('起動オプション --agents で指定されているため変更できません');
    e.code = 'LOCKED';
    throw e;
  }
  const agents = normalizeAgents(list);
  if (!agents || agents.length === 0) {
    const e = new Error('agents には監視するエージェントを 1 つ以上、文字列の配列で指定してください');
    e.code = 'INVALID';
    throw e;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ agents }, null, 2)}\n`);
  fs.renameSync(tmp, CONFIG_FILE);
  return getConfig();
}
