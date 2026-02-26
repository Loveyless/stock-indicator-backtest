# STRATEGY：从这里开始

你要写策略，只需要改/新建一个 `strategy.js`，导出 `strategy(ctx)`，返回本周期要买的股票 `file` 列表（如 `sh600000.csv`）。

文档入口：

- 策略函数接口与回测口径：`STRATEGY_API.md`
- 指标口径与指标函数（REF/MA/EMA/SMA/WMA/DMA...）：`STRATEGY_INDICATORS.md`

快速运行：

`pnpm start -- --freq=W --start=20211115 --end=20211231 --quiet`

