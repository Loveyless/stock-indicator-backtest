# Report

脚本结束后会在项目根目录生成报告文件（不同 `mode` 的报告结构不同）：

- 文件名：`量化分析结果+YYYY_MM_DD_HH_mm_ss.html`（北京时间）
- 内容：自包含 HTML，双击即可在浏览器打开

## Run Meta

`Run Meta` 记录本次运行的关键信息（用于复现）：

- `generated_at`：生成时间
- `elapsed_seconds`：总耗时
- `data_dir`：数据目录（应为 `...\\stock`）
- `files_total`：本次参与统计的文件数（应用 `--files/--limit` 后的数量）
- `data_version`：可选数据版本标识（如果传了 `--data-version`）
- `mode`：`stats` 或 `backtest`
- `start/end`：时间过滤区间（包含边界）
- `stats` 模式额外字段：`day_list`、`safe_rsv`、`exact_quantiles`
- `backtest` 模式额外字段：`capital`、`execution`、`lot`、`fee_bps`、`stamp_bps`、`er_span`

## stats 模式：看跌/看涨分组

每个分组对应 `signal`：

- 看跌：`signal=0`（死叉）
- 看涨：`signal=1`（金叉）

分组里有两张表：

### describe

按列（`N日后涨跌幅`）输出描述统计：

- `count`：该列有效收益样本数（只统计非 NaN）
- `mean/std/min/max`：均值/样本标准差/最小/最大
- `25%/50%/75%`：分位数

注意：如果未开启 `--exact-quantiles`，分位数是近似值（P² 流式估计）。

### hit rate

命中率统计表字段：

- `hit_count`：命中次数
- `signal_rows`：该分组样本点总行数（分母）
- `hit_rate = hit_count / signal_rows`
- `valid_return_rows`：该天数下可计算收益的样本数（等价 `describe.count`）

分母口径说明：

- `signal_rows` 包含“未来 N 日收益无法计算（NaN）”的样本点；
- 这是为了与原 Python 版的概率口径保持一致，因此 `hit_rate` 与 `valid_return_rows/signal_rows` 之间可能存在差异。

## backtest 模式：组合回测报告

backtest 报告的目标是“结论优先”，核心是 Strategy Summary 与组合资金曲线。

### Strategy Summary

常见字段含义：

- `portfolio_final_equity`：组合期末资金
- `portfolio_total_return`：组合区间总收益率
- `portfolio_max_dd`：组合区间最大回撤
- `portfolio_trades`：组合交易次数
- `portfolio_win_rate`：组合胜率（按每笔交易 `pnl>0` 计胜）

### Per File

逐文件（逐股票）汇总表字段：

- `trades`：该文件交易次数
- `win_rate`：该文件胜率
- `total_return`：该文件总收益率（按该文件独立用同一初始资金回测）
- `max_dd`：该文件最大回撤
- `final_equity`：该文件期末资金

