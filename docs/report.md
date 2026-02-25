# Report

脚本结束后会在项目根目录生成报告文件：

- 文件名：`量化分析结果+YYYYMMDDHHmmss.html`
- 内容：自包含 HTML，双击即可在浏览器打开

## Run Meta

`Run Meta` 记录本次运行的关键信息（用于复现）：

- `generated_at`：生成时间
- `elapsed_seconds`：总耗时
- `data_dir`：数据目录（应为 `...\\stock`）
- `files_total`：本次参与统计的文件数（应用 `--files/--limit` 后的数量）
- `start/end`：时间过滤区间（包含边界）
- `day_list`：未来收益的天数列表
- `safe_rsv` / `exact_quantiles`：是否开启对应开关

## 看跌/看涨分组

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

