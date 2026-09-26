#!/usr/bin/env node
// Claude Code の statusLine.command に src/statusline-save.js を挟み、使用枠を保存できるようにする。
//   node src/setup-statusline.js            確認のうえ設定する
//   node src/setup-statusline.js --remove   設定を取り除く
//   --yes を付けると確認を省略する
// 設定ファイルは ~/.claude/settings.json(CLAUDE_CONFIG_DIR があればそのディレクトリ)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = `使い方: npm run setup-statusline -- [--remove] [--yes]
  (引数なし)  ~/.claude/settings.json の statusLine.command に保存用スクリプトを挟む
  --remove    挟んだ保存用スクリプトを取り除く
  --yes       確認せずに書き込む
  --help      この説明を表示する
CLAUDE_CONFIG_DIR が設定されていれば、そのディレクトリの settings.json を対象にします。`;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      remove: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  }));
} catch (e) {
  console.error(e.message);
  console.error(USAGE);
  process.exit(1);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsPath = path.join(configDir, 'settings.json');
// Windows でもシェル(bash)から実行されるのでスラッシュ区切りにし、空白を含むパスに備えて囲む
const scriptPath = fileURLToPath(new URL('./statusline-save.js', import.meta.url)).replaceAll('\\', '/');
const saveCmd = `node "${scriptPath}"`;
const prefix = `${saveCmd} --tee | `;

// 手で書いた設定(引用符なし・別の場所のパス)も取り除けるよう、パスは緩く合わせる
const SAVE_ARG = String.raw`(?:"[^"]*statusline-save\.js"|'[^']*statusline-save\.js'|\S*statusline-save\.js)`;
const PREFIX_RE = new RegExp(String.raw`^\s*node\s+${SAVE_ARG}\s+--tee\s*\|\s*`);
const ONLY_RE = new RegExp(String.raw`^\s*node\s+${SAVE_ARG}\s*$`);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function readSettings() {
  let text;
  try {
    text = fs.readFileSync(settingsPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, settings: {} };
    fail(`${settingsPath} を読めません: ${e.message}`);
  }
  let settings;
  try {
    settings = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    fail(`${settingsPath} を JSON として読めません。何も変更していません。\n${e.message}`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    fail(`${settingsPath} の中身がオブジェクトではありません。何も変更していません。`);
  }
  return { exists: true, settings };
}

// 変更後の settings と表示用の command を返す。変更しないときは理由を表示して終了する
function plan(settings) {
  const sl = settings.statusLine;
  const cur = sl && typeof sl.command === 'string' ? sl.command : '';
  if (sl !== undefined && (!sl || typeof sl !== 'object' || sl.type !== 'command')) {
    console.log(`statusLine.type が "command" ではないため変更しません(type: ${JSON.stringify(sl?.type)})。`);
    console.log('README の手順を参考に、手で設定してください。');
    process.exit(0);
  }
  if (!args.remove) {
    if (cur.includes('statusline-save.js')) {
      console.log('設定済みです。statusLine.command は既に statusline-save.js を呼んでいます。');
      console.log(`  ${cur}`);
      process.exit(0);
    }
    const next = cur.trim() ? prefix + cur : saveCmd;
    // 既存の statusLine の他のキー(padding など)は残す
    const statusLine = sl ? { ...sl, command: next } : { type: 'command', command: next };
    return { before: cur || null, after: next, settings: { ...settings, statusLine } };
  }
  if (!cur.includes('statusline-save.js')) {
    console.log('statusLine.command は statusline-save.js を呼んでいないため、取り除くものはありません。');
    process.exit(0);
  }
  if (ONLY_RE.test(cur)) {
    const { statusLine, ...rest } = settings;
    return { before: cur, after: null, settings: rest };
  }
  if (!PREFIX_RE.test(cur)) {
    console.log('statusLine.command の先頭以外で statusline-save.js を呼んでいるため、自動では取り除けません。');
    console.log(`  ${cur}`);
    process.exit(0);
  }
  const next = cur.replace(PREFIX_RE, '');
  return { before: cur, after: next, settings: { ...settings, statusLine: { ...sl, command: next } } };
}

async function confirm() {
  if (args.yes) return true;
  if (!process.stdin.isTTY) {
    console.log('対話できない環境のため書き込みませんでした。書き込むには --yes を付けて実行してください。');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question('この内容で書き込みますか? [y/N] ')).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

function write(exists, settings) {
  fs.mkdirSync(configDir, { recursive: true });
  if (exists) fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
  // 書きかけのファイルを Claude Code が読まないよう、一時ファイルに書いてから置き換える
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    fs.renameSync(tmp, settingsPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    fail(`${settingsPath} に書き込めません: ${e.message}`);
  }
}

const { exists, settings } = readSettings();
const p = plan(settings);
console.log(`設定ファイル: ${settingsPath}${exists ? '' : '(新規作成)'}`);
console.log(`変更前: ${p.before ?? '(statusLine なし)'}`);
console.log(`変更後: ${p.after ?? '(statusLine を削除)'}`);
if (!(await confirm())) {
  console.log('中止しました。何も変更していません。');
  process.exit(0);
}
write(exists, p.settings);
if (exists) console.log(`書き込みました(元のファイルは ${settingsPath}.bak に保存しました)。`);
else console.log('書き込みました。');
console.log(
  args.remove ? 'Claude Code の statusline から保存用スクリプトを外しました。' : '次に statusline が更新されたときから、使用枠が保存されます。',
);
