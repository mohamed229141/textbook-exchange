#!/usr/bin/env bash
# Creates the first admin and (optionally) demo data in the DynamoDB tables on Floci.
# Passwords are typed in (or passed as environment variables): never stored in the repo.
#   bash infra/seed-floci.sh
#   ADMIN_EMAIL=admin@uni.edu ADMIN_PASSWORD='...' DEMO_PASSWORD='...' bash infra/seed-floci.sh
cd "$(dirname "$0")/.." || exit 1
source infra/_lib.sh

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@uni.edu}"
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  read -r -s -p "Choose a password for $ADMIN_EMAIL (8+ chars, letter + digit): " ADMIN_PASSWORD; echo
fi
if [ -z "${DEMO_PASSWORD:-}" ]; then
  read -r -s -p "Password for the demo students sara@ / omar@student.edu (empty = skip demo data): " DEMO_PASSWORD; echo
fi

export STORAGE=dynamodb DYNAMODB_TABLE_PREFIX="$PREFIX" AWS_ENDPOINT_URL="$ENDPOINT" SECRETS_ID="$SECRET_ID"
(cd backend && ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" node scripts/seed-admin.js) || exit 1
if [ -n "$DEMO_PASSWORD" ]; then
  (cd backend && DEMO_PASSWORD="$DEMO_PASSWORD" node scripts/seed-demo.js)
fi
echo "Log in at $ENDPOINT/$WEB_BUCKET/index.html"
