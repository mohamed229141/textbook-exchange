#!/usr/bin/env bash
# Tests the deployed system on Floci end to end: AWS resources, the 3 services working
# together, the integrations (S3, SNS, SQS, CloudWatch, EventBridge/Lambda) and security.
#   bash infra/check-floci.sh            -> expect "Result: N passed, 0 failed"
# Save the output as evidence:  bash infra/check-floci.sh | tee docs/evidence/check-floci.txt
cd "$(dirname "$0")/.." || exit 1
source infra/_lib.sh

API_ID=$(api_id)
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then echo "No API $API_NAME. Run: bash infra/deploy-floci.sh"; exit 1; fi
API="http://$API_ID.execute-api.localhost.floci.io:4566"
ORIGIN="http://localhost:4566"
T="$OUT/check"; mkdir -p "$T"
PASS=0; FAIL=0
pass() { echo "PASS $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL $1"; [ -n "${2:-}" ] && echo "     -> $2"; FAIL=$((FAIL + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1" "${3:-}"; fi; }

# req METHOD PATH [TOKEN] [JSON] -> CODE, BODY
req() {
  local auth=() data=()
  [ -n "${3:-}" ] && auth=(-H "Authorization: Bearer $3")
  [ -n "${4:-}" ] && data=(-H 'Content-Type: application/json' --data "$4")
  CODE=$(curl -s -X "$1" -o "$T/body" -D "$T/head" -w '%{http_code}' --max-time 40 "${auth[@]}" "${data[@]}" "$API$2")
  BODY=$(cat "$T/body" 2>/dev/null)
}
json() { node -e "let o;try{o=JSON.parse(require('fs').readFileSync(0,'utf8'))}catch{process.exit(0)};const v=($1);if(v!==undefined)console.log(typeof v==='object'?JSON.stringify(v):v)" <<< "$BODY"; }

echo "Checking Textbook Exchange on Floci"
echo "API: $API"
echo
echo "--- AWS resources"
for t in Users Listings Requests Notifications Reports Alerts Settings; do
  check "DynamoDB table $PREFIX$t exists" "awsl dynamodb describe-table --table-name $PREFIX$t > /dev/null 2>&1"
done
check "Secrets Manager secret $SECRET_ID exists" "awsl secretsmanager describe-secret --secret-id $SECRET_ID > /dev/null 2>&1"
check "CloudWatch log group $AUDIT_LOG_GROUP exists" "awsl logs describe-log-groups --log-group-name-prefix $AUDIT_LOG_GROUP --output text | grep -q $AUDIT_LOG_GROUP"
check "S3 buckets $WEB_BUCKET and $PHOTO_BUCKET exist" "awsl s3api head-bucket --bucket $WEB_BUCKET 2>/dev/null && awsl s3api head-bucket --bucket $PHOTO_BUCKET 2>/dev/null"
check "SNS topic $TOPIC_NAME exists" "awsl sns list-topics --output text | grep -q $TOPIC_NAME"
check "SQS queues exist" "awsl sqs get-queue-url --queue-name $EVENTS_QUEUE > /dev/null 2>&1 && awsl sqs get-queue-url --queue-name $DELIVERY_QUEUE > /dev/null 2>&1"
check "EventBridge rule $RULE_NAME exists" "awsl events describe-rule --name $RULE_NAME > /dev/null 2>&1"
for fn in "$FN_IDENTITY" "$FN_LISTINGS" "$FN_REQUESTS" "$FN_MODERATION" "$FN_ALERTS" "$FN_JOBS"; do
  check "Lambda $fn exists" "awsl lambda get-function --function-name $fn > /dev/null 2>&1"
done

echo
echo "--- the four services (and shared login) through API Gateway"
req GET /api/health
check "GET /api/health answers 200 from Lambda" "[ \"\$CODE\" = 200 ] && echo \"\$BODY\" | grep -q lambda" "Body: $BODY"
SUFFIX=$(date +%s)
req POST /api/auth/register "" "{\"email\":\"seller$SUFFIX@student.edu\",\"password\":\"Check-Pass1\",\"displayName\":\"Check Seller\"}"
SELLER=$(json o.token); SELLER_ID=$(json o.user.id)
check "Identity: register seller 201" "[ \"\$CODE\" = 201 ] && [ -n '$SELLER' ]" "Body: $BODY"
req POST /api/auth/register "" "{\"email\":\"buyer$SUFFIX@student.edu\",\"password\":\"Check-Pass1\",\"displayName\":\"Check Buyer\"}"
BUYER=$(json o.token)
req POST /api/auth/login "" "{\"email\":\"buyer$SUFFIX@student.edu\",\"password\":\"Check-Pass1\"}"
check "Identity: login 200 (JWT signed with the key from Secrets Manager)" "[ \"\$CODE\" = 200 ]" "Body: $BODY"
req POST /api/auth/register "" "{\"email\":\"eve$SUFFIX@student.edu\",\"password\":\"Check-Pass1\",\"displayName\":\"Eve\"}"
EVE=$(json o.token)
req POST /api/alerts "$BUYER" '{"courseCode":"CHK101","maxPrice":600}'
check "Course Alerts: buyer follows CHK101 (201)" "[ \"\$CODE\" = 201 ]" "Body: $BODY"
req GET /api/settings/semester
check "Book Listing: semester end is readable ($(json o.name), $(json o.source))" "[ \"\$CODE\" = 200 ]"

req POST /api/listings "$SELLER" '{"courseCode":"CHK101","title":"Introduction to Algorithms","author":"Cormen","isbn":"9780262033848","condition":"Good","price":500}'
LISTING=$(json o.id)
check "Listings: create listing 201" "[ \"\$CODE\" = 201 ] && [ -n '$LISTING' ]" "Body: $BODY"
if [ "$(json o.isbnVerified)" = "true" ]; then pass "Listings: ISBN verified by Google Books (external API)";
else echo "INFO Google Books not reachable from the Lambda container (listing saved unverified)"; fi
req GET /api/notifications "$BUYER"
check "Integration: new listing matched the buyer's course alert (Listings -> Alerts)" "echo \"\$BODY\" | grep -q COURSE_ALERT_MATCH" "Body: $BODY"
req POST /api/reports "$EVE" "{\"listingId\":\"$LISTING\",\"reason\":\"wrong_details\",\"details\":\"check script report\"}"
check "Moderation: student reports a listing (201)" "[ \"\$CODE\" = 201 ]" "Body: $BODY"
req POST /api/reports "$SELLER" "{\"listingId\":\"$LISTING\",\"reason\":\"scam\"}"
check "Moderation: seller cannot report own listing (403)" "[ \"\$CODE\" = 403 ]"
req GET "/api/listings?courseCode=CHK101"
check "Listings: search by course code (DynamoDB Query on course-index)" "[ \"\$CODE\" = 200 ] && echo \"\$BODY\" | grep -q '$LISTING'"
PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
req POST "/api/listings/$LISTING/photo" "$SELLER" "{\"data\":\"$PNG\"}"
check "Listings: photo upload 200" "[ \"\$CODE\" = 200 ]" "Body: $BODY"
check "S3: photo object stored in private bucket $PHOTO_BUCKET" "awsl s3 ls s3://$PHOTO_BUCKET/listings/$LISTING/ | grep -q png"
P_CODE=$(curl -s -o out/.discard -w '%{http_code}' "$ENDPOINT/$PHOTO_BUCKET/listings/$LISTING/")
req GET "/api/listings/$LISTING/photo"
check "Listings: photo read back through the API" "[ \"\$CODE\" = 200 ] && echo \"\$BODY\" | grep -q image/png"

req POST /api/requests "$BUYER" "{\"listingId\":\"$LISTING\",\"offerPrice\":450,\"message\":\"check\"}"
REQUEST=$(json o.id)
check "Requests: purchase request 201" "[ \"\$CODE\" = 201 ] && [ -n '$REQUEST' ]" "Body: $BODY"
req GET /api/notifications "$SELLER"
check "Requests: seller got an in-app notification" "[ '$(json o.unread)' -ge 1 ] 2>/dev/null"
req PATCH "/api/requests/$REQUEST/status" "$SELLER" '{"status":"Accepted"}'
check "Requests: seller accepts 200, contact details shared" "[ \"\$CODE\" = 200 ] && echo \"\$BODY\" | grep -q contact" "Body: $BODY"
req GET "/api/listings/$LISTING"
check "Integration: listing became Reserved (Requests -> Listings)" "[ '$(json o.status)' = Reserved ]"
req PATCH "/api/requests/$REQUEST/status" "$SELLER" '{"status":"Completed"}'
req GET "/api/listings/$LISTING"
check "Integration: completing the request marks the listing Sold" "[ '$(json o.status)' = Sold ]"

sleep 2
EVENTS_URL=$(awsl sqs get-queue-url --queue-name "$EVENTS_QUEUE" --query QueueUrl --output text)
DELIVERY_URL=$(awsl sqs get-queue-url --queue-name "$DELIVERY_QUEUE" --query QueueUrl --output text)
N1=$(awsl sqs get-queue-attributes --queue-url "$EVENTS_URL" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)
N2=$(awsl sqs get-queue-attributes --queue-url "$DELIVERY_URL" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)
check "SQS: request events in $EVENTS_QUEUE ($N1 messages)" "[ '${N1:-0}' -gt 0 ] 2>/dev/null"
check "SNS -> SQS: notifications delivered to $DELIVERY_QUEUE ($N2 messages)" "[ '${N2:-0}' -gt 0 ] 2>/dev/null"
check "CloudWatch Logs: audit events written to $AUDIT_LOG_GROUP" \
  "awsl logs filter-log-events --log-group-name $AUDIT_LOG_GROUP --filter-pattern REQUEST_CREATED --query 'events[0].message' --output text | grep -q REQUEST_CREATED"
awsl lambda invoke --function-name "$FN_JOBS" --payload '{"source":"manual"}' --cli-binary-format raw-in-base64-out "$T/jobs.json" > /dev/null 2>&1
check "Lambda $FN_JOBS (EventBridge target) runs the expiry job" "grep -q expiredListings '$T/jobs.json'" "$(cat "$T/jobs.json" 2>/dev/null)"

echo
echo "--- security"
req GET /api/users/me
check "SEC no token -> 401" "[ \"\$CODE\" = 401 ]"
req GET /api/users/me "${SELLER%?}x"
check "SEC tampered token -> 401" "[ \"\$CODE\" = 401 ]"
req GET /api/admin/users "$EVE"
check "SEC student on admin route -> 403" "[ \"\$CODE\" = 403 ]"
req GET /api/admin/reports "$EVE"
check "SEC student on moderation queue -> 403" "[ \"\$CODE\" = 403 ]"
req PUT "/api/listings/$LISTING" "$EVE" '{"courseCode":"CHK101","title":"Hacked","author":"Eve","condition":"Good","price":1}'
check "SEC IDOR edit another user's listing -> 403" "[ \"\$CODE\" = 403 ]"
req GET "/api/requests/$REQUEST" "$EVE"
check "SEC IDOR read another user's request -> 403" "[ \"\$CODE\" = 403 ]"
req PATCH /api/users/me "$EVE" '{"role":"admin"}'
check "SEC mass assignment role=admin -> 400" "[ \"\$CODE\" = 400 ]"
req POST /api/listings "$EVE" '{"courseCode":"X","title":"","author":"","condition":"Mint","price":-1}'
check "SEC invalid input -> 400" "[ \"\$CODE\" = 400 ]"
req DELETE /api/health
check "SEC unknown route stopped by API Gateway (404, Lambda never ran)" "[ \"\$CODE\" = 404 ] && ! echo \"\$BODY\" | grep -q ROUTE_NOT_FOUND" "Body: $BODY"
H=$(curl -s -o out/.discard -D - -X OPTIONS -H 'Origin: http://evil.example' -H 'Access-Control-Request-Method: POST' "$API/api/listings" | tr -d '\r')
check "SEC CORS refuses http://evil.example" "! echo \"\$H\" | grep -qi '^access-control-allow-origin'"
H=$(curl -s -o out/.discard -D - -X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' "$API/api/listings" | tr -d '\r')
check "SEC CORS allows the website $ORIGIN" "echo \"\$H\" | grep -qi '^access-control-allow-origin: $ORIGIN'"
check "SEC photo bucket is not public (anonymous GET refused)" "[ '$P_CODE' != 200 ]"

echo
echo "--- website"
W=$(curl -s -o "$T/index" -w '%{http_code}' "$ENDPOINT/$WEB_BUCKET/index.html")
check "index.html served from S3" "[ '$W' = 200 ] && grep -q 'Textbook Exchange' '$T/index'"
check "config.js points at this API" "curl -s $ENDPOINT/$WEB_BUCKET/js/config.js | grep -q $API_ID"
E1=$(curl -s -o out/.discard -w '%{http_code}' "$ENDPOINT/$WEB_BUCKET/.env")
E2=$(curl -s -o out/.discard -w '%{http_code}' "$ENDPOINT/$WEB_BUCKET/backend/.env")
check "no .env or backend files in the website bucket" "[ '$E1' != 200 ] && [ '$E2' != 200 ]"

rm -rf "$T"
echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
