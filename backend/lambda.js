// Runs the SAME Express app on AWS Lambda (handler: lambda.handler).
// Deployed three times on Floci, one function per service:
//   tbx-identity-fn  ENABLED_SERVICES=identity
//   tbx-listings-fn  ENABLED_SERVICES=listings
//   tbx-requests-fn  ENABLED_SERVICES=requests
const serverless = require('serverless-http');
const app = require('./app');

module.exports.handler = serverless(app);
