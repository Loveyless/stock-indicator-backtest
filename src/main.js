/**
 * Node.js 入口脚本
 *
 * 做的事：
 * - `--mode=stats`：遍历 `stock/*.csv`，计算信号日后 N 日收益的条件统计（describe + 命中率）
 * - `--mode=backtest`：用默认策略（ER，长仓）做逐文件回测，并输出收益/回撤等结论
 *
 * 运行：
 * - `npm i`
 * - `npm start`
 *
 * 可选参数：
 * - `--mode=stats|backtest`（默认 stats）
 * - `--data-dir=PATH`（数据目录，默认 `./stock`）
 * - `--data-version=STRING`（可选：写进报告 Run Meta，方便复现）
 * - `--start=20070101` / `--end=20220930`
 * - `--days=1,2,3,5,10,20`
 * - `--files=sz000001.csv,sh600000.csv`（只跑指定文件）
 * - `--limit=10`（只跑前 N 个文件）
 * - `--quiet`（不显示进度，仅输出报告路径）
 * - `--encoding=gbk|utf8|auto`（默认 gbk；auto 仅做 BOM 级别识别后回退 gbk）
 *
 * stats 模式参数：
 * - `--safe-rsv`（更稳：HIGH_N==LOW_N 时不产生 inf/NaN；注意会改变信号/结果）
 * - `--exact-quantiles`（精确分位数：更慢、更吃内存）
 *
 * backtest 模式参数（默认策略 ER）：
 * - `--capital=10000`
 * - `--execution=close|next_close`（默认 next_close）
 * - `--lot=100`
 * - `--fee-bps=0`（双边佣金）
 * - `--stamp-bps=0`（卖出印花税）
 * - `--er-span=20`（EMA span）
 */

const fs = require('node:fs');
const path = require('node:path');
const iconv = require('iconv-lite');
const { parse } = require('csv-parse/sync');
const { computeSignalKD } = require('./technicalIndicator');
const { DescribeAccumulator } = require('./stats');
const { computeSignalsErLongOnly } = require('./strategyEr');
const { simulateLongOnly } = require('./backtest');
const { buildExecutionEvents, simulatePortfolioEqualWeight } = require('./backtestPortfolio');

const DEFAULT_DAY_LIST = [1, 2, 3, 5, 10, 20];
const DEFAULT_START_TIME = '20070101';
const DEFAULT_END_TIME = '20220930';
const DEFAULT_ENCODING = 'gbk';
const DEFAULT_MODE = 'stats'; // stats | backtest

