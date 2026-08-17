#!/usr/bin/env bash
# What the runner can actually reach, recorded before the day's read is attempted.
#
# `update-sheds` has been dying on its FIRST Socrata request — eight attempts, most hanging the full
# 90 s and one per run closing early — while the same URL answers in 0.28 s from a laptop and, in the
# same job, the DOB clone and the Pages fetch both succeed. Three things differ between the laptop
# and the runner at once (network location, curl versus bun's fetch, and the app token), so the
# laptop test ruled out only the query's shape and size. This varies them one at a time from the
# vantage point that is actually failing.
#
# Every probe is observational and the step is `continue-on-error`, so this never decides whether the
# job runs. It costs about five seconds when healthy and is capped near seventy-five when not.
set -u

HOST=data.cityofnewyork.us
# The smallest read the failing dataset can answer, so a hang is the connection and not the query.
PROBE="https://$HOST/resource/5zhs-2jue.json?%24select=bin&%24limit=1"
FORMAT='  http=%{http_code} ip=%{remote_ip} dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n'

# The number that decides the leading hypothesis. A runner draws a different egress address each day,
# and the one day this job worked in the last five it drew a different one — so if reachability is
# keyed to the source address, these two columns correlate across a week and nothing else has to be
# proved.
echo "egress: $(curl -s --max-time 10 https://api.ipify.org || echo unknown)"
# `dig +short` prints the CNAME chain above the addresses, so the addresses are the lines that look
# like addresses — the host is a chain of two aliases before the load balancer's targets.
addresses() {
  dig +short "$HOST" A | grep -E '^[0-9]+(\.[0-9]+){3}$'
}

echo "resolver:"
echo "  A:    $(addresses | tr '\n' ' ')"
echo "  AAAA: $(dig +short "$HOST" AAAA | tr '\n' ' ')"
echo "  CNAME: $(dig +short "$HOST" CNAME | tr '\n' ' ')"

# The timing split is the discriminator. No `tcp` means the SYN never landed — a drop below the HTTP
# layer, where no header and no token can matter. A `tls` without a `ttfb` means the handshake was
# seen and the request abandoned after it, which is something reading the ClientHello or the SNI.
echo "probe (no token):"
curl -s -o /dev/null --max-time 15 -w "$FORMAT" "$PROBE"
echo "probe (token):"
curl -s -o /dev/null --max-time 15 -H "X-App-Token: ${SOCRATA_APP_TOKEN:-}" -w "$FORMAT" "$PROBE"

# Per address, because the host is a bare AWS network load balancer with three targets and no CDN. If
# exactly one of these hangs, the fleet is healthy and one target is not.
for address in $(addresses); do
  echo "probe (pinned $address):"
  curl -s -o /dev/null --max-time 15 --resolve "$HOST:443:$address" -w "$FORMAT" "$PROBE"
done

# Whether AWS us-east-1 is reachable at all from here, which separates "this host refuses us" from
# "this path is broken". Deliberately not another Socrata deployment: data.sfgov.org resolves to the
# very same load balancer and would prove nothing.
echo "control (s3 us-east-1):"
curl -s -o /dev/null --max-time 15 -w "$FORMAT" https://s3.amazonaws.com

exit 0
