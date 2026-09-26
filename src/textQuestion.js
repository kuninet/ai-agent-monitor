// ターン末の応答の本文から、人に判断・回答・作業を求めて止まっている文を見つける。
//   level 'question': 疑問の文末、選択や許可を求める強い言い回しがある
//   level 'request' : 依頼の言い回しだけ(「〜を確認してください」など)。返事待ちという意味で扱う

const TAIL_CHARS = 2000;

// 文の分類ごとの正規表現
// 疑問符で終わる
const QEND = /[?]+[)」』*_~ー]*$/;
// 「〜ますか。」「〜しましょうか」などの疑問の文末と、「〜するか、〜するか」の二択
const KA_END =
  /(ます|です|でしょう|ましょう|しょう|ません|いい|よい|良い|どう|いかが)か[。!…]*$|か、[^\n]{1,80}(する|にする|進める|入れる|やる|残す)か[。]?$/;
// 依頼・条件付きの許可・判断待ちの言い回し
const ASK = new RegExp(
  [
    '(教えて|決めて|選んで|指示して|指定して|判断して|知らせて|貼って|送って|共有して|続けて|お聞かせ|お申し付け|確認して)(ください|下さい|もらえ|いただけ|くれ|くださ)',
    '(どちら|どれ|どの(方針|案|形|順)?|いかが)(に|で|から)?(し|進め|行き|いき|始め|着手|切り)|どう(します|しましょう|するか)',
    '(確認|判断|承認|指示|回答|返事|OK|go)(を|が)?(もらえれば|もらったら|いただければ|いただいたら|いただいてから|もらってから|あれば|があるまで|あるまで)',
    '(点|こと|方針|答え|回答)が(決まれば|分かれば|わかれば|出れば|埋まれば)|か、[^\n]{1,80}か(です|。|$)',
    '(て|で|が|内容が|これで|それで|この(方針|形|内容|計画|案)で)?(よければ|良ければ|よろしければ|OKなら|いいなら|良いなら|構わなければ)',
    '(もらえれば|いただければ|くだされば|くれれば)',
    '決めたい|決める必要|確認したい(です|点|のは)|確認させて|お任せします|任せます',
    'どちらでも(構いません|動けます|進められます|大丈夫|いいです|。|$)|(二択|三択|次のどちらか|のどちらか|のどれか|いずれか)(です|で|。)',
    '(全文|続き|結果|出力)(だけ)?(を)?(ください|そのままください)',
  ].join('|'),
  'i',
);
// 英語の問いかけ(文頭)
const ASK_EN = /^(Should I|Would you like|Do you want)\b/i;
// 社交辞令(完了後の任意の申し出)。選択を求める語が同じ文にあれば除外しない
const POLITE =
  /(うまくいかない場合|お困り|必要(なら|であれば|に応じて|があれば)|もし必要|気になる(点|こと|ところ)|何か(あれば|ありましたら)|ご不明|不明点|お気軽|いつでも|他に[^\n]*(あれば|ありましたら))/;
const POLITE_EN = /Let me know if/i;
const POLITE_KEEP = /(どちら|どれ|決め|選|か[、,])/;
// level 'question' にする強い言い回し
const STRONG_ASK = /(よければ|良ければ|よろしければ|OKなら|いいなら|構わなければ|どちら|どれ|いかが|どう(します|しましょう)|決めて|選んで|指示|承認|か、[^\n]{1,80}か)/;
// 箇条書き・番号付きの行
const LIST = /^\s*(?:[-*+•]\s+|\d{1,2}[.)]\s*|[①-⑩]\s*|\(\d{1,2}\)\s*|[A-Ea-e][.)]\s+|[A-E]案|案\s*[A-Z0-9]\s*[::])/;
// 選択肢の前置き
const CHOOSE = /(どちら|どれ|いずれ|二択|三択|選択肢|候補|決め|選ん|選び|案[をで]|方針[をで])/;

// 末尾の「Sources:」「参考:」の段落と、リンクや URL だけの段落
const SOURCES_PARA = /^\s*(?:[*_]{1,2})?(Sources|参考)(?:[*_]{1,2})?\s*[:：]/i;
const LINK_LINE = /^\s*(?:[-*+•]\s+|\d{1,2}[.)]\s*)?(?:\[[^\]]*\]\([^)]*\)|<?https?:\/\/\S+>?)\s*$/;

// 行末・文末の扱いを揃えるため、`.` の代わりに [^\n] を使い、`$` の代わりに次の先読みを使う
//   END: 文字列の末尾、または末尾の改行の直前 / LINE_END: 改行の直前か文字列の末尾 / LINE_START: 行頭
const END = String.raw`(?=\n?(?![\s\S]))`;
const LINE_END = String.raw`(?=\n|(?![\s\S]))`;
const LINE_START = String.raw`(?<![^\n])`;
const CODE_FENCE = new RegExp(String.raw`\`\`\`[\s\S]*?(\`\`\`|${END})`, 'g');
const DIRECTIVE = new RegExp(String.raw`${LINE_START}::[a-z-]+\{[^\n]*?\}\s*${LINE_END}`, 'g');

