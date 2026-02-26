/**
 * Node.js 入口脚本
 *
 * 做的事：
 * - `--mode=backtest`：按周期轮动策略回测（周期首个交易日买入，周期最后一个交易日卖出；支持 D/W/M/Q；日频为隔夜），输出组合资金曲线/回撤/胜率等
 *
 * 运行：
 * - `npm i`
 * - `npm start`
 *
 * 可选参数：
 * - `--mode=backtest`（默认 backtest；已移除 stats）
 * - `--data-dir=PATH`（数据目录，默认 `./stock`）
 * - `--start=20070101` / `--end=20220930`
 * - `--files=sz000001.csv,sh600000.csv`（只跑指定文件）
 * - `--limit=10`（只跑前 N 个文件）
 * - `--quiet`（不显示进度，仅输出报告路径）
 * - `--encoding=gbk|utf8|auto`（默认 gbk；auto 仅做 BOM 级别识别后回退 gbk）
 *
 * backtest 模式参数（默认策略 file：strategy.js）：
 * - `--capital=1000000`
 * - `--fee-bps=0`（双边佣金）
 * - `--stamp-bps=0`（卖出印花税）
 * - `--freq=D|W|M|Q`（交易频率：日/周/月/季；周期开始买，周期结束卖；日频为隔夜：买入日->下一交易日卖出）
 * - `--strategy=file`（默认 file：从文件加载策略）
 * - `--strategy-file=strategy.js`（默认；策略必须导出名为 strategy 的函数）
 * - `--ma=5,10,20`（示例策略用到：多头排列 MA 快>中>慢）
 * - `--exclude-st=1|0`（示例策略用到：默认 1）
 * - `--pick-limit=NUMBER`（可选：每个周期最多选 N 只；不填则全买）
 */

const fs = require('node:fs');
const path = require('node:path');
const iconv = require('iconv-lite');
const { parse } = require('csv-parse/sync');
const { computeMaxDrawdown } = require('./backtest');
const { simulatePortfolioPeriodicIdeal } = require('./backtestPortfolio');
const indicators = require('./indicators');
const { buildPeriodPlans } = require('./dateUtils');
const { upperBound, indexOfDate } = require('./seriesUtils');

