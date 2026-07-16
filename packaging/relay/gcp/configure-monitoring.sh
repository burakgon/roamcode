#!/bin/sh
set -eu

CONFIG=${1:-./cloud.env}
: "${ROAMCODE_GCP_PROJECT:=$(gcloud config get-value project 2>/dev/null)}"

if [ ! -r "$CONFIG" ]; then
  echo "Pass the reviewed cloud.env path as the first argument" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

case "$ROAMCODE_GCP_PROJECT" in
  "" | *[!a-z0-9-]*)
    echo "ROAMCODE_GCP_PROJECT must be a valid Google Cloud project id" >&2
    exit 1
    ;;
esac
: "${ROAMCODE_APP_DOMAIN:?public app hostname is required}"
: "${ROAMCODE_RELAY_DOMAIN:?public relay hostname is required}"

command -v gcloud >/dev/null
command -v jq >/dev/null

configs=$(gcloud monitoring uptime list-configs --project "$ROAMCODE_GCP_PROJECT" --format=json)

create_uptime_check() {
  display=$1
  host=$2
  path=$3
  component=$4
  matcher_type=$5
  matcher_content=$6
  json_path=${7:-}

  count=$(printf '%s' "$configs" | jq --arg display "$display" '[.[] | select(.displayName == $display)] | length')
  if [ "$count" -gt 1 ]; then
    echo "Duplicate uptime checks exist for $display" >&2
    exit 1
  fi
  if [ "$count" -eq 1 ]; then return; fi

  if [ -n "$json_path" ]; then
    gcloud monitoring uptime create "$display" \
      --project "$ROAMCODE_GCP_PROJECT" \
      --resource-type=uptime-url \
      --resource-labels="host=$host,project_id=$ROAMCODE_GCP_PROJECT" \
      --protocol=https --port=443 --path="$path" --request-method=get \
      --validate-ssl=true --status-codes=200 \
      --matcher-type="$matcher_type" --matcher-content="$matcher_content" \
      --json-path="$json_path" --json-path-matcher-type=exact-match \
      --period=1 --timeout=10 --regions=europe,usa-oregon,asia-pacific \
      --user-labels="service=roamcode-cloud,component=$component" \
      --quiet >/dev/null
  else
    gcloud monitoring uptime create "$display" \
      --project "$ROAMCODE_GCP_PROJECT" \
      --resource-type=uptime-url \
      --resource-labels="host=$host,project_id=$ROAMCODE_GCP_PROJECT" \
      --protocol=https --port=443 --path="$path" --request-method=get \
      --validate-ssl=true --status-codes=200 \
      --matcher-type="$matcher_type" --matcher-content="$matcher_content" \
      --period=1 --timeout=10 --regions=europe,usa-oregon,asia-pacific \
      --user-labels="service=roamcode-cloud,component=$component" \
      --quiet >/dev/null
  fi
  configs=$(gcloud monitoring uptime list-configs --project "$ROAMCODE_GCP_PROJECT" --format=json)
}

create_uptime_check \
  "RoamCode Cloud PWA" "$ROAMCODE_APP_DOMAIN" / pwa \
  contains-string '<div id="root"></div>'
create_uptime_check \
  "RoamCode Cloud Relay" "$ROAMCODE_RELAY_DOMAIN" /ready relay \
  matches-json-path '"ready"' '$.status'

configs=$(gcloud monitoring uptime list-configs --project "$ROAMCODE_GCP_PROJECT" --format=json)
printf '%s' "$configs" | jq -e \
  --arg app "$ROAMCODE_APP_DOMAIN" \
  --arg relay "$ROAMCODE_RELAY_DOMAIN" '
    def exact_regions: (.selectedRegions | sort) == ["ASIA_PACIFIC", "EUROPE", "USA_OREGON"];
    def exact_http($host; $path; $component):
      .checkerType == "STATIC_IP_CHECKERS" and
      .monitoredResource.labels.host == $host and
      .httpCheck.path == $path and .httpCheck.port == 443 and
      .httpCheck.requestMethod == "GET" and .httpCheck.useSsl == true and
      .httpCheck.validateSsl == true and
      .httpCheck.acceptedResponseStatusCodes == [{"statusValue": 200}] and
      .period == "60s" and .timeout == "10s" and exact_regions and
      .userLabels.service == "roamcode-cloud" and .userLabels.component == $component;
    ([.[] | select(.displayName == "RoamCode Cloud PWA")] | length) == 1 and
    ([.[] | select(.displayName == "RoamCode Cloud Relay")] | length) == 1 and
    ([.[] | select(.displayName == "RoamCode Cloud PWA")][0] |
      exact_http($app; "/"; "pwa") and
      (.contentMatchers | length) == 1 and
      .contentMatchers[0].matcher == "CONTAINS_STRING" and
      .contentMatchers[0].content == "<div id=\"root\"></div>") and
    ([.[] | select(.displayName == "RoamCode Cloud Relay")][0] |
      exact_http($relay; "/ready"; "relay") and
      (.contentMatchers | length) == 1 and
      .contentMatchers[0].matcher == "MATCHES_JSON_PATH" and
      .contentMatchers[0].content == "\"ready\"" and
      .contentMatchers[0].jsonPathMatcher.jsonPath == "$.status" and
      .contentMatchers[0].jsonPathMatcher.jsonMatcher == "EXACT_MATCH")
  ' >/dev/null