// 丸括弧の中の「?」は文の区切りや疑問の文末とみなさないよう、判定に使わない全角の「？」に置き換える
// (NFKC の後なので、全角の丸括弧も半角になっている)
const PAREN = /\(([^()\n]{0,200})\)/g;
const maskParen = (m) => m.replace(/\?/g, '？');

function clean(t, opts) {
  t = t.normalize('NFKC');
  t = t.replace(CODE_FENCE, '\n'); // 閉じていないコードフェンスは末尾まで除く
  t = t.replace(DIRECTIVE, ''); // ::git-stage{...} などのディレクティブ行
  t = t.replace(INLINE_CODE, 'CODE');
  t = t.replace(MD_LINK, '$1');
  t = t.replace(URL_RE, 'URL');
  t = t.replace(QUOTED, '「Q」'); // 引用は中身を見ない
  t = t.replace(BOLD, '');
  if (opts.parens) t = t.replace(PAREN, maskParen);
  return t;
}

const INLINE_CODE = /`[^`\n]*`/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const URL_RE = /https?:\/\/\S+/g;
const QUOTED = /[「『"“]([^」』"”\n]{0,200})[」』"”]/g;
const BOLD = /\*\*|__/g;

// 表示用の本文: 判定用の前処理のうち、インラインコード・URL・括弧の中身を伏せる処理だけを除いたもの
function displayText(t) {
  t = t.normalize('NFKC');
  t = t.replace(CODE_FENCE, '\n');
  t = t.replace(DIRECTIVE, '');
  t = t.replace(MD_LINK, '$1');
  t = t.replace(BOLD, '');
  return t;
}

// 表示用の行に伏せ字の処理をかけ、伏せ字後の各文字が表示用の行のどの範囲に当たるかを返す
function maskWithMap(line, opts) {
  let text = line;
  let src = Array.from({ length: line.length }, (_, i) => [i, i + 1]); // UTF-16 の単位
  const steps = [
    [INLINE_CODE, () => 'CODE'],
    [URL_RE, () => 'URL'],
    [QUOTED, () => '「Q」'],
  ];
  if (opts.parens) steps.push([PAREN, maskParen]);
  for (const [re, replace] of steps) {
    let out = '';
    const map = [];
    let pos = 0;
    for (const m of text.matchAll(re)) {
      out += text.slice(pos, m.index);
      map.push(...src.slice(pos, m.index));
      const span = src.slice(m.index, m.index + m[0].length);
      const range = span.length ? [span[0][0], span[span.length - 1][1]] : [0, 0];
      const repl = replace(m[0]);
      out += repl;
      // 同じ長さの置き換え(括弧の中の「?」)は 1 文字ずつ対応させる
      if (repl.length === m[0].length) map.push(...span);
      else for (let i = 0; i < repl.length; i++) map.push(range);
      pos = m.index + m[0].length;
    }
    out += text.slice(pos);
    map.push(...src.slice(pos));
    text = out;
    src = map;
  }
  return { text, src };
}

// 前後の空白を除く
function strip(s) {
  return s.replace(/^\s+|\s+$/g, '');
}

// 前後から chars の文字を除いた範囲 [開始, 終了)
function stripRange(s, chars) {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return [a, b];
}

// 段落(行の配列)の配列。見出し・引用・表・区切り線の行は除く
function blocks(text, opts) {
  return splitBlocks(clean(text, opts));
}

function splitBlocks(cleaned) {
  const out = [];
  for (const p of cleaned.split(/\n\s*\n/)) {
    const lines = [];
    for (const l of p.split('\n')) {
      const s = strip(l);
      if (!s || /^#{1,6}\s/.test(s) || s.startsWith('>') || s.startsWith('|') || /^[-=*_]{3,}$/.test(s)) continue;
      lines.push(s);
    }
    if (lines.length) out.push(lines);
  }
  return out;
}

// 文と、行の中での開始位置
function sents(line) {
  const out = [];
  for (const m of line.matchAll(/[^。?!]*[。?!]+|[^。?!]+$/g)) {
    const text = strip(m[0]);
    if (text) out.push({ text, start: m.index + m[0].search(/\S|$/) });
  }
  return out;
}

// 末尾から「Sources:」「参考:」の段落と、リンクや URL だけの段落を取り除く
function dropTrailingSources(text) {
  const paras = text.split(/\n\s*\n/);
  while (paras.length) {
    const lines = paras[paras.length - 1].split('\n').filter((l) => strip(l));
    if (!lines.length) {
      paras.pop();
      continue;
    }
    if (SOURCES_PARA.test(lines[0]) || lines.every((l) => LINK_LINE.test(l))) paras.pop();
    else break;
  }
  return paras.join('\n\n');
}

// 末尾 TAIL_CHARS 文字程度に切る。切った位置がコードフェンスの中なら、フェンスを開き直さないよう閉じ記号を補う
function tail(text) {
  if (text.length <= TAIL_CHARS) return text;
  let cut = text.length - TAIL_CHARS;
  const nl = text.indexOf('\n', cut);
  if (nl >= 0 && nl - cut < 200) cut = nl + 1;
  const fences = (text.slice(0, cut).match(/```/g) ?? []).length;
  return (fences % 2 ? '```\n' : '') + text.slice(cut);
}

