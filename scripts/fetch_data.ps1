param(
  [Parameter(Mandatory = $true)]
  [string]$AssetUrl,

  [Parameter(Mandatory = $false)]
  [string]$Sha256 = "",

  [Parameter(Mandatory = $false)]
  [string]$OutZip = "stock.zip",

  [Parameter(Mandatory = $false)]
  [string]$OutDir = "stock",

  [Parameter(Mandatory = $false)]
  [string]$DataVersion = ""
)

$ErrorActionPreference = "Stop"

Write-Host "Downloading: $AssetUrl"
Invoke-WebRequest -Uri $AssetUrl -OutFile $OutZip

if ($Sha256 -and $Sha256.Trim().Length -gt 0) {
  $actual = (Get-FileHash $OutZip -Algorithm SHA256).Hash.ToLower()
  $expected = $Sha256.Trim().ToLower()
  if ($actual -ne $expected) {
    throw "SHA256 mismatch. expected=$expected actual=$actual"
  }
  Write-Host "SHA256 OK: $actual"
} else {
  Write-Host "SHA256 skipped (no -Sha256 provided)."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "Extracting to: $OutDir"
Expand-Archive -Force $OutZip $OutDir

if ($DataVersion -and $DataVersion.Trim().Length -gt 0) {
  Write-Host "Tip: run with --data-version=$DataVersion so the report records which dataset you used."
}

Write-Host "Done."
