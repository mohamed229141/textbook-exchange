// Frontend configuration. Nothing here is secret: every visitor can read it.
// infra/deploy-floci.sh fills in FLOCI_API automatically.

// Floci: API Gateway URL (no slash at the end)
const FLOCI_API = 'http://0377300c66.execute-api.localhost.floci.io:4566';

// Optional: real AWS / Vercel
const AWS_API = 'https://YOUR-AWS-API-ID.execute-api.us-east-1.amazonaws.com';
const VERCEL_API = 'https://YOUR-API-PROJECT.vercel.app';

// Picks the API from the address the page was loaded from:
//   port 4566       -> Floci (website in the S3 bucket on Floci)
//   amazonaws.com   -> real AWS
//   localhost       -> Express on your PC (npm run dev, port 3000)
//   anything else   -> Vercel
const { hostname, port } = window.location;
let API_ROOT;
if (port === '4566') API_ROOT = FLOCI_API;
else if (hostname.endsWith('amazonaws.com')) API_ROOT = AWS_API;
else if (['localhost', '127.0.0.1'].includes(hostname)) API_ROOT = 'http://localhost:3000';
else API_ROOT = VERCEL_API;
