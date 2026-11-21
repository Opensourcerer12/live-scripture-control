# Draws build/icon.png (512x512): a cream open book under a gold beam, on a navy tile.
# electron-builder converts this PNG into the Windows .ico.

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "build\icon.png"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null

$bmp = New-Object System.Drawing.Bitmap 512, 512
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# rounded navy tile
$tile = New-Object System.Drawing.Drawing2D.GraphicsPath
$tile.AddArc(0, 0, 208, 208, 180, 90)
$tile.AddArc(304, 0, 208, 208, 270, 90)
$tile.AddArc(304, 304, 208, 208, 0, 90)
$tile.AddArc(0, 304, 208, 208, 90, 90)
$tile.CloseFigure()
$navy = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 20, 26, 38))
$g.FillPath($navy, $tile)

# gold beam
$beam = [System.Drawing.Point[]]@(
	(New-Object System.Drawing.Point 198, 268),
	(New-Object System.Drawing.Point 314, 268),
	(New-Object System.Drawing.Point 368, 44),
	(New-Object System.Drawing.Point 144, 44)
)
$beamBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(90, 232, 193, 112))
$g.FillPolygon($beamBrush, $beam)

# cream open book
$cream = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 245, 238, 224))
$left = [System.Drawing.Point[]]@(
	(New-Object System.Drawing.Point 256, 300),
	(New-Object System.Drawing.Point 74, 268),
	(New-Object System.Drawing.Point 74, 400),
	(New-Object System.Drawing.Point 256, 432)
)
$right = [System.Drawing.Point[]]@(
	(New-Object System.Drawing.Point 256, 300),
	(New-Object System.Drawing.Point 438, 268),
	(New-Object System.Drawing.Point 438, 400),
	(New-Object System.Drawing.Point 256, 432)
)
$g.FillPolygon($cream, $left)
$g.FillPolygon($cream, $right)

# page lines
$line = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 196, 186, 170)), 6
$g.DrawLine($line, 108, 310, 220, 332)
$g.DrawLine($line, 108, 340, 220, 362)
$g.DrawLine($line, 292, 332, 404, 310)
$g.DrawLine($line, 292, 362, 404, 340)

# spine
$spine = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 20, 26, 38)), 8
$g.DrawLine($spine, 256, 300, 256, 432)

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "wrote $out"
