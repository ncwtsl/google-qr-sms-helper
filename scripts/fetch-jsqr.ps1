# 可选增强：拉取 jsQR 到扩展根目录，并把它加回 manifest 的 content_scripts。
# 不跑这个脚本扩展也能用 —— content.js 优先用浏览器的 BarcodeDetector。
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-jsqr.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dst = Join-Path $root "jsqr.min.js"
$url = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js"

Write-Host "下载 jsQR 1.4.0 …"
Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing

# 去掉 jsDelivr 的 banner 注释与 sourcemap 引用，保持文件干净
$txt = Get-Content $dst -Raw
$txt = [regex]::Replace($txt, "(?s)^/\*.*?\*/\s*", "")
$txt = [regex]::Replace($txt, "//# sourceMappingURL=.*$", "")
[IO.File]::WriteAllText($dst, $txt.TrimEnd() + "`n", (New-Object Text.UTF8Encoding $false))

Write-Host "已写入 $dst ($((Get-Item $dst).Length) 字节)"

# 把 jsqr.min.js 插回 manifest（放在 content.js 之前）
$mf = Join-Path $root "manifest.json"
$m = Get-Content $mf -Raw | ConvertFrom-Json
$cs = $m.content_scripts | Where-Object { $_.js -contains "content.js" }
if ($cs -and ($cs.js -notcontains "jsqr.min.js")) {
  $cs.js = @("jsqr.min.js") + $cs.js
  ($m | ConvertTo-Json -Depth 10) | Set-Content $mf -Encoding utf8
  Write-Host "manifest.json 已加回 jsqr.min.js"
} else {
  Write-Host "manifest.json 已包含 jsqr.min.js，跳过"
}