function parseBool(s) {
  if (s === undefined || s === null) return false;
  const v = String(s).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function getNpmConfig(key) {
  // npm 运行脚本时会把参数解析为环境变量：npm_config_<key>
  // 例如：`npm start --limit=10` 可能会设置 `npm_config_limit=10`
  //
  // 注意：不同 npm 版本对 “-- 参数透传” 的行为不完全一致；这里同时支持 argv 与 npm_config_ 两种来源。
  const envKey = `npm_config_${key}`;
  return process.env[envKey];
}

function parseArgs(argv) {
  const args = {
    mode: DEFAULT_MODE,
    start: DEFAULT_START_TIME,
    end: DEFAULT_END_TIME,
    days: DEFAULT_DAY_LIST.slice(),
    files: null,
    limit: null,
    quiet: false,
    dataDir: null,
    dataVersion: null,
    encoding: DEFAULT_ENCODING,
    safeRsv: false,
    exactQuantiles: false,

    // backtest only
    capital: 1000000,
    execution: 'next_close', // close | next_close
    lot: 100,
    feeBps: 0,
    stampBps: 0,
    erSpan: 20,
  };

  for (const raw of argv) {
    if (raw === '--quiet') args.quiet = true;
    else if (raw === '--safe-rsv') args.safeRsv = true;
    else if (raw === '--exact-quantiles') args.exactQuantiles = true;
    else if (raw.startsWith('--mode=')) args.mode = raw.slice('--mode='.length).trim();
    else if (raw.startsWith('--data-dir=')) args.dataDir = raw.slice('--data-dir='.length).trim();
    else if (raw.startsWith('--data-version=')) args.dataVersion = raw.slice('--data-version='.length).trim();
    else if (raw.startsWith('--start=')) args.start = raw.slice('--start='.length);
    else if (raw.startsWith('--end=')) args.end = raw.slice('--end='.length);
    else if (raw.startsWith('--days=')) {
      const list = raw
        .slice('--days='.length)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (!list.length) throw new Error(`--days 解析失败：${raw}`);
      args.days = list;
    } else if (raw.startsWith('--files=')) {
      const list = raw
        .slice('--files='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!list.length) throw new Error(`--files 解析失败：${raw}`);
      args.files = list;
    } else if (raw.startsWith('--encoding=')) {
      const enc = raw.slice('--encoding='.length).trim();
      if (!enc) throw new Error(`--encoding 不能为空：${raw}`);
      args.encoding = enc;
    } else if (raw.startsWith('--capital=')) {
      const x = Number(raw.slice('--capital='.length));
      if (!Number.isFinite(x) || x <= 0) throw new Error(`--capital 必须是正数：${raw}`);
      args.capital = x;
    } else if (raw.startsWith('--execution=')) {
      args.execution = raw.slice('--execution='.length).trim();
    } else if (raw.startsWith('--lot=')) {
      const x = Number(raw.slice('--lot='.length));
      if (!Number.isFinite(x) || x <= 0) throw new Error(`--lot 必须是正数：${raw}`);
      args.lot = Math.floor(x);
    } else if (raw.startsWith('--fee-bps=')) {
      const x = Number(raw.slice('--fee-bps='.length));
      if (!Number.isFinite(x) || x < 0) throw new Error(`--fee-bps 必须是非负数：${raw}`);
      args.feeBps = x;
    } else if (raw.startsWith('--stamp-bps=')) {
      const x = Number(raw.slice('--stamp-bps='.length));
      if (!Number.isFinite(x) || x < 0) throw new Error(`--stamp-bps 必须是非负数：${raw}`);
      args.stampBps = x;
    } else if (raw.startsWith('--er-span=')) {
      const x = Number(raw.slice('--er-span='.length));
      if (!Number.isFinite(x) || x <= 0) throw new Error(`--er-span 必须是正数：${raw}`);
      args.erSpan = Math.floor(x);
    } else if (raw.startsWith('--limit=')) {
      const n = Number(raw.slice('--limit='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--limit 必须是正数：${raw}`);
      args.limit = Math.floor(n);
    } else {
      throw new Error(`未知参数：${raw}`);
    }
  }

  // === npm_config_* fallback（当 npm 没把参数透传到 argv 时仍可生效）
  if (args.mode === DEFAULT_MODE && getNpmConfig('mode')) args.mode = String(getNpmConfig('mode')).trim() || DEFAULT_MODE;
  if (args.start === DEFAULT_START_TIME && getNpmConfig('start')) args.start = String(getNpmConfig('start'));
  if (args.end === DEFAULT_END_TIME && getNpmConfig('end')) args.end = String(getNpmConfig('end'));
  if (args.dataDir === null && getNpmConfig('data_dir')) args.dataDir = String(getNpmConfig('data_dir')).trim() || null;
  if (args.dataVersion === null && getNpmConfig('data_version')) args.dataVersion = String(getNpmConfig('data_version')).trim() || null;

  if (args.days.join(',') === DEFAULT_DAY_LIST.join(',') && getNpmConfig('days')) {
    const list = String(getNpmConfig('days'))
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (list.length) args.days = list;
  }

  if (!args.files && getNpmConfig('files')) {
    const list = String(getNpmConfig('files'))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length) args.files = list;
  }

  if (args.encoding === DEFAULT_ENCODING && getNpmConfig('encoding')) {
    args.encoding = String(getNpmConfig('encoding')).trim() || DEFAULT_ENCODING;
  }

  if (args.limit === null && getNpmConfig('limit')) {
    const n = Number(getNpmConfig('limit'));
    if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
  }

  // 布尔型 flag：仅当 argv 未显式指定时，才用 npm_config_* 补齐
  if (!args.quiet && parseBool(getNpmConfig('quiet'))) args.quiet = true;
  if (!args.safeRsv && (parseBool(getNpmConfig('safe_rsv')) || parseBool(getNpmConfig('safe-rsv')))) args.safeRsv = true;
  if (!args.exactQuantiles && (parseBool(getNpmConfig('exact_quantiles')) || parseBool(getNpmConfig('exact-quantiles')))) args.exactQuantiles = true;

  if (args.capital === 10000 && getNpmConfig('capital')) {
    const x = Number(getNpmConfig('capital'));
    if (Number.isFinite(x) && x > 0) args.capital = x;
  }
  if (args.execution === 'next_close' && getNpmConfig('execution')) args.execution = String(getNpmConfig('execution')).trim() || args.execution;
  if (args.lot === 100 && getNpmConfig('lot')) {
    const x = Number(getNpmConfig('lot'));
    if (Number.isFinite(x) && x > 0) args.lot = Math.floor(x);
  }
  if (args.feeBps === 0 && getNpmConfig('fee_bps')) {
    const x = Number(getNpmConfig('fee_bps'));
    if (Number.isFinite(x) && x >= 0) args.feeBps = x;
  }
  if (args.stampBps === 0 && getNpmConfig('stamp_bps')) {
    const x = Number(getNpmConfig('stamp_bps'));
    if (Number.isFinite(x) && x >= 0) args.stampBps = x;
  }
  if (args.erSpan === 20 && getNpmConfig('er_span')) {
    const x = Number(getNpmConfig('er_span'));
    if (Number.isFinite(x) && x > 0) args.erSpan = Math.floor(x);
  }

  return args;
}

function detectEncodingFromBom(buf) {
  if (!buf || buf.length < 2) return null;
  // UTF-8 BOM: EF BB BF
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8';
  // UTF-16LE BOM: FF FE
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le';
  // UTF-16BE BOM: FE FF（iconv-lite 对 utf16be 支持不稳定，明确报错更安全）
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be';
  return null;
}

function decodeCsvBuffer(buf, encoding) {
  const encRaw = String(encoding || DEFAULT_ENCODING).trim().toLowerCase();
  const enc = encRaw === 'auto' ? (detectEncodingFromBom(buf) || DEFAULT_ENCODING) : encRaw;

  if (enc === 'utf16be') {
    throw new Error('检测到 UTF-16BE BOM（FE FF），当前不支持；请先转码为 UTF-8 或 GBK。');
  }

  if (!iconv.encodingExists(enc)) {
    throw new Error(`不支持的编码：${encoding}`);
  }

  // 对带 BOM 的文本，先去掉 BOM，避免把 BOM 当作数据的一部分。
  let sliceStart = 0;
  if (enc === 'utf8' && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) sliceStart = 3;
  if (enc === 'utf16le' && buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) sliceStart = 2;
  const body = sliceStart ? buf.subarray(sliceStart) : buf;

  return iconv.decode(body, enc);
}

function parseYmdInt(dateLike) {
  if (dateLike === undefined || dateLike === null) return Number.NaN;
  const s = String(dateLike).trim();
  const m = s.match(/^(\d{4})[/-]?(\d{2})[/-]?(\d{2})/);
  if (!m) return Number.NaN;
  return Number(m[1] + m[2] + m[3]);
}

function parseNumber(v) {
  if (v === undefined || v === null) return Number.NaN;
  const s = String(v).trim();
  if (s === '') return Number.NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : Number.NaN;
}

function formatNum(x) {
  if (!Number.isFinite(x)) return 'NaN';
  return x.toFixed(6);
}

function htmlEscape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatInt(x) {
  if (!Number.isFinite(x)) return 'NaN';
  return String(Math.trunc(x));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatYmd(ymd) {
  const s = String(ymd);
  if (!/^\d{8}$/.test(s)) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function getBeijingDateTimeParts(d) {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    }).formatToParts(d);

    const map = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = p.value;
    }

    return {
      year: map.year,
      month: map.month,
      day: map.day,
      hour: map.hour,
      minute: map.minute,
      second: map.second,
    };
  } catch {
    // 兜底：按 UTC+8（北京时间）计算，避免某些运行环境缺失时区数据导致报错。
    const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
    return {
      year: String(bj.getUTCFullYear()),
      month: pad2(bj.getUTCMonth() + 1),
      day: pad2(bj.getUTCDate()),
      hour: pad2(bj.getUTCHours()),
      minute: pad2(bj.getUTCMinutes()),
      second: pad2(bj.getUTCSeconds()),
    };
  }
}

function timestampBeijingYmdHmsUnderscore(d) {
  const t = getBeijingDateTimeParts(d);
  return `${t.year}_${t.month}_${t.day}_${t.hour}_${t.minute}_${t.second}`;
}

function formatBeijingGeneratedAt(d) {
  const t = getBeijingDateTimeParts(d);
  return `${t.year}-${t.month}-${t.day} ${t.hour}:${t.minute}:${t.second} (北京时间)`;
}

function renderProgress(processed, total, startedAtMs) {
  const pct = total ? (processed / total) * 100 : 100;
  const elapsedSec = (Date.now() - startedAtMs) / 1000;
  const speed = elapsedSec > 0 ? processed / elapsedSec : 0;
  const etaSec = speed > 0 ? (total - processed) / speed : Number.NaN;

  const etaText = Number.isFinite(etaSec) ? `${Math.max(0, Math.round(etaSec))}s` : '--';
  const line = `处理进度: ${processed}/${total} (${pct.toFixed(2)}%)  用时:${Math.round(elapsedSec)}s  ETA:${etaText}`;
  // 使用 \r 覆盖同一行，避免刷屏；在不支持回车覆盖的终端里会退化为多行输出。
  process.stdout.write(`\r${line}`);
}

function collectDescribeSnapshots(dayList, describeByDay) {
  const snap = {};
  for (const day of dayList) snap[day] = describeByDay[day].snapshot();
  return snap;
}

function renderDescribeTableHtml(dayList, snapByDay) {
  const rows = [
    ['count', (s) => formatInt(s.count)],
    ['mean', (s) => formatNum(s.mean)],
    ['std', (s) => formatNum(s.std)],
    ['min', (s) => formatNum(s.min)],
    ['25%', (s) => formatNum(s.q25)],
    ['50%', (s) => formatNum(s.q50)],
    ['75%', (s) => formatNum(s.q75)],
    ['max', (s) => formatNum(s.max)],
  ];

  const head = `
    <thead>
      <tr>
        <th class="sticky-col">stat</th>
        ${dayList.map((d) => `<th>${htmlEscape(`${d}日后涨跌幅`)}</th>`).join('')}
      </tr>
    </thead>`;

  const body = `
    <tbody>
      ${rows.map(([name, getter]) => `
        <tr>
          <td class="sticky-col">${htmlEscape(name)}</td>
          ${dayList.map((d) => `<td class="num">${htmlEscape(getter(snapByDay[d]))}</td>`).join('')}
        </tr>
      `).join('')}
    </tbody>`;

  return `<table class="table">${head}${body}</table>`;
}

function renderProbabilityTableHtml(dayList, bucket, snapByDay, { directionText, compareSign }) {
  const rows = dayList.map((day) => {
    const hit = bucket.probCountByDay.get(day) || 0;
    const den = bucket.totalRows || 0;
    const p = den ? hit / den : Number.NaN;
    return {
      day,
      hit,
      den,
      p,
      valid: snapByDay[day].count,
    };
  });

  const head = `
    <thead>
      <tr>
        <th>day</th>
        <th>condition</th>
        <th class="num">hit_count</th>
        <th class="num">signal_rows</th>
        <th class="num">hit_rate</th>
        <th class="num">valid_return_rows</th>
      </tr>
    </thead>`;

  const body = `
    <tbody>
      ${rows.map((r) => `
        <tr>
          <td>${htmlEscape(String(r.day))}</td>
          <td>${htmlEscape(`ret ${compareSign} 0 (${directionText})`)}</td>
          <td class="num">${htmlEscape(formatInt(r.hit))}</td>
          <td class="num">${htmlEscape(formatInt(r.den))}</td>
          <td class="num">${htmlEscape(Number.isFinite(r.p) ? r.p.toFixed(6) : 'NaN')}</td>
          <td class="num">${htmlEscape(formatInt(r.valid))}</td>
        </tr>
      `).join('')}
    </tbody>`;

  return `<table class="table">${head}${body}</table>`;
}

function downsampleSeries(series, maxPoints) {
  if (series.length <= maxPoints) return series;
  const step = Math.ceil(series.length / maxPoints);
  const out = [];
  for (let i = 0; i < series.length; i += step) out.push(series[i]);
  // 确保最后一个点被保留
  const last = series[series.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function renderEquityCurveSvg(equityCurve) {
  const pts = downsampleSeries(equityCurve, 900);
  const values = pts.map((p) => p.equity).filter((x) => Number.isFinite(x));
  if (!values.length) return '<div class="hint">无净值数据</div>';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const w = 1080;
  const h = 240;
  const pad = 8;
  const range = max - min || 1;

  const toX = (idx) => pad + (idx * (w - pad * 2)) / Math.max(1, pts.length - 1);
  const toY = (v) => pad + (h - pad * 2) * (1 - (v - min) / range);

  const points = pts.map((p, idx) => {
    const v = Number.isFinite(p.equity) ? p.equity : min;
    return `${toX(idx).toFixed(2)},${toY(v).toFixed(2)}`;
  }).join(' ');

  const last = pts[pts.length - 1];
  return `
    <div class="hint">区间：${htmlEscape(formatYmd(pts[0].date))} → ${htmlEscape(formatYmd(last.date))}；末值：${htmlEscape(formatNum(last.equity))}</div>
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="equity curve">
      <rect x="0" y="0" width="${w}" height="${h}" fill="rgba(255,255,255,0.02)"></rect>
      <polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${points}"></polyline>
    </svg>
  `;
}

function renderReportHtml({ title, meta, resultsBySignal, notes }) {
  const metaRows = Object.entries(meta)
    .map(([k, v]) => `<tr><th>${htmlEscape(k)}</th><td>${htmlEscape(v)}</td></tr>`)
    .join('');

  const blocks = resultsBySignal.map((b) => `
    <section class="card">
      <h2>${htmlEscape(b.sectionTitle)}</h2>
      <div class="hint">样本点：${htmlEscape(formatInt(b.totalRows))}（只统计出现信号的行）</div>
      <h3>describe</h3>
      ${b.describeTableHtml}
      <h3>hit rate</h3>
      ${b.probTableHtml}
    </section>
  `).join('');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEscape(title)}</title>
    <style>
      :root { --bg:#0b0f17; --card:#121a27; --muted:#9fb0c2; --text:#e7eef7; --line:#223046; --accent:#6aa9ff; }
      body { margin:0; background:var(--bg); color:var(--text); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }
      .wrap { max-width: 1200px; margin: 24px auto; padding: 0 16px; }
      header { margin-bottom: 16px; }
      h1 { font-size: 22px; margin: 0 0 8px; }
      .sub { color: var(--muted); font-size: 13px; }
      .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
      .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
      .hint { color: var(--muted); font-size: 13px; margin: 6px 0 12px; }
      h2 { margin: 0 0 8px; font-size: 18px; }
      h3 { margin: 14px 0 8px; font-size: 14px; color: var(--accent); }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      th, td { border: 1px solid var(--line); padding: 8px; font-size: 12px; }
      th { background: rgba(255,255,255,0.03); text-align: left; }
      td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
      .table { overflow: auto; display: block; }
      .sticky-col { position: sticky; left: 0; background: var(--card); }
      .meta { width: 100%; max-width: 900px; }
      .meta th { width: 240px; }
      .notes { white-space: pre-wrap; color: var(--muted); font-size: 12px; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <h1>${htmlEscape(title)}</h1>
        <div class="sub">策略：KD 金叉/死叉信号 → 统计信号日后 N 日涨跌幅分布与命中率</div>
      </header>

      <section class="card">
        <h2>Run Meta</h2>
        <table class="meta">
          <tbody>
            ${metaRows}
          </tbody>
        </table>
      </section>

      <div class="grid">
        ${blocks}
      </div>

      <section class="card">
        <h2>Notes</h2>
        <div class="notes">${htmlEscape(notes)}</div>
      </section>
    </div>
  </body>
</html>`;
}

function renderBacktestReportHtml({ title, meta, strategy, summary, perFileRows, equityCurveSvg, notes }) {
  const metaRows = Object.entries(meta)
    .map(([k, v]) => `<tr><th>${htmlEscape(k)}</th><td>${htmlEscape(v)}</td></tr>`)
    .join('');

  const summaryRows = Object.entries(summary)
    .map(([k, v]) => `<tr><th>${htmlEscape(k)}</th><td>${htmlEscape(v)}</td></tr>`)
    .join('');

  const perFileHead = `
    <thead>
      <tr>
        <th>file</th>
        <th class="num">trades</th>
        <th class="num">win_rate</th>
        <th class="num">total_return</th>
        <th class="num">max_dd</th>
        <th class="num">final_equity</th>
      </tr>
    </thead>`;

  const perFileBody = `
    <tbody>
      ${perFileRows.map((r) => `
        <tr>
          <td>${htmlEscape(r.file)}</td>
          <td class="num">${htmlEscape(formatInt(r.trades))}</td>
          <td class="num">${htmlEscape(Number.isFinite(r.winRate) ? (r.winRate * 100).toFixed(2) + '%' : 'NaN')}</td>
          <td class="num">${htmlEscape(Number.isFinite(r.totalReturn) ? (r.totalReturn * 100).toFixed(2) + '%' : 'NaN')}</td>
          <td class="num">${htmlEscape(Number.isFinite(r.maxDrawdown) ? (r.maxDrawdown * 100).toFixed(2) + '%' : 'NaN')}</td>
          <td class="num">${htmlEscape(Number.isFinite(r.finalEquity) ? formatNum(r.finalEquity) : 'NaN')}</td>
        </tr>
      `).join('')}
    </tbody>`;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEscape(title)}</title>
    <style>
      :root { --bg:#0b0f17; --card:#121a27; --muted:#9fb0c2; --text:#e7eef7; --line:#223046; --accent:#6aa9ff; }
      body { margin:0; background:var(--bg); color:var(--text); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }
      .wrap { max-width: 1200px; margin: 24px auto; padding: 0 16px; }
      header { margin-bottom: 16px; }
      h1 { font-size: 22px; margin: 0 0 8px; }
      .sub { color: var(--muted); font-size: 13px; }
      .grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
      .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
      .hint { color: var(--muted); font-size: 13px; margin: 6px 0 12px; }
      h2 { margin: 0 0 8px; font-size: 18px; }
      h3 { margin: 14px 0 8px; font-size: 14px; color: var(--accent); }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      th, td { border: 1px solid var(--line); padding: 8px; font-size: 12px; }
      th { background: rgba(255,255,255,0.03); text-align: left; }
      td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
      .table { overflow: auto; display: block; }
      .meta { width: 100%; max-width: 900px; }
      .meta th { width: 240px; }
      .notes { white-space: pre-wrap; color: var(--muted); font-size: 12px; line-height: 1.5; }
      details > summary { cursor: pointer; color: var(--accent); }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <h1>${htmlEscape(title)}</h1>
        <div class="sub">${htmlEscape(strategy)}</div>
      </header>

      <section class="card">
        <h2>Run Meta</h2>
        <table class="meta"><tbody>${metaRows}</tbody></table>
      </section>

      <div class="grid">
        <section class="card">
          <h2>Strategy Summary</h2>
          <table class="meta"><tbody>${summaryRows}</tbody></table>
        </section>

        <section class="card">
          <h2>Per File</h2>
          <div class="hint">说明：A 股长仓回测；同日多票入场按现金平均分仓（仅对当日新增入场票）。</div>
          <table class="table">${perFileHead}${perFileBody}</table>
          ${equityCurveSvg ? `<details open><summary>Portfolio Equity Curve</summary>${equityCurveSvg}</details>` : '<div class="hint">无组合净值数据（可能没有任何成交）。</div>'}
        </section>

        <section class="card">
          <h2>Notes</h2>
          <div class="notes">${htmlEscape(notes)}</div>
        </section>
      </div>
    </div>
  </body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const startYmd = Number(args.start);
  const endYmd = Number(args.end);
  if (!Number.isFinite(startYmd) || !Number.isFinite(endYmd)) {
    throw new Error(`start/end 必须是 YYYYMMDD：start=${args.start}, end=${args.end}`);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const dataDir = args.dataDir ? path.resolve(args.dataDir) : path.join(projectRoot, 'stock');
  if (!fs.existsSync(dataDir)) throw new Error(`找不到数据目录：${dataDir}`);

  let fileList = fs.readdirSync(dataDir).filter((f) => f.toLowerCase().endsWith('.csv'));
  // 固定顺序：避免不同文件系统/环境导致遍历顺序不一致，保证结果可复现。
  fileList.sort((a, b) => a.localeCompare(b, 'en'));
  if (args.files) {
    const set = new Set(args.files);
    fileList = fileList.filter((f) => set.has(f));
  }
  if (args.limit) fileList = fileList.slice(0, args.limit);

  const startedAt = Date.now();

  if (args.mode !== 'stats' && args.mode !== 'backtest') {
    throw new Error(`--mode 仅支持 stats/backtest：${args.mode}`);
  }

  if (args.mode === 'backtest' && args.days.join(',') !== DEFAULT_DAY_LIST.join(',')) {
    // backtest 模式不使用 --days，避免误解（回测持有期/止盈止损并未定义）。
    // 允许用户仍然传入，但强制提示更清晰。
  }

  if (args.mode === 'backtest') {
    const seriesByFile = new Map();
    const portfolioEvents = [];
    const perFile = [];

    const totalFiles = fileList.length;
    let processedFiles = 0;

    for (const f of fileList) {
      processedFiles += 1;
      if (!args.quiet) renderProgress(processedFiles, totalFiles, startedAt);

      const fullPath = path.join(dataDir, f);
      const buf = fs.readFileSync(fullPath);
      const text = decodeCsvBuffer(buf, args.encoding);

      const records = parse(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      if (!records.length) continue;
      for (const col of ['交易日期', '最低价_复权', '最高价_复权', '收盘价_复权']) {
        if (!(col in records[0])) {
          throw new Error(`文件 ${f} 缺少必要列：${col}（encoding=${args.encoding}；若列名乱码，尝试 --encoding=auto 或 --encoding=utf8）`);
        }
      }

      const n = records.length;
      const dates = new Array(n);
      const lowAdj = new Array(n);
      const highAdj = new Array(n);
      const closeAdj = new Array(n);

      for (let i = 0; i < n; i += 1) {
        const r = records[i];
        dates[i] = parseYmdInt(r['交易日期']);
        lowAdj[i] = parseNumber(r['最低价_复权']);
        highAdj[i] = parseNumber(r['最高价_复权']);
        closeAdj[i] = parseNumber(r['收盘价_复权']);
      }

      const { entry, exit } = computeSignalsErLongOnly({ highAdj, lowAdj, closeAdj }, { span: args.erSpan });

      // 组合回测需要：事件 + 收盘序列（用于净值曲线与回撤）
      const evs = buildExecutionEvents(
        { file: f, datesYmd: dates, closeAdj, entrySignal: entry, exitSignal: exit },
        { startYmd, endYmd, execution: args.execution },
      );
      if (evs.length) {
        seriesByFile.set(f, { datesYmd: dates, closeAdj });
        for (const e of evs) portfolioEvents.push(e);
      }

      const r = simulateLongOnly(
        { datesYmd: dates, closeAdj, entrySignal: entry, exitSignal: exit },
        {
          startYmd,
          endYmd,
          initialCapital: args.capital,
          execution: args.execution,
          lot: args.lot,
          feeBps: args.feeBps,
          stampBps: args.stampBps,
          forceExitEof: true,
        },
      );

      perFile.push({
        file: f,
        trades: r.trades.length,
        wins: r.trades.filter((t) => Number.isFinite(t.pnl) && t.pnl > 0).length,
        winRate: r.winRate,
        totalReturn: r.totalReturn,
        maxDrawdown: r.maxDrawdown,
        finalEquity: r.finalEquity,
        equityCurve: r.equityCurve,
      });
    }

    if (!args.quiet) process.stdout.write('\n');

    // 结论优先：按总收益排序
    perFile.sort((a, b) => {
      const ar = Number.isFinite(a.totalReturn) ? a.totalReturn : Number.NEGATIVE_INFINITY;
      const br = Number.isFinite(b.totalReturn) ? b.totalReturn : Number.NEGATIVE_INFINITY;
      return br - ar;
    });

    const portfolio = simulatePortfolioEqualWeight(
      { seriesByFile, events: portfolioEvents },
      {
        startYmd,
        endYmd,
        initialCapital: args.capital,
        lot: args.lot,
        feeBps: args.feeBps,
        stampBps: args.stampBps,
      },
    );

    const totalTrades = perFile.reduce((s, x) => s + x.trades, 0);
    const winTrades = perFile.reduce((s, x) => s + x.wins, 0);
    const pooledWinRate = totalTrades ? winTrades / totalTrades : Number.NaN;
    const avgReturn = perFile.length
      ? perFile.reduce((s, x) => s + (Number.isFinite(x.totalReturn) ? x.totalReturn : 0), 0) / perFile.length
      : Number.NaN;

    const now = new Date();
    const ts = timestampBeijingYmdHmsUnderscore(now);
    const reportName = `量化分析结果+${ts}.html`;
    const reportPath = path.join(projectRoot, reportName);

    const equityCurveSvg = portfolio.equityCurve && portfolio.equityCurve.length ? renderEquityCurveSvg(portfolio.equityCurve) : '';

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const notes = [
      `- 默认策略：ER（Elder Ray）。BullPower=HIGH-EMA(CLOSE,N)，BearPower=LOW-EMA(CLOSE,N)。`,
      `- 入场：BearPower 上穿 0；出场：BullPower 下穿 0（长仓）。`,
      `- 执行价：${args.execution}（为避免“收盘生成信号又用同一收盘成交”的偷看，默认 next_close）。`,
      `- 股数：按 lot=${args.lot} 整手交易；资金不足则跳过该次入场。`,
      `- 手续费：fee_bps=${args.feeBps}；印花税（卖出）：stamp_bps=${args.stampBps}。`,
      `- 同一交易日多票入场：对“当日新增入场票”按现金平均分仓（不会对存量持仓做再平衡）。`,
    ].join('\n');

    const html = renderBacktestReportHtml({
      title: `量化分析结果+${ts}`,
      meta: {
        generated_at: formatBeijingGeneratedAt(now),
        elapsed_seconds: String(elapsedSec),
        data_dir: dataDir,
        data_version: args.dataVersion ? String(args.dataVersion) : '',
        files_total: String(perFile.length),
        encoding: String(args.encoding),
        mode: 'backtest',
        start: args.start,
        end: args.end,
        capital: String(args.capital),
        execution: String(args.execution),
        lot: String(args.lot),
        fee_bps: String(args.feeBps),
        stamp_bps: String(args.stampBps),
        er_span: String(args.erSpan),
      },
      strategy: '默认策略（ER）：仅做多。入场 BearPower 上穿 0；出场 BullPower 下穿 0；EMA(CLOSE, N)。',
      summary: {
        files: String(perFile.length),
        portfolio_final_equity: Number.isFinite(portfolio.finalEquity) ? formatNum(portfolio.finalEquity) : 'NaN',
        portfolio_total_return: Number.isFinite(portfolio.totalReturn) ? (portfolio.totalReturn * 100).toFixed(2) + '%' : 'NaN',
        portfolio_max_dd: Number.isFinite(portfolio.maxDrawdown) ? (portfolio.maxDrawdown * 100).toFixed(2) + '%' : 'NaN',
        portfolio_trades: String(portfolio.trades.length),
        portfolio_win_rate: Number.isFinite(portfolio.winRate) ? (portfolio.winRate * 100).toFixed(2) + '%' : 'NaN',
        trades_total: String(totalTrades),
        win_rate_pooled: Number.isFinite(pooledWinRate) ? (pooledWinRate * 100).toFixed(2) + '%' : 'NaN',
        avg_total_return_per_file: Number.isFinite(avgReturn) ? (avgReturn * 100).toFixed(2) + '%' : 'NaN',
      },
      perFileRows: perFile.slice(0, 200),
      equityCurveSvg: equityCurveSvg || null,
      notes,
    });

    fs.writeFileSync(reportPath, html, 'utf8');
    console.log(`已生成报告：${reportPath}`);
    return;
  }

  const signalBuckets = new Map([
    [0, { totalRows: 0, probCountByDay: new Map(), describeByDay: {} }],
    [1, { totalRows: 0, probCountByDay: new Map(), describeByDay: {} }],
  ]);

  for (const signal of [0, 1]) {
    const bucket = signalBuckets.get(signal);
    for (const day of args.days) {
      bucket.probCountByDay.set(day, 0);
      bucket.describeByDay[day] = new DescribeAccumulator({ exactQuantiles: args.exactQuantiles });
    }
  }

  const totalFiles = fileList.length;
  let processedFiles = 0;

  for (const f of fileList) {
    processedFiles += 1;
    if (!args.quiet) renderProgress(processedFiles, totalFiles, startedAt);

    const fullPath = path.join(dataDir, f);
    const buf = fs.readFileSync(fullPath);
    const text = decodeCsvBuffer(buf, args.encoding);

    const records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    if (!records.length) continue;
    for (const col of ['交易日期', '最低价_复权', '最高价_复权', '收盘价_复权']) {
      if (!(col in records[0])) {
        throw new Error(`文件 ${f} 缺少必要列：${col}（encoding=${args.encoding}；若列名乱码，尝试 --encoding=auto 或 --encoding=utf8）`);
      }
    }

    const n = records.length;
    const dates = new Array(n);
    const lowAdj = new Array(n);
    const highAdj = new Array(n);
    const closeAdj = new Array(n);

    for (let i = 0; i < n; i += 1) {
      const r = records[i];
      dates[i] = parseYmdInt(r['交易日期']);
      lowAdj[i] = parseNumber(r['最低价_复权']);
      highAdj[i] = parseNumber(r['最高价_复权']);
      closeAdj[i] = parseNumber(r['收盘价_复权']);
    }

    const { signal } = computeSignalKD({ lowAdj, highAdj, closeAdj }, { safeRsv: args.safeRsv });

    const futureReturnsByDay = new Map();
    for (const day of args.days) {
      const arr = new Array(n).fill(Number.NaN);
      for (let i = 0; i < n; i += 1) {
        const j = i + day;
        if (j >= n) continue;
        const base = closeAdj[i];
        const fut = closeAdj[j];
        if (!Number.isFinite(base) || !Number.isFinite(fut) || base === 0) continue;
        arr[i] = fut / base - 1;
      }
      futureReturnsByDay.set(day, arr);
    }

    for (let i = 0; i < n; i += 1) {
      const ymd = dates[i];
      if (!Number.isFinite(ymd) || ymd < startYmd || ymd > endYmd) continue;

      const sig = signal[i];
      if (sig !== 0 && sig !== 1) continue;

      const bucket = signalBuckets.get(sig);
      // `totalRows` 是“信号样本点”的总行数（分母），与收益是否可计算无关。
      // 某些样本点位于尾部，未来 N 日收益无法计算（NaN），这会导致：
      // - describe 的 count < totalRows（describe 只统计有限值）
      // - hit_rate 分母仍是 totalRows（为了与原 Python 写法一致）
      bucket.totalRows += 1;

      for (const day of args.days) {
        const ret = futureReturnsByDay.get(day)[i];
        // describe：只统计有限值（NaN/Inf 会被忽略）
        bucket.describeByDay[day].add(ret);

        if (sig === 1) {
          if (ret > 0) bucket.probCountByDay.set(day, bucket.probCountByDay.get(day) + 1);
        } else {
          if (ret < 0) bucket.probCountByDay.set(day, bucket.probCountByDay.get(day) + 1);
        }
      }
    }
  }

  if (!args.quiet) process.stdout.write('\n');

  const now = new Date();
  const ts = timestampBeijingYmdHmsUnderscore(now);
  const reportName = `量化分析结果+${ts}.html`;
  const reportPath = path.join(projectRoot, reportName);

  const resultsBySignal = [0, 1].map((sig) => {
    const bucket = signalBuckets.get(sig);
    const snapByDay = collectDescribeSnapshots(args.days, bucket.describeByDay);
    const describeTableHtml = renderDescribeTableHtml(args.days, snapByDay);
    const probTableHtml = renderProbabilityTableHtml(args.days, bucket, snapByDay, sig === 1
      ? { directionText: 'bullish', compareSign: '>' }
      : { directionText: 'bearish', compareSign: '<' });

    return {
      sig,
      sectionTitle: sig === 1 ? '看涨信号 (signal=1)' : '看跌信号 (signal=0)',
      totalRows: bucket.totalRows,
      describeTableHtml,
      probTableHtml,
    };
  });

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  const notes = [
    `- 统计口径：只在“信号出现的那一天”计入样本点（signal=0/1）。`,
    `- 概率口径：hit_rate = hit_count / signal_rows（分母包含未来 N 日收益无法计算的样本点；这是为了复刻原 Python 写法）。`,
    `- 分位数：默认是近似值（P² 流式估计）；使用 --exact-quantiles 会改为精确分位数（更慢、更吃内存）。`,
  ].join('\n');

  const html = renderReportHtml({
    title: `量化分析结果+${ts}`,
    meta: {
      generated_at: formatBeijingGeneratedAt(now),
      elapsed_seconds: String(elapsedSec),
      data_dir: dataDir,
      data_version: args.dataVersion ? String(args.dataVersion) : '',
      files_total: String(totalFiles),
      encoding: String(args.encoding),
      start: args.start,
      end: args.end,
      day_list: args.days.join(','),
      safe_rsv: String(args.safeRsv),
      exact_quantiles: String(args.exactQuantiles),
    },
    resultsBySignal,
    notes,
  });

  fs.writeFileSync(reportPath, html, 'utf8');
  console.log(`已生成报告：${reportPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  }
}