policies=$(gcloud monitoring policies list --project "$ROAMCODE_GCP_PROJECT" --format=json)

create_policy() {
  display=$1
  check_display=$2
  component=$3
  count=$(printf '%s' "$policies" | jq --arg display "$display" '[.[] | select(.displayName == $display)] | length')
  if [ "$count" -gt 1 ]; then
    echo "Duplicate alert policies exist for $display" >&2
    exit 1
  fi
  if [ "$count" -eq 1 ]; then return; fi

  check_id=$(printf '%s' "$configs" | jq -er --arg display "$check_display" \
    '.[] | select(.displayName == $display) | .name | split("/")[-1]')
  gcloud monitoring policies create \
    --project "$ROAMCODE_GCP_PROJECT" \
    --display-name "$display" \
    --condition-display-name="$check_display unavailable in most probe regions" \
    --condition-filter="resource.type=\"uptime_url\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"$check_id\"" \
    --aggregation='{"alignmentPeriod":"60s","perSeriesAligner":"ALIGN_NEXT_OLDER"}' \
    --duration=120s --if='< 1' --trigger-percent=50 \
    --combiner=OR --enabled \
    --documentation="Public $component health failed from at least half of configured probe regions for two minutes. Verify Cloudflare Tunnel, GCP service health, and the latest deployment before changing DNS or credentials." \
    --user-labels="service=roamcode-cloud,component=$component" \
    --quiet >/dev/null
  policies=$(gcloud monitoring policies list --project "$ROAMCODE_GCP_PROJECT" --format=json)
}

create_policy "RoamCode Cloud PWA unavailable" "RoamCode Cloud PWA" pwa
create_policy "RoamCode Cloud Relay unavailable" "RoamCode Cloud Relay" relay

policies=$(gcloud monitoring policies list --project "$ROAMCODE_GCP_PROJECT" --format=json)
app_check_id=$(printf '%s' "$configs" | jq -er \
  '.[] | select(.displayName == "RoamCode Cloud PWA") | .name | split("/")[-1]')
relay_check_id=$(printf '%s' "$configs" | jq -er \
  '.[] | select(.displayName == "RoamCode Cloud Relay") | .name | split("/")[-1]')
printf '%s' "$policies" | jq -e \
  --arg app_id "$app_check_id" \
  --arg relay_id "$relay_check_id" '
    def exact_policy($display; $check_display; $component; $check_id):
      [.[] | select(.displayName == $display)] as $matches |
      ($matches | length) == 1 and
      ($matches[0] as $policy |
        $policy.enabled == true and $policy.combiner == "OR" and
        $policy.userLabels.service == "roamcode-cloud" and
        $policy.userLabels.component == $component and
        ($policy.conditions | length) == 1 and
        $policy.conditions[0].displayName == ($check_display + " unavailable in most probe regions") and
        ($policy.conditions[0].conditionThreshold as $threshold |
          $threshold.filter == ("resource.type=\"uptime_url\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"" + $check_id + "\"") and
          $threshold.comparison == "COMPARISON_LT" and $threshold.thresholdValue == 1 and
          $threshold.duration == "120s" and $threshold.trigger.percent == 50 and
          ($threshold.aggregations | length) == 1 and
          $threshold.aggregations[0].alignmentPeriod == "60s" and
          $threshold.aggregations[0].perSeriesAligner == "ALIGN_NEXT_OLDER"));
    exact_policy("RoamCode Cloud PWA unavailable"; "RoamCode Cloud PWA"; "pwa"; $app_id) and
    exact_policy("RoamCode Cloud Relay unavailable"; "RoamCode Cloud Relay"; "relay"; $relay_id)
  ' >/dev/null

printf '%s\n' "RoamCode cloud uptime checks and alert policies are configured"