// sources: 末尾の出典・リンクだけの段落を除く / english: 英語の問いかけ・社交辞令も見る
// tail: 末尾 TAIL_CHARS 文字程度に切る / parens: 丸括弧の中の「?」を判定に使わない
const DEFAULTS = { sources: true, english: true, tail: true, parens: true };

// 末尾 n 段落の文のうち、問い・依頼に当たるもの [{kind, text, p, l, start, end}](p, l は段落と行の位置)
function qSentences(bs, n, opts) {
  const hits = [];
  const from = Math.max(0, bs.length - n);
  for (let p = from; p < bs.length; p++) {
    for (let l = 0; l < bs[p].length; l++) {
      for (const s of sents(bs[p][l])) {
        const [a, b] = stripRange(s.text, '*_ ');
        const s2 = s.text.slice(a, b);
        const english = opts.english && ASK_EN.test(s2);
        const kind = QEND.test(s2) ? 'QEND' : KA_END.test(s2) ? 'KA' : ASK.test(s2) || english ? 'ASK' : null;
        if (!kind) continue;
        const polite = POLITE.test(s2) || (opts.english && POLITE_EN.test(s2));
        if (polite && !POLITE_KEEP.test(s2)) continue;
        hits.push({ kind, english, text: s2, p, l, start: s.start + a, end: s.start + b });
      }
    }
  }
  return hits;
}

function prepare(text, opts) {
  let t = typeof text === 'string' ? text : '';
  if (opts.tail) t = tail(t);
  if (opts.sources) t = dropTrailingSources(t);
  return { source: t, bs: blocks(t, opts) };
}

// 判定に使った段落 bs と表示用の段落 dbs の対応。段落は末尾からの位置で合わせる
function displayLine(bs, dbs, p, l, opts) {
  const dp = dbs[dbs.length - (bs.length - p)];
  const line = dp?.[l];
  if (line == null) return null;
  const m = maskWithMap(line, opts);
  return m.text === bs[p][l] ? { line, src: m.src, para: dp } : { line: null, src: null, para: dp };
}

// 当たった文を元の文章(伏せ字なし)で返す。対応が取れなければ、その段落の末尾 200 文字
function displaySentence(bs, dbs, hit, opts) {
  const d = displayLine(bs, dbs, hit.p, hit.l, opts);
  if (d?.line != null && hit.end > hit.start) {
    return d.line.slice(d.src[hit.start][0], d.src[hit.end - 1][1]).slice(0, 200);
  }
  if (d?.para) return d.para.join('\n').slice(-200);
  return hit.text.slice(0, 200);
}

// 選択肢: 末尾 3 段落に箇条書きの行が 2 行以上あり、箇条書き以外の行に選択を求める語があるとき
function optionsOf(bs, dbs, opts) {
  const lines = [];
  for (let p = Math.max(0, bs.length - 3); p < bs.length; p++) {
    bs[p].forEach((line, l) => lines.push({ line, p, l }));
  }
  const items = lines.filter((x) => LIST.test(x.line));
  const lead = lines.some((x) => !LIST.test(x.line) && CHOOSE.test(x.line));
  if (items.length < 2 || !lead) return [];
  return items.slice(0, 6).map((x) => {
    const shown = displayLine(bs, dbs, x.p, x.l, opts)?.line ?? x.line;
    return strip(shown.replace(LIST, '')).slice(0, 60);
  });
}

// 疑問の文末、選択や許可を求める強い言い回し、英語の問いかけは level 'question'
function isStrong(h) {
  return h.kind === 'QEND' || h.kind === 'KA' || h.english || STRONG_ASK.test(h.text);
}

// 判定の本体。hasHit は末尾 2 段落に問い・依頼があるか、hasStrong はそのうち level 'question' に当たるものがあるか
export function evaluate(text, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { source, bs } = prepare(text, opts);
  const hits = qSentences(bs, 2, opts);
  return { opts, source, bs, hits, hasHit: hits.length > 0, hasStrong: hits.some(isStrong) };
}

// 当たらなければ null
export function detectTextQuestion(text, options = {}) {
  const { opts, source, bs, hits, hasStrong } = evaluate(text, options);
  if (!hits.length) return null;
  const dbs = splitBlocks(displayText(source));
  return {
    level: hasStrong ? 'question' : 'request',
    text: displaySentence(bs, dbs, hits[hits.length - 1], opts),
    options: optionsOf(bs, dbs, opts),
    matched: [...new Set(hits.map((h) => h.kind))],
  };
}

// ターン末の応答 resp = {ts, text} から、未回答の本文中の質問を作る。応答より後に人が発話していれば null
export function pendingTextQuestion(resp, lastHumanTs) {
  if (!resp?.text) return null;
  if (lastHumanTs != null && (resp.ts == null || lastHumanTs >= resp.ts)) return null;
  const d = detectTextQuestion(resp.text);
  return d ? { ts: resp.ts, kind: 'text', ...d } : null;
}
