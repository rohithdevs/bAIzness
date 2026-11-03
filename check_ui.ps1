$out = @()
try { $out += "UI: " + (Invoke-WebRequest -Uri http://127.0.0.1:5173/ -UseBasicParsing -TimeoutSec 5).StatusCode } catch { $out += "UI DOWN: " + $_.Exception.Message }
try { $out += "PROXY: " + (Invoke-WebRequest -Uri http://127.0.0.1:5173/api/health -UseBasicParsing -TimeoutSec 5).Content } catch { $out += "PROXY DOWN: " + $_.Exception.Message }
$out | Set-Content c:/Users/Rohit/Desktop/Project/baizness/ui.txt
