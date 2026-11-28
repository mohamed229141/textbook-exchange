// Academic calendar: a listing expires at the end of the semester it was posted in.
//   Fall   : 1 Sep  - 31 Jan (next year)
//   Spring : 1 Feb  - 30 Jun
//   Summer : 1 Jul  - 31 Aug
// Calculated from the date, so nothing needs to be updated every year.

function endOfDayUtc(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day, 23, 59, 59));
}

function semesterFor(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0 = Jan
  if (m === 0) return { name: `Fall ${y - 1}`, endsAt: endOfDayUtc(y, 0, 31) };
  if (m >= 1 && m <= 5) return { name: `Spring ${y}`, endsAt: endOfDayUtc(y, 5, 30) };
  if (m === 6 || m === 7) return { name: `Summer ${y}`, endsAt: endOfDayUtc(y, 7, 31) };
  return { name: `Fall ${y}`, endsAt: endOfDayUtc(y + 1, 0, 31) };
}

module.exports = { semesterFor };
