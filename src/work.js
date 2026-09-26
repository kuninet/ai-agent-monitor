// 作業区間 [{start, end}](epoch ms)の扱い

// これ以上間隔が空いたら、その間は作業していなかったとみなす
export const WORK_GAP_MS = 2 * 60_000;

// 重なる区間・接する区間をまとめ、開始順に並べる
export function mergeIntervals(list) {
  const xs = list
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of xs) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push({ start: w.start, end: w.end });
  }
  return out;
}

// 行の時刻を並べ、隣り合う時刻の間隔が gapMs 以下の部分を作業区間としてつなぐ
export function gapIntervals(times, gapMs = WORK_GAP_MS) {
  const ts = times.filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  let cur = null;
  for (const t of ts) {
    if (cur && t - cur.end <= gapMs) cur.end = t;
    else {
      if (cur && cur.end > cur.start) out.push(cur);
      cur = { start: t, end: t };
    }
  }
  if (cur && cur.end > cur.start) out.push(cur);
  return out;
}

// [since, now] と重なる部分だけの合計(ms)
export function clippedMs(list, since, now) {
  let sum = 0;
  for (const w of list ?? []) {
    const a = Math.max(w.start, since);
    const b = Math.min(w.end, now);
    if (b > a) sum += b - a;
  }
  return sum;
}

// ターンの中の行の間隔がこれを超えたら、その間は作業していなかったとみなす(Codex・agy)
export const TURN_GAP_MS = 30 * 60_000;

// list から holes と重なる部分を取り除く
export function subtractIntervals(list, holes) {
  const hs = mergeIntervals(holes);
  const out = [];
  for (const w of mergeIntervals(list)) {
    let start = w.start;
    for (const h of hs) {
      if (h.end <= start || h.start >= w.end) continue;
      if (h.start > start) out.push({ start, end: h.start });
      start = Math.max(start, h.end);
    }
    if (start < w.end) out.push({ start, end: w.end });
  }
  return out;
}
