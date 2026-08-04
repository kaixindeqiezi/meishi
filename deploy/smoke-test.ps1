param(
  [string]$BaseUrl = 'http://127.0.0.1:4320',
  [string]$FrontendUrl = ''
)

$ErrorActionPreference = 'Stop'

function Test-Endpoint([string]$Url) {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $Url
  if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
    throw "Unexpected status $($response.StatusCode) from $Url"
  }
  Write-Output "OK $($response.StatusCode) $Url"
}

Test-Endpoint "$BaseUrl/health"
if ($FrontendUrl) { Test-Endpoint "$FrontendUrl/food-flow/index.html" }
