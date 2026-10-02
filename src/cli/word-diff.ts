export type DiffOp =
  | { op: "equal"; a: number; b: number }
  | { op: "delete"; a: number }
  | { op: "insert"; b: number };

// Word-level Myers diff in linear space (the middle-snake bisection used by
// diff-match-patch), so long transcripts with large deletions stay cheap.
export function diffWords(a: readonly string[], b: readonly string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  diffRange(a, b, 0, a.length, 0, b.length, ops);
  return ops;
}

function diffRange(a: readonly string[], b: readonly string[], aLo: number, aHi: number, bLo: number, bHi: number, ops: DiffOp[]): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) ops.push({ op: "equal", a: aLo++, b: bLo++ });
  let suffix = 0;
  while (aHi - suffix > aLo && bHi - suffix > bLo && a[aHi - suffix - 1] === b[bHi - suffix - 1]) suffix++;
  const aEnd = aHi - suffix, bEnd = bHi - suffix;

  if (aLo === aEnd) for (let j = bLo; j < bEnd; j++) ops.push({ op: "insert", b: j });
  else if (bLo === bEnd) for (let i = aLo; i < aEnd; i++) ops.push({ op: "delete", a: i });
  else {
    const split = bisect(a, b, aLo, aEnd, bLo, bEnd);
    if (split) {
      diffRange(a, b, aLo, split[0], bLo, split[1], ops);
      diffRange(a, b, split[0], aEnd, split[1], bEnd, ops);
    } else {
      for (let i = aLo; i < aEnd; i++) ops.push({ op: "delete", a: i });
      for (let j = bLo; j < bEnd; j++) ops.push({ op: "insert", b: j });
    }
  }
  for (let k = suffix; k > 0; k--) ops.push({ op: "equal", a: aHi - k, b: bHi - k });
}

// Finds the middle snake of the edit graph and returns where to split both ranges,
// or null when the ranges share nothing.
function bisect(a: readonly string[], b: readonly string[], aLo: number, aHi: number, bLo: number, bHi: number): [number, number] | null {
  const n = aHi - aLo, m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD, length = 2 * maxD + 2;
  const v1 = new Int32Array(length).fill(-1), v2 = new Int32Array(length).fill(-1);
  v1[offset + 1] = 0;
  v2[offset + 1] = 0;
  const delta = n - m, front = delta % 2 !== 0;
  let k1start = 0, k1end = 0, k2start = 0, k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Offset = offset + k1;
      let x1 = k1 === -d || (k1 !== d && v1[k1Offset - 1] < v1[k1Offset + 1]) ? v1[k1Offset + 1] : v1[k1Offset - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) { x1++; y1++; }
      v1[k1Offset] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2Offset = offset + delta - k1;
        if (k2Offset >= 0 && k2Offset < length && v2[k2Offset] !== -1 && x1 >= n - v2[k2Offset]) return [aLo + x1, bLo + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Offset = offset + k2;
      let x2 = k2 === -d || (k2 !== d && v2[k2Offset - 1] < v2[k2Offset + 1]) ? v2[k2Offset + 1] : v2[k2Offset - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - x2 - 1] === b[bHi - y2 - 1]) { x2++; y2++; }
      v2[k2Offset] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1Offset = offset + delta - k2;
        if (k1Offset >= 0 && k1Offset < length && v1[k1Offset] !== -1) {
          const x1 = v1[k1Offset], y1 = offset + x1 - k1Offset;
          if (x1 >= n - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }
  return null;
}
