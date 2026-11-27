// Lambda handler for the scheduled job (function tbx-jobs-fn, handler jobs.handler).
// Triggered every hour by the EventBridge rule tbx-expiry-schedule.
const { runAllJobs } = require('./src/jobsRunner');

module.exports.handler = async (event) => {
  const trigger = event && event.source === 'aws.events' ? 'eventbridge-schedule' : 'manual-invoke';
  const result = await runAllJobs({ trigger });
  console.log(JSON.stringify({ message: 'jobs finished', ...result }));
  return result;
};
