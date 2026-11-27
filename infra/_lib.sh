#!/usr/bin/env bash
# Shared settings for every infra script (same idea as Lab 8 infra/services/_lib.sh).
# In a new Git Bash window you can also run:  source infra/_lib.sh   -> gives you "awsl"
# Floci accepts any keys: "test"/"test" are NOT secrets.

export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export AWS_REGION=us-east-1
export AWS_PAGER=""
export MSYS_NO_PATHCONV=1
unset AWS_PROFILE

export ENDPOINT="${ENDPOINT:-http://localhost:4566}"
export ACCOUNT=000000000000
export REGION=us-east-1
export RUNTIME="${RUNTIME:-nodejs24.x}"

# Resource names (one place, used by deploy / check / reset)
export PREFIX=Tbx
export SECRET_ID=tbx/app-secrets
export AUDIT_LOG_GROUP=/tbx/audit
export WEB_BUCKET=tbx-web
export PHOTO_BUCKET=tbx-listing-photos
export TOPIC_NAME=tbx-notifications
export EVENTS_QUEUE=tbx-request-events
export DELIVERY_QUEUE=tbx-notification-delivery
export API_NAME=tbx-http-api
export RULE_NAME=tbx-expiry-schedule
export FN_IDENTITY=tbx-identity-fn
export FN_LISTINGS=tbx-listings-fn
export FN_REQUESTS=tbx-requests-fn
export FN_JOBS=tbx-jobs-fn
export FN_MODERATION=tbx-moderation-fn
export FN_ALERTS=tbx-alerts-fn
export CORS_ORIGINS="http://localhost:4566,http://localhost:8080"

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROJECT_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
export OUT="out"
mkdir -p "$OUT"

awsl() { aws --endpoint-url "$ENDPOINT" "$@"; }

# Run a create command; "already exists" is fine (scripts can be re-run)
ok() {
  local output
  if ! output=$("$@" 2>&1); then
    if echo "$output" | grep -qiE 'already exists|ResourceInUse|AlreadyExists|BucketAlreadyOwnedByYou|ResourceConflict|EntityAlreadyExists'; then
      echo "    (already exists)"
    else
      echo "$output" >&2
      return 1
    fi
  fi
}

api_id() {
  awsl apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text 2>/dev/null
}
