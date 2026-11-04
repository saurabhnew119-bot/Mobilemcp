Add-Type -AssemblyName System.Drawing

$S = 2  # supersampling scale for crisp output
$outDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Monocept palette
$cDeepBlue  = [System.Drawing.ColorTranslator]::FromHtml("#0040FF")
$cBlue      = [System.Drawing.ColorTranslator]::FromHtml("#0D4DFF")
$cCyan      = [System.Drawing.ColorTranslator]::FromHtml("#19E6FF")
$cPaleCyan  = [System.Drawing.ColorTranslator]::FromHtml("#B2FFFF")
$cOrange    = [System.Drawing.ColorTranslator]::FromHtml("#FF601F")
$cGreen     = [System.Drawing.ColorTranslator]::FromHtml("#96C93D")
$cDark      = [System.Drawing.ColorTranslator]::FromHtml("#333333")
$cMid       = [System.Drawing.ColorTranslator]::FromHtml("#666666")
$cLine      = [System.Drawing.ColorTranslator]::FromHtml("#BFBFBF")
$cLight     = [System.Drawing.ColorTranslator]::FromHtml("#D9D9D9")
$cWhite     = [System.Drawing.Color]::White

function New-Canvas($w, $h) {
    $bmp = New-Object System.Drawing.Bitmap ($w * $S), ($h * $S)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.ScaleTransform($S, $S)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear($cWhite)
    return @($bmp, $g)
}

function RoundRectPath($x, $y, $w, $h, $r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, 2*$r, 2*$r, 180, 90)
    $p.AddArc($x + $w - 2*$r, $y, 2*$r, 2*$r, 270, 90)
    $p.AddArc($x + $w - 2*$r, $y + $h - 2*$r, 2*$r, 2*$r, 0, 90)
    $p.AddArc($x, $y + $h - 2*$r, 2*$r, 2*$r, 90, 90)
    $p.CloseFigure()
    return $p
}

function Draw-Box($g, $x, $y, $w, $h, $fill, $border, $title, $body, $titleColor, $bodyColor, $titleSize = 12, $bodySize = 9.5) {
    $path = RoundRectPath $x $y $w $h 8
    $g.FillPath((New-Object System.Drawing.SolidBrush $fill), $path)
    $g.DrawPath((New-Object System.Drawing.Pen $border, 1.5), $path)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $tf = New-Object System.Drawing.Font "Segoe UI", $titleSize, ([System.Drawing.FontStyle]::Bold)
    $bf = New-Object System.Drawing.Font "Segoe UI", $bodySize
    if ($body) {
        $tH = [Math]::Round($h * 0.42)
        $g.DrawString($title, $tf, (New-Object System.Drawing.SolidBrush $titleColor), (New-Object System.Drawing.RectangleF $x, ($y + 4), $w, $tH), $fmt)
        $g.DrawString($body, $bf, (New-Object System.Drawing.SolidBrush $bodyColor), (New-Object System.Drawing.RectangleF ($x + 6), ($y + $tH), ($w - 12), ($h - $tH - 6)), $fmt)
    } else {
        $g.DrawString($title, $tf, (New-Object System.Drawing.SolidBrush $titleColor), (New-Object System.Drawing.RectangleF $x, $y, $w, $h), $fmt)
    }
}

function Draw-Diamond($g, $cx, $cy, $w, $h, $text) {
    $pts = @(
        (New-Object System.Drawing.PointF $cx, ($cy - $h/2)),
        (New-Object System.Drawing.PointF ($cx + $w/2), $cy),
        (New-Object System.Drawing.PointF $cx, ($cy + $h/2)),
        (New-Object System.Drawing.PointF ($cx - $w/2), $cy)
    )
    $g.FillPolygon((New-Object System.Drawing.SolidBrush $cPaleCyan), $pts)
    $g.DrawPolygon((New-Object System.Drawing.Pen $cDeepBlue, 1.5), $pts)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $f = New-Object System.Drawing.Font "Segoe UI", 10, ([System.Drawing.FontStyle]::Bold)
    $g.DrawString($text, $f, (New-Object System.Drawing.SolidBrush $cDark), (New-Object System.Drawing.RectangleF ($cx - $w/2 + 20), ($cy - $h/2), ($w - 40), $h), $fmt)
}

