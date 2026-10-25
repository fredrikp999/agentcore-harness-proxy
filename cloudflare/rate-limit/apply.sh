#!/usr/bin/env bash
# Sets the rate-limiting rule for /api/* on one hostname, through the Cloudflare API.
#
#   CLOUDFLARE_API_TOKEN=... ZONE_ID=... HOSTNAME=agent.example.com ./apply.sh
#
# The token needs Zone -> Zone WAF -> Edit on the zone. This PUTs the zone's whole
# http_ratelimit phase, so it replaces any other rate-limiting rules in the zone; on the
# Free plan only one rule is allowed anyway. The numbers fit the Free plan (10 second window
# and block, per IP). Tune LIMIT, or use a longer period on a paid plan.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${ZONE_ID:?set ZONE_ID}"
: "${HOSTNAME:?set HOSTNAME}"
LIMIT="${LIMIT:-30}"

curl -fsS -X PUT "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data @- <<JSON
{
  "rules": [
    {
      "description": "Rate limit /api/* on ${HOSTNAME}",
      "expression": "(http.host eq \"${HOSTNAME}\" and starts_with(http.request.uri.path, \"/api/\"))",
      "action": "block",
      "ratelimit": {
        "characteristics": ["ip.src", "cf.colo.id"],
        "period": 10,
        "requests_per_period": ${LIMIT},
        "mitigation_timeout": 10
      }
    }
  ]
}
JSON
echo