const DEFAULT_START_TIME = '20070101';
const DEFAULT_END_TIME = '20220930';
const DEFAULT_ENCODING = 'gbk';
const DEFAULT_MODE = 'backtest'; // backtest
const DEFAULT_STRATEGY = 'file'; // backtest only
const DEFAULT_STRATEGY_FILE = 'strategy.js';
const DEFAULT_FREQ = 'W';

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
    files: null,
    limit: null,
    quiet: false,
    dataDir: null,
    encoding: DEFAULT_ENCODING,

    // backtest only
    capital: 1000000,
    lot: 100, // 兼容旧参数：理想化成交下不使用（可无限可分）
    feeBps: 0,
    stampBps: 0,

    strategy: DEFAULT_STRATEGY,
    strategyFile: DEFAULT_STRATEGY_FILE,
    freq: DEFAULT_FREQ,
    ma: '5,10,20',
    excludeSt: true,
    pickLimit: null,
  };

  for (const raw of argv) {
    if (raw === '--quiet') args.quiet = true;
    else if (raw.startsWith('--mode=')) args.mode = raw.slice('--mode='.length).trim();
    else if (raw.startsWith('--data-dir=')) args.dataDir = raw.slice('--data-dir='.length).trim();
    else if (raw.startsWith('--start=')) args.start = raw.slice('--start='.length);
    else if (raw.startsWith('--end=')) args.end = raw.slice('--end='.length);
    else if (raw.startsWith('--files=')) {
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
    } else if (raw.startsWith('--strategy=')) {
      args.strategy = raw.slice('--strategy='.length).trim();
    } else if (raw.startsWith('--strategy-file=')) {
      args.strategyFile = raw.slice('--strategy-file='.length).trim();
    } else if (raw.startsWith('--freq=')) {
      args.freq = raw.slice('--freq='.length).trim().toUpperCase();
    } else if (raw.startsWith('--ma=')) {
      args.ma = raw.slice('--ma='.length).trim();
    } else if (raw.startsWith('--exclude-st=')) {
      args.excludeSt = parseBool(raw.slice('--exclude-st='.length));
    } else if (raw.startsWith('--pick-limit=')) {
      const x = Number(raw.slice('--pick-limit='.length));
      if (!Number.isFinite(x) || x <= 0) throw new Error(`--pick-limit 必须是正数：${raw}`);
      args.pickLimit = Math.floor(x);
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

  if (args.strategy === DEFAULT_STRATEGY && getNpmConfig('strategy')) {
    args.strategy = String(getNpmConfig('strategy')).trim() || DEFAULT_STRATEGY;
  }
  if (args.strategyFile === DEFAULT_STRATEGY_FILE && getNpmConfig('strategy_file')) {
    args.strategyFile = String(getNpmConfig('strategy_file')).trim() || DEFAULT_STRATEGY_FILE;
  }
  if (args.freq === DEFAULT_FREQ && getNpmConfig('freq')) {
    args.freq = String(getNpmConfig('freq')).trim().toUpperCase() || DEFAULT_FREQ;
  }
  if (args.ma === '5,10,20' && getNpmConfig('ma')) {
    args.ma = String(getNpmConfig('ma')).trim() || '5,10,20';
  }
  if (args.pickLimit === null && getNpmConfig('pick_limit')) {
    const x = Number(getNpmConfig('pick_limit'));
    if (Number.isFinite(x) && x > 0) args.pickLimit = Math.floor(x);
  }
  if (getNpmConfig('exclude_st') !== undefined) {
    args.excludeSt = parseBool(getNpmConfig('exclude_st'));
  }

  if (args.limit === null && getNpmConfig('limit')) {
    const n = Number(getNpmConfig('limit'));
    if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
  }

  // 布尔型 flag：仅当 argv 未显式指定时，才用 npm_config_* 补齐
  if (!args.quiet && parseBool(getNpmConfig('quiet'))) args.quiet = true;

  if (args.capital === 1000000 && getNpmConfig('capital')) {
    const x = Number(getNpmConfig('capital'));
    if (Number.isFinite(x) && x > 0) args.capital = x;
  }
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

function formatMoney(x) {
  if (!Number.isFinite(x)) return 'NaN';
  try {
    return new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(x);
  } catch {
    return x.toFixed(2);
  }
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

function labelMetaKeyZh(key) {
  const map = {
    generated_at: '生成时间',
    elapsed_seconds: '耗时(秒)',
    data_dir: '数据目录',
    files_total: '文件数',
    encoding: '编码',
    mode: '模式',
    start: '开始日期',
    end: '结束日期',
    capital: '初始资金',
    fee_bps: '佣金(bp)',
    stamp_bps: '印花税(bp)',
    strategy: '回测策略',
    strategy_file: '策略文件',
    freq: '交易频率',
    ma: '均线参数',
    exclude_st: '排除ST',
    pick_limit: '每周期选股上限',
  };
  return map[key] || '';
}

function labelSummaryKeyZh(key) {
  const map = {
    files: '文件数',
    portfolio_final_equity: '组合期末资金',
    portfolio_total_return: '组合总收益率',
    portfolio_max_dd: '组合最大回撤',
    portfolio_trades: '组合交易次数',
    portfolio_win_rate: '组合胜率',
    periods_total: '周期数',
    periods_traded: '有交易的周期数',
    picks_total: '选股总数(累计)',
    picks_avg_per_period: '平均每周期选股数',
    period_win_rate: '周期胜率(按周期)',
  };
  return map[key] || '';
}

function renderKeyWithZhLabel(key, labelZh) {
  const k = htmlEscape(String(key));
  if (!labelZh) return `<span class="kv-k-only">${k}</span>`;
  return `<span class="kv-k-zh">${htmlEscape(String(labelZh))}</span><span class="kv-k-en">${k}</span>`;
}

function formatMetaValue(key, value) {
  if (value === undefined || value === null) return '';
  const raw = String(value);

  if (key === 'mode') {
    if (raw === 'backtest') return '回测(backtest)';
  }

  if (key === 'strategy') {
    if (raw === 'file') return '文件策略(strategy.js) (file)';
  }

  if (key === 'freq') {
    if (raw === 'D') return '日频隔夜(D)';
    if (raw === 'W') return '周频(W)';
    if (raw === 'M') return '月频(M)';
    if (raw === 'Q') return '季频(Q)';
  }

  if (key === 'fee_bps' || key === 'stamp_bps') {
    const bps = Number(value);
    if (Number.isFinite(bps)) return `${bps} bp（${(bps / 100).toFixed(2)}%）`;
  }

  if (key === 'capital') {
    const x = Number(value);
    if (Number.isFinite(x)) return `${formatMoney(x)} 元`;
  }

  if (key === 'exclude_st') {
    return parseBool(value) ? '是' : '否';
  }

  if (key === 'start' || key === 'end') {
    const s = String(value);
    if (/^\d{8}$/.test(s)) return `${formatYmd(s)}（${s}）`;
  }

  return raw;
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

function renderEquityCurveSvg(equityCurve, { initialCapital = null } = {}) {
  const pts = downsampleSeries(equityCurve, 900);
  const values = pts.map((p) => p.equity).filter((x) => Number.isFinite(x));
  if (!values.length) return '<div class="hint">无净值数据</div>';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const w = 1080;
  const h = 240;
  const padL = 84;
  const padR = 14;
  const padT = 12;
  const padB = 34;
  const range = max - min || 1;

  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const toX = (idx) => padL + (idx * innerW) / Math.max(1, pts.length - 1);
  const toY = (v) => padT + innerH * (1 - (v - min) / range);

  const points = pts.map((p, idx) => {
    const v = Number.isFinite(p.equity) ? p.equity : min;
    return `${toX(idx).toFixed(2)},${toY(v).toFixed(2)}`;
  }).join(' ');

  const last = pts[pts.length - 1];
  const data = pts.map((p) => ({ d: p.date, e: Number.isFinite(p.equity) ? p.equity : null }));
  const dataJson = JSON.stringify(data);
  const initial = Number.isFinite(initialCapital) ? initialCapital : null;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const v = min + t * range;
    const y = toY(v);
    return { v, y };
  });

  const xTicks = [
    { t: 0, idx: 0 },
    { t: 0.5, idx: Math.floor((pts.length - 1) / 2) },
    { t: 1, idx: pts.length - 1 },
  ].map((x) => {
    const idx = Math.max(0, Math.min(pts.length - 1, x.idx));
    const px = toX(idx);
    return { idx, x: px, date: pts[idx].date };
  });
  return `
    <div class="hint">区间：${htmlEscape(formatYmd(pts[0].date))} → ${htmlEscape(formatYmd(last.date))}；末值：${htmlEscape(formatMoney(last.equity))}</div>
    <div class="chart-wrap" id="equity-chart-wrap">
      <svg id="equity-chart" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="equity curve">
        <rect x="0" y="0" width="${w}" height="${h}" fill="var(--chart-bg)"></rect>
        <text x="${padL}" y="${padT - 2}" fill="var(--axisText)" font-size="12">资产（元）</text>
        <text x="${w - padR}" y="${h - 10}" text-anchor="end" fill="var(--axisText)" font-size="12">日期</text>

        ${yTicks.map((t) => `
          <line x1="${padL}" y1="${t.y.toFixed(2)}" x2="${(w - padR).toFixed(2)}" y2="${t.y.toFixed(2)}" stroke="var(--grid)" stroke-width="1"></line>
          <text x="${(padL - 8).toFixed(2)}" y="${(t.y + 4).toFixed(2)}" text-anchor="end" fill="var(--tickText)" font-size="11">${htmlEscape(formatMoney(t.v))}</text>
        `).join('')}

        ${xTicks.map((t) => `
          <line x1="${t.x.toFixed(2)}" y1="${(h - padB).toFixed(2)}" x2="${t.x.toFixed(2)}" y2="${(h - padB + 6).toFixed(2)}" stroke="var(--axis)" stroke-width="1"></line>
          <text x="${t.x.toFixed(2)}" y="${(h - 12).toFixed(2)}" text-anchor="${t.idx === 0 ? 'start' : (t.idx === pts.length - 1 ? 'end' : 'middle')}" fill="var(--tickText)" font-size="11">${htmlEscape(formatYmd(t.date))}</text>
        `).join('')}

        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${h - padB}" stroke="var(--axis)" stroke-width="1"></line>
        <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="var(--axis)" stroke-width="1"></line>
        <polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${points}"></polyline>
        <line id="equity-hover-line" x1="0" y1="${padT}" x2="0" y2="${h - padB}" stroke="var(--hover)" stroke-width="1" visibility="hidden"></line>
        <circle id="equity-hover-dot" cx="0" cy="0" r="3.5" fill="var(--accent)" stroke="var(--chart-bg)" stroke-width="1.2" visibility="hidden"></circle>
      </svg>
      <div class="chart-tooltip" id="equity-tooltip" style="display:none;"></div>
    </div>
    <script>
    (() => {
      const data = ${dataJson};
      if (!data || !data.length) return;
      const initial = ${initial === null ? 'null' : String(initial)};

      const wrap = document.getElementById('equity-chart-wrap');
      const svg = document.getElementById('equity-chart');
      const tooltip = document.getElementById('equity-tooltip');
      const line = document.getElementById('equity-hover-line');
      const dot = document.getElementById('equity-hover-dot');
      if (!wrap || !svg || !tooltip || !line || !dot) return;

      const W = ${w};
      const H = ${h};
      const PAD_L = ${padL};
      const PAD_R = ${padR};
      const PAD_T = ${padT};
      const PAD_B = ${padB};
      const MIN = ${Number.isFinite(min) ? String(min) : '0'};
      const MAX = ${Number.isFinite(max) ? String(max) : '0'};
      const RANGE = (MAX - MIN) || 1;

      const innerW = W - PAD_L - PAD_R;
      const innerH = H - PAD_T - PAD_B;
      const toX = (idx) => PAD_L + (idx * innerW) / Math.max(1, data.length - 1);
      const toY = (v) => PAD_T + innerH * (1 - (v - MIN) / RANGE);
      const fmtDate = (ymd) => {
        const s = String(ymd || '');
        if (s.length !== 8) return s;
        return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
      };
      const fmtMoney = (x) => {
        if (!Number.isFinite(x)) return 'NaN';
        try { return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x); }
        catch { return x.toFixed(2); }
      };

      const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

      const pickIndexByClientX = (clientX) => {
        const rect = svg.getBoundingClientRect();
        const x = ((clientX - rect.left) / Math.max(1, rect.width)) * W;
        const t = (x - PAD_L) / Math.max(1, (W - PAD_L - PAD_R));
        const idx = Math.round(t * (data.length - 1));
        return clamp(idx, 0, data.length - 1);
      };

      const renderAt = (idx, clientX, clientY) => {
        const p = data[idx];
        if (!p || !Number.isFinite(p.e)) return;

        const x = toX(idx);
        const y = toY(p.e);
        line.setAttribute('x1', x.toFixed(2));
        line.setAttribute('x2', x.toFixed(2));
        line.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', x.toFixed(2));
        dot.setAttribute('cy', y.toFixed(2));
        dot.setAttribute('visibility', 'visible');

        const ret = initial ? (p.e / initial - 1) : null;
        const retHtml = (ret === null || !Number.isFinite(ret)) ? '' : ('<div>收益：' + (ret * 100).toFixed(2) + '%</div>');
        tooltip.innerHTML = '<div><b>' + fmtDate(p.d) + '</b></div>'
          + '<div>资产：' + fmtMoney(p.e) + '</div>'
          + retHtml;
        tooltip.style.display = 'block';

        const wrapRect = wrap.getBoundingClientRect();
        let left = clientX - wrapRect.left + 12;
        let top = clientY - wrapRect.top + 12;

        // 先放上去测量尺寸，再做边界夹取
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
        const tw = tooltip.offsetWidth || 0;
        const th = tooltip.offsetHeight || 0;

        left = clamp(left, 8, Math.max(8, wrapRect.width - tw - 8));
        top = clamp(top, 8, Math.max(8, wrapRect.height - th - 8));
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
      };

      const hide = () => {
        tooltip.style.display = 'none';
        line.setAttribute('visibility', 'hidden');
        dot.setAttribute('visibility', 'hidden');
      };

      wrap.addEventListener('mouseleave', hide);
      wrap.addEventListener('mousemove', (ev) => {
        const idx = pickIndexByClientX(ev.clientX);
        renderAt(idx, ev.clientX, ev.clientY);
      });
    })();
    </script>
  `;
}

function renderBacktestReportHtml({ title, meta, strategy, overview, amounts, summary, equityCurveSvg, notes }) {
  const metaItems = Object.entries(meta).map(([k, v]) => ({
    kHtml: renderKeyWithZhLabel(k, labelMetaKeyZh(k)),
    v: formatMetaValue(k, v),
    isNum: false,
  }));

  const summaryItems = Object.entries(summary).map(([k, v]) => ({
    kHtml: renderKeyWithZhLabel(k, labelSummaryKeyZh(k)),
    v: String(v),
    isNum: true,
  }));

  const kpis = Array.isArray(overview) ? overview : [];
  const kpiHtml = `
    <div class="kpi-grid">
      ${kpis.map((x) => `
        <div class="kpi-item">
          <div class="kpi-k">${htmlEscape(x.k)}</div>
          <div class="kpi-v">${htmlEscape(x.v)}</div>
          ${x.sub ? `<div class="kpi-sub">${htmlEscape(x.sub)}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `;

  const a = amounts || {};
  const moneyDrawdownItems = [
    { kHtml: htmlEscape('最大回撤金额'), v: Number.isFinite(a.maxDrawdownAmount) ? `-${formatMoney(a.maxDrawdownAmount)} 元` : 'NaN', isNum: true },
    { kHtml: htmlEscape('回撤峰值(资产)'), v: Number.isFinite(a.maxDrawdownPeakEquity) ? `${formatMoney(a.maxDrawdownPeakEquity)} 元` : 'NaN', isNum: true },
    { kHtml: htmlEscape('回撤谷底(资产)'), v: Number.isFinite(a.maxDrawdownTroughEquity) ? `${formatMoney(a.maxDrawdownTroughEquity)} 元` : 'NaN', isNum: true },
    { kHtml: htmlEscape('回撤区间'), v: a.maxDrawdownPeakDate && a.maxDrawdownTroughDate ? `${formatYmd(String(a.maxDrawdownPeakDate))} → ${formatYmd(String(a.maxDrawdownTroughDate))}` : '-', isNum: false },
  ];
  const moneyPeakItems = [
    { kHtml: htmlEscape('最高净值(资产)'), v: Number.isFinite(a.maxEquity) ? `${formatMoney(a.maxEquity)} 元` : 'NaN', isNum: true },
    { kHtml: htmlEscape('最大收益(元)'), v: Number.isFinite(a.maxPnl) ? `${a.maxPnl >= 0 ? '+' : ''}${formatMoney(a.maxPnl)} 元` : 'NaN', isNum: true },
    { kHtml: htmlEscape('最大收益率'), v: Number.isFinite(a.maxReturn) ? `${(a.maxReturn * 100).toFixed(2)}%` : 'NaN', isNum: false },
    { kHtml: htmlEscape('发生日期'), v: a.maxEquityDate ? formatYmd(String(a.maxEquityDate)) : '-', isNum: false },
  ];

  const renderKvGrid = (items) => `
    <dl class="kv-grid">
      ${items.map((it) => `
        <div class="kv">
          <dt class="kv-k">${it.kHtml}</dt>
          <dd class="kv-v${it.isNum ? ' num' : ''}">${htmlEscape(it.v)}</dd>
        </div>
      `).join('')}
    </dl>
  `;

  const meaningful = (s) => {
    const x = String(s || '');
    if (!x) return false;
    if (x === 'NaN' || x === 'NaN%' || x === 'null' || x === 'undefined') return false;
    return !x.includes('NaN');
  };
  const freqLabel = (() => {
    const f = meta && meta.freq ? String(meta.freq).toUpperCase() : '';
    if (f === 'D') return '日度';
    if (f === 'W') return '周度';
    if (f === 'M') return '月度';
    if (f === 'Q') return '季度';
    return '周期';
  })();
  const headlineParts = [];
  if (summary && meaningful(summary.portfolio_total_return)) headlineParts.push(`总收益率 ${summary.portfolio_total_return}`);
  if (summary && meaningful(summary.portfolio_max_dd)) headlineParts.push(`最大回撤 ${summary.portfolio_max_dd}`);
  if (summary && meaningful(summary.period_win_rate)) headlineParts.push(`${freqLabel}胜率 ${summary.period_win_rate}`);
  if (summary && meaningful(summary.portfolio_trades)) headlineParts.push(`交易 ${summary.portfolio_trades} 次`);
  const headline = headlineParts.length ? `结论：${headlineParts.join('；')}。` : '';

  const sublineParts = [];
  if (meta && meaningful(meta.generated_at)) sublineParts.push(`生成时间：${formatMetaValue('generated_at', meta.generated_at)}`);
  if (meta && meaningful(meta.start) && meaningful(meta.end)) sublineParts.push(`区间：${formatMetaValue('start', meta.start)} → ${formatMetaValue('end', meta.end)}`);
  if (meta && meaningful(meta.files_total)) sublineParts.push(`文件数：${meta.files_total}`);
  const subline = sublineParts.join(' ｜ ');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEscape(title)}</title>
    <style>
      :root {
        --bg: #f6f7fb;
        --card: #ffffff;
        --text: #111827;
        --muted: rgba(17, 24, 39, 0.62);
        --line: rgba(17, 24, 39, 0.12);
        --accent: #2563eb;
        --shadow: 0 10px 24px rgba(17, 24, 39, 0.08);
        --chart-bg: #ffffff;
        --grid: rgba(17, 24, 39, 0.08);
        --axis: rgba(17, 24, 39, 0.28);
        --axisText: rgba(17, 24, 39, 0.55);
        --tickText: rgba(17, 24, 39, 0.55);
        --hover: rgba(37, 99, 235, 0.35);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: radial-gradient(1200px 600px at 20% 0%, #eef2ff 0%, rgba(238,242,255,0) 65%),
                    radial-gradient(1200px 600px at 80% 0%, #ecfeff 0%, rgba(236,254,255,0) 65%),
                    var(--bg);
        color: var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
        line-height: 1.45;
      }

      .wrap { max-width: 1200px; margin: 28px auto; padding: 0 16px 32px; }

      .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
      h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: 0.2px; }
      .sub { color: var(--muted); font-size: 13px; }
      .headline { margin-top: 10px; font-size: 14px; color: rgba(17,24,39,0.82); }
      .badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,0.75); box-shadow: 0 6px 14px rgba(17,24,39,0.06); color: rgba(17,24,39,0.75); font-size: 12px; white-space: nowrap; }
      .badge b { color: rgba(17,24,39,0.9); font-weight: 600; }

      .grid { display: grid; gap: 16px; }
      .grid-2 { grid-template-columns: 1.15fr 0.85fr; }
      @media (max-width: 980px) { .grid-2 { grid-template-columns: 1fr; } }

      .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; box-shadow: var(--shadow); }
      .card + .card { margin-top: 16px; }
      .card-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
      h2 { margin: 0; font-size: 16px; letter-spacing: 0.2px; }
      h3 { margin: 0 0 8px; font-size: 14px; color: rgba(17,24,39,0.86); }

      .hint { color: var(--muted); font-size: 12px; margin: 8px 0 10px; }
      .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 12px 0 0; }
      .kpi-item { background: #f9fafb; border: 1px solid var(--line); border-radius: 14px; padding: 12px; }
      .kpi-k { color: var(--muted); font-size: 12px; }
      .kpi-v { font-size: 16px; margin-top: 6px; font-variant-numeric: tabular-nums; }
      .kpi-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }

      .kv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px 12px; margin: 0; }
      .kv { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: #fbfbfd; }
      .kv-k { margin: 0; font-size: 12px; color: var(--muted); display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
      .kv-k-zh { color: rgba(17,24,39,0.8); }
      .kv-k-en { color: rgba(17,24,39,0.45); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 11px; }
      .kv-v { margin: 6px 0 0; font-size: 13px; color: rgba(17,24,39,0.88); }
      .kv-v.num { font-variant-numeric: tabular-nums; }

      .split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      @media (max-width: 980px) { .split { grid-template-columns: 1fr; } }
      .subcard { border: 1px solid var(--line); border-radius: 14px; padding: 12px; background: #ffffff; box-shadow: 0 6px 16px rgba(17,24,39,0.06); }

      details.card { padding: 0; overflow: hidden; }
      details.card > summary { list-style: none; cursor: pointer; padding: 14px 16px; color: rgba(37, 99, 235, 0.95); font-weight: 600; }
      details.card > summary::-webkit-details-marker { display: none; }
      details.card .details-body { padding: 0 16px 16px; }

      .notes { white-space: pre-wrap; color: rgba(17,24,39,0.68); font-size: 12px; line-height: 1.55; margin: 0; }

      .chart-wrap { position: relative; }
      .chart-tooltip {
        position: absolute;
        z-index: 2;
        min-width: 140px;
        max-width: 260px;
        background: rgba(255,255,255,0.96);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 12px;
        color: rgba(17,24,39,0.92);
        box-shadow: 0 14px 30px rgba(17,24,39,0.12);
        pointer-events: none;
        backdrop-filter: blur(6px);
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header class="page-header">
        <div>
          <h1>${htmlEscape(title)}</h1>
          <div class="sub">${htmlEscape(strategy)}</div>
          ${subline ? `<div class="sub" style="margin-top:6px;">${htmlEscape(subline)}</div>` : ''}
          ${headline ? `<div class="headline">${htmlEscape(headline)}</div>` : ''}
        </div>
        <div class="badge" title="策略口径提示">
          <b>A股</b><span>仅做多</span><span>${htmlEscape(freqLabel)}轮动</span><span>均仓</span>
        </div>
      </header>

      <section class="card">
        <div class="card-title">
          <h2>组合资产曲线</h2>
          <div class="hint" style="margin:0;">鼠标移动到曲线上查看日期与资产</div>
        </div>
        ${equityCurveSvg || '<div class="hint">无组合净值数据（可能没有任何成交）。</div>'}
        ${kpiHtml}
      </section>

      <div class="grid grid-2" style="margin-top:16px;">
        <section class="card">
          <div class="card-title"><h2>策略总结</h2><div class="hint" style="margin:0;">只看这张卡就够了：胜率/回撤/交易次数等核心指标</div></div>
          ${renderKvGrid(summaryItems)}
        </section>

        <section class="card">
          <div class="card-title"><h2>金额明细</h2><div class="hint" style="margin:0;">把“最大回撤率/最高净值”对应的金额拆出来</div></div>
          <div class="split" style="margin-top:10px;">
            <div class="subcard">
              <h3>最大回撤</h3>
              ${renderKvGrid(moneyDrawdownItems)}
            </div>
            <div class="subcard">
              <h3>最高净值</h3>
              ${renderKvGrid(moneyPeakItems)}
            </div>
          </div>
        </section>
      </div>

      <details class="card" style="margin-top:16px;">
        <summary>运行信息</summary>
        <div class="details-body">
          ${renderKvGrid(metaItems)}
        </div>
      </details>

      <section class="card">
        <div class="card-title"><h2>口径说明</h2><div class="hint" style="margin:0;">避免误解：你看到的收益/胜率/回撤具体怎么算</div></div>
        <pre class="notes">${htmlEscape(notes)}</pre>
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

  if (args.mode !== 'backtest') {
    throw new Error(`已移除统计(stats)报告逻辑；当前仅支持 --mode=backtest（收到：${args.mode}）`);
  }

  {
    if (args.strategy !== 'file') {
      throw new Error(`当前仅支持 --strategy=file；收到：${args.strategy}`);
    }
    const freq = String(args.freq || '').toUpperCase();
    if (!['D', 'W', 'M', 'Q'].includes(freq)) {
      throw new Error(`--freq 仅支持 D/W/M/Q；收到：${args.freq}`);
    }

    const maPeriods = String(args.ma || '5,10,20')
      .split(',')
      .map((s) => Number(String(s).trim()))
      .filter((x) => Number.isFinite(x) && x > 0)
      .slice(0, 3);
    if (maPeriods.length !== 3) {
      throw new Error(`--ma 解析失败，示例：--ma=5,10,20；收到：${args.ma}`);
    }

    const seriesList = [];
    const seriesByFile = new Map();

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
      for (const col of ['股票名称', '交易日期', '收盘价_复权']) {
        if (!(col in records[0])) {
          throw new Error(`文件 ${f} 缺少必要列：${col}（encoding=${args.encoding}；若列名乱码，尝试 --encoding=auto 或 --encoding=utf8）`);
        }
      }

      const n = records.length;
      const dates = new Array(n);
      const closeAdj = new Array(n);
      const openAdj = new Array(n);
      const highAdj = new Array(n);
      const lowAdj = new Array(n);
      const volume = new Array(n);
      const amount = new Array(n);
      const marketCapFloat = new Array(n);
      const marketCapTotal = new Array(n);
      const changePct = new Array(n);

      for (let i = 0; i < n; i += 1) {
        const r = records[i];
        dates[i] = parseYmdInt(r['交易日期']);
        closeAdj[i] = parseNumber(r['收盘价_复权']);
        openAdj[i] = parseNumber(r['开盘价_复权']);
        highAdj[i] = parseNumber(r['最高价_复权']);
        lowAdj[i] = parseNumber(r['最低价_复权']);
        volume[i] = parseNumber(r['成交量']);
        amount[i] = parseNumber(r['成交额']);
        marketCapFloat[i] = parseNumber(r['流通市值']);
        marketCapTotal[i] = parseNumber(r['总市值']);
        changePct[i] = parseNumber(r['涨跌幅']);
      }

      const stockCode = String(records[0]['股票代码'] || '');
      const stockName = String(records[0]['股票名称'] || '');
      const s = {
        file: f,
        stockCode,
        stockName,
        datesYmd: dates,
        closeAdj,
        openAdj,
        highAdj,
        lowAdj,
        volume,
        amount,
        marketCapFloat,
        marketCapTotal,
        changePct,
      };
      seriesList.push(s);
      seriesByFile.set(f, s);
    }

    if (!args.quiet) process.stdout.write('\n');

    // 构建全市场交易日（按数据出现的日期去重）
    const dateSet = new Set();
    for (const s of seriesList) {
      for (const ymd of s.datesYmd) {
        if (!Number.isFinite(ymd) || ymd < startYmd || ymd > endYmd) continue;
        dateSet.add(ymd);
      }
    }
    const marketDates = Array.from(dateSet).sort((a, b) => a - b);

    const periodPlans = buildPeriodPlans(marketDates, freq);
    const marketIndex = new Map();
    for (let i = 0; i < marketDates.length; i += 1) marketIndex.set(marketDates[i], i);

    const strategyPath = path.isAbsolute(args.strategyFile)
      ? args.strategyFile
      : path.join(projectRoot, args.strategyFile || DEFAULT_STRATEGY_FILE);
    if (!fs.existsSync(strategyPath)) {
      throw new Error(`找不到策略文件：${strategyPath}（默认读取 ${DEFAULT_STRATEGY_FILE}；可用 --strategy-file=PATH 指定）`);
    }

    let loaded;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      loaded = require(strategyPath);
    } catch (e) {
      throw new Error(`加载策略失败：${strategyPath}\n${e && e.stack ? e.stack : String(e)}`);
    }

    const strategyFn = typeof loaded === 'function' ? loaded : (loaded && loaded.strategy);
    if (typeof strategyFn !== 'function') {
      throw new Error(`策略文件必须导出名为 strategy 的函数：module.exports = { strategy }\n收到：${typeof loaded}`);
    }

    const validFiles = new Set(seriesList.map((s) => s.file));
    const cache = new Map();
    const strategyParams = {
      maPeriods,
      excludeSt: args.excludeSt,
      pickLimit: args.pickLimit,
    };

    let picksTotal = 0;

    for (const p of periodPlans) {
      const buyIdx = marketIndex.get(p.buyYmd);
      const asOfYmd = (buyIdx !== undefined && buyIdx > 0) ? marketDates[buyIdx - 1] : null;
      const ctx = {
        freq,
        periodStartYmd: p.buyYmd,
        periodEndYmd: p.sellYmd,
        buyYmd: p.buyYmd,
        sellYmd: p.sellYmd,
        asOfYmd,
        universe: seriesList,
        params: strategyParams,
        ind: indicators,
        cache,
        util: { upperBound, indexOfDate },
      };

      let out;
      try {
        out = strategyFn(ctx);
      } catch (e) {
        throw new Error(`策略执行失败：periodKey=${p.periodKey}, buy=${p.buyYmd}, sell=${p.sellYmd}\n${e && e.stack ? e.stack : String(e)}`);
      }

      let picks = [];
      if (Array.isArray(out)) picks = out;
      else if (out && Array.isArray(out.picks)) picks = out.picks;
      else {
        throw new Error(`策略返回值不合法：必须返回数组，或返回 { picks: [] }。\nperiodKey=${p.periodKey}`);
      }

      picks = picks
        .map((x) => String(x).trim())
        .filter(Boolean)
        .filter((file) => validFiles.has(file));

      if (args.pickLimit && picks.length > args.pickLimit) picks = picks.slice(0, args.pickLimit);
      p.picks = picks;
      picksTotal += picks.length;
    }

    const portfolio = simulatePortfolioPeriodicIdeal(
      { seriesByFile, marketDatesAsc: marketDates, periodPlans },
      {
        startYmd,
        endYmd,
        initialCapital: args.capital,
        feeBps: args.feeBps,
        stampBps: args.stampBps,
      },
    );

    const periodAgg = new Map(); // periodKey -> { trades, pnl }
    for (const t of portfolio.trades) {
      const key = String(t.periodKey || '');
      if (!periodAgg.has(key)) periodAgg.set(key, { trades: 0, pnl: 0 });
      const a = periodAgg.get(key);
      a.trades += 1;
      if (Number.isFinite(t.pnl)) a.pnl += t.pnl;
    }

    const periodsTotal = periodPlans.length;
    const periodsTraded = Array.from(periodAgg.values()).filter((a) => a.trades > 0).length;
    const periodWinPeriods = Array.from(periodAgg.values()).filter((a) => a.trades > 0 && a.pnl > 0).length;
    const periodWinRate = periodsTraded ? periodWinPeriods / periodsTraded : Number.NaN;
    const picksAvgPerPeriod = periodsTotal ? picksTotal / periodsTotal : Number.NaN;

    const curve = Array.isArray(portfolio.equityCurve) ? portfolio.equityCurve : [];
    const dd = computeMaxDrawdown(curve);

    let maxEquity = Number.NEGATIVE_INFINITY;
    let maxEquityDate = null;
    let minEquity = Number.POSITIVE_INFINITY;
    let minEquityDate = null;
    for (const p of curve) {
      if (!p || !Number.isFinite(p.equity)) continue;
      if (p.equity > maxEquity) {
        maxEquity = p.equity;
        maxEquityDate = p.date;
      }
      if (p.equity < minEquity) {
        minEquity = p.equity;
        minEquityDate = p.date;
      }
    }

    const initialCapital = args.capital;
    const finalEquity = portfolio.finalEquity;
    const totalPnl = Number.isFinite(finalEquity) ? (finalEquity - initialCapital) : Number.NaN;
    const maxReturn = Number.isFinite(maxEquity) && Number.isFinite(initialCapital) && initialCapital > 0
      ? (maxEquity / initialCapital - 1)
      : Number.NaN;
    const maxPnl = Number.isFinite(maxEquity) ? (maxEquity - initialCapital) : Number.NaN;

    const now = new Date();
    const ts = timestampBeijingYmdHmsUnderscore(now);
    const reportName = `量化分析结果+${ts}.html`;
    const reportPath = path.join(projectRoot, reportName);

    const equityCurveSvg = curve.length ? renderEquityCurveSvg(curve, { initialCapital: initialCapital }) : '';

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const notes = [
      `- 回测流程：按 freq=${freq} 切分自然周期；周期首个交易日买入（收盘复权价成交），周期最后一个交易日卖出（收盘复权价成交）；仅做多。`,
      `- 信号口径：策略只能使用 asOfYmd（买入日前一交易日）及更早的数据生成信号，避免未来函数。`,
      `- 策略来源：从策略文件加载 strategy(ctx) 决定每个周期要买哪些股票（用 file 作为主键）。`,
      `- 缺价处理：若某票在买入日或卖出日缺少收盘复权价（NaN/<=0/不存在该日记录），该票本周期整期跳过（不建仓）。`,
      `- 理想化成交：不考虑涨跌停/停牌导致的成交失败；不限制整手/最小成交单位（可无限可分）。`,
      `- 示例参数：ma=${maPeriods.join(',')}；exclude_st=${args.excludeSt ? '1' : '0'}；pick_limit=${args.pickLimit || '不限'}。`,
      `- 费用：fee_bps=${args.feeBps}；印花税（卖出）：stamp_bps=${args.stampBps}。`,
    ].join('\n');

    const html = renderBacktestReportHtml({
      title: `量化分析结果+${ts}`,
      meta: {
        generated_at: formatBeijingGeneratedAt(now),
        elapsed_seconds: String(elapsedSec),
        data_dir: dataDir,
        files_total: String(seriesList.length),
        encoding: String(args.encoding),
        mode: 'backtest',
        start: args.start,
        end: args.end,
        capital: String(args.capital),
        fee_bps: String(args.feeBps),
        stamp_bps: String(args.stampBps),
        strategy: String(args.strategy),
        strategy_file: strategyPath,
        freq: freq,
        ma: String(args.ma),
        exclude_st: String(args.excludeSt),
        pick_limit: args.pickLimit === null ? '' : String(args.pickLimit),
      },
      strategy: '周期轮动：周期开始买入、周期结束卖出；选股逻辑来自 strategy.js；仅做多（理想化成交）。',
      overview: [
        { k: '初始资金', v: `${formatMoney(initialCapital)} 元` },
        {
          k: '最终资金',
          v: Number.isFinite(finalEquity) ? `${formatMoney(finalEquity)} 元` : 'NaN',
          sub: Number.isFinite(portfolio.totalReturn) && Number.isFinite(totalPnl)
            ? `总收益：${totalPnl >= 0 ? '+' : ''}${formatMoney(totalPnl)} 元（${(portfolio.totalReturn * 100).toFixed(2)}%）`
            : '',
        },
        {
          k: '最大回撤',
          v: Number.isFinite(dd.maxDrawdown)
            ? `${(dd.maxDrawdown * 100).toFixed(2)}%`
            : (Number.isFinite(portfolio.maxDrawdown) ? `${(portfolio.maxDrawdown * 100).toFixed(2)}%` : 'NaN'),
          sub: dd.maxDrawdownPeakDate && dd.maxDrawdownTroughDate
            ? `回撤区间：${formatYmd(String(dd.maxDrawdownPeakDate))} → ${formatYmd(String(dd.maxDrawdownTroughDate))}`
            : '',
        },
        {
          k: '最高净值 / 最大收益',
          v: Number.isFinite(maxReturn) ? `${(maxReturn * 100).toFixed(2)}%` : 'NaN',
          sub: maxEquityDate ? `发生日期：${formatYmd(String(maxEquityDate))}` : '',
        },
        {
          k: '胜率 / 交易次数',
          v: portfolio.trades.length > 0 && Number.isFinite(portfolio.winRate) ? `${(portfolio.winRate * 100).toFixed(2)}%` : (portfolio.trades.length > 0 ? 'NaN' : '无交易'),
          sub: `交易次数：${portfolio.trades.length}；周期胜率：${Number.isFinite(periodWinRate) ? (periodWinRate * 100).toFixed(2) + '%' : 'NaN'}`,
        },
      ],
      amounts: {
        maxDrawdownAmount: dd.maxDrawdownAmount,
        maxDrawdownPeakEquity: dd.maxDrawdownPeakEquity,
        maxDrawdownPeakDate: dd.maxDrawdownPeakDate,
        maxDrawdownTroughEquity: dd.maxDrawdownTroughEquity,
        maxDrawdownTroughDate: dd.maxDrawdownTroughDate,
        maxEquity,
        maxEquityDate,
        maxReturn,
        maxPnl,
      },
      summary: {
        files: String(seriesList.length),
        portfolio_final_equity: Number.isFinite(portfolio.finalEquity) ? formatMoney(portfolio.finalEquity) : 'NaN',
        portfolio_total_return: Number.isFinite(portfolio.totalReturn) ? (portfolio.totalReturn * 100).toFixed(2) + '%' : 'NaN',
        portfolio_max_dd: Number.isFinite(portfolio.maxDrawdown) ? (portfolio.maxDrawdown * 100).toFixed(2) + '%' : 'NaN',
        portfolio_trades: String(portfolio.trades.length),
        portfolio_win_rate: Number.isFinite(portfolio.winRate) ? (portfolio.winRate * 100).toFixed(2) + '%' : 'NaN',
        periods_total: String(periodsTotal),
        periods_traded: String(periodsTraded),
        picks_total: String(picksTotal),
        picks_avg_per_period: Number.isFinite(picksAvgPerPeriod) ? picksAvgPerPeriod.toFixed(2) : 'NaN',
        period_win_rate: Number.isFinite(periodWinRate) ? (periodWinRate * 100).toFixed(2) + '%' : 'NaN',
      },
      equityCurveSvg: equityCurveSvg || null,
      notes,
    });

    fs.writeFileSync(reportPath, html, 'utf8');
    console.log(`已生成报告：${reportPath}`);
    return;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  }
}
