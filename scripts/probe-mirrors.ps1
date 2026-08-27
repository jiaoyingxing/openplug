$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'docs\evidence\probe\probe-log.csv'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
if (-not (Test-Path $log)) {
	Set-Content -Path $log -Value 'time,mirror,target,status,ms,bytes' -Encoding UTF8
}

$suffix = 'https://raw.githubusercontent.com/blacksmithgu/obsidian-dataview/master/manifest.json'
$bigList = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json'
$mirrors = @('', 'https://gh-proxy.com/', 'https://ghfast.top/', 'https://wget.la/', 'https://gh.idayer.com/')
$lastBigDay = $null

function Probe($url, $mirrorLabel, $target) {
	$sw = [Diagnostics.Stopwatch]::StartNew()
	try {
		$r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri $url
		$sw.Stop()
		return "$((Get-Date).ToString('s')),$mirrorLabel,$target,$($r.StatusCode),$($sw.ElapsedMilliseconds),$($r.RawContentLength)"
	} catch {
		$sw.Stop()
		return "$((Get-Date).ToString('s')),$mirrorLabel,$target,ERR,$($sw.ElapsedMilliseconds),0"
	}
}

while ($true) {
	foreach ($m in $mirrors) {
		$label = if ($m) { $m } else { 'direct' }
		$url = if ($m) { $m + $suffix } else { $suffix }
		(Probe $url $label 'manifest') | Add-Content $log
	}
	$today = (Get-Date).Date
	if (-not $lastBigDay -or $today -ne $lastBigDay) {
		foreach ($m in @('', 'https://gh-proxy.com/')) {
			$label = if ($m) { $m } else { 'direct' }
			$url = if ($m) { $m + $bigList } else { $bigList }
			(Probe $url $label 'list') | Add-Content $log
		}
		$lastBigDay = $today
	}
	Start-Sleep -Seconds 1800
}
