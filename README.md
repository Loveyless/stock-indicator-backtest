[中文](./README.md) | [English](./README.en.md)

<p align="center">
  <img src="./logo.svg" width="96" alt="Logo" />
</p>
<h2 align="center">股票量化助手</h2>
<h1 align="center">stock-indicator-backtest</h1>
<p align="center">
  A 股周期轮动回测工具：写或修改 <code>strategy.js</code>，按日/周/月/季执行“周期开始买入、周期结束卖出”，输出可视化报告。
</p>

## 先看结论

- 你不会写策略也能跑：根目录 `strategy.js` 已内置示例策略。
- 默认只做一件事：回测并生成 `量化分析结果+YYYY_MM_DD_HH_mm_ss.html`（北京时间）。
- 当前是理想化成交口径：不模拟涨跌停/停牌成交失败，不限制整手，结果更适合做策略对比而非实盘收益承诺。

## 报告预览

<p align="center">
  <img src="./preview.png" alt="量化报告预览" width="640" style="width:66%;max-width:640px;height:auto;" />
</p>

## 3 分钟跑通（新手版）

1) 准备数据：下载并解压数据到项目根目录 `stock/`
Release（0.1.0）：https://github.com/Loveyless/stock-indicator-backtest/releases/tag/0.1.0

2) 安装依赖：

`pnpm i`（或 `npm i`）

3) 运行回测：

`pnpm start`（或 `npm start`）

4) 成功标准（必须看到）：

- 终端输出 `已生成报告：...`
- 项目根目录出现 `量化分析结果+YYYY_MM_DD_HH_mm_ss.html`

## 目录结构（避免放错数据）

```text
stock-indicator-backtest-node/
├─ stock/                      # 你的股票 CSV 数据目录
├─ strategy.js                 # 示例策略（可直接改）
├─ src/main.js                 # 入口
├─ STRATEGY.md                 # 策略文档总入口
├─ STRATEGY_API.md             # strategy(ctx) 入参/返回值/回测口径
└─ STRATEGY_INDICATORS.md      # 指标函数与口径
```

## 常用命令

- 快速回测（已内置）：`pnpm run backtest:quick`
- 指定时间范围：`pnpm start -- --start=20211115 --end=20241231 --quiet`
- 改交易频率：`pnpm start -- --freq=D`（D 日频隔夜） / `--freq=W|M|Q`
- 限制样本数量：`pnpm start -- --limit=100 --quiet`
- 指定策略文件：`pnpm start -- --strategy-file=./my_strategy.js --quiet`
- 传策略参数 JSON：`pnpm start -- --strategy-params='{"minAmount":80000000}' --quiet`

## 策略怎么改

- 默认策略文件是根目录 `strategy.js`，仅作为示例，你可以直接改。
- 策略函数必须导出 `strategy(ctx)`，返回本周期要买的股票文件名（如 `sh600000.csv`）。
- 信号日必须使用 `ctx.asOfYmd`（买入日前一交易日），否则会引入未来函数。

详细规则请看：

- `STRATEGY.md`
- `STRATEGY_API.md`
- `STRATEGY_INDICATORS.md`

## 关键口径（先统一认知）

- 仅做多，周期开始买入、周期结束卖出（`--freq=D|W|M|Q`）。
- 缺价股票会整期跳过：买入日或卖出日无有效 `收盘价_复权` 时不建仓。
- 费用默认 0，可通过 `--fee-bps`、`--stamp-bps` 开启。

## 常见问题（普通用户最容易卡住）

- 报错“找不到数据目录”：确认存在 `stock/` 且里面有 `*.csv`。
- 报错“缺少必要列”：至少要有 `股票名称`、`交易日期`、`收盘价_复权`。
- 列名乱码：尝试 `--encoding=auto` 或 `--encoding=utf8`。
- 没有成交：检查策略是否返回了正确的文件名（不是股票代码）。
- 结果太少：先用 `--limit` 去掉，再扩大 `--start/--end` 区间。

## 更多文档

- 端到端流程：`docs/workflow.md`
- 数据契约：`docs/data-contract.md`
- 数据下载与校验：`docs/data.md`
- 报告字段说明：`docs/report.md`
