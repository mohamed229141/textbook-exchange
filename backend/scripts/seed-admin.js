// Creates the first admin account (or promotes an existing user to admin).
// The password is read from the environment, never written in the code:
//   ADMIN_EMAIL=admin@uni.edu ADMIN_PASSWORD='...' npm run seed:admin
// Uses the same storage settings as the API (.env), e.g. DynamoDB on Floci.
const { tables } = require('../src/store');
const identity = require('../src/services/identity/identityService');

(async () => {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD, e.g.\n  ADMIN_EMAIL=admin@uni.edu ADMIN_PASSWORD=\'Choose-A-Strong-1\' npm run seed:admin');
    process.exit(1);
  }
  const existing = await identity.findByEmail(email);
  if (existing) {
    await tables.users.update({ ...existing, role: 'admin', status: 'active', tokenVersion: existing.tokenVersion + 1 }, existing.version);
    console.log(`Promoted ${email} to admin.`);
  } else {
    const { user } = await identity.register({ email, password, displayName: process.env.ADMIN_NAME || 'Platform Admin' }, { role: 'admin' });
    console.log(`Created admin ${user.email} (${user.id}).`);
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
