#!/usr/bin/env bash
# Container egress filter — restricts agent containers to OneCLI gateway only.
# Idempotent: safe to run multiple times. Flushes DOCKER-USER and rebuilds.
#
# Rollback: iptables -F DOCKER-USER && iptables -A DOCKER-USER -j RETURN

set -euo pipefail

DOCKER0_IFACE="docker0"
ONECLI_NETWORK="onecli_onecli"
GATEWAY_PORT="10255"

# Wait for Docker to create DOCKER-USER chain (may not exist immediately after boot)
for i in $(seq 1 30); do
  if iptables -L DOCKER-USER -n &>/dev/null; then
    break
  fi
  echo "Waiting for DOCKER-USER chain... ($i/30)"
  sleep 2
done

if ! iptables -L DOCKER-USER -n &>/dev/null; then
  echo "ERROR: DOCKER-USER chain does not exist after 60s. Is Docker running?"
  exit 1
fi

# Dynamically resolve the OneCLI network subnet — resilient to IP reassignment
# after Docker restarts or compose stack recreation.
ONECLI_SUBNET=$(docker network inspect "$ONECLI_NETWORK" \
  --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null) || true

if [ -z "$ONECLI_SUBNET" ]; then
  echo "ERROR: Could not resolve subnet for Docker network '$ONECLI_NETWORK'. Is OneCLI running?"
  exit 1
fi

# Flush and rebuild — idempotent, atomic replacement
iptables -F DOCKER-USER

# 1. Allow agent containers → OneCLI gateway (post-DNAT destination on onecli_onecli network)
iptables -A DOCKER-USER -i "$DOCKER0_IFACE" -d "$ONECLI_SUBNET" -p tcp --dport "$GATEWAY_PORT" -j ACCEPT

# 2. Drop all other forwarded traffic from agent containers
iptables -A DOCKER-USER -i "$DOCKER0_IFACE" -j DROP

# 3. Pass everything else through (OneCLI containers, etc.)
iptables -A DOCKER-USER -j RETURN

echo "Egress filter applied: agent containers restricted to gateway at $ONECLI_SUBNET:$GATEWAY_PORT"
iptables -L DOCKER-USER -n -v --line-numbers
