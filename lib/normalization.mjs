const STREET_TERMS = new Map([
  ["avenue", "ave"], ["boulevard", "blvd"], ["circle", "cir"],
  ["court", "ct"], ["drive", "dr"], ["highway", "hwy"],
  ["lane", "ln"], ["parkway", "pkwy"], ["place", "pl"],
  ["road", "rd"], ["route", "rt"], ["street", "st"],
  ["terrace", "ter"], ["trail", "trl"], ["way", "way"],
  ["north", "n"], ["south", "s"], ["east", "e"], ["west", "w"],
  ["northeast", "ne"], ["northwest", "nw"],
  ["southeast", "se"], ["southwest", "sw"],
]);

function fold(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function normalizeZip(value = "") {
  return String(value).match(/\d{5}/)?.[0] ?? "";
}

export function normalizeSimple(value = "") {
  return fold(value).replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function normalizeStreet(value = "") {
  const rawTokens = fold(value)
    .replace(/\bpost office box\b/g, "po box")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return rawTokens.map((token) => STREET_TERMS.get(token) ?? token).join(" ");
}

export function normalizeName(value = "") {
  return fold(value)
    .replace(/&/g, " and ")
    .replace(/\bcentre\b/g, "center")
    .replace(/\bhealthcare\b/g, "health care")
    .replace(/\brehab\b/g, "rehabilitation")
    .replace(/\bthe\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function addressKey(record) {
  return [
    normalizeStreet(record.billing_street ?? record.street),
    normalizeSimple(record.billing_city ?? record.city),
    normalizeSimple(record.billing_state ?? record.state),
    normalizeZip(record.billing_zip ?? record.zip),
  ].join("|");
}

export function sameAddress(left, right) {
  const leftStreet = normalizeStreet(left.billing_street ?? left.street);
  const rightStreet = normalizeStreet(right.billing_street ?? right.street);
  const leftZip = normalizeZip(left.billing_zip ?? left.zip);
  const rightZip = normalizeZip(right.billing_zip ?? right.zip);
  return Boolean(leftStreet && leftZip && leftStreet === rightStreet && leftZip === rightZip);
}

function levenshtein(left, right) {
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function nameSimilarity(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  const tokenScore = union ? intersection / union : 0;
  const editScore = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return Number((tokenScore * 0.65 + editScore * 0.35).toFixed(4));
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
