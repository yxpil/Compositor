# Regenerates the Tauri app icons in src-tauri/icons/.
# Run with: powershell -File scripts/make-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$iconsDir = Join-Path $PSScriptRoot '..\src-tauri\icons'
New-Item -ItemType Directory -Force $iconsDir | Out-Null

function New-Icon([int]$size) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $radius = [Math]::Max(2, [int]($size * 0.22))
    $diameter = $radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $path.AddArc($size - $diameter, 0, $diameter, $diameter, 270, 90)
    $path.AddArc($size - $diameter, $size - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc(0, $size - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()

    $background = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 24, 24, 27))
    $foreground = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $graphics.FillPath($background, $path)

    $font = New-Object System.Drawing.Font('Segoe UI', [float]($size * 0.5), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $box = New-Object System.Drawing.RectangleF(0, ($size * -0.02), $size, $size)
    $graphics.DrawString('C', $font, $foreground, $box, $format)

    $graphics.Dispose()
    return $bitmap
}

$targets = @(
    @{ Size = 32;  File = '32x32.png' },
    @{ Size = 128; File = '128x128.png' },
    @{ Size = 512; File = 'icon.png' }
)
foreach ($target in $targets) {
    $bitmap = New-Icon $target.Size
    $bitmap.Save((Join-Path $iconsDir $target.File), [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

# icon.ico: ICONDIR plus one ICONDIRENTRY wrapping the 32x32 PNG (Vista+ format).
$png = [IO.File]::ReadAllBytes((Join-Path $iconsDir '32x32.png'))
$stream = New-Object IO.MemoryStream
$writer = New-Object IO.BinaryWriter($stream)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]32); $writer.Write([byte]32); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32)
$writer.Write([uint32]$png.Length); $writer.Write([uint32]22)
$writer.Write($png)
$writer.Flush()
[IO.File]::WriteAllBytes((Join-Path $iconsDir 'icon.ico'), $stream.ToArray())
$writer.Dispose()

Write-Host "Icons written to $iconsDir"
