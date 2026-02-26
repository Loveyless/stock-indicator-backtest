function ymdToUtcDate(ymd) {
  const s = String(ymd);
  if (!/^\d{8}$/.test(s)) throw new Error(`ymd 必须是 YYYYMMDD：${ymd}`);
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d));
}

function utcDateToYmd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return Number(`${y}${m}${d}`);
}

function weekKeyMondayYmd(ymd) {
  const dt = ymdToUtcDate(ymd);
  // getUTCDay: 0=Sun..6=Sat；周一为 1
  const dow = dt.getUTCDay();
  const offsetDays = dow === 0 ? 6 : dow - 1; // 退到周一
  dt.setUTCDate(dt.getUTCDate() - offsetDays);
  return utcDateToYmd(dt);
}

function monthKeyYm(ymd) {
  const s = String(ymd);
  if (!/^\d{8}$/.test(s)) throw new Error(`ymd 必须是 YYYYMMDD：${ymd}`);
  return s.slice(0, 6); // YYYYMM
}

function quarterKeyYq(ymd) {
  const s = String(ymd);
  if (!/^\d{8}$/.test(s)) throw new Error(`ymd 必须是 YYYYMMDD：${ymd}`);
  const year = s.slice(0, 4);
  const m = Number(s.slice(4, 6));
  const q = Math.floor((m - 1) / 3) + 1;
  return `${year}Q${q}`;
}

function buildPeriodPlans(tradingDatesAsc, freq) {
  const dates = Array.isArray(tradingDatesAsc) ? tradingDatesAsc : [];
  if (!dates.length) return [];
  const f = String(freq || '').toUpperCase();
  if (!['D', 'W', 'M', 'Q'].includes(f)) throw new Error(`freq 仅支持 D/W/M/Q：${freq}`);

  if (f === 'D') {
    const out = [];
    for (let i = 0; i < dates.length - 1; i += 1) {
      const buyYmd = dates[i];
      const sellYmd = dates[i + 1];
      out.push({ periodKey: String(buyYmd), buyYmd, sellYmd });
    }
    return out;
  }

  const groups = new Map(); // key -> { buyYmd, sellYmd }
  const keyFn = f === 'W' ? (ymd) => String(weekKeyMondayYmd(ymd))
    : (f === 'M' ? (ymd) => monthKeyYm(ymd) : (ymd) => quarterKeyYq(ymd));

  for (const ymd of dates) {
    const k = keyFn(ymd);
    const g = groups.get(k);
    if (!g) groups.set(k, { buyYmd: ymd, sellYmd: ymd });
    else {
      if (ymd < g.buyYmd) g.buyYmd = ymd;
      if (ymd > g.sellYmd) g.sellYmd = ymd;
    }
  }

  return Array.from(groups.entries())
    .map(([periodKey, g]) => ({ periodKey, buyYmd: g.buyYmd, sellYmd: g.sellYmd }))
    .sort((a, b) => a.buyYmd - b.buyYmd);
}

module.exports = {
  ymdToUtcDate,
  utcDateToYmd,
  weekKeyMondayYmd,
  monthKeyYm,
  quarterKeyYq,
  buildPeriodPlans,
};
