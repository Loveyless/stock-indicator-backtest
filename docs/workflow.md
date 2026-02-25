# Workflow

本文档描述 `src/main.js` 在 `--mode=stats` 下的端到端处理流程（从读取 CSV 到生成 HTML 报告）。

## 入口与目录约定

- 入口脚本：`src/main.js`
- 数据目录：项目根目录下的 `stock/`（读取 `stock/*.csv`）
- 输出：项目根目录生成 `量化分析结果+YYYY_MM_DD_HH_mm_ss.html`（北京时间）

补充：

- `--mode=backtest`：走“长仓回测”流程（默认策略 ER），报告结构与 stats 不同；见 `README.md` 参数说明。

## 处理流程（逐文件）

1) **枚举文件**

- 读取 `stock/` 下所有 `.csv` 文件名并排序（保证顺序可复现）
- 可选：`--files=...` 仅跑指定文件；`--limit=...` 仅跑前 N 个文件

2) **读取与解析**

- 以二进制读入文件内容
- 使用 `--encoding` 指定的编码解码为字符串（默认 `GBK`；`auto` 仅做 BOM 级别识别后回退 `GBK`）
- 使用 `csv-parse` 解析为“按表头列名映射”的记录数组
- 校验必须列存在：`交易日期`、`最低价_复权`、`最高价_复权`、`收盘价_复权`

3) **抽取序列**

把每个文件的记录抽为等长数组（对后续 rolling / EWMA / shift 计算更直接）：

- `dates[i]`：`交易日期` 转为 `YYYYMMDD` 整数（仅用于时间过滤）
- `lowAdj[i]`：`最低价_复权` 数值
- `highAdj[i]`：`最高价_复权` 数值
- `closeAdj[i]`：`收盘价_复权` 数值

4) **计算信号（KD 金叉/死叉）**

调用 `src/technicalIndicator.js` 的 `computeSignalKD()`：

- rolling 40 日低/高：`LOW_N` / `HIGH_N`
- `RSV = (closeAdj - LOW_N) / (HIGH_N - LOW_N) * 100`
- `K = EWMA(RSV, span=2, adjust=false, ignore_na=false)`
- `D = EWMA(K, span=2, adjust=false, ignore_na=false)`
- `signal`：
  - 金叉：前一日 `K<=D` 且当日 `K>D` → `signal=1`
  - 死叉：前一日 `K>=D` 且当日 `K<D` → `signal=0`
  - 非交叉日为缺失（`null`）

5) **计算未来 N 日涨跌幅**

对每个 `day`（默认 `1,2,3,5,10,20`）构造一列收益率数组：

`ret_day[i] = closeAdj[i+day] / closeAdj[i] - 1`

这等价于 pandas 的 `shift(-day)`。

6) **过滤时间区间与聚合统计**

对每一行 `i`：

- 仅保留 `start<=dates[i]<=end`
- 仅保留 `signal[i]` 为 `0/1` 的行（缺失值直接跳过）

对每个 `day` 更新两个统计口径：

- **describe**：把 `ret_day[i]` 送进 `DescribeAccumulator`（只统计有限值）
- **hit rate**：
  - 看涨（`signal=1`）：`ret_day[i] > 0` 计为命中
  - 看跌（`signal=0`）：`ret_day[i] < 0` 计为命中

注意：命中率分母用的是“信号行数”（`signal_rows`），不是 `describe.count`；这与原 Python 版口径一致。

7) **生成 HTML 报告**

脚本把聚合结果渲染成一个自包含 HTML：

- `Run Meta`：本次运行参数与环境信息
- `看跌/看涨` 两个分组：describe 表格 + 命中率表格
- `Notes`：口径说明与注意事项

## 性能与风险点

- 脚本“按文件处理”，不会把所有股票的原始行一次性拼成大表，内存压力主要来自：
  - CSV 解析后的 records（单文件）
  - 指标/收益中间数组（单文件）
  - 统计累加器（全局）
- `--exact-quantiles` 会缓存所有收益样本用于精确分位数：全量数据下可能非常占内存，建议只对小样本使用（例如配合 `--files` / `--limit`）。
- CSV 行顺序会影响 rolling/EWMA/未来收益计算；请确保每个文件按 `交易日期` 升序排列，否则结果不可信。

