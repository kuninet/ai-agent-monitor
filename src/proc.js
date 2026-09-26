import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// ps の出力(lstart など)はロケールで書式が変わるので、C ロケールで実行する
function ps(args) {
  return run('ps', args, { env: { ...process.env, LC_ALL: 'C' } });
}

const WIN = process.platform === 'win32';

// Windows には ps が無い(Git Bash の ps は書式が違う)ので、PowerShell の Win32_Process で代わりに取る。
// 開始時刻は DateTime の JSON 書式に頼らず、PowerShell 側で epoch ms にしてから出す
const WIN_PS = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; cmd = $_.CommandLine;' +
    ' start = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null } } } | ConvertTo-Json -Compress',
].join('; ');

// powershell.exe の実行は 1 秒ほどかかるので、1 回の集計(各コレクタが並行に呼ぶ)で 1 度で済むよう結果を短く使い回す
const WIN_TTL = 2000;
let winCache = null; // {at, promise}

// [{pid, name, cmd, start}]。取れなければ空配列
function winProcesses() {
  if (winCache && Date.now() - winCache.at < WIN_TTL) return winCache.promise;
  const promise = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 64 * 1024 * 1024,
  })
    .then(({ stdout }) => {
      const j = JSON.parse(stdout || '[]');
      return (Array.isArray(j) ? j : [j]).map((p) => ({
        pid: Number(p.pid),
        name: String(p.name ?? ''),
        cmd: String(p.cmd ?? ''),
        start: typeof p.start === 'number' ? p.start : null,
      }));
    })
    .catch(() => []);
  winCache = { at: Date.now(), promise };
  return promise;
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
  if (WIN) return null; // Windows では環境変数を読めない(Orca も Mac 用)
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
  if (WIN) {
    const want = new Set(pids.map(Number));
    for (const p of await winProcesses()) if (want.has(p.pid)) out.set(p.pid, p.start);
    return out;
  }
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
  if (WIN) {
    return (await winProcesses())
      .filter((p) => /^agy(\.exe)?$/i.test(p.name))
      .map((p) => ({
        pid: p.pid,
        conversationId: p.cmd.match(/--conversation[= ]"?([^\s"]+)/)?.[1] ?? null,
        startedAt: p.start,
      }));
  }
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

// 実行ファイル名が codex のプロセス(CLI や app-server)の pid 一覧
export async function codexProcesses() {
  // Windows では codex.exe のほか、npm 版の node.exe …\codex\bin\codex.js も数える
  if (WIN) {
    return (await winProcesses())
      .filter(
        (p) =>
          /^codex(\.exe)?$/i.test(p.name) ||
          (/^node(\.exe)?$/i.test(p.name) && /[\\/]codex[\\/]bin[\\/]codex\.js\b/i.test(p.cmd)),
      )
      .map((p) => p.pid);
  }
  try {
    const { stdout } = await ps(['-axo', 'pid=,command=']);
    const out = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S*\/)?codex(\s.*)?$/);
      if (m) out.push(Number(m[1]));
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
