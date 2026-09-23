// Distance utilities — haversine great-circle distance.
// No external deps. Returns null when coordinates are missing so callers can
// show an honest "no reliable data" state instead of guessing.

const EARTH_RADIUS_M = 6371000;
const TO_RAD = Math.PI / 180;

function isValidCoord(lat, lng) {
  // Empty strings and nulls coerce to 0, which is a real coordinate, so reject
  // them explicitly before the numeric checks.
  if (lat === null || lat === undefined || lng === null || lng === undefined) return false;
  if (String(lat).trim() === '' || String(lng).trim() === '') return false;
  const a = Number(lat);
  const b = Number(lng);
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a) <= 90 &&
    Math.abs(b) <= 180
  );
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const a = Number(lat1);
  const b = Number(lng1);
  const c = Number(lat2);
  const d = Number(lng2);
  if (!isValidCoord(lat1, lng1) || !isValidCoord(lat2, lng2)) return null;
  const dLat = (c - a) * TO_RAD;
  const dLng = (d - b) * TO_RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a * TO_RAD) * Math.cos(c * TO_RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Distance between a school record and its nearest station, in meters.
// school: { latitude, longitude }; station: { latitude, longitude }.
function schoolStationDistance(school, station) {
  if (!school || !station) return null;
  return haversineMeters(school.latitude, school.longitude, station.latitude, station.longitude);
}

// Human-readable Chinese distance label. Returns null when distance is unavailable.
function distanceLabel(meters) {
  if (meters === null || meters === undefined) return null;
  const m = Math.max(0, Number(meters));
  if (m < 1000) return `${Math.round(m)} 米`;
  return `${(m / 1000).toFixed(1)} 公里`;
}

module.exports = { haversineMeters, schoolStationDistance, distanceLabel, isValidCoord };
