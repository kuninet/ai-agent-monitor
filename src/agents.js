import os from 'node:os';
import path from 'node:path';
import * as claude from './collectors/claude.js';
import * as agy from './collectors/agy.js';
import * as codex from './collectors/codex.js';

const HOME = os.homedir();

// 監視できるエージェントの一覧。コレクタを増やすときはここに足す
//   identity: Orca の端末一覧の agentIdentity
//   dataDirs: どれかがあれば「データあり」とみなす
//   priced: usage に費用(costUSD)が入る
//   cumulativeUsage: usage がリクエストごとの値(累計の集計に使える)。agy は直近 1 回のスナップショットなので false
export const AGENT_DEFS = [
  {
    id: 'claude',
    label: 'Claude',
    identity: 'claude',
    collect: claude.collect,
    dataDirs: [path.join(HOME, '.claude', 'projects')],
    priced: true,
    cumulativeUsage: true,
  },
  {
    id: 'agy',
    label: 'agy',
    identity: 'antigravity',
    collect: agy.collect,
    dataDirs: [path.join(HOME, '.gemini', 'antigravity-cli'), path.join(HOME, '.gemini', 'antigravity')],
    priced: false,
    cumulativeUsage: false,
  },
  {
    id: 'codex',
    label: 'Codex',
    identity: 'codex',
    collect: codex.collect,
    dataDirs: [path.join(HOME, '.codex', 'sessions')],
    priced: false,
    cumulativeUsage: true,
  },
];

export const AGENT_IDS = AGENT_DEFS.map((a) => a.id);

export function agentDef(id) {
  return AGENT_DEFS.find((a) => a.id === id) ?? null;
}
