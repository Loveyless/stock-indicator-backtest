# stock-indicator-backtest-node

Node.js 版本：遍历股票 CSV 数据，计算技术指标信号，并统计未来 N 日涨跌幅分布/概率。

本项目支持两种输出：

- `--mode=stats`：**信号出现时点**的条件统计报告（describe + 命中率）
- `--mode=backtest`：默认策略（ER，长仓）做“组合回测”，输出组合资金曲线与最大回撤等结论

## Quick Start

1) 安装依赖：

`npm i`

2) 运行（默认读取 `stock/*.csv`）：

`npm start`

运行时会显示处理进度；结束后会在项目根目录生成报告：`量化分析结果+YYYY_MM_DD_HH_mm_ss.html`（北京时间）。

3) 回测（默认策略 ER，长仓）：

`npm run backtest -- --files=sz000001.csv --start=20070101 --end=20220930 --quiet`

## Parameters

推荐直接用 node 运行以传参：

`node src/main.js --limit=50 --quiet`

支持参数（见 `src/main.js` 顶部注释）：

- `--mode=stats|backtest`（默认 stats）
- `--data-dir=PATH`（数据目录，默认 `./stock`）
- `--data-version=STRING`（可选：写进报告 Run Meta，方便复现）
- `--start=YYYYMMDD` / `--end=YYYYMMDD`
- `--days=1,2,3,5,10,20`
- `--files=sz000001.csv,sh600000.csv`
- `--limit=10`
- `--quiet`（不显示进度，仅输出报告路径）
- `--encoding=gbk|utf8|auto`（默认 gbk；auto 仅做 BOM 级别识别后回退 gbk）
- `--safe-rsv`
- `--exact-quantiles`

回测模式（`--mode=backtest`）额外参数：

- `--capital=1000000`（初始资金，默认 100 万）
- `--execution=close|next_close`（默认 next_close）
- `--lot=100`（整手）
- `--fee-bps=0`（双边佣金，单位：bp）
- `--stamp-bps=0`（卖出印花税，单位：bp）
- `--er-span=20`（ER 指标 EMA span）

## Data

- 数据目录：`stock/`
- CSV 默认按 `GBK` 解码（可用 `--encoding` 指定），必须包含列：`交易日期`、`最低价_复权`、`最高价_复权`、`收盘价_复权`
- 为了避免把大量数据误提交进 git，`stock/` 已在 `.gitignore` 里默认忽略
- 全量数据建议通过 GitHub Release 附件分发：见 `docs/data.md`；可用 `scripts/fetch_data.ps1` 一键下载/校验/解压

## Notes

- 默认分位数是“近似值”（常量内存，更稳）；需要“精确分位数”则加 `--exact-quantiles`（更慢、更吃内存）
- `--mode=backtest` 是“长仓回测”（默认策略 ER）。同日多票入场会对“当日新增入场票”按现金平均分仓（不会对存量持仓做再平衡）。

## Docs

- 端到端流程：`docs/workflow.md`
- 数据契约与约束：`docs/data-contract.md`
- 数据下载与校验：`docs/data.md`
- 报告字段说明：`docs/report.md`
- 指标参考（来源资料）：`docs/references/`
