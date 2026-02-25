const { computeMaxDrawdown } = require('./backtest');

function shouldReplaceLastPoint(curve, date) {
  return curve.length && curve[curve.length - 1].date === date;
}

function pushEquityPoint(curve, date, equity) {
  const p = { date, equity };
  if (shouldReplaceLastPoint(curve, date)) curve[curve.length - 1] = p;
  else curve.push(p);
}

class MinHeap {
  constructor() {
    this._a = [];
  }

  size() {
    return this._a.length;
  }

  peek() {
    return this._a.length ? this._a[0] : null;
  }

  push(x) {
    const a = this._a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (a[p].date <= a[i].date) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this._a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (!a.length) return top;
    a[0] = last;
    let i = 0;
    while (true) {
      const l = i * 2 + 1;
      const r = i * 2 + 2;
      let m = i;
      if (l < a.length && a[l].date < a[m].date) m = l;
      if (r < a.length && a[r].date < a[m].date) m = r;
      if (m === i) break;
      [a[m], a[i]] = [a[i], a[m]];
      i = m;
    }
    return top;
  }
}

function buildExecutionEvents({
  file,
  datesYmd,
  closeAdj,
  entrySignal,
  exitSignal,
}, {
  startYmd,
  endYmd,
  execution = 'next_close', // close | next_close
} = {}) {
  const events = [];
  const n = closeAdj.length;

  const inRange = (idx) => {
    const ymd = datesYmd[idx];
    return Number.isFinite(ymd) && ymd >= startYmd && ymd <= endYmd;
  };

  const execIndex = (i) => (execution === 'close' ? i : i + 1);

  for (let i = 0; i < n; i += 1) {
    if (!inRange(i)) continue;

    if (exitSignal[i]) {
      const j = execIndex(i);
      if (j < 0 || j >= n) continue;
      if (!inRange(j)) continue;
      const px = closeAdj[j];
      if (!Number.isFinite(px) || !(px > 0)) continue;
      events.push({ date: datesYmd[j], type: 'sell', file, execIdx: j, price: px, reason: 'signal_exit' });
    }

    if (entrySignal[i]) {
      const j = execIndex(i);
      if (j < 0 || j >= n) continue;
      if (!inRange(j)) continue;
      const px = closeAdj[j];
      if (!Number.isFinite(px) || !(px > 0)) continue;
      events.push({ date: datesYmd[j], type: 'buy', file, execIdx: j, price: px, reason: 'signal_entry' });
    }
  }

  // 强平：每个标的在区间内最后一个可交易日强制卖出（若仍持仓）
  let lastIdx = -1;
  for (let i = 0; i < n; i += 1) {
    const ymd = datesYmd[i];
    if (!Number.isFinite(ymd) || ymd < startYmd || ymd > endYmd) continue;
    const px = closeAdj[i];
    if (!Number.isFinite(px) || !(px > 0)) continue;
    lastIdx = i;
  }
  if (lastIdx >= 0) {
    events.push({
      date: datesYmd[lastIdx],
      type: 'sell',
      file,
      execIdx: lastIdx,
      price: closeAdj[lastIdx],
      reason: 'force_exit_eof',
    });
  }

  return events;
}

