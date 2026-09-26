import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// ps の出力(lstart など)はロケールで書式が変わるので、C ロケールで実行する
function ps(args) {
  return run('ps', args, { env: { ...process.env, LC_ALL: 'C' } });
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// 同一ユーザーのプロセスの環境変数から ORCA_PANE_KEY を取る(macOS の ps eww)。
export async function paneKeyOf(pid) {
  try {
    const { stdout } = await ps(['eww', '-o', 'command=', '-p', String(pid)]);
    return stdout.match(/\bORCA_PANE_KEY=(\S+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

// ps の lstart(ローカル時刻の "Sat Sep 26 10:35:01 2026")
const LSTART = /\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4}/.source;

function lstartMs(s) {
  const n = Date.parse(s);
  return Number.isNaN(n) ? null : n;
}

// 複数 pid の開始時刻(epoch ms)を 1 回の ps でまとめて取る。pid の再利用を見分けるのに使う
export async function procStarts(pids) {
  const out = new Map();
  if (!pids.length) return out;
  let stdout = '';
  try {
    ({ stdout } = await ps(['-o', 'pid=,lstart=', '-p', pids.join(',')]));
  } catch (e) {
    // 存在しない pid が 1 つでも混ざると ps は終了コード 1 を返すが、残りの行は出力される
    stdout = e.stdout ?? '';
  }
  const re = new RegExp(String.raw`^\s*(\d+)\s+(${LSTART})`);
  for (const line of String(stdout).split('\n')) {
    const m = line.match(re);
    if (m) out.set(Number(m[1]), lstartMs(m[2]));
  }
  return out;
}

// 起動中の agy プロセス: [{pid, conversationId, startedAt}]
export async function agyProcesses() {
  try {
    const { stdout } = await ps(['-axo', 'pid=,lstart=,command=']);
    const out = [];
    // lstart が想定外の書式(ロケール違いなど)でも pid と command は拾えるよう、
    // lstart 部分は「西暦 4 桁で終わる 3〜5 語」として省略可能にし、C ロケールの書式のときだけ時刻に変換する
    const re = new RegExp(String.raw`^\s*(\d+)\s+(?:(\S+(?:\s+\S+){1,3}\s+\d{4})\s+)?(\S*\/)?agy(\s.*)?$`);
    const cLstart = new RegExp(String.raw`^${LSTART}$`);
    for (const line of stdout.split('\n')) {
      const m = line.match(re);
      if (!m) continue;
      out.push({
        pid: Number(m[1]),
        conversationId: m[4]?.match(/--conversation[= ](\S+)/)?.[1] ?? null,
        startedAt: m[2] && cLstart.test(m[2]) ? lstartMs(m[2]) : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// Orca の端末一覧。Orca が無い環境では空配列。
export async function orcaTerminals() {
  try {
    const { stdout } = await run('orca', ['terminal', 'list', '--json'], { timeout: 5000 });
    return JSON.parse(stdout).result?.terminals ?? [];
  } catch {
    return [];
  }
}

export async function orcaSwitch(handle) {
  await run('orca', ['terminal', 'switch', '--terminal', handle], { timeout: 5000 });
}
