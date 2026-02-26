function isFiniteNumber(x) {
  return Number.isFinite(x);
}

function isStName(name) {
  if (!name) return false;
  return /st/i.test(String(name));
}

function getCached(cache, key, compute) {
  if (cache.has(key)) return cache.get(key);
  const v = compute();
  cache.set(key, v);
  return v;
}

/**
 * 示例策略（strategy.js）
 *
 * 口径（由引擎保证）：
 * - 周期首个交易日买入（收盘价_复权），周期最后一个交易日卖出（收盘价_复权）
 * - 策略只能使用 asOfYmd（买入日前一交易日）及更早数据生成信号，避免未来函数
 * - 返回 picks：要买入的股票 file 列表（如 sh600000.csv）
 *
 * 你可以直接改这个文件，或者复制成新文件再用 `--strategy-file=...` 指定。
 */
function strategy(ctx) {
  const universe = Array.isArray(ctx.universe) ? ctx.universe : [];
  const params = ctx.params || {};
  const cache = ctx.cache || new Map();
  const ind = ctx.ind || {};
  const util = ctx.util || {};

  const asOfYmd = ctx.asOfYmd;
  // 没有信号截止日（例如区间第一天），直接不交易，避免未来函数。
  if (!asOfYmd) return { picks: [] };

  const maPeriods = Array.isArray(params.maPeriods) ? params.maPeriods : [5, 10, 20];
  const pFast = Number(maPeriods[0] || 5);
  const pMid = Number(maPeriods[1] || 10);
  const pSlow = Number(maPeriods[2] || 20);

  const excludeSt = params.excludeSt !== false;
  const pickLimit = Number.isFinite(params.pickLimit) ? params.pickLimit : null;

  const picks = [];

  for (const s of universe) {
    if (!s || !Array.isArray(s.datesYmd) || !Array.isArray(s.closeAdj)) continue;
    if (excludeSt && isStName(s.stockName)) continue;

    // 信号日 index（必须用 asOfYmd，而不是 buyYmd）
    const idx = typeof util.indexOfDate === 'function' ? util.indexOfDate(s.datesYmd, asOfYmd) : -1;
    if (idx < 0) continue;

    // 指标建议缓存：避免每个周期重复计算整列 MA/EMA，性能会差很多。
    const maFast = getCached(cache, `MA:${s.file}:${pFast}`, () => (typeof ind.MA === 'function' ? ind.MA(s.closeAdj, pFast) : []));
    const maMid = getCached(cache, `MA:${s.file}:${pMid}`, () => (typeof ind.MA === 'function' ? ind.MA(s.closeAdj, pMid) : []));
    const maSlow = getCached(cache, `MA:${s.file}:${pSlow}`, () => (typeof ind.MA === 'function' ? ind.MA(s.closeAdj, pSlow) : []));

    const f = maFast[idx];
    const m = maMid[idx];
    const l = maSlow[idx];
    if (!isFiniteNumber(f) || !isFiniteNumber(m) || !isFiniteNumber(l)) continue;

    // 多头排列：MA(快) > MA(中) > MA(慢)
    if (!(f > m && m > l)) continue;

    const score = l !== 0 ? (f / l - 1) : (f - l);
    picks.push({ file: s.file, score });
  }

  // 打分排序后返回（引擎还会按 --pick-limit 再截断一次）
  picks.sort((a, b) => b.score - a.score);
  const out = picks.map((p) => p.file);
  if (pickLimit && out.length > pickLimit) return { picks: out.slice(0, pickLimit) };
  return { picks: out };
}

module.exports = { strategy };
