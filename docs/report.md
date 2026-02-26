# Report

脚本结束后会在项目根目录生成报告文件：

- 文件名：`量化分析结果+YYYY_MM_DD_HH_mm_ss.html`（北京时间）
- 内容：自包含 HTML，双击即可在浏览器打开

## Run Meta

`Run Meta` 记录本次运行的关键信息（用于复现）：

- `generated_at`：生成时间
- `elapsed_seconds`：总耗时
- `data_dir`：数据目录（应为 `...\\stock`）
- `files_total`：本次参与统计的文件数（应用 `--files/--limit` 后的数量）
- `mode`：`backtest`
- `start/end`：时间过滤区间（包含边界）
- `backtest` 模式额外字段：`capital`、`fee_bps`、`stamp_bps`、`freq`、`strategy`、`strategy_file`、`ma`、`exclude_st`、`pick_limit`

## backtest 模式：组合回测报告

backtest 报告的目标是“结论优先”，核心是 Strategy Summary 与组合资金曲线。

### 组合资产曲线

报告最上方的“组合资产曲线”卡片是你最应该先看的部分：

- 关键 KPI：初始资金、最终资金、总收益（元/百分比）、最大回撤（百分比）、最大收益率（百分比）
- 组合资金曲线：支持鼠标悬停 tooltip（日期 + 当前资产 + 收益%）

### Strategy Summary

常见字段含义：

- `portfolio_final_equity`：组合期末资金
- `portfolio_total_return`：组合区间总收益率
- `portfolio_max_dd`：组合区间最大回撤
- `portfolio_trades`：组合交易次数
- `portfolio_win_rate`：组合胜率（按每笔交易 `pnl>0` 计胜）
- `periods_total`：区间内周期数（按 `freq` 切分得到）
- `periods_traded`：发生过交易的周期数（该周期有成交）
- `picks_total`：累计选中股票数（每周期选中数量求和）
- `picks_avg_per_period`：平均每周期选股数（`picks_total/periods_total`）
- `period_win_rate`：周期胜率（按“周期”计胜：该周期 `pnl>0` 记胜；分母为 `periods_traded`）

### 金额明细卡片

报告中有两张“金额明细”卡片，把金额类信息单独展示，避免在 KPI 里混杂太多数字：

- `金额明细：最大回撤`：最大回撤金额、峰值资产、谷底资产、回撤区间
- `金额明细：最高净值`：最高净值(资产峰值)、最大收益(元)、最大收益率、发生日期

