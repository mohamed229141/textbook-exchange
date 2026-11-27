#!/usr/bin/env bash
# Builds the WHOLE Textbook Exchange on Floci (safe to run again: it updates what exists).
#   docker compose -f infra/floci/docker-compose.yml up -d
#   bash infra/deploy-floci.sh
#   bash infra/seed-floci.sh        (first admin + demo data)
#   bash infra/check-floci.sh       (tests everything)
#
# AWS services per service (4 services, 2 per student):
#   Mohamed - Book Listing   : Lambda tbx-listings-fn + tbx-jobs-fn, DynamoDB TbxListings + TbxSettings,
#                              S3 tbx-listing-photos, EventBridge tbx-expiry-schedule, IAM
#   Mohamed - Course Alerts  : Lambda tbx-alerts-fn, DynamoDB TbxAlerts, SNS (via notifications), IAM
#   Tarek   - Purchase Request: Lambda tbx-requests-fn, DynamoDB TbxRequests + TbxNotifications,
#                              SNS tbx-notifications, SQS tbx-request-events + tbx-notification-delivery, IAM
#   Tarek   - Moderation     : Lambda tbx-moderation-fn, DynamoDB TbxReports, CloudWatch Logs /tbx/audit, IAM
#   Shared login (Tarek lead): Lambda tbx-identity-fn, DynamoDB TbxUsers, Secrets Manager tbx/app-secrets
#   Shared                   : API Gateway tbx-http-api, S3 website bucket tbx-web
set -u
cd "$(dirname "$0")/.." || exit 1
source infra/_lib.sh

if ! curl -s -o out/.discard "$ENDPOINT/_floci/health" && ! curl -s -o out/.discard "$ENDPOINT/"; then
  echo "Floci is not running. Start Docker Desktop, then:"
  echo "  docker compose -f infra/floci/docker-compose.yml up -d"
  exit 1
fi
command -v node > /dev/null || { echo "Node.js is required (node -v)."; exit 1; }

