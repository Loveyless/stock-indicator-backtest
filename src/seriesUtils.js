function upperBound(sortedAsc, x) {
  let lo = 0;
  let hi = sortedAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function indexOfDate(sortedDatesYmd, ymd) {
  const i = upperBound(sortedDatesYmd, ymd) - 1;
  if (i >= 0 && i < sortedDatesYmd.length && sortedDatesYmd[i] === ymd) return i;
  return -1;
}

module.exports = {
  upperBound,
  indexOfDate,
};

