// Claude API の単価(USD / 100万トークン)。2026-06 時点の公式価格。
// cache write は 5分 TTL = input×1.25、1時間 TTL = input×2。cache read はモデルごとに異なる。
// 先に一致させたいもの(fable-5-1 など)を上に置く。
const TABLE = [
  [/fable-5-1|mythos-5-1/, { input: 10, output: 50, read: 0.25 }],
  [/fable-5|mythos-5/, { input: 10, output: 50, read: 1.0 }],
  [/opus-5-5/, { input: 4, output: 20, read: 0.2 }],
  [/opus-5/, { input: 5, output: 25, read: 0.5 }],
  [/opus-4-[5-9]/, { input: 5, output: 25, read: 0.5 }],
  [/opus-4/, { input: 15, output: 75, read: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, read: 0.2 }],
  [/sonnet-4|sonnet-3-7/, { input: 3, output: 15, read: 0.3 }],
  [/haiku-4-5/, { input: 1, output: 5, read: 0.1 }],
  [/haiku-3-5/, { input: 0.8, output: 4, read: 0.08 }],
];

export function priceFor(model) {
  if (!model) return null;
  const m = model.toLowerCase().replace(/\[.*?\]/g, '');
  for (const [re, p] of TABLE) if (re.test(m)) return p;
  return null;
}

// usage オブジェクト 1件分の費用。単価不明なら null。
export function costOf(model, u) {
  const p = priceFor(model);
  if (!p) return null;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
  const usd =
    ((u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      w5m * p.input * 1.25 +
      w1h * p.input * 2 +
      (u.cache_read_input_tokens ?? 0) * p.read) /
    1e6;
  // fast mode は標準の 2倍
  return u.speed === 'fast' ? usd * 2 : usd;
}