function Draw-Arrow($g, $x1, $y1, $x2, $y2, $color, $dashed = $false, $label = $null, $labelAbove = $true) {
    $pen = New-Object System.Drawing.Pen $color, 2
    $pen.CustomEndCap = New-Object System.Drawing.Drawing2D.AdjustableArrowCap 5, 6
    if ($dashed) { $pen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash }
    $g.DrawLine($pen, [float]$x1, [float]$y1, [float]$x2, [float]$y2)
    if ($label) {
        $f = New-Object System.Drawing.Font "Segoe UI", 8.5, ([System.Drawing.FontStyle]::Italic)
        $sz = $g.MeasureString($label, $f)
        $mx = ($x1 + $x2) / 2; $my = ($y1 + $y2) / 2
        if ($labelAbove) { $ly = $my - $sz.Height - 2 } else { $ly = $my + 2 }
        $g.FillRectangle((New-Object System.Drawing.SolidBrush $cWhite), ($mx - $sz.Width/2), $ly, $sz.Width, $sz.Height)
        $g.DrawString($label, $f, (New-Object System.Drawing.SolidBrush $cMid), ($mx - $sz.Width/2), $ly)
    }
}

function Draw-Elbow($g, $x1, $y1, $x2, $y2, $color, $dashed = $false, $label = $null) {
    # vertical then horizontal with arrow at the end
    $pen = New-Object System.Drawing.Pen $color, 2
    if ($dashed) { $pen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash }
    $g.DrawLine($pen, [float]$x1, [float]$y1, [float]$x1, [float]$y2)
    Draw-Arrow $g $x1 $y2 $x2 $y2 $color $dashed $label
}

function Draw-Caption($g, $x, $y, $w, $text) {
    $f = New-Object System.Drawing.Font "Segoe UI", 9
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Near
    $g.DrawString($text, $f, (New-Object System.Drawing.SolidBrush $cMid), (New-Object System.Drawing.RectangleF $x, $y, $w, 40), $fmt)
}

# ------------------------------------------------------------------
# Figure 1: How it works (architecture and data flow)
# ------------------------------------------------------------------
$W = 1240; $H = 560
$r = New-Canvas $W $H; $bmp = $r[0]; $g = $r[1]

$tf = New-Object System.Drawing.Font "Segoe UI", 15, ([System.Drawing.FontStyle]::Bold)
$g.DrawString("How Mobilemcp works", $tf, (New-Object System.Drawing.SolidBrush $cOrange), 30, 22)
$sf = New-Object System.Drawing.Font "Segoe UI", 10
$g.DrawString("One tool call travels left to right. Logs from the server and from the app are merged into one terminal.", $sf, (New-Object System.Drawing.SolidBrush $cMid), 30, 52)

$bw = 184; $bh = 115; $y1 = 110; $gap = 62
$x = 30
$boxes = @(
    @("MCP client", "Claude Code, Cursor,`nClaude Desktop or curl.`nSends JSON-RPC tool calls.", $cPaleCyan, $cDeepBlue, $cDark),
    @("mobile-mcp server", "Node.js, from this repo.`nstdio for MCP clients or`nHTTP on 127.0.0.1:3100", $cDeepBlue, $cDeepBlue, $cWhite),
    @("mobilecli + adb", "Translate tool calls into`ndevice commands:`ntap, type, launch, screenshot", $cBlue, $cBlue, $cWhite),
    @("Android emulator`nor device", "Medium_Phone_API_37.0`nor a phone with USB`ndebugging. Runs mSpace.", $cPaleCyan, $cDeepBlue, $cDark),
    @("mSpace backend", "uatapi.maxlifeinsurance.com`n(UAT). Called by the app,`nnot by mobile-mcp.", $cLight, $cMid, $cDark)
)
$centers = @()
for ($i = 0; $i -lt $boxes.Count; $i++) {
    $b = $boxes[$i]
    $tc = $b[4]; if ($b[4] -eq $cWhite) { $tc = $cWhite }
    Draw-Box $g $x $y1 $bw $bh $b[2] $b[3] $b[0] $b[1] $b[4] $b[4] 11.5 9
    $centers += ($x + $bw/2)
    if ($i -lt $boxes.Count - 1) {
        $labels = @("tools/call", "device cmd", "adb / USB", "HTTPS")
        Draw-Arrow $g ($x + $bw + 4) ($y1 + $bh/2) ($x + $bw + $gap - 4) ($y1 + $bh/2) $cDeepBlue $false $null
        $lf = New-Object System.Drawing.Font "Segoe UI", 8, ([System.Drawing.FontStyle]::Italic)
        $lsz = $g.MeasureString($labels[$i], $lf)
        $g.DrawString($labels[$i], $lf, (New-Object System.Drawing.SolidBrush $cMid), ($x + $bw + $gap/2 - $lsz.Width/2), ($y1 + $bh/2 - 20))
    }
    $x += $bw + $gap
}

# result path back
$f8 = New-Object System.Drawing.Font "Segoe UI", 8.5, ([System.Drawing.FontStyle]::Italic)
$g.DrawString("result, screenshot or element list returns the same way", $f8, (New-Object System.Drawing.SolidBrush $cMid), 300, ($y1 + $bh + 6))