function simulatePortfolioEqualWeight({
  seriesByFile,
  events,
}, {
  startYmd,
  endYmd,
  initialCapital = 1000000,
  lot = 100,
  feeBps = 0,
  stampBps = 0,
} = {}) {
  if (!Number.isFinite(startYmd) || !Number.isFinite(endYmd)) throw new Error('startYmd/endYmd 必须是数字 YYYYMMDD');
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new Error(`initialCapital 必须是正数：${initialCapital}`);
  if (!Number.isFinite(lot) || lot <= 0) throw new Error(`lot 必须是正数：${lot}`);
  if (!Number.isFinite(feeBps) || feeBps < 0) throw new Error(`feeBps 必须是非负数：${feeBps}`);
  if (!Number.isFinite(stampBps) || stampBps < 0) throw new Error(`stampBps 必须是非负数：${stampBps}`);

  const feeRate = feeBps / 10000;
  const stampRate = stampBps / 10000;

  const sortedEvents = events
    .filter((e) => Number.isFinite(e.date) && e.date >= startYmd && e.date <= endYmd)
    .slice()
    .sort((a, b) => {
      if (a.date !== b.date) return a.date - b.date;
      // 同日：先卖后买
      if (a.type !== b.type) return a.type === 'sell' ? -1 : 1;
      return a.file.localeCompare(b.file, 'en');
    });

  let cash = initialCapital;
  const positions = new Map(); // file -> { shares, lastPrice, idx, nextIdx, entry: {...} }
  const trades = [];
  const equityCurve = [];
  let totalMarketValue = 0;

  const heap = new MinHeap(); // { date, file }

  const pushNextIfAny = (file) => {
    const pos = positions.get(file);
    if (!pos) return;
    const s = seriesByFile.get(file);
    if (!s) return;
    const { datesYmd } = s;
    const ni = pos.nextIdx;
    if (ni >= 0 && ni < datesYmd.length) {
      const nd = datesYmd[ni];
      if (Number.isFinite(nd) && nd <= endYmd) heap.push({ date: nd, file });
    }
  };

  const applyPriceUpdate = (file, newIdx) => {
    const pos = positions.get(file);
    const s = seriesByFile.get(file);
    if (!pos || !s) return;
    const { closeAdj } = s;
    const newPrice = closeAdj[newIdx];
    if (!Number.isFinite(newPrice) || !(newPrice > 0)) {
      pos.idx = newIdx;
      pos.nextIdx = newIdx + 1;
      pushNextIfAny(file);
      return;
    }

    const old = pos.lastPrice;
    pos.lastPrice = newPrice;
    pos.idx = newIdx;
    pos.nextIdx = newIdx + 1;
    totalMarketValue += pos.shares * (newPrice - old);
    pushNextIfAny(file);
  };

  const flushUpdatesBefore = (dateExclusive) => {
    while (heap.size()) {
      const top = heap.peek();
      if (top.date >= dateExclusive) break;
      const d = top.date;
      // 同一日可能多个股票更新：合并为一个净值点
      while (heap.size() && heap.peek().date === d) {
        const { file } = heap.pop();
        const pos = positions.get(file);
        const s = seriesByFile.get(file);
        if (!pos || !s) continue;
        const idx = pos.nextIdx;
        if (idx >= 0 && idx < s.datesYmd.length && s.datesYmd[idx] === d) {
          applyPriceUpdate(file, idx);
        }
      }
      pushEquityPoint(equityCurve, d, cash + totalMarketValue);
    }
  };

  const applyUpdatesAt = (dateInclusive) => {
    while (heap.size() && heap.peek().date === dateInclusive) {
      const d = dateInclusive;
      while (heap.size() && heap.peek().date === d) {
        const { file } = heap.pop();
        const pos = positions.get(file);
        const s = seriesByFile.get(file);
        if (!pos || !s) continue;
        const idx = pos.nextIdx;
        if (idx >= 0 && idx < s.datesYmd.length && s.datesYmd[idx] === d) {
          applyPriceUpdate(file, idx);
        }
      }
    }
  };

  const canBuyAtBudget = (ev, budget) => Math.floor(budget / (ev.price * lot)) * lot > 0;

  const buyWithEqualBudget = (buyEvents) => {
    const candidates0 = buyEvents.filter((ev) => !positions.has(ev.file));
    if (!candidates0.length) return;

    let candidates = candidates0.slice();
    while (candidates.length) {
      const budget = cash / candidates.length;
      const buyable = candidates.filter((ev) => canBuyAtBudget(ev, budget));
      if (buyable.length === candidates.length) {
        for (let k = 0; k < candidates.length; k += 1) {
          const ev = candidates[k];
          const px = ev.price;
          const budgetNow = cash / (candidates.length - k);
          let qty = Math.floor(budgetNow / (px * lot)) * lot;
          const maxQty = Math.floor(cash / (px * lot)) * lot;
          if (qty > maxQty) qty = maxQty;
          if (qty <= 0) continue;

          const gross = qty * px;
          const fee = gross * feeRate;
          const cost = gross + fee;
          if (cost > cash + 1e-9) continue;

          cash -= cost;
          positions.set(ev.file, {
            shares: qty,
            lastPrice: px,
            idx: ev.execIdx,
            nextIdx: ev.execIdx + 1,
            entry: {
              date: ev.date,
              price: px,
              costBasis: cost,
            },
          });
          totalMarketValue += qty * px;
          pushNextIfAny(ev.file);
        }
        return;
      }
      if (!buyable.length) return;
      candidates = buyable;
    }
  };

  const sellOne = (ev) => {
    const pos = positions.get(ev.file);
    if (!pos) return;
    const px = ev.price;
    if (!Number.isFinite(px) || !(px > 0)) return;

    // 若价格未被更新到该日（理论上不应发生），先用成交价校正一次。
    if (pos.lastPrice !== px) {
      totalMarketValue += pos.shares * (px - pos.lastPrice);
      pos.lastPrice = px;
    }

    const gross = pos.shares * px;
    const fee = gross * feeRate;
    const stamp = gross * stampRate;
    const net = gross - fee - stamp;
    cash += net;
    totalMarketValue -= pos.shares * px;

    const pnl = net - pos.entry.costBasis;
    const ret = pos.entry.costBasis > 0 ? pnl / pos.entry.costBasis : Number.NaN;
    trades.push({
      file: ev.file,
      entryDate: pos.entry.date,
      exitDate: ev.date,
      entryPrice: pos.entry.price,
      exitPrice: px,
      shares: pos.shares,
      pnl,
      ret,
      reason: ev.reason,
    });

    positions.delete(ev.file);
  };

  let i = 0;
  while (i < sortedEvents.length) {
    const date = sortedEvents[i].date;

    flushUpdatesBefore(date);
    applyUpdatesAt(date);

    const todays = [];
    while (i < sortedEvents.length && sortedEvents[i].date === date) {
      todays.push(sortedEvents[i]);
      i += 1;
    }

    // 先卖
    for (const ev of todays) if (ev.type === 'sell') sellOne(ev);

    // 再买：同日多票平均分配现金（仅对同日新增入场票）
    const buys = todays.filter((ev) => ev.type === 'buy');
    buyWithEqualBudget(buys);

    pushEquityPoint(equityCurve, date, cash + totalMarketValue);
  }

  flushUpdatesBefore(endYmd + 1);
  // 末尾再记一次 endYmd 的权益（可能最后一个点 < endYmd）
  if (equityCurve.length) pushEquityPoint(equityCurve, endYmd, cash + totalMarketValue);

  const finalEquity = cash + totalMarketValue;
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
    maxDrawdown,
    trades,
    winRate,
    avgTradeRet,
    equityCurve,
  };
}

module.exports = {
  buildExecutionEvents,
  simulatePortfolioEqualWeight,
};

