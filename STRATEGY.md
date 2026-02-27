# STRATEGY（strategy.js）从这里开始

策略就是一个文件：项目根目录 `strategy.js`。

你只需要实现并导出 `strategy(ctx)`，返回本周期要买的股票 **CSV 文件名** 列表（例如 `sh600000.csv`）。

必读两份文档：

- `STRATEGY_API.md`：`strategy(ctx)` 入参/返回值 + 回测撮合口径
- `STRATEGY_INDICATORS.md`：指标函数库（`src/indicators.js`）与口径（REF/MA/EMA/SMA/WMA/DMA...）

快速跑一次：

`pnpm start -- --freq=W --start=20211115 --end=20211231 --limit=50 --quiet`