# Dev logs viewer
$vy = 330; $vw = 520; $vh = 120; $vx = 330
Draw-Box $g $vx $vy $vw $vh $cWhite $cOrange "Dev log viewer  (npm run dev:logs)" "Starts the server, tails logcat of the app process and prints both in one terminal:`nMCP request/response blocks, app API request/response blocks, errors.`nKeys:  /  search     Esc  clear     c  clear screen.  Screen clears on every app rerun." $cOrange $cDark 11.5 9

# dashed feeds into the viewer
Draw-Elbow $g $centers[1] ($y1 + $bh + 24) ($vx - 6) ($vy + 40) $cOrange $true $null
$g.DrawString("request-logger:`nevery MCP request`nand response", $f8, (New-Object System.Drawing.SolidBrush $cMid), ($centers[1] + 8), ($y1 + $bh + 50))
Draw-Elbow $g $centers[3] ($y1 + $bh + 24) ($vx + $vw + 6) ($vy + 80) $cGreen $true $null
$g.DrawString("adb logcat --pid <mSpace>:`nAPI blocks, JS logs, crashes", $f8, (New-Object System.Drawing.SolidBrush $cMid), ($centers[3] + 8), ($y1 + $bh + 50))

# terminal output
$ty = 480
Draw-Box $g $vx $ty $vw 50 $cDark $cDark "Single terminal: MCP + APP feed, searchable, also written to a log file" $null $cWhite $cWhite 10.5 9
Draw-Arrow $g ($vx + $vw/2) ($vy + $vh + 2) ($vx + $vw/2) ($ty - 2) $cOrange

