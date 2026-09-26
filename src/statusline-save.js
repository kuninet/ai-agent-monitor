#!/usr/bin/env node
// Claude Code の statusline 入力を ~/.ai-status/claude/<session_id>.json に保存する。
// 使用枠(rate_limits)はこの入力にしか含まれないため、ダッシュボードはこのファイルを読む。
//   node src/statusline-save.js                   保存だけ(何も出力しない)
//   node src/statusline-save.js --tee | <cmd>     保存して、入力をそのまま stdout に流す
//   node src/statusline-save.js -- <cmd> [args]   保存して、<cmd> を子プロセスとして起動し、入力を渡す
//   --agy を付けると Antigravity CLI(agy)の入力として ~/.ai-status/agy/<conversation_id>.json に保存する。
//   agy の使用枠(quota)・コンテキスト・モデル名もこの入力にしか含まれない
//
// `--` の形は、statusline のコマンドをシェルを通さずに実行する環境(Windows の agy)向け。
// パイプも引用符も使えないため、後段のコマンドをこのスクリプトが起動する。
//   - 自分のオプション(--agy, --tee)は `--` より前だけから読む。`--` より後ろは、--agy などを含めて
//     すべて子プロセスのコマンドと引数としてそのまま渡す(シェルは通さない)
//   - `--` があるときは入力を子の stdin に渡すので、--tee は不要で、付いていても無視する
//   - 子の stdout / stderr はそのまま自分の stdout / stderr になり、終了コードは子の終了コードを返す。
//     子を起動できなかったときは理由を stderr に出して終了コード 1 で終わる
//   - 子のコマンドが node(node.exe)なら、今動いている node(process.execPath)で起動する
// 保存は子の起動前に行う。保存の失敗は表示を妨げないよう、どの形でも握りつぶす。
// `--` が無いときは、statusline を壊さないよう、どんな失敗でも例外を出さず終了コード 0 で終わる
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep === -1 ? argv : argv.slice(0, sep);
const child = sep === -1 ? null : argv.slice(sep + 1);
const agy = own.includes('--agy');
const tee = !child && own.includes('--tee');

function save(buf) {
  // 先頭の BOM は JSON.parse できないので取り除く(保存するファイルにも付けない)
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  const input = JSON.parse(body.toString('utf8'));
  const sid = agy ? input?.conversation_id : input?.session_id;
  // ファイル名に使うので、パス区切りや .. を含み得る値は保存しない
  if (typeof sid !== 'string' || !/^[\w-]{1,128}$/.test(sid)) return;
  const dir = path.join(os.homedir(), '.ai-status', agy ? 'agy' : 'claude');
  const dest = path.join(dir, `${sid}.json`);
  let data = body;
  if (agy) {
    // collectors/agy.js が last_statusline_input.json を写すときと同じ形にする。
    // 個人情報(アカウントのメールアドレス)は保存せず、保存した時刻を capturedAt(ms)に入れる
    const { email, ...rest } = input;
    data = JSON.stringify({ ...rest, capturedAt: Date.now() });
  }
  fs.mkdirSync(dir, { recursive: true });
  // ダッシュボードが書きかけを読まないよう、一時ファイルに書いてから置き換える
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

// `--` より後ろのコマンドを起動し、入力を渡す。終了コードは子に合わせる
function runChild(buf) {
  if (!child.length) {
    console.error('statusline-save.js: `--` の後ろに起動するコマンドがありません');
    process.exitCode = 1;
    return;
  }
  const [cmd, ...rest] = child;
  const file = /^node(\.exe)?$/i.test(cmd) ? process.execPath : cmd;
  let proc;
  try {
    proc = spawn(file, rest, { stdio: ['pipe', 'inherit', 'inherit'], shell: false, windowsHide: true });
  } catch (e) {
    console.error(`statusline-save.js: ${cmd} を起動できません: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  let failed = false;
  proc.on('error', (e) => {
    failed = true;
    console.error(`statusline-save.js: ${cmd} を起動できません: ${e.message}`);
    process.exitCode = 1;
  });
  proc.on('close', (code) => {
    // 起動できなかったときは 1 のまま。シグナルで終了したとき(code が null)も 1 にする
    if (!failed) process.exitCode = code ?? 1;
  });
  // 子が入力を読まずに終了しても(EPIPE)無視する
  proc.stdin.on('error', () => {});
  proc.stdin.end(buf);
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  const buf = Buffer.concat(chunks);
  if (tee && buf.length) {
    // 後段のコマンドが先に終了しても(EPIPE)無視する
    process.stdout.on('error', () => {});
    process.stdout.write(buf);
  }
  try {
    save(buf);
  } catch {}
  if (child) runChild(buf);
});
if (!child) {
  process.on('uncaughtException', () => {});
  process.on('exit', () => {
    process.exitCode = 0;
  });
}
