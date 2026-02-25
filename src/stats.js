/**
 * 统计工具
 *
 * 目标：在不把全量数据塞进内存的前提下，输出一组常见描述性统计：
 * - count / mean / std / min / max：精确、可流式累积
 * - q25 / q50 / q75：默认用 P² 算法做近似分位数（常量内存）
 *
 * 备注：
 * - `--exact-quantiles` 会启用“精确分位数”，代价是需要缓存所有值（更慢、更吃内存）
 */

class StreamingStats {
  constructor() {
    this.count = 0;
    this.mean = 0;
    this.m2 = 0; // sum of squares of differences from the current mean
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
  }

  add(x) {
    if (!Number.isFinite(x)) return;
    this.count += 1;
    const delta = x - this.mean;
    this.mean += delta / this.count;
    const delta2 = x - this.mean;
    this.m2 += delta * delta2;
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
  }

  // 样本标准差（ddof=1）
  std(ddof = 1) {
    if (this.count <= ddof) return Number.NaN;
    return Math.sqrt(this.m2 / (this.count - ddof));
  }

  snapshot() {
    return {
      count: this.count,
      mean: this.count ? this.mean : Number.NaN,
      std: this.std(1),
      min: this.count ? this.min : Number.NaN,
      max: this.count ? this.max : Number.NaN,
    };
  }
}

/**
 * P² 分位数估计算法
 * - 常量内存、单遍流式
 * - 输出是近似分位数（并非精确）
 */
class P2Quantile {
  constructor(p) {
    if (!(p > 0 && p < 1)) throw new Error(`p must be (0,1), got ${p}`);
    this.p = p;
    this._init = []; // 前 5 个样本，用于初始化 marker
    this._q = null; // marker heights (5)
    this._n = null; // marker positions (5)
    this._np = null; // desired positions (5)
    this._dn = [0, p / 2, p, (1 + p) / 2, 1]; // desired position increments
  }

  add(x) {
    if (!Number.isFinite(x)) return;

    if (this._q === null) {
      this._init.push(x);
      if (this._init.length === 5) this._bootstrap();
      return;
    }

    let k;
    if (x < this._q[0]) {
      this._q[0] = x;
      k = 0;
    } else if (x < this._q[1]) {
      k = 0;
    } else if (x < this._q[2]) {
      k = 1;
    } else if (x < this._q[3]) {
      k = 2;
    } else if (x <= this._q[4]) {
      k = 3;
    } else {
      this._q[4] = x;
      k = 3;
    }

    // 更新 marker 的实际位置
    for (let i = k + 1; i < 5; i += 1) this._n[i] += 1;
    // 更新 marker 的期望位置
    for (let i = 0; i < 5; i += 1) this._np[i] += this._dn[i];

    // 调整中间三个 marker（i=1..3）
    for (let i = 1; i <= 3; i += 1) {
      const d = this._np[i] - this._n[i];
      if ((d >= 1 && this._n[i + 1] - this._n[i] > 1) || (d <= -1 && this._n[i - 1] - this._n[i] < -1)) {
        const di = Math.sign(d);
        const qHat = this._parabolic(i, di);
        if (this._q[i - 1] < qHat && qHat < this._q[i + 1]) {
          this._q[i] = qHat;
        } else {
          this._q[i] = this._linear(i, di);
        }
        this._n[i] += di;
      }
    }
  }

  value() {
    if (this._q === null) {
      if (this._init.length === 0) return Number.NaN;
      return exactQuantile(this._init, this.p);
    }
    return this._q[2]; // 第 3 个 marker 代表目标分位数 p
  }

  _bootstrap() {
    this._init.sort((a, b) => a - b);
    this._q = this._init.slice(0, 5);
    this._n = [1, 2, 3, 4, 5];
    // 目标 marker：min, p/2, p, (1+p)/2, max
    const p = this.p;
    this._np = [1, 1 + 2 * p, 1 + 4 * p, 3 + 2 * p, 5];
    this._init = []; // 释放
  }

  _parabolic(i, d) {
    const n = this._n;
    const q = this._q;
    const nPrev = n[i - 1];
    const nCurr = n[i];
    const nNext = n[i + 1];
    const qPrev = q[i - 1];
    const qCurr = q[i];
    const qNext = q[i + 1];

    const a = (nCurr - nPrev + d) * (qNext - qCurr) / (nNext - nCurr);
    const b = (nNext - nCurr - d) * (qCurr - qPrev) / (nCurr - nPrev);
    return qCurr + (d / (nNext - nPrev)) * (a + b);
  }

  _linear(i, d) {
    const n = this._n;
    const q = this._q;
    return q[i] + (d * (q[i + d] - q[i])) / (n[i + d] - n[i]);
  }
}

class ExactQuantilesBuffer {
  constructor() {
    this._values = [];
  }

  add(x) {
    if (!Number.isFinite(x)) return;
    this._values.push(x);
  }

  snapshot() {
    if (this._values.length === 0) {
      return { q25: Number.NaN, q50: Number.NaN, q75: Number.NaN };
    }
    const sorted = this._values.slice().sort((a, b) => a - b);
    return {
      q25: quantileSorted(sorted, 0.25),
      q50: quantileSorted(sorted, 0.5),
      q75: quantileSorted(sorted, 0.75),
    };
  }
}

function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function exactQuantile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return quantileSorted(sorted, p);
}

class DescribeAccumulator {
  constructor({ exactQuantiles = false } = {}) {
    this.stats = new StreamingStats();
    this.exactQuantiles = exactQuantiles;
    if (exactQuantiles) {
      this.quantiles = new ExactQuantilesBuffer();
    } else {
      this.q25 = new P2Quantile(0.25);
      this.q50 = new P2Quantile(0.5);
      this.q75 = new P2Quantile(0.75);
    }
  }

  add(x) {
    if (!Number.isFinite(x)) return;
    this.stats.add(x);
    if (this.exactQuantiles) {
      this.quantiles.add(x);
    } else {
      this.q25.add(x);
      this.q50.add(x);
      this.q75.add(x);
    }
  }

  snapshot() {
    const base = this.stats.snapshot();
    if (this.exactQuantiles) {
      return { ...base, ...this.quantiles.snapshot() };
    }
    return {
      ...base,
      q25: this.q25.value(),
      q50: this.q50.value(),
      q75: this.q75.value(),
    };
  }
}

module.exports = {
  DescribeAccumulator,
};
