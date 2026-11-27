# Textbook Exchange (Team 44)

Students list used textbooks by course code, condition and price. Buyers send requests, sellers
reserve or sell, and listings expire at the end of the semester.

One web application (HTML/CSS/JS + Node.js/Express) made of **four services (two per student)**
plus a shared login module, deployed on **Floci** (local AWS): API Gateway, Lambda, DynamoDB, S3, IAM,
Secrets Manager, CloudWatch Logs, EventBridge, SNS and SQS. External API: **Google Books** (ISBN
verification and autofill).

| Service | Owner | Code | AWS services |
|---|---|---|---|
| Book Listing | Mohamed Al Ghazaly (229141) | `backend/src/services/listings/` | Lambda `tbx-listings-fn` + `tbx-jobs-fn`, DynamoDB `TbxListings` + `TbxSettings`, S3 photos, EventBridge, IAM |
| Course Alerts | Mohamed Al Ghazaly | `backend/src/services/alerts/` | Lambda `tbx-alerts-fn`, DynamoDB `TbxAlerts`, SNS/SQS (via notifications), IAM |
| Purchase Request | Tarek Waleed (236288) | `backend/src/services/requests/` | Lambda `tbx-requests-fn`, DynamoDB `TbxRequests` + `TbxNotifications`, SNS, SQS, IAM |
| Moderation & Reports | Tarek Waleed | `backend/src/services/moderation/` | Lambda `tbx-moderation-fn`, DynamoDB `TbxReports`, CloudWatch Logs, IAM |
| Shared login and roles (not a service) | Tarek lead, Mohamed support | `backend/src/services/identity/`, `src/middleware/` | Lambda `tbx-identity-fn`, DynamoDB `TbxUsers`, Secrets Manager |

## Run on your PC (quick start, no AWS)

```bash
cd backend
npm install
cp .env.example .env          # then put a random value in JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
DEMO_PASSWORD='Demo-Pass1' npm run seed:demo
ADMIN_EMAIL=admin@uni.edu ADMIN_PASSWORD='Admin-Pass1' npm run seed:admin
npm run dev                   # http://localhost:3000/api/health

# second terminal
cd frontend && npm install && npm start     # http://localhost:8080
```

Data is kept in `backend/data/db.json` (git-ignored).

## Deploy on Floci (the required deployment)

Git Bash, in the project folder, Docker Desktop running, AWS CLI + Node.js installed:

```bash
docker compose -f infra/floci/docker-compose.yml up -d
bash infra/deploy-floci.sh                 # builds everything (re-runnable)
bash infra/seed-floci.sh                   # first admin + demo data (asks for passwords)
bash infra/check-floci.sh | tee docs/evidence/check-floci.txt   # expect "0 failed"
```

- Website: http://localhost:4566/tbx-web/index.html
- Floci Dash: http://localhost:4566/_floci/ui
- Use the AWS CLI on Floci in a new window: `source infra/_lib.sh` then `awsl ...`
- Logs: `awsl logs tail /aws/lambda/tbx-requests-fn --since 10m`,
  `awsl logs filter-log-events --log-group-name /tbx/audit --filter-pattern SECURITY`
- Start again from zero: `bash infra/reset-floci.sh`

Optional: run the PC backend against Floci's DynamoDB (uncomment the DynamoDB lines in `.env`),
or use Neon (`DATABASE_URL` + run `backend/db/schema.sql` once).

## Tests

```bash
cd backend
npm test        # 44 tests: business rules of all 4 services, cross-service flows, 15 security tests
# the security tests against the deployed Floci API:
API_URL=$(grep API_URL ../out/floci.env | cut -d= -f2) ADMIN_EMAIL=admin@uni.edu ADMIN_PASSWORD='...' \
  node --test test/security.test.js
```

## Before you push

```bash
bash infra/check-secrets.sh     # scans files AND git history: expect "No secrets found"
git status                      # .env, out/, *.zip, backend/data/ must not appear
```

## API

42 routes (76 in API Gateway with the CORS OPTIONS routes); see the report section 4. Health: `GET /api/health` returns runtime (`lambda`/`pc`), storage
and the Lambda function name.

## Demo video plan (max 5 minutes)

| Time | Show |
|---|---|
| 0:00-0:30 | Floci Dash: 4 Lambda functions, 4 DynamoDB tables, S3 buckets, API routes, EventBridge rule, SNS/SQS |
| 0:30-1:30 | Website from S3: browse by course code, price guide. Sign up as a seller, Sell a book: ISBN **Look up** (Google Books), photo upload |
| 1:30-2:45 | Log in as buyer: request the book with an offer. Seller: bell notification, Accept (book Reserved, contact shown), Mark completed (Sold) |
| 2:45-3:30 | Course alert fires when a matching book is listed; report a listing; Admin page: reports queue (uphold/dismiss), semester end setting, stats |
| 3:30-4:30 | Security: `bash infra/check-floci.sh` security section (401/403/IDOR/CORS), audit log in CloudWatch `/tbx/audit`, SQS messages |
| 4:30-5:00 | `npm test` result (37 passing) and `check-secrets.sh` |

## Folders

| Folder | What |
|---|---|
| `backend/` | Express app (`app.js`), Lambda handlers (`lambda.js`, `jobs.js`), services, storage, tests |
| `frontend/` | `index.html`, `css/`, `js/config.js` (API address), `js/api.js`, `js/app.js` |
| `infra/` | Floci docker-compose, deploy / seed / check / reset scripts, IAM trust policy |
| `docs/evidence/` | screenshots and check outputs for the report |
