/**
 * Natural sort comparator: numeric substrings compare by value,
 * not lexicographically. Case-insensitive.
 */
export function naturalSortCompare(a: string, b: string): number {
  const ax = tokenize(a.toLowerCase());
  const bx = tokenize(b.toLowerCase());
  const len = Math.min(ax.length, bx.length);

  for (let i = 0; i < len; i++) {
    const ai = ax[i];
    const bi = bx[i];
    if (typeof ai === 'number' && typeof bi === 'number') {
      if (ai !== bi) return ai - bi;
    } else {
      const sa = String(ai);
      const sb = String(bi);
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

function tokenize(s: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  const re = /(\d+)|(\D+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(parseInt(match[1], 10));
    } else {
      tokens.push(match[2]);
    }
  }
  return tokens;
}
