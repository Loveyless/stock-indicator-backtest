/**
 * Node.js 入口脚本
 *
 * 做的事：
 * 1) 遍历 `stock/*.csv`（GBK 编码）
 * 2) 计算技术指标信号（KD 金叉/死叉）
 * 3) 计算未来 N 日涨跌幅，并按 signal 分组输出统计与概率
 *
 * 运行：
 * - `npm i`
 * - `npm start`
 *
 * 可选参数：
 * - `--start=20070101` / `--end=20220930`
 * - `--days=1,2,3,5,10,20`
 * - `--files=sz000001.csv,sh600000.csv`（只跑指定文件）
 * - `--limit=10`（只跑前 N 个文件）
 * - `--quiet`（不显示进度，仅输出报告路径）
 * - `--safe-rsv`（更稳：HIGH_N==LOW_N 时不产生 inf/NaN；注意会改变信号/结果）
 * - `--exact-quantiles`（精确分位数：更慢、更吃内存）
 */

const fs = require('node:fs');
const path = require('node:path');
const iconv = require('iconv-lite');
const { parse } = require('csv-parse/sync');
const { computeSignalKD } = require('./technicalIndicator');
const { DescribeAccumulator } = require('./stats');

const DEFAULT_DAY_LIST = [1, 2, 3, 5, 10, 20];
const DEFAULT_START_TIME = '20070101';
const DEFAULT_END_TIME = '20220930';

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
    start: DEFAULT_START_TIME,
    end: DEFAULT_END_TIME,
    days: DEFAULT_DAY_LIST.slice(),
    files: null,
    limit: null,
    quiet: false,
    safeRsv: false,
    exactQuantiles: false,
  };

  for (const raw of argv) {
    if (raw === '--quiet') args.quiet = true;
    else if (raw === '--safe-rsv') args.safeRsv = true;
    else if (raw === '--exact-quantiles') args.exactQuantiles = true;
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
    } else if (raw.startsWith('--limit=')) {
      const n = Number(raw.slice('--limit='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--limit 必须是正数：${raw}`);
      args.limit = Math.floor(n);
    } else {
      throw new Error(`未知参数：${raw}`);
    }
  }

  // === npm_config_* fallback（当 npm 没把参数透传到 argv 时仍可生效）
  if (args.start === DEFAULT_START_TIME && getNpmConfig('start')) args.start = String(getNpmConfig('start'));
  if (args.end === DEFAULT_END_TIME && getNpmConfig('end')) args.end = String(getNpmConfig('end'));

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

  if (args.limit === null && getNpmConfig('limit')) {
    const n = Number(getNpmConfig('limit'));
    if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
  }

  // 布尔型 flag：仅当 argv 未显式指定时，才用 npm_config_* 补齐
  if (!args.quiet && parseBool(getNpmConfig('quiet'))) args.quiet = true;
  if (!args.safeRsv && (parseBool(getNpmConfig('safe_rsv')) || parseBool(getNpmConfig('safe-rsv')))) args.safeRsv = true;
  if (!args.exactQuantiles && (parseBool(getNpmConfig('exact_quantiles')) || parseBool(getNpmConfig('exact-quantiles')))) args.exactQuantiles = true;

  return args;
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

function timestampYmdHms(d) {
  return [
    d.getFullYear(),
    pad2(d.getMonth() + 1),
    pad2(d.getDate()),
    pad2(d.getHours()),
    pad2(d.getMinutes()),
    pad2(d.getSeconds()),
  ].join('');
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

function renderProbabilityTableHtml(dayList, bucket, { directionText, compareSign }) {
  const rows = dayList.map((day) => {
    const hit = bucket.probCountByDay.get(day) || 0;
    const den = bucket.totalRows || 0;
    const p = den ? hit / den : Number.NaN;
    return {
      day,
      hit,
      den,
      p,
      valid: bucket.describeByDay[day].snapshot().count,
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

function main() {
  const args = parseArgs(process.argv.slice(2));

  const startYmd = Number(args.start);
  const endYmd = Number(args.end);
  if (!Number.isFinite(startYmd) || !Number.isFinite(endYmd)) {
    throw new Error(`start/end 必须是 YYYYMMDD：start=${args.start}, end=${args.end}`);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const dataDir = path.join(projectRoot, 'stock');
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
    const text = iconv.decode(buf, 'gbk');

    const records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    if (!records.length) continue;
    for (const col of ['交易日期', '最低价_复权', '最高价_复权', '收盘价_复权']) {
      if (!(col in records[0])) throw new Error(`文件 ${f} 缺少必要列：${col}`);
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
  const ts = timestampYmdHms(now);
  const reportName = `量化分析结果+${ts}.html`;
  const reportPath = path.join(projectRoot, reportName);

  const resultsBySignal = [0, 1].map((sig) => {
    const bucket = signalBuckets.get(sig);
    const snapByDay = collectDescribeSnapshots(args.days, bucket.describeByDay);
    const describeTableHtml = renderDescribeTableHtml(args.days, snapByDay);
    const probTableHtml = renderProbabilityTableHtml(args.days, bucket, sig === 1
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
      generated_at: now.toLocaleString(),
      elapsed_seconds: String(elapsedSec),
      data_dir: dataDir,
      files_total: String(totalFiles),
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
