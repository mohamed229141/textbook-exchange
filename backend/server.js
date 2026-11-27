// Runs the Express app on your PC: npm run dev -> http://localhost:3000
const app = require('./app');
const config = require('./src/config');

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Textbook Exchange API on http://localhost:${config.port} (storage: ${config.storage})`);
  });
}

// Vercel turns the exported Express app into one serverless function.
module.exports = app;
