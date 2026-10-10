# Builds the macOS .icns icon next to the existing PNG icons by wrapping
# them into an Apple ICNS container (PNG-encoded ic07/ic08/ic09 chunks).
# Run from the repository root: pwsh ports/tauri/scripts/make-icns.ps1
param(
    [string]$Source = "$PSScriptRoot\..\src-tauri\icons\icon.png",
    [string]$SmallSource = "$PSScriptRoot\..\src-tauri\icons\128x128.png",
    [string]$OutFile = "$PSScriptRoot\..\src-tauri\icons\icon.icns"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Get-EncodedPng([System.Drawing.Image]$image, [int]$size) {
    if ($image.Width -eq $size -and $image.Height -eq $size) {
        $stream = [System.IO.MemoryStream]::new()
        $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return $stream.ToArray()
    }
    $resized = [System.Drawing.Bitmap]::new($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($resized)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($image, 0, 0, $size, $size)
    $graphics.Dispose()
    $stream = [System.IO.MemoryStream]::new()
    $resized.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $resized.Dispose()
    return $stream.ToArray()
}

function Get-Chunk([string]$type, [byte[]]$png) {
    $header = [System.Text.Encoding]::ASCII.GetBytes($type)
    $length = [BitConverter]::GetBytes([uint32]($png.Length + 8))
    [array]::Reverse($length)
    return , ($header + $length + $png)
}

$large = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
$small = [System.Drawing.Image]::FromFile((Resolve-Path $SmallSource))
try {
    $body = @()
    $body += Get-Chunk 'ic07' (Get-EncodedPng $small 128)   # 128x128
    $body += Get-Chunk 'ic08' (Get-EncodedPng $large 256)   # 256x256
    $body += Get-Chunk 'ic09' (Get-EncodedPng $large 512)   # 512x512
    $totalLength = 8 + ($body | ForEach-Object { $_.Length } | Measure-Object -Sum).Sum

    $stream = [System.IO.File]::Create($OutFile)
    $writer = [System.IO.BinaryWriter]::new($stream)
    $writer.Write([byte[]](0x69, 0x63, 0x6E, 0x73))         # 'icns' magic
    $sizeBytes = [BitConverter]::GetBytes([uint32]$totalLength)
    [array]::Reverse($sizeBytes)                            # big-endian container length
    $writer.Write($sizeBytes)
    foreach ($chunk in $body) { $writer.Write([byte[]]$chunk) }
    $writer.Close()
    "Wrote $OutFile ($totalLength bytes)"
}
finally {
    $large.Dispose()
    $small.Dispose()
}