echo "== 1/11 DynamoDB tables (with global secondary indexes for queries)"
gsi() { # gsi <index-name> <attribute>
  printf '{"IndexName":"%s","KeySchema":[{"AttributeName":"%s","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}' "$1" "$2"
}
make_table() { # make_table <Name> <attr1> <index1> [<attr2> <index2> ...]
  local name="$PREFIX$1"; shift
  local defs="AttributeName=id,AttributeType=S" idx=""
  while [ $# -gt 0 ]; do
    defs="$defs AttributeName=$1,AttributeType=S"
    idx="$idx${idx:+,}$(gsi "$2" "$1")"
    shift 2
  done
  if awsl dynamodb describe-table --table-name "$name" > /dev/null 2>&1; then
    echo "  $name (already exists)"
  elif [ -z "$idx" ]; then
    awsl dynamodb create-table --table-name "$name" \
      --attribute-definitions AttributeName=id,AttributeType=S \
      --key-schema AttributeName=id,KeyType=HASH \
      --billing-mode PAY_PER_REQUEST > /dev/null && echo "  $name created"
  else
    # shellcheck disable=SC2086
    awsl dynamodb create-table --table-name "$name" \
      --attribute-definitions $defs \
      --key-schema AttributeName=id,KeyType=HASH \
      --global-secondary-indexes "[$idx]" \
      --billing-mode PAY_PER_REQUEST > /dev/null && echo "  $name created"
  fi
}
make_table Users email email-index
make_table Listings sellerId seller-index courseCode course-index
make_table Requests listingId listing-index buyerId buyer-index sellerId seller-index
make_table Notifications userId user-index
make_table Reports listingId listing-index reporterId reporter-index status status-index
make_table Alerts userId user-index courseCode course-index
make_table Settings

echo "== 2/11 Secrets Manager: $SECRET_ID (random JWT signing key, generated here, never in Git)"
if awsl secretsmanager describe-secret --secret-id "$SECRET_ID" > /dev/null 2>&1; then
  echo "  (already exists - keeping the current key)"
else
  JWT=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
  awsl secretsmanager create-secret --name "$SECRET_ID" \
    --description "Textbook Exchange JWT signing key" \
    --secret-string "{\"jwtSecret\":\"$JWT\"}" > /dev/null && echo "  created"
  unset JWT
fi

echo "== 3/11 CloudWatch Logs: audit log group $AUDIT_LOG_GROUP (30 days retention)"
ok awsl logs create-log-group --log-group-name "$AUDIT_LOG_GROUP"
awsl logs put-retention-policy --log-group-name "$AUDIT_LOG_GROUP" --retention-in-days 30 > /dev/null 2>&1

echo "== 4/11 S3: private photo bucket $PHOTO_BUCKET"
ok awsl s3api create-bucket --bucket "$PHOTO_BUCKET"
awsl s3api put-public-access-block --bucket "$PHOTO_BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true > /dev/null 2>&1
awsl s3api put-bucket-encryption --bucket "$PHOTO_BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' > /dev/null 2>&1

echo "== 5/11 SNS topic $TOPIC_NAME + SQS queues"
TOPIC_ARN=$(awsl sns create-topic --name "$TOPIC_NAME" --query TopicArn --output text)
awsl sqs create-queue --queue-name "$EVENTS_QUEUE" > /dev/null
awsl sqs create-queue --queue-name "$DELIVERY_QUEUE" > /dev/null
QUEUE_URL=$(awsl sqs get-queue-url --queue-name "$EVENTS_QUEUE" --query QueueUrl --output text)
DELIVERY_URL=$(awsl sqs get-queue-url --queue-name "$DELIVERY_QUEUE" --query QueueUrl --output text)
DELIVERY_ARN="arn:aws:sqs:$REGION:$ACCOUNT:$DELIVERY_QUEUE"
# Only our SNS topic may write into the delivery queue
cat > "$OUT/queue-policy.json" <<JSON
{"Policy":"{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"sns.amazonaws.com\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"$DELIVERY_ARN\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"$TOPIC_ARN\"}}}]}"}
JSON
awsl sqs set-queue-attributes --queue-url "$DELIVERY_URL" --attributes "file://$OUT/queue-policy.json" > /dev/null 2>&1
if ! awsl sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --output text | grep -q "$DELIVERY_ARN"; then
  awsl sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$DELIVERY_ARN" > /dev/null
fi
echo "  TOPIC_ARN=$TOPIC_ARN"
echo "  QUEUE_URL=$QUEUE_URL"

echo "== 6/11 IAM: one least-privilege role per function"
TABLE_ARN="arn:aws:dynamodb:$REGION:$ACCOUNT:table/$PREFIX"
CRUD='"dynamodb:GetItem","dynamodb:PutItem","dynamodb:DeleteItem","dynamodb:Query","dynamodb:Scan"'
READ='"dynamodb:GetItem","dynamodb:Query","dynamodb:Scan"'
tables_arns() { local out=""; for t in "$@"; do out="$out${out:+,}\"$TABLE_ARN$t\",\"$TABLE_ARN$t/index/*\""; done; echo "$out"; }
common_statements() { # logs of its own function + audit group, read the JWT secret
  cat <<JSON
    {"Sid":"OwnLogs","Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],
     "Resource":["arn:aws:logs:$REGION:$ACCOUNT:log-group:/aws/lambda/$1:*","arn:aws:logs:$REGION:$ACCOUNT:log-group:$AUDIT_LOG_GROUP:*"]},
    {"Sid":"ReadJwtSecret","Effect":"Allow","Action":"secretsmanager:GetSecretValue",
     "Resource":"arn:aws:secretsmanager:$REGION:$ACCOUNT:secret:$SECRET_ID*"},
    {"Sid":"Notify","Effect":"Allow","Action":["sns:Publish"],"Resource":"$TOPIC_ARN"},
    {"Sid":"EventLog","Effect":"Allow","Action":["sqs:SendMessage"],"Resource":"arn:aws:sqs:$REGION:$ACCOUNT:$EVENTS_QUEUE"}
JSON
}
write_policy() { # write_policy <fn> <crud tables...> -- <read-only tables...> [photos]
  local fn="$1"; shift
  local crud_tables=() read_tables=() photos="" mode=crud
  for a in "$@"; do
    if [ "$a" = "--" ]; then mode=read; elif [ "$a" = "photos" ]; then photos=1;
    elif [ $mode = crud ]; then crud_tables+=("$a"); else read_tables+=("$a"); fi
  done
  {
    echo '{"Version":"2012-10-17","Statement":['
    common_statements "$fn"
    echo ",{\"Sid\":\"WriteTables\",\"Effect\":\"Allow\",\"Action\":[$CRUD],\"Resource\":[$(tables_arns "${crud_tables[@]}")]}"
    if [ ${#read_tables[@]} -gt 0 ]; then
      echo ",{\"Sid\":\"ReadTables\",\"Effect\":\"Allow\",\"Action\":[$READ],\"Resource\":[$(tables_arns "${read_tables[@]}")]}"
    fi
    if [ -n "$photos" ]; then
      echo ",{\"Sid\":\"Photos\",\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:PutObject\",\"s3:DeleteObject\"],\"Resource\":\"arn:aws:s3:::$PHOTO_BUCKET/listings/*\"}"
    fi
    echo ']}'
  } > "$OUT/policy-$fn.json"
}
# Which tables each function may change / only read (events between services need cross-table writes)
write_policy "$FN_IDENTITY"   Users Listings Requests Notifications Alerts photos -- Reports Settings
write_policy "$FN_LISTINGS"   Listings Settings Requests Notifications Alerts photos -- Users
write_policy "$FN_REQUESTS"   Requests Notifications Listings Alerts -- Users Settings
write_policy "$FN_MODERATION" Reports Listings Requests Notifications Users Alerts photos -- Settings
write_policy "$FN_ALERTS"     Alerts Notifications -- Listings Users Settings
write_policy "$FN_JOBS"       Listings Requests Notifications Alerts -- Users Settings
for fn in "$FN_IDENTITY" "$FN_LISTINGS" "$FN_REQUESTS" "$FN_MODERATION" "$FN_ALERTS" "$FN_JOBS"; do
  role="${fn%-fn}-role"
  ok awsl iam create-role --role-name "$role" --assume-role-policy-document file://infra/iam/trust-policy.json
  awsl iam put-role-policy --role-name "$role" --policy-name "${fn}-access" --policy-document "file://$OUT/policy-$fn.json"
  echo "  $role"
done

echo "== 7/11 Build the Lambda zip (npm install + npm run zip; .env is never included)"
(cd backend && npm install --omit=dev --no-audit --no-fund --loglevel=error && npm run zip --silent) || exit 1

echo "== 8/11 Lambda functions"
env_file() { # env_file <fn> <enabled-services>
  cat > "$OUT/env-$1.json" <<JSON
{"Variables":{
  "NODE_ENV":"production","STORAGE":"dynamodb","DYNAMODB_TABLE_PREFIX":"$PREFIX",
  "SECRETS_ID":"$SECRET_ID","AUDIT_LOG_GROUP":"$AUDIT_LOG_GROUP","CORS_ORIGINS":"$CORS_ORIGINS",
  "ENABLED_SERVICES":"$2","PHOTO_BUCKET":"$PHOTO_BUCKET","S3_FORCE_PATH_STYLE":"true",
  "TOPIC_ARN":"$TOPIC_ARN","QUEUE_URL":"$QUEUE_URL"
}}
JSON
}
deploy_fn() { # deploy_fn <fn> <handler> <enabled-services>
  local fn="$1" handler="$2" role="${1%-fn}-role"
  env_file "$fn" "$3"
  if awsl lambda get-function --function-name "$fn" > /dev/null 2>&1; then
    awsl lambda update-function-code --function-name "$fn" --zip-file fileb://backend/lambda.zip > /dev/null
    awsl lambda wait function-updated-v2 --function-name "$fn" 2>/dev/null
    awsl lambda update-function-configuration --function-name "$fn" --runtime "$RUNTIME" --handler "$handler" \
      --role "arn:aws:iam::$ACCOUNT:role/$role" --timeout 15 --memory-size 512 \
      --environment "file://$OUT/env-$fn.json" > /dev/null
    awsl lambda wait function-updated-v2 --function-name "$fn" 2>/dev/null
    echo "  $fn updated"
  else
    awsl lambda create-function --function-name "$fn" --runtime "$RUNTIME" --handler "$handler" \
      --role "arn:aws:iam::$ACCOUNT:role/$role" --zip-file fileb://backend/lambda.zip \
      --timeout 15 --memory-size 512 --environment "file://$OUT/env-$fn.json" > /dev/null || exit 1
    awsl lambda wait function-active-v2 --function-name "$fn" 2>/dev/null
    echo "  $fn created"
  fi
}
deploy_fn "$FN_IDENTITY" lambda.handler identity
deploy_fn "$FN_LISTINGS" lambda.handler listings
deploy_fn "$FN_REQUESTS" lambda.handler requests
deploy_fn "$FN_MODERATION" lambda.handler moderation
deploy_fn "$FN_ALERTS" lambda.handler alerts
deploy_fn "$FN_JOBS"     jobs.handler   listings

echo "== 9/11 API Gateway $API_NAME (explicit routes only: unknown routes never reach Lambda)"
API_ID=$(api_id)
if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
  echo "  deleting the old API $API_ID to rebuild the routes"
  awsl apigatewayv2 delete-api --api-id "$API_ID" > /dev/null
fi
API_ID=$(awsl apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP --query ApiId --output text)
integration() {
  awsl apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
    --payload-format-version 2.0 --integration-uri "arn:aws:lambda:$REGION:$ACCOUNT:function:$1" \
    --query IntegrationId --output text
}
INT_IDENTITY=$(integration "$FN_IDENTITY")
INT_LISTINGS=$(integration "$FN_LISTINGS")
INT_REQUESTS=$(integration "$FN_REQUESTS")
INT_MODERATION=$(integration "$FN_MODERATION")
INT_ALERTS=$(integration "$FN_ALERTS")
routes() { # routes <integration-id> "METHOD /path" ...
  local target="$1"; shift
  local seen_paths=""
  for r in "$@"; do
    awsl apigatewayv2 create-route --api-id "$API_ID" --route-key "$r" --target "integrations/$target" > /dev/null
    local p="${r#* }"
    case " $seen_paths " in *" $p "*) ;; *)
      seen_paths="$seen_paths $p"
      awsl apigatewayv2 create-route --api-id "$API_ID" --route-key "OPTIONS $p" --target "integrations/$target" > /dev/null ;;
    esac
  done
}
routes "$INT_IDENTITY" \
  "GET /api/health" \
  "POST /api/auth/register" "POST /api/auth/login" "POST /api/auth/logout" \
  "GET /api/users/me" "PATCH /api/users/me" "PUT /api/users/me/password" \
  "GET /api/admin/users" "PATCH /api/admin/users/{id}/status" "PATCH /api/admin/users/{id}/role" \
  "GET /api/admin/stats" "POST /api/admin/jobs/run"
routes "$INT_LISTINGS" \
  "GET /api/listings" "POST /api/listings" "GET /api/listings/mine" "GET /api/listings/price-guide" \
  "GET /api/listings/{id}" "PUT /api/listings/{id}" "DELETE /api/listings/{id}" \
  "PATCH /api/listings/{id}/status" "POST /api/listings/{id}/renew" \
  "POST /api/listings/{id}/photo" "GET /api/listings/{id}/photo" \
  "GET /api/books/isbn/{isbn}" \
  "GET /api/settings/semester" "PUT /api/admin/semester"
routes "$INT_REQUESTS" \
  "POST /api/requests" "GET /api/requests" "GET /api/requests/{id}" "PATCH /api/requests/{id}/status" \
  "GET /api/notifications" "PATCH /api/notifications/{id}/read" "POST /api/notifications/read-all"
routes "$INT_MODERATION" \
  "POST /api/reports" "GET /api/reports/mine" \
  "GET /api/admin/reports" "PATCH /api/admin/reports/{listingId}/decision"
routes "$INT_ALERTS" \
  "POST /api/alerts" "GET /api/alerts" "PATCH /api/alerts/{id}" "DELETE /api/alerts/{id}" "GET /api/alerts/{id}/matches"
awsl apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy > /dev/null
for fn in "$FN_IDENTITY" "$FN_LISTINGS" "$FN_REQUESTS" "$FN_MODERATION" "$FN_ALERTS"; do
  awsl lambda remove-permission --function-name "$fn" --statement-id apigw-invoke > /dev/null 2>&1
  awsl lambda add-permission --function-name "$fn" --statement-id apigw-invoke \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" > /dev/null
done
API_URL="http://$API_ID.execute-api.localhost.floci.io:4566"
echo "  API_URL=$API_URL"

echo "== 10/11 EventBridge: run tbx-jobs-fn every hour (listing + reservation expiry)"
awsl events put-rule --name "$RULE_NAME" --schedule-expression "rate(1 hour)" --state ENABLED \
  --description "Expire listings at semester end and reservations after 72 hours" > /dev/null
awsl lambda remove-permission --function-name "$FN_JOBS" --statement-id events-invoke > /dev/null 2>&1
awsl lambda add-permission --function-name "$FN_JOBS" --statement-id events-invoke \
  --action lambda:InvokeFunction --principal events.amazonaws.com \
  --source-arn "arn:aws:events:$REGION:$ACCOUNT:rule/$RULE_NAME" > /dev/null
awsl events put-targets --rule "$RULE_NAME" \
  --targets "Id=jobs,Arn=arn:aws:lambda:$REGION:$ACCOUNT:function:$FN_JOBS" > /dev/null
echo "  rule $RULE_NAME -> $FN_JOBS"

echo "== 11/11 Website on S3 bucket $WEB_BUCKET (only the frontend folder is uploaded)"
sed -i "s#^const FLOCI_API = .*#const FLOCI_API = '$API_URL';#" frontend/js/config.js
ok awsl s3api create-bucket --bucket "$WEB_BUCKET"
awsl s3 sync frontend "s3://$WEB_BUCKET" --delete \
  --exclude "package.json" --exclude "vercel.json" --exclude "node_modules/*" --exclude "*.md" > /dev/null
awsl s3 cp frontend/css "s3://$WEB_BUCKET/css" --recursive --content-type text/css > /dev/null
awsl s3 cp frontend/js "s3://$WEB_BUCKET/js" --recursive --content-type text/javascript > /dev/null
awsl s3 cp frontend/index.html "s3://$WEB_BUCKET/index.html" --content-type text/html > /dev/null

cat > "$OUT/floci.env" <<ENV
API_URL=$API_URL
API_ID=$API_ID
TOPIC_ARN=$TOPIC_ARN
QUEUE_URL=$QUEUE_URL
DELIVERY_URL=$DELIVERY_URL
WEB_URL=$ENDPOINT/$WEB_BUCKET/index.html
ENV

echo
echo "Done."
echo "  Website:  $ENDPOINT/$WEB_BUCKET/index.html"
echo "  API:      $API_URL/api/health"
echo "  Console:  $ENDPOINT/_floci/ui"
echo "Next: bash infra/seed-floci.sh   then   bash infra/check-floci.sh"
