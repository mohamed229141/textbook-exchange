// The data model: 7 tables, which service owns each one, and the secondary
// indexes used for queries. Every item has: id (partition key) and version
// (optimistic locking: an update only succeeds if nobody changed the item since it was read).
//
//  Table          Owner                     Indexes (attribute -> index name)
//  Users          shared login (Tarek lead) email      -> email-index
//  Listings       Book Listing (Mohamed)    sellerId   -> seller-index,  courseCode -> course-index
//  Settings       Book Listing (Mohamed)    (none: one item per setting, e.g. id = "semester")
//  Alerts         Course Alerts (Mohamed)   userId     -> user-index,    courseCode -> course-index
//  Requests       Purchase Request (Tarek)  listingId  -> listing-index, buyerId -> buyer-index, sellerId -> seller-index
//  Notifications  Purchase Request (Tarek)  userId     -> user-index
//  Reports        Moderation (Tarek)        listingId  -> listing-index, reporterId -> reporter-index, status -> status-index
module.exports = {
  users: { name: 'Users', indexes: { email: 'email-index' } },
  listings: { name: 'Listings', indexes: { sellerId: 'seller-index', courseCode: 'course-index' } },
  settings: { name: 'Settings', indexes: {} },
  alerts: { name: 'Alerts', indexes: { userId: 'user-index', courseCode: 'course-index' } },
  requests: { name: 'Requests', indexes: { listingId: 'listing-index', buyerId: 'buyer-index', sellerId: 'seller-index' } },
  notifications: { name: 'Notifications', indexes: { userId: 'user-index' } },
  reports: { name: 'Reports', indexes: { listingId: 'listing-index', reporterId: 'reporter-index', status: 'status-index' } }
};
