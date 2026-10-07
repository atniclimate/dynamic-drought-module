param([Parameter(Mandatory=$true)][string]$SourcePath, [Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$expected = '29D79857E53F591700C819E6389677FEB9EEEC74CF6053B5816082E308F28FF1'
if ((Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash -ne $expected) { throw 'Source seal changed' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Add-Type -AssemblyName System.Drawing
$sourceImage = [Drawing.Image]::FromFile((Resolve-Path -LiteralPath $SourcePath).Path)
try {
  foreach ($size in @(64,128)) {
    $outputFile = Join-Path $OutputDirectory "atni-seal-on-dark-$size.png"
    if (Test-Path -LiteralPath $outputFile) { throw "Output already exists: $outputFile" }
    $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([Drawing.Color]::Transparent)
      $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $scale = [Math]::Min($size / $sourceImage.Width, $size / $sourceImage.Height)
      $targetWidth = [single]($sourceImage.Width * $scale)
      $targetHeight = [single]($sourceImage.Height * $scale)
      $graphics.DrawImage($sourceImage, [Drawing.RectangleF]::new(($size-$targetWidth)/2, ($size-$targetHeight)/2, $targetWidth, $targetHeight))
      $bitmap.Save($outputFile, [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    Get-FileHash -LiteralPath $outputFile -Algorithm SHA256
  }
} finally { $sourceImage.Dispose() }
