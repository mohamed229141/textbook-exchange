// Notifications for the Requests service (Student C).
//   1. In-app notification  -> Notifications table (what the bell icon in the UI shows)
//   2. Amazon SNS topic     -> TOPIC_ARN (fan-out: e-mail/SMS subscribers on real AWS,
//                              and the SQS queue below is subscribed to it)
//   3. Amazon SQS queue     -> QUEUE_URL (durable event log for later processing,
//                              e.g. an analytics or e-mail worker)
// SNS/SQS failures never fail the user's request: they are logged and skipped.
const crypto = require('crypto');
const config = require('../../config');
const { tables } = require('../../store');
const { log } = require('../../lib/logger');

let sns;
let sqs;

const withTimeout = (promise, ms = 2000) => Promise.race([
  promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms).unref())
]);

async function publishToSns(event) {
  if (!config.topicArn) return;
  const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
  sns = sns || new SNSClient({});
  await withTimeout(sns.send(new PublishCommand({
    TopicArn: config.topicArn,
    Subject: `Textbook Exchange: ${event.type}`.slice(0, 99),
    Message: JSON.stringify(event),
    MessageAttributes: { eventType: { DataType: 'String', StringValue: event.type } }
  })));
}

async function sendToSqs(event) {
  if (!config.queueUrl) return;
  const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
  // Use the configured endpoint (Floci), not the host inside the queue URL
  // (inside a Lambda container "localhost" in the queue URL is not Floci).
  sqs = sqs || new SQSClient({ useQueueUrlAsEndpoint: false });
  await withTimeout(sqs.send(new SendMessageCommand({
    QueueUrl: config.queueUrl,
    MessageBody: JSON.stringify(event),
    MessageAttributes: { eventType: { DataType: 'String', StringValue: event.type } }
  })));
}

// type: e.g. REQUEST_CREATED; userId: who gets the in-app notification
async function notify(userId, type, message, refs = {}) {
  const now = new Date().toISOString();
  const notification = {
    id: `ntf_${crypto.randomUUID().replace(/-/g, '')}`,
    userId, type, message,
    requestId: refs.requestId || null, listingId: refs.listingId || null,
    read: false, createdAt: now
  };
  await tables.notifications.create(notification);
  const event = { type, userId, message, ...refs, at: now };
  const results = await Promise.allSettled([publishToSns(event), sendToSqs(event)]);
  results.filter((r) => r.status === 'rejected')
    .forEach((r) => log('warn', 'event publish failed', { type, error: r.reason.message }));
  return notification;
}

module.exports = { notify };
