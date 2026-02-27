# STRATEGY：指标函数库与口径（给 `strategy.js` 用）

本仓库内置了一套“数组指标函数”，供 `strategy(ctx)` 直接调用：

- 实现文件：`src/indicators.js`
- 暴露位置：`ctx.ind`

目标：让策略作者**不用重复造轮子**，同时避免“同名指标不同实现口径不同”导致回测结果不可对齐。

## 1) 数据结构约定

所有指标函数都遵守同一套输入/输出约定：

- 输入：等长数组 `x[]`（与 `s.datesYmd` 同步对齐）
- 输出：等长数组 `out[]`
- 缺失值：用 `NaN` 表示
- 窗口不足：返回 `NaN`（不要用 `0` 填充，否则会污染信号判断）

策略里常见用法：

```js
const idx = ctx.util.indexOfDate(s.datesYmd, ctx.asOfYmd);
const ma20 = ctx.ind.MA(s.closeAdj, 20);
const v = ma20[idx];
```

## 2) 函数列表（ctx.ind）

`src/indicators.js` 导出（并在 `ctx.ind` 中提供）：

- `REF(x, n)`：向后引用（n 天前）
- `IF(cond, a, b)`：逐元素条件选择（cond 为布尔数组；a/b 可为数组或常数）
- `SUM(x, n)`：n 日滚动求和（窗口不足为 NaN）
- `CUMSUM(x)`：累计和
- `MAX(x, n)` / `MIN(x, n)`：n 日滚动最大/最小（窗口不足为 NaN）
- `MAX([a,b,...])` / `MIN([a,b,...])`：逐元素多列取最大/最小
- `ABS(x)`：绝对值（x 可为数组或常数）
- `MA(x, n)`：简单移动平均（基于 `SUM/窗口长度`）
- `EMA(x, n)`：指数移动平均
- `SMA(x, n, m)`：递推 SMA（A 股常用口径）
- `WMA(x, n)`：加权移动平均（权重 1..n，最近权重最大）
- `DMA(x, a)`：动态移动平均（a 可为常数或数组；会被 clamp 到 [0,1]）

## 3) 关键语义（避免口径误解）

### REF(x, n)

- `REF(x, 0) === x`
- 前 `n` 个位置输出 `NaN`

### IF(cond, a, b)

- `out[i] = cond[i] ? a[i] : b[i]`
- `a/b` 允许传常数（视为广播）

### SUM/MA/MAX/MIN（滚动窗口）

- 窗口定义：`[i-n+1, ..., i]`（包含当天）
- 当窗口内存在 `NaN`：当前实现会要求“窗口内全部有限值”才输出，否则为 `NaN`

### EMA(x, n)

递推公式：

- `alpha = 2 / (n + 1)`
- `EMA[i] = alpha * x[i] + (1-alpha) * EMA[i-1]`

初始化口径：

- 从序列中第一个有限值开始作为起点（起点之前为 `NaN`）

### SMA(x, n, m)

递推公式（A 股常见口径）：

- `SMA[i] = (m*x[i] + (n-m)*SMA[i-1]) / n`
- `1 <= m <= n`

初始化口径：

- 从第一个有限值开始作为起点

### WMA(x, n)

权重 1..n（最近权重最大）：

- 分母：`n*(n+1)/2`
- `WMA[i] = sum_{k=0..n-1}( x[i-k] * (n-k) ) / denom`

### DMA(x, a)

动态系数递推：

- `DMA[i] = a[i]*x[i] + (1-a[i])*DMA[i-1]`
- `a` 可传常数或数组；会 clamp 到 `[0,1]`

## 4) 使用建议（写策略更稳）

- **先定信号日**：策略用 `ctx.asOfYmd` 定位 index，再取指标值（避免未来函数）
- **先做 NaN 判断**：`Number.isFinite(v)`，不然信号会乱
- **用 ctx.cache 缓存整列指标**：MA/EMA 这种是“整列计算”，每周期重复算会很慢

## 5) 关联文档

- `STRATEGY_API.md`：策略入参/出参与回测口径
- `docs/data-contract.md`：CSV 必须列与升序要求（日期乱序会让 REF/MA/EMA 失真）

