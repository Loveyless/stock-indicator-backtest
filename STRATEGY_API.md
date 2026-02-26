# STRATEGY：策略插件接口（strategy.js）

本项目的回测引擎负责：读数据、切周期、撮合成交、资金曲线/回撤/报告。

策略作者只需要写一个文件：`strategy.js`，导出 `strategy(ctx)`，返回“本周期要买哪些股票”。

> 注意：策略文件是本地 JS 代码，会在你的机器上执行，等同于“运行任意代码”。不要跑不可信的策略文件。

## 1) 文件放哪

默认读取项目根目录的 `strategy.js`。

也可以运行时指定：

`node src/main.js --strategy-file=PATH_TO_STRATEGY_JS ...`

## 2) 必须导出的函数

`strategy.js` 必须导出名为 `strategy` 的函数（CommonJS）：

```js
module.exports = { strategy };
```

引擎会调用 `strategy(ctx)`，并接受两种返回值：

- 直接返回数组：`['sh600000.csv', 'sz000001.csv']`
- 或返回对象：`{ picks: ['sh600000.csv', ...] }`

### 主键口径（已定死）

`picks` 里放的是 **CSV 文件名**（例如 `sh600000.csv`），这是策略与引擎关联标的的唯一标识。

## 3) ctx 入参说明

`ctx` 由引擎构造，字段如下（会逐步扩展，但会保持向后兼容）：

- `ctx.freq`：`'D'|'W'|'M'|'Q'`（日/周/月/季）
- `ctx.buyYmd` / `ctx.sellYmd`：本周期买入日/卖出日（交易日，`YYYYMMDD` 数字）
- `ctx.asOfYmd`：**信号截止日**（= `buyYmd` 的上一交易日；策略只能用这一天及更早的数据做判断）
- `ctx.universe`：股票数组，每个元素至少包含：
  - `file`：如 `sh600000.csv`
  - `stockCode`：股票代码（如果 CSV 有）
  - `stockName`：股票名称（可用于 ST 过滤）
  - `datesYmd`：交易日期数组（升序）
  - `closeAdj/openAdj/highAdj/lowAdj`：复权价数组（与 dates 对齐；列不存在时为 `NaN`）
  - `volume/amount/marketCapFloat/marketCapTotal/changePct`：成交/市值/涨跌幅（列不存在时为 `NaN`）
- `ctx.params`：引擎透传的参数（示例策略会用到）：
  - `maPeriods`：如 `[5,10,20]`
  - `excludeSt`：是否排除 ST
  - `pickLimit`：每周期选股上限（引擎也会再截断一次）
- `ctx.ind`：指标工具库（实现见 `src/indicators.js`，口径说明见 `STRATEGY_INDICATORS.md`）
- `ctx.cache`：`Map`，跨周期缓存（建议把 MA/EMA 等数组缓存下来，避免重复计算）
- `ctx.util`：工具函数（实现见 `src/seriesUtils.js`）
  - `indexOfDate(datesYmd, ymd)`：精确日期查找（存在则返回 index，否则 -1）
  - `upperBound(sortedAsc, x)`：二分上界

## 4) 回测撮合口径（策略写法必须对齐）

引擎当前是“理想化成交”版本（用于先跑通策略逻辑）：

- 周期首个交易日按 `收盘价_复权` 买入，周期最后一个交易日按 `收盘价_复权` 卖出（仅做多）
- 不考虑涨跌停/停牌导致的买不进卖不出
- 不限制整手/最小成交单位（可无限可分）
- 缺价处理：若某票在买入日或卖出日缺少复权收盘价（NaN/<=0/不存在该日记录），该票本周期**整期跳过**（不建仓）

## 5) 示例策略

项目根目录自带一个示例：`strategy.js`（多头排列 MA，按 `asOfYmd` 计算信号）。

你可以直接改它来写自己的策略。

## 6) 最小可运行模板（推荐直接复制改）

下面这份模板刻意写得“土”，但不容易写错（尤其是 `asOfYmd` 与 index 的取法）：

```js
function strategy(ctx) {
  // 第一天没有 asOfYmd（买入日前一交易日），直接不交易，避免未来函数
  if (!ctx.asOfYmd) return { picks: [] };

  const out = [];
  for (const s of ctx.universe || []) {
    // 1) 取信号日对应的 index（必须用 asOfYmd，不要用 buyYmd）
    const idx = ctx.util.indexOfDate(s.datesYmd, ctx.asOfYmd);
    if (idx < 0) continue;

    // 2) 例：用复权收盘价做 MA
    const ma5 = ctx.ind.MA(s.closeAdj, 5);
    const ma10 = ctx.ind.MA(s.closeAdj, 10);
    const ma20 = ctx.ind.MA(s.closeAdj, 20);

    const f = ma5[idx], m = ma10[idx], l = ma20[idx];
    if (!(Number.isFinite(f) && Number.isFinite(m) && Number.isFinite(l))) continue;

    // 3) 例：多头排列
    if (f > m && m > l) out.push(s.file);
  }

  return { picks: out };
}

module.exports = { strategy };
```

> 性能提示：如果你在循环里反复算 `MA/EMA`，会很慢。建议用 `ctx.cache` 按 `file+参数` 缓存整列指标数组（见根目录 `strategy.js` 的写法）。

## 7) universe 字段“哪些一定有、哪些可能全是 NaN”

引擎会给策略提供这些字段，但含义不同：

- 一定存在且通常有值：
  - `s.file`（策略主键）
  - `s.stockName`
  - `s.datesYmd`（升序）
  - `s.closeAdj`（来自 `收盘价_复权`；缺失/异常会是 `NaN`）
- 字段一定存在，但如果 CSV 没有该列，整列会是 `NaN`（用前请 `Number.isFinite` 判断）：
  - `openAdj/highAdj/lowAdj`
  - `volume/amount/marketCapFloat/marketCapTotal/changePct`

## 8) 常见错误（外人最容易写崩的地方）

1) **用 `buyYmd` 做信号**  
你会不自觉地写“买入日看指标决定买入”，这是未来函数。必须用 `asOfYmd`（买入日前一交易日）。

2) **`picks` 返回了股票代码而不是文件名**  
本项目策略主键已定死为 `file`（如 `sh600000.csv`），返回 `600000` 会导致引擎匹配不到数据。

3) **没做 NaN 判断**  
滚动指标在窗口不足/遇到缺失值时会产生 `NaN`。不判断就会把 `NaN` 当成 0/false，信号乱飞。

4) **自己在策略里“撮合成交/扣费/整手”**  
这些由引擎统一做。策略只负责“选哪些票”（可选加排序/权重），否则回测口径会分裂，结果不可复现。

5) **CSV 日期不升序**  
`REF/MA/EMA` 都依赖行序。数据必须按 `交易日期` 升序（见 `docs/data-contract.md`）。否则你写再牛的策略也没意义。
