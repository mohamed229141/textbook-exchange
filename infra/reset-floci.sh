#!/usr/bin/env bash
# Deletes everything deploy-floci.sh created on Floci (data included!). Then run deploy again.
cd "$(dirname "$0")/.." || exit 1
source infra/_lib.sh
read -r -p "Delete ALL Textbook Exchange resources and data on Floci? (yes/no) " answer
[ "$answer" = "yes" ] || exit 0

for id in $(awsl apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId" --output text 2>/dev/null); do
  awsl apigatewayv2 delete-api --api-id "$id" && echo "deleted API $id"
done
awsl events remove-targets --rule "$RULE_NAME" --ids jobs > /dev/null 2>&1
awsl events delete-rule --name "$RULE_NAME" > /dev/null 2>&1 && echo "deleted rule $RULE_NAME"
for fn in "$FN_IDENTITY" "$FN_LISTINGS" "$FN_REQUESTS" "$FN_MODERATION" "$FN_ALERTS" "$FN_JOBS"; do
  awsl lambda delete-function --function-name "$fn" > /dev/null 2>&1 && echo "deleted function $fn"
  role="${fn%-fn}-role"
  awsl iam delete-role-policy --role-name "$role" --policy-name "${fn}-access" > /dev/null 2>&1
  awsl iam delete-role --role-name "$role" > /dev/null 2>&1 && echo "deleted role $role"
done
for t in Users Listings Requests Notifications Reports Alerts Settings; do
  awsl dynamodb delete-table --table-name "$PREFIX$t" > /dev/null 2>&1 && echo "deleted table $PREFIX$t"
done
for b in "$WEB_BUCKET" "$PHOTO_BUCKET"; do awsl s3 rb "s3://$b" --force > /dev/null 2>&1 && echo "deleted bucket $b"; done
TOPIC_ARN="arn:aws:sns:$REGION:$ACCOUNT:$TOPIC_NAME"
awsl sns delete-topic --topic-arn "$TOPIC_ARN" > /dev/null 2>&1 && echo "deleted topic $TOPIC_NAME"
for q in "$EVENTS_QUEUE" "$DELIVERY_QUEUE"; do
  url=$(awsl sqs get-queue-url --queue-name "$q" --query QueueUrl --output text 2>/dev/null)
  [ -n "$url" ] && awsl sqs delete-queue --queue-url "$url" && echo "deleted queue $q"
done
awsl secretsmanager delete-secret --secret-id "$SECRET_ID" --force-delete-without-recovery > /dev/null 2>&1 && echo "deleted secret $SECRET_ID"
awsl logs delete-log-group --log-group-name "$AUDIT_LOG_GROUP" > /dev/null 2>&1 && echo "deleted log group $AUDIT_LOG_GROUP"
sed -i "s#^const FLOCI_API = .*#const FLOCI_API = 'http://YOUR-API-ID.execute-api.localhost.floci.io:4566';#" frontend/js/config.js
rm -rf out
echo "Reset done. Rebuild with: bash infra/deploy-floci.sh"
