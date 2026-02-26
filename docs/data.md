# Data (GitHub Release)

本项目不把全量数据放进 git。推荐做法：把数据包（例如 `stock.zip`）作为 GitHub Release 的附件发布；代码仓库只提供下载/校验/解压说明。

## 目录约定

- 默认数据目录：项目根目录 `stock/`
- 可自定义：运行时传 `--data-dir=...` 指定数据目录

目录里应包含：`*.csv`（文件名会被脚本枚举；也可用 `--files=` 指定子集）。

## 下载与校验（PowerShell）

1) 下载 Release 附件（示例）

```powershell
$url = "<YOUR_RELEASE_ASSET_URL>"
Invoke-WebRequest -Uri $url -OutFile stock.zip
```

2) 校验 SHA256

```powershell
Get-FileHash stock.zip -Algorithm SHA256
```

3) 解压到 `stock/`

```powershell
New-Item -ItemType Directory -Force -Path stock | Out-Null
Expand-Archive -Force stock.zip stock
```

## 一键脚本

见 `scripts/fetch_data.ps1`：

- 支持：下载 → 可选校验 SHA256 → 解压到指定目录
- 支持：把 `--data-version` 写进报告 `Run Meta` 方便复现

