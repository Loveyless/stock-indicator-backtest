# stock-indicator-backtest-node

Node.js 版本：A 股“周期轮动”策略回测（周期首个交易日买入、周期最后一个交易日卖出），输出组合资金曲线/回撤/胜率等。

本项目只保留回测输出（已移除统计(stats)报告逻辑）。

## Quick Start

1) 安装依赖：

`npm i`（或 `pnpm i`）

2) 运行（默认读取 `stock/*.csv`）：

`npm start`（或 `pnpm start`）

运行时会显示处理进度；结束后会在项目根目录生成报告：`量化分析结果+YYYY_MM_DD_HH_mm_ss.html`（北京时间）。

3) 回测（默认从根目录 `strategy.js` 读取策略；周频示例策略为 MA 多头排列）：

`npm run backtest -- --files=sz000001.csv --start=20070101 --end=20220930 --quiet --freq=W --ma=5,10,20 --exclude-st=1`

## 写策略（strategy.js）

本项目的策略是一个本地 JS 文件：根目录 `strategy.js`，必须导出 `strategy(ctx)`，并返回本周期要买的股票列表：

- 主键已定死：返回 **CSV 文件名**（例如 `sh600000.csv`），不是股票代码。
- 防未来函数：策略应使用 `ctx.asOfYmd`（买入日前一交易日）及更早的数据做信号。

最推荐的入门方式：

1) 直接打开根目录的 `strategy.js`（示例：MA 多头排列）修改。
2) 需要看接口/字段/口径：先读 `STRATEGY.md` → `STRATEGY_API.md`。

也可以指定别的策略文件：

`pnpm start -- --strategy-file=./my_strategy.js --freq=W --start=20211115 --end=20211231 --quiet`

## 示例命令

- 日频（隔夜）：`pnpm start -- --freq=D --start=20211115 --end=20211130 --limit=50 --quiet`
- 月频：`pnpm start -- --freq=M --start=20190101 --end=20241231 --limit=200 --quiet`
- 限制每周期最多选 N 只：`pnpm start -- --pick-limit=10 --quiet`

## Parameters

推荐直接用 node 运行以传参：

`node src/main.js --limit=50 --quiet`

支持参数（见 `src/main.js` 顶部注释）：

- `--mode=backtest`（默认 backtest）
- `--data-dir=PATH`（数据目录，默认 `./stock`）
- `--start=YYYYMMDD` / `--end=YYYYMMDD`
- `--files=sz000001.csv,sh600000.csv`
- `--limit=10`
- `--quiet`（不显示进度，仅输出报告路径）
- `--encoding=gbk|utf8|auto`（默认 gbk；auto 仅做 BOM 级别识别后回退 gbk）

回测模式（`--mode=backtest`）额外参数：

- `--capital=1000000`（初始资金，默认 100 万）
- `--fee-bps=0`（双边佣金，单位：bp）
- `--stamp-bps=0`（卖出印花税，单位：bp）
- `--freq=D|W|M|Q`（交易频率：日/周/月/季；日频为隔夜：买入日→下一交易日卖出；默认 W）
- `--strategy=file`（默认 file：从文件加载策略）
- `--strategy-file=strategy.js`（默认；策略必须导出名为 `strategy` 的函数）
- `--ma=5,10,20`（多头排列：MA 快>中>慢；基于复权收盘价 `收盘价_复权`）
- `--exclude-st=1|0`（是否排除 ST，默认 1；判断来自 `股票名称` 含 `ST/*ST`）
- `--pick-limit=NUMBER`（可选：每周期最多选 N 只；不填则全买）

兼容旧参数（当前理想化成交版本不使用）：

- `--lot=100`（整手/最小成交单位；当前不限制整手，可无限可分）

## Data

- 数据目录：`stock/`
- CSV 默认按 `GBK` 解码（可用 `--encoding` 指定）
  - 必须列：`股票名称`、`交易日期`、`收盘价_复权`
- 为了避免把大量数据误提交进 git，`stock/` 已在 `.gitignore` 里默认忽略
- 全量数据建议通过 GitHub Release 附件分发：见 `docs/data.md`（手动下载/校验/解压）

## Notes

- `--mode=backtest` 是“周期轮动长仓回测”：按 `freq` 切周期→每期选股→均仓买入→期末全卖→循环往复。
- 当前撮合口径是“理想化成交”（先把策略跑通）：不限制整手/最小成交单位、不模拟涨跌停/停牌导致的成交失败；缺价标的会整期跳过。详见 `STRATEGY_API.md`。

## Docs

- 端到端流程：`docs/workflow.md`
- 数据契约与约束：`docs/data-contract.md`
- 数据下载与校验：`docs/data.md`
- 报告字段说明：`docs/report.md`
- STRATEGY 总入口：`STRATEGY.md`
- STRATEGY 指标编写与校验：`STRATEGY_INDICATORS.md`
- STRATEGY 策略函数接口：`STRATEGY_API.md`
- 指标参考（来源资料）：`docs/references/`
