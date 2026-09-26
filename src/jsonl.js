import fs from 'node:fs';

// 追記型の JSONL を差分だけ読むためのカーソル。
// 途中までしか書かれていない最終行は Buffer のまま持ち越す(マルチバイト文字の分断対策)。
export function newCursor() {
  return { offset: 0, ino: 0, rest: Buffer.alloc(0) };
}

const CHUNK = 8 * 1024 * 1024;

function parseLines(buf, out) {
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 壊れた行(書き込み途中・改行混入)は読み飛ばす
    }
  }
}

// 追記分の JSON オブジェクトを返す。ファイルが縮んだ/置き換わった場合は null(呼び出し側で作り直す)。
// 巨大な追記でも文字列長の上限に当たらないよう、チャンク単位で完結した行ごとに処理する。
export function readAppended(file, cursor) {
  const st = fs.statSync(file);
  if (st.size < cursor.offset || (cursor.ino && cursor.ino !== st.ino)) return null;
  if (st.size === cursor.offset) return [];

  const out = [];
  const fd = fs.openSync(file, 'r');
  try {
    while (cursor.offset < st.size) {
      const len = Math.min(CHUNK, st.size - cursor.offset);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, cursor.offset);
      if (n <= 0) break;
      cursor.offset += n;
      cursor.ino = st.ino;

      const chunk = buf.subarray(0, n);
      const all = cursor.rest.length ? Buffer.concat([cursor.rest, chunk]) : chunk;
      const nl = all.lastIndexOf(0x0a);
      if (nl < 0) {
        cursor.rest = all;
        continue;
      }
      // 持ち越し分がチャンク全体のバッファを参照し続けないようコピーする
      cursor.rest = Buffer.from(all.subarray(nl + 1));
      parseLines(all.subarray(0, nl), out);
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
