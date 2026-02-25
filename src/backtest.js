function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function computeMaxDrawdown(equityCurve) {
  let peak = Number.NEGATIVE_INFINITY;
  let maxDd = 0;
  let maxDdFrom = null;
  let maxDdTo = null;

  for (const p of equityCurve) {
    if (!Number.isFinite(p.equity)) continue;
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = (peak - p.equity) / peak;
      if (dd > maxDd) {
        maxDd = dd;
        maxDdFrom = p.date;
        maxDdTo = p.date;
      }
    }
  }

  return { maxDrawdown: maxDd, maxDrawdownFrom: maxDdFrom, maxDrawdownTo: maxDdTo };
}

function simulateLongOnly({
  datesYmd,
  closeAdj,
  entrySignal,
  exitSignal,
}, {
  startYmd,
  endYmd,
  initialCapital = 10000,
  execution = 'next_close', // close | next_close
  lot = 100,
  feeBps = 0,
  stampBps = 0,
  forceExitEof = true,
} = {}) {
  if (!Number.isFinite(startYmd) || !Number.isFinite(endYmd)) throw new Error('startYmd/endYmd 必须是数字 YYYYMMDD');
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new Error(`initialCapital 必须是正数：${initialCapital}`);
  if (execution !== 'close' && execution !== 'next_close') throw new Error(`execution 仅支持 close/next_close：${execution}`);
  if (!Number.isFinite(lot) || lot <= 0) throw new Error(`lot 必须是正数：${lot}`);
  if (!Number.isFinite(feeBps) || feeBps < 0) throw new Error(`feeBps 必须是非负数：${feeBps}`);
  if (!Number.isFinite(stampBps) || stampBps < 0) throw new Error(`stampBps 必须是非负数：${stampBps}`);

  const n = closeAdj.length;
  if (datesYmd.length !== n || entrySignal.length !== n || exitSignal.length !== n) {
    throw new Error('datesYmd/closeAdj/entrySignal/exitSignal 长度不一致');
  }

  let cash = initialCapital;
  let shares = 0;
  let entry = null;

  const trades = [];
  const equityCurve = [];

  let lastValidClose = Number.NaN;

  const inRange = (i) => {
    const ymd = datesYmd[i];
    return Number.isFinite(ymd) && ymd >= startYmd && ymd <= endYmd;
  };

  const feeRate = feeBps / 10000;
  const stampRate = stampBps / 10000;

  const execIndex = (i) => (execution === 'close' ? i : i + 1);

  const canExec = (i, j) => j >= 0 && j < n && inRange(i) && inRange(j);

  for (let i = 0; i < n; i += 1) {
    const ymd = datesYmd[i];
    const close = closeAdj[i];
    if (Number.isFinite(close) && close > 0) lastValidClose = close;

    // 只记录区间内的净值曲线（避免 start 之前的 warmup 影响阅读）
    if (inRange(i)) {
      const mark = shares > 0 ? (Number.isFinite(close) && close > 0 ? close : lastValidClose) : 0;
      const equity = cash + (shares > 0 && Number.isFinite(mark) ? shares * mark : 0);
      equityCurve.push({ date: ymd, equity });
    }

    if (!inRange(i)) continue;

    // 先处理卖出（避免同一天既出场又入场时的歧义）
    if (shares > 0 && exitSignal[i]) {
      const j = execIndex(i);
      if (canExec(i, j)) {
        const px = closeAdj[j];
        if (Number.isFinite(px) && px > 0) {
          const gross = shares * px;
          const fee = gross * feeRate + gross * stampRate;
          cash += gross - fee;

          const pnl = cash - entry.equityAfterBuy;
          const ret = entry.equityAfterBuy > 0 ? pnl / entry.equityAfterBuy : Number.NaN;
          trades.push({
            entryDate: entry.execDate,
            exitDate: datesYmd[j],
            entryPrice: entry.execPrice,
            exitPrice: px,
            shares,
            pnl,
            ret,
            reason: 'signal_exit',
          });

          shares = 0;
          entry = null;
        }
      }
    }

    if (shares === 0 && entrySignal[i]) {
      const j = execIndex(i);
      if (canExec(i, j)) {
        const px = closeAdj[j];
        if (Number.isFinite(px) && px > 0) {
          const lots = Math.floor(cash / (px * lot));
          const qty = lots * lot;
          if (qty > 0) {
            const gross = qty * px;
            const fee = gross * feeRate;
            const totalCost = gross + fee;
            if (totalCost <= cash + 1e-9) {
              cash -= totalCost;
              shares = qty;
              entry = {
                execDate: datesYmd[j],
                execPrice: px,
                cashAfterBuy: cash,
                equityAfterBuy: cash + shares * px,
              };
            }
          }
        }
      }
    }
  }

  // 强制在区间末尾平仓（否则 max drawdown/收益都没有可解释性）
  if (forceExitEof && shares > 0 && equityCurve.length) {
    const last = equityCurve[equityCurve.length - 1];
    const lastIdx = datesYmd.lastIndexOf(last.date);
    const px = closeAdj[lastIdx];
    const execPx = Number.isFinite(px) && px > 0 ? px : lastValidClose;
    if (Number.isFinite(execPx) && execPx > 0) {
      const gross = shares * execPx;
      const fee = gross * feeRate + gross * stampRate;
      cash += gross - fee;

      const pnl = cash - entry.equityAfterBuy;
      const ret = entry.equityAfterBuy > 0 ? pnl / entry.equityAfterBuy : Number.NaN;
      trades.push({
        entryDate: entry.execDate,
        exitDate: last.date,
        entryPrice: entry.execPrice,
        exitPrice: execPx,
        shares,
        pnl,
        ret,
        reason: 'force_exit_eof',
      });
      shares = 0;
      entry = null;
    }
  }

  const finalEquity = shares === 0 ? cash : (cash + shares * lastValidClose);
  const totalReturn = finalEquity / initialCapital - 1;

  const winTrades = trades.filter((t) => Number.isFinite(t.pnl) && t.pnl > 0).length;
  const winRate = trades.length ? winTrades / trades.length : Number.NaN;
  const avgTradeRet = trades.length
    ? trades.reduce((s, t) => s + (Number.isFinite(t.ret) ? t.ret : 0), 0) / trades.length
    : Number.NaN;

  const { maxDrawdown } = computeMaxDrawdown(equityCurve);

  return {
    finalEquity,
    totalReturn,
    maxDrawdown: clamp01(maxDrawdown),
    trades,
    winRate,
    avgTradeRet,
    equityCurve,
  };
}

module.exports = {
  simulateLongOnly,
  computeMaxDrawdown,
};
