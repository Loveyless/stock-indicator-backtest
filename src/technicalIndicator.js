/**
 * 技术指标（Node 版）
 *
 * 指标逻辑：
 * - LOW_N = 最低价_复权 rolling(40).min()
 * - HIGH_N = 最高价_复权 rolling(40).max()
 * - RSV = (收盘价_复权 - LOW_N) / (HIGH_N - LOW_N) * 100
 * - K：对 RSV 做指数加权移动平均（span=2，adjust=false，ignore_na=false）
 * - D：对 K 做指数加权移动平均（span=2，adjust=false，ignore_na=false）
 * - signal：金叉(1)/死叉(0)，只在交叉当日打点，其余为缺失值（NaN）
 */

function rollingMin(values, window) {
  const n = values.length;
  const out = new Array(n).fill(Number.NaN);
  const dq = []; // 单调递增：dq[0] 是窗口内最小值索引
  const invalid = []; // 窗口内出现 NaN/Inf 的索引

  for (let i = 0; i < n; i += 1) {
    const left = i - window + 1;

    while (dq.length && dq[0] < left) dq.shift();
    while (invalid.length && invalid[0] < left) invalid.shift();

    const v = values[i];
    if (!Number.isFinite(v)) {
      invalid.push(i);
    } else {
      while (dq.length && values[dq[dq.length - 1]] >= v) dq.pop();
      dq.push(i);
    }

    if (i < window - 1) continue;
    if (invalid.length) continue; // min_periods=window：窗口内不满 window 个有效值 -> NaN
    out[i] = values[dq[0]];
  }

  return out;
}

function rollingMax(values, window) {
  const n = values.length;
  const out = new Array(n).fill(Number.NaN);
  const dq = []; // 单调递减：dq[0] 是窗口内最大值索引
  const invalid = [];

  for (let i = 0; i < n; i += 1) {
    const left = i - window + 1;

    while (dq.length && dq[0] < left) dq.shift();
    while (invalid.length && invalid[0] < left) invalid.shift();

    const v = values[i];
    if (!Number.isFinite(v)) {
      invalid.push(i);
    } else {
      while (dq.length && values[dq[dq.length - 1]] <= v) dq.pop();
      dq.push(i);
    }

    if (i < window - 1) continue;
    if (invalid.length) continue;
    out[i] = values[dq[0]];
  }

  return out;
}

/**
 * 指数加权移动平均（EWMA）
 *
 * 参数约束：
 * - adjust=false：递推形式
 * - ignore_na=false：遇到 NaN 不更新均值，但“时间步”仍会让旧权重衰减（NaN 间隔会影响后续权重）
 */
function ewmMeanAdjustFalseIgnoreNaFalse(values, span) {
  const n = values.length;
  const out = new Array(n).fill(Number.NaN);
  const alpha = 2 / (span + 1);
  const oldWtFactor = 1 - alpha;

  let weightedAvg = Number.NaN;
  let oldWt = 1;

  for (let i = 0; i < n; i += 1) {
    const x = values[i];

    if (!Number.isFinite(weightedAvg)) {
      if (Number.isFinite(x)) {
        weightedAvg = x;
        out[i] = weightedAvg;
        oldWt = 1;
      }
      continue;
    }

    oldWt *= oldWtFactor;
    if (!Number.isFinite(x)) {
      out[i] = weightedAvg;
      continue;
    }

    weightedAvg = (oldWt * weightedAvg + alpha * x) / (oldWt + alpha);
    out[i] = weightedAvg;
    oldWt = 1;
  }

  return out;
}

function computeSignalKD({ lowAdj, highAdj, closeAdj }, { window = 40, span = 2, safeRsv = false } = {}) {
  if (lowAdj.length !== highAdj.length || lowAdj.length !== closeAdj.length) {
    throw new Error('lowAdj/highAdj/closeAdj 长度不一致');
  }

  const lowN = rollingMin(lowAdj, window);
  const highN = rollingMax(highAdj, window);

  const n = closeAdj.length;
  const rsv = new Array(n).fill(Number.NaN);
  for (let i = 0; i < n; i += 1) {
    const low = lowN[i];
    const high = highN[i];
    const close = closeAdj[i];
    if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(close)) continue;
    const denom = high - low;
    // denom==0：表示窗口内最高/最低相等（常见于停牌/一字板/数据缺失等情况）
    // - safeRsv=false：保留 JS 的除零结果（NaN/±Infinity），后续 EWMA 会把非有限值当作“缺失”处理
    // - safeRsv=true ：直接跳过，避免在 RSV 阶段产生非有限值（会改变信号与统计结果）
    if (safeRsv && !(denom > 0)) continue;
    rsv[i] = ((close - low) / denom) * 100;
  }

  const k = ewmMeanAdjustFalseIgnoreNaFalse(rsv, span);
  const d = ewmMeanAdjustFalseIgnoreNaFalse(k, span);

  const signal = new Array(n).fill(null); // null 代表缺失（等价 pandas NaN）
  for (let i = 1; i < n; i += 1) {
    const kPrev = k[i - 1];
    const dPrev = d[i - 1];
    const kNow = k[i];
    const dNow = d[i];
    if (!Number.isFinite(kPrev) || !Number.isFinite(dPrev) || !Number.isFinite(kNow) || !Number.isFinite(dNow)) continue;

    if (kPrev <= dPrev && kNow > dNow) signal[i] = 1;
    else if (kPrev >= dPrev && kNow < dNow) signal[i] = 0;
  }

  return { signal };
}

module.exports = {
  computeSignalKD,
};
