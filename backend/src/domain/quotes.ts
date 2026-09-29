/**
 * 引用核验（backend_plan.md 7.5）：引用必须在来源文本中命中，伪造引用直接拒绝。
 * 命中判定在归一化后进行（合并空白/全角空格），位置返回原文下标。
 */
export interface QuoteHit {
  found: boolean;
  start: number;
  end: number;
}

function normalize(s: string): string {
  return s
    .replace(/\u00a0/g, " ")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 归一化文本中每个字符到原文本下标的映射（近似：归一化只做空白合并）。 */
function buildIndexMap(source: string): number[] {
  const map: number[] = [];
  let i = 0;
  let lastWasSpace = true;
  while (i < source.length) {
    const ch = source[i];
    if (ch === undefined) break;
    const isSpace = /\s|\u00a0|\u3000/.test(ch);
    if (isSpace) {
      if (!lastWasSpace) {
        map.push(i);
        lastWasSpace = true;
      }
    } else {
      map.push(i);
      lastWasSpace = false;
    }
    i++;
  }
  return map;
}

export function verifyQuote(source: string, quote: string): QuoteHit {
  const normSource = normalize(source);
  const normQuote = normalize(quote);
  if (!normQuote) return { found: false, start: -1, end: -1 };
  const idx = normSource.indexOf(normQuote);
  if (idx < 0) return { found: false, start: -1, end: -1 };

  const map = buildIndexMap(source);
  const start = map[idx] ?? -1;
  const endChar = map[idx + normQuote.length - 1];
  if (start < 0 || endChar === undefined) return { found: false, start: -1, end: -1 };
  return { found: true, start, end: endChar + 1 };
}

/** 校验一组 {quote} 引用，返回全部命中的；任一未命中时丢弃该条目（调用方决定是否拒绝整个结果）。 */
export function allQuotesFound(source: string, quotes: string[]): boolean {
  return quotes.every((q) => verifyQuote(source, q).found);
}
