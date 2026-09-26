#!/usr/bin/env node
// Claude Code の statusline 入力を ~/.ai-status/claude/<session_id>.json に保存する。
// 使用枠(rate_limits)はこの入力にしか含まれないため、ダッシュボードはこのファイルを読む。
//   node src/statusline-save.js                 保存だけ(何も出力しない)
//   node src/statusline-save.js --tee | <cmd>   保存して、入力をそのまま stdout に流す
//   --agy を付けると Antigravity CLI(agy)の入力として ~/.ai-status/agy/<conversation_id>.json に保存する。
//   agy の使用枠(quota)・コンテキスト・モデル名もこの入力にしか含まれない
// statusline を壊さないよう、どんな失敗でも例外を出さず終了コード 0 で終わる
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tee = process.argv.includes('--tee');
const agy = process.argv.includes('--agy');

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
});
process.on('uncaughtException', () => {});
process.on('exit', () => {
  process.exitCode = 0;
});
