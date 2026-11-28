// In-process domain event bus: how the three services talk to each other
// without importing each other's internals in a circle.
//   identity  --user.suspended------->  listings (remove listings), requests (cancel requests)
//   listings  --listing.statusChanged->  requests (decline / complete / cancel requests)
//   listings  --listing.removed------->  requests (decline pending requests)
// Handlers are awaited, so all side effects finish before the HTTP answer
// (important on Lambda: the process is frozen right after the response).
const { log } = require('./logger');

const handlers = new Map();

function on(name, handler) {
  if (!handlers.has(name)) handlers.set(name, []);
  handlers.get(name).push(handler);
}

async function emit(name, payload) {
  for (const handler of handlers.get(name) || []) {
    try {
      await handler(payload);
    } catch (err) {
      log('error', 'event handler failed', { event: name, error: err.message });
    }
  }
}

module.exports = { on, emit };