$bmp.Save("$outDir\fig1-how-it-works.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# ------------------------------------------------------------------
# Figure 2: Setup and run flow
# ------------------------------------------------------------------
$W = 1180; $H = 840
$r = New-Canvas $W $H; $bmp = $r[0]; $g = $r[1]
$g.DrawString("Setup and run flow for a team member", $tf, (New-Object System.Drawing.SolidBrush $cOrange), 30, 22)
$g.DrawString("Follow the arrows once per machine. The loop at the end is the daily routine.", $sf, (New-Object System.Drawing.SolidBrush $cMid), 30, 52)

$bw = 230; $bh = 92
# column 1 (x=40), column 2 (x=475), column 3 (x=910)
$c1 = 40; $c2 = 475; $c3 = 910
$rowY = @(100, 230, 360, 490, 670)

# Start
$sp = RoundRectPath $c1 $rowY[0] $bw 50 25
$g.FillPath((New-Object System.Drawing.SolidBrush $cGreen), $sp);
$fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = "Center"; $fmt.LineAlignment = "Center"
$g.DrawString("Start: new machine", (New-Object System.Drawing.Font "Segoe UI", 11, ([System.Drawing.FontStyle]::Bold)), (New-Object System.Drawing.SolidBrush $cWhite), (New-Object System.Drawing.RectangleF $c1, $rowY[0], $bw, 50), $fmt)

Draw-Arrow $g ($c1 + $bw/2) ($rowY[0] + 52) ($c1 + $bw/2) ($rowY[1] - 4) $cDeepBlue
Draw-Box $g $c1 $rowY[1] $bw $bh $cPaleCyan $cDeepBlue "1. Install prerequisites" "Git, Node.js 20+, Android Studio`n(SDK platform-tools + emulator),`nVS Code, an MCP client" $cDark $cDark 11 9

Draw-Arrow $g ($c1 + $bw/2) ($rowY[1] + $bh + 2) ($c1 + $bw/2) ($rowY[2] - 4) $cDeepBlue
Draw-Box $g $c1 $rowY[2] $bw $bh $cPaleCyan $cDeepBlue "2. Clone and build" "git clone <repo> Mobilemcp`nnpm install`nnpm run build" $cDark $cDark 11 9

Draw-Arrow $g ($c1 + $bw/2) ($rowY[2] + $bh + 2) ($c1 + $bw/2) ($rowY[3] - 4) $cDeepBlue
# decision
$dcx = $c1 + $bw/2; $dcy = $rowY[3] + 50
Draw-Diamond $g $dcx $dcy 250 110 "Emulator or device`nready?"
# No branch -> right box
Draw-Arrow $g ($dcx + 125 + 2) $dcy ($c2 - 6) $dcy $cDeepBlue $false "No"
Draw-Box $g $c2 ($dcy - $bh/2) $bw $bh $cWhite $cOrange "Create one" "Android Studio > Device Manager >`ncreate AVD (e.g. Medium Phone),`nor enable USB debugging on a phone" $cOrange $cDark 11 9
# loop back from Create one to decision (down and around)
$pen = New-Object System.Drawing.Pen $cDeepBlue, 2
$g.DrawLine($pen, [float]($c2 + $bw/2), [float]($dcy + $bh/2 + 2), [float]($c2 + $bw/2), [float]($dcy + $bh/2 + 30))
$g.DrawLine($pen, [float]($c2 + $bw/2), [float]($dcy + $bh/2 + 30), [float]($dcx + 40), [float]($dcy + $bh/2 + 30))
Draw-Arrow $g ($dcx + 40) ($dcy + $bh/2 + 30) ($dcx + 40) ($dcy + 56) $cDeepBlue

# Yes branch -> down
Draw-Arrow $g $dcx ($dcy + 57) $dcx ($rowY[4] - 4) $cDeepBlue $false "Yes" $false
Draw-Box $g $c1 $rowY[4] $bw $bh $cPaleCyan $cDeepBlue "3. Start device, install app" "Boot the emulator (adb devices`nshows it), install the mSpace APK" $cDark $cDark 11 9

# arrow to column 3 top: run viewer
Draw-Arrow $g ($c1 + $bw + 4) ($rowY[4] + $bh/2) ($c3 - 6) ($rowY[4] + $bh/2) $cDeepBlue
Draw-Box $g $c3 $rowY[4] $bw $bh $cDeepBlue $cDeepBlue "4. Run the log viewer" "cd Mobilemcp`nnpm run dev:logs`n(server + logs in one terminal)" $cWhite $cWhite 11 9

# up to configure client
Draw-Arrow $g ($c3 + $bw/2) ($rowY[4] - 2) ($c3 + $bw/2) ($rowY[2] + $bh + 6) $cDeepBlue
Draw-Box $g $c3 $rowY[2] $bw $bh $cPaleCyan $cDeepBlue "5. Point your MCP client at it" "Claude Code / Cursor:`nnode <Mobilemcp>\lib\index.js`nor HTTP http://127.0.0.1:3100/mcp" $cDark $cDark 11 9

Draw-Arrow $g ($c3 + $bw/2) ($rowY[2] - 2) ($c3 + $bw/2) ($rowY[1] + $bh + 6) $cDeepBlue
Draw-Box $g $c3 $rowY[1] $bw $bh $cPaleCyan $cDeepBlue "6. Drive the app" "mobile_list_available_devices,`nmobile_launch_app, tap, type,`nscreenshot, list elements" $cDark $cDark 11 9

Draw-Arrow $g ($c3 + $bw/2) ($rowY[1] - 2) ($c3 + $bw/2) ($rowY[0] + 56) $cDeepBlue
Draw-Box $g $c3 $rowY[0] $bw 52 $cWhite $cOrange "7. Read and search the logs" $null $cOrange $cDark 11 9

# daily loop between 7 and 6
$g.DrawString("Daily loop: rerun the app (terminal clears itself), drive it, read the logs", $f8, (New-Object System.Drawing.SolidBrush $cMid), ($c2 + 130), ($rowY[0] + 40))
$pen2 = New-Object System.Drawing.Pen $cOrange, 2; $pen2.DashStyle = "Dash"
$g.DrawLine($pen2, [float]($c3 - 4), [float]($rowY[0] + 26), [float]($c2 + $bw/2), [float]($rowY[0] + 26))
$g.DrawLine($pen2, [float]($c2 + $bw/2), [float]($rowY[0] + 26), [float]($c2 + $bw/2), [float]($rowY[1] + 20))
Draw-Arrow $g ($c2 + $bw/2) ($rowY[1] + 20) ($c3 - 6) ($rowY[1] + 20) $cOrange $true

# legend
$ly = 795
$g.FillRectangle((New-Object System.Drawing.SolidBrush $cPaleCyan), 40, $ly, 18, 14); $g.DrawRectangle((New-Object System.Drawing.Pen $cDeepBlue, 1), 40, $ly, 18, 14)
$g.DrawString("step you do once", $sf, (New-Object System.Drawing.SolidBrush $cDark), 64, ($ly - 3))
$g.FillRectangle((New-Object System.Drawing.SolidBrush $cDeepBlue), 220, $ly, 18, 14)
$g.DrawString("step you do every day", $sf, (New-Object System.Drawing.SolidBrush $cDark), 244, ($ly - 3))
$g.DrawRectangle((New-Object System.Drawing.Pen $cOrange, 1.5), 430, $ly, 18, 14)
$g.DrawString("something to resolve or watch at your end", $sf, (New-Object System.Drawing.SolidBrush $cDark), 454, ($ly - 3))

$bmp.Save("$outDir\fig2-setup-flow.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"done"
