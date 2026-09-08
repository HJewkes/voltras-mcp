// The card label TrueCoach renders for a calendar day.
//
// Fixed English names rather than `toLocaleDateString`: the page is English
// regardless of the machine's locale, and a locale-dependent needle would make
// the workout lookup fail on someone else's laptop for no visible reason.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-09-08` becomes `Monday, September 8th`. */
export function longCardDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(`not a YYYY-MM-DD date: "${isoDate}"`);
  }
  const at = new Date(year, month - 1, day);
  return `${WEEKDAYS[at.getDay()]}, ${MONTHS[month - 1]} ${day}${ordinalSuffix(day)}`;
}

function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return 'th';
  if (day % 10 === 1) return 'st';
  if (day % 10 === 2) return 'nd';
  if (day % 10 === 3) return 'rd';
  return 'th';
}
