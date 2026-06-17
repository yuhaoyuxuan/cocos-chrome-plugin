# 用 .NET System.Drawing 直接画并保存 PNG，最稳，无需手工编码。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot '..\public\icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

foreach ($size in 16, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    # 背景
    $g.Clear([System.Drawing.Color]::FromArgb(38, 50, 56))
    # 画一个简化的"C"（cocos 蓝）
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(79, 195, 247)), ([Math]::Max(1, $size / 10))
    $rect = New-Object System.Drawing.RectangleF ($size * 0.25), ($size * 0.25), ($size * 0.5), ($size * 0.5)
    $g.DrawArc($pen, $rect, 45, 270)
    $g.Dispose()
    $path = Join-Path $dir "icon-$size.png"
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "saved $path"
}
