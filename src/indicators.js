function isFiniteNumber(x) {
  return Number.isFinite(x);
}

function abs(x) {
  if (Array.isArray(x)) return x.map((v) => (isFiniteNumber(v) ? Math.abs(v) : Number.NaN));
  return isFiniteNumber(x) ? Math.abs(x) : Number.NaN;
}

function ref(x, n) {
  const shift = Math.max(0, Math.floor(Number(n)));
  const out = new Array(x.length).fill(Number.NaN);
  for (let i = 0; i < x.length; i += 1) {
    const j = i - shift;
    if (j >= 0) out[i] = x[j];
  }
  return out;
}

function ifElse(cond, a, b) {
  const out = new Array(cond.length).fill(Number.NaN);
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  for (let i = 0; i < cond.length; i += 1) {
    const av = aIsArr ? a[i] : a;
    const bv = bIsArr ? b[i] : b;
    out[i] = cond[i] ? av : bv;
  }
  return out;
}

function sum(x, n) {
  const win = Math.max(1, Math.floor(Number(n)));
  const out = new Array(x.length).fill(Number.NaN);
  let s = 0;
  let count = 0;
  for (let i = 0; i < x.length; i += 1) {
    const v = x[i];
    if (isFiniteNumber(v)) {
      s += v;
      count += 1;
    }

    const j = i - win;
    if (j >= 0) {
      const old = x[j];
      if (isFiniteNumber(old)) {
        s -= old;
        count -= 1;
      }
    }

    if (i >= win - 1 && count === win) out[i] = s;
  }
  return out;
}

function cumsum(x) {
  const out = new Array(x.length).fill(Number.NaN);
  let s = 0;
  for (let i = 0; i < x.length; i += 1) {
    const v = x[i];
    if (isFiniteNumber(v)) s += v;
    out[i] = isFiniteNumber(v) ? s : Number.NaN;
  }
  return out;
}

function ma(x, n) {
  const win = Math.max(1, Math.floor(Number(n)));
  const sx = sum(x, win);
  return sx.map((v) => (isFiniteNumber(v) ? v / win : Number.NaN));
}

function rollingExtrema(x, n, cmp) {
  const win = Math.max(1, Math.floor(Number(n)));
  const out = new Array(x.length).fill(Number.NaN);
  let missing = 0;

  for (let i = 0; i < x.length; i += 1) {
    if (!isFiniteNumber(x[i])) missing += 1;
    const j = i - win;
    if (j >= 0 && !isFiniteNumber(x[j])) missing -= 1;

    if (i >= win - 1 && missing === 0) {
      let best = x[i - win + 1];
      for (let k = i - win + 2; k <= i; k += 1) {
        best = cmp(best, x[k]);
      }
      out[i] = best;
    }
  }
  return out;
}

function max(x, n) {
  if (n === undefined) {
    // max(A,B,...)：逐行取最大值（这里按数组输入实现）
    if (!Array.isArray(x) || !x.length) throw new Error('max(A,B,...) 需要传数组数组：max([a,b,...])');
    const m = x[0].length;
    const out = new Array(m).fill(Number.NaN);
    for (let i = 0; i < m; i += 1) {
      let best = Number.NEGATIVE_INFINITY;
      let ok = false;
      for (const arr of x) {
        const v = arr[i];
        if (!isFiniteNumber(v)) continue;
        if (v > best) best = v;
        ok = true;
      }
      out[i] = ok ? best : Number.NaN;
    }
    return out;
  }
  return rollingExtrema(x, n, (a, b) => (a > b ? a : b));
}

function min(x, n) {
  if (n === undefined) {
    if (!Array.isArray(x) || !x.length) throw new Error('min(A,B,...) 需要传数组数组：min([a,b,...])');
    const m = x[0].length;
    const out = new Array(m).fill(Number.NaN);
    for (let i = 0; i < m; i += 1) {
      let best = Number.POSITIVE_INFINITY;
      let ok = false;
      for (const arr of x) {
        const v = arr[i];
        if (!isFiniteNumber(v)) continue;
        if (v < best) best = v;
        ok = true;
      }
      out[i] = ok ? best : Number.NaN;
    }
    return out;
  }
  return rollingExtrema(x, n, (a, b) => (a < b ? a : b));
}

function ema(x, n) {
  const period = Math.max(1, Math.floor(Number(n)));
  const alpha = 2 / (period + 1);
  const out = new Array(x.length).fill(Number.NaN);
  let started = false;
  let prev = Number.NaN;
  for (let i = 0; i < x.length; i += 1) {
    const v = x[i];
    if (!started) {
      if (isFiniteNumber(v)) {
        prev = v;
        out[i] = v;
        started = true;
      } else {
        out[i] = Number.NaN;
      }
      continue;
    }

    if (!isFiniteNumber(v)) {
      out[i] = prev;
      continue;
    }

    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

function sma(x, n, m) {
  const N = Math.max(1, Math.floor(Number(n)));
  const M = Math.max(1, Math.floor(Number(m)));
  if (M > N) throw new Error(`SMA(X,N,M) 要求 M<=N：N=${N}, M=${M}`);
  const out = new Array(x.length).fill(Number.NaN);
  let started = false;
  let prev = Number.NaN;
  for (let i = 0; i < x.length; i += 1) {
    const v = x[i];
    if (!started) {
      if (isFiniteNumber(v)) {
        prev = v;
        out[i] = v;
        started = true;
      } else {
        out[i] = Number.NaN;
      }
      continue;
    }

    if (!isFiniteNumber(v)) {
      out[i] = prev;
      continue;
    }

    prev = (M * v + (N - M) * prev) / N;
    out[i] = prev;
  }
  return out;
}

function wma(x, n) {
  const win = Math.max(1, Math.floor(Number(n)));
  const out = new Array(x.length).fill(Number.NaN);
  const denom = (win * (win + 1)) / 2;
  let missing = 0;
  for (let i = 0; i < x.length; i += 1) {
    if (!isFiniteNumber(x[i])) missing += 1;
    const j = i - win;
    if (j >= 0 && !isFiniteNumber(x[j])) missing -= 1;

    if (i >= win - 1 && missing === 0) {
      let num = 0;
      for (let k = 0; k < win; k += 1) {
        const v = x[i - k];
        num += v * (win - k);
      }
      out[i] = num / denom;
    }
  }
  return out;
}

function dma(x, a) {
  const out = new Array(x.length).fill(Number.NaN);
  const aIsArr = Array.isArray(a);
  let started = false;
  let prev = Number.NaN;
  for (let i = 0; i < x.length; i += 1) {
    const v = x[i];
    const ai = aIsArr ? a[i] : a;
    const alpha = isFiniteNumber(ai) ? Math.max(0, Math.min(1, ai)) : Number.NaN;

    if (!started) {
      if (isFiniteNumber(v)) {
        prev = v;
        out[i] = v;
        started = true;
      } else {
        out[i] = Number.NaN;
      }
      continue;
    }

    if (!isFiniteNumber(v)) {
      out[i] = prev;
      continue;
    }
    if (!isFiniteNumber(alpha)) {
      out[i] = prev;
      continue;
    }

    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

module.exports = {
  ABS: abs,
  REF: ref,
  IF: ifElse,
  SUM: sum,
  CUMSUM: cumsum,
  MAX: max,
  MIN: min,
  MA: ma,
  EMA: ema,
  SMA: sma,
  WMA: wma,
  DMA: dma,
};

