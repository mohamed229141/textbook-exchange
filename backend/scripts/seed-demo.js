// Demo data for the video / live demo: two students and a few listings.
//   DEMO_PASSWORD='Choose-A-Strong-1' npm run seed:demo
// Accounts: sara@student.edu (seller), omar@student.edu (buyer)
const identity = require('../src/services/identity/identityService');
const listings = require('../src/services/listings/listingService');

const books = [
  { courseCode: 'CS101', title: 'Introduction to Algorithms', author: 'Cormen, Leiserson, Rivest, Stein', isbn: '9780262033848', edition: '3rd', condition: 'Good', price: 650, description: 'Some highlighting in chapters 1-4.' },
  { courseCode: 'CS201', title: 'Clean Code', author: 'Robert C. Martin', isbn: '9780132350884', condition: 'Like New', price: 400, description: 'Used for one semester.' },
  { courseCode: 'MATH101', title: 'Calculus: Early Transcendentals', author: 'James Stewart', edition: '8th', condition: 'Fair', price: 300, description: 'Cover is worn, pages fine.' },
  { courseCode: 'CS305', title: 'Computer Networking: A Top-Down Approach', author: 'Kurose, Ross', edition: '7th', condition: 'Good', price: 500 }
];

async function ensureUser(email, displayName, password) {
  const existing = await identity.findByEmail(email);
  if (existing) return identity.publicUser(existing);
  return (await identity.register({ email, password, displayName })).user;
}

(async () => {
  const password = process.env.DEMO_PASSWORD;
  if (!password) {
    console.error('Set DEMO_PASSWORD first, e.g. DEMO_PASSWORD=\'Choose-A-Strong-1\' npm run seed:demo');
    process.exit(1);
  }
  const sara = await ensureUser('sara@student.edu', 'Sara Ahmed', password);
  await ensureUser('omar@student.edu', 'Omar Hassan', password);
  for (const book of books) {
    try {
      const l = await listings.createListing(sara, book);
      console.log(`listing ${l.id}  ${l.courseCode}  ${l.title}  (isbnVerified=${l.isbnVerified})`);
    } catch (err) {
      console.log(`skipped "${book.title}": ${err.message}`);
    }
  }
  console.log('Demo users: sara@student.edu (seller), omar@student.edu (buyer) - password = DEMO_PASSWORD');
})().catch((err) => { console.error(err.message); process.exit(1); });
