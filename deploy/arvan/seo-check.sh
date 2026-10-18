#!/usr/bin/env bash
# Read-only: why a kind of page is (not) in search.
#   bash deploy/arvan/seo-check.sh
# Per page type: records, how many are public (what the page and the
# sitemap count as visible), how many have a slug (the sitemap lists only
# those), and whether «سئوی خودکار» marks the type noindex. Then one live
# page of each type: its HTTP status and robots meta. Nothing is written.
set -euo pipefail
APP_DIR=/var/www/noyanai-ts
STATE=/root/.noyanai-ts
CONTAINER=noyanai-mongo
PASSWORD="$(cat "$STATE/mongo_password")"
DB="$(grep -E '^DB_NAME=' "$APP_DIR/back/.env" | cut -d= -f2 | tr -d '\r')"
DB="${DB:-NoyanAiTs}"
cat > "$STATE/seo-check.js" <<'JS'
const d = db.getSiblingDB(process.env.S_DB);
const medical = { published: { $ne: false } };
const types = [
  ["dr", "doctorprofiles", { active: true }],
  ["clinic", "clinics", { active: true }],
  ["hospital", "hospitals", { isActive: true }],
  ["paraClinic", "paraclinics", { active: true }],
  ["pharmacy", "pharmacies", { active: true }],
  ["insurance", "insurances", { active: true }],
  ["speciality", "specialities", { active: true }],
  ["service", "services", { isActive: true }],
  ["servicePackage", "servicepackages", { isActive: true }],
  ["product", "products", { isActive: true }],
  ["productPackage", "productpackages", { isActive: true }],
  ["test", "tests", { isActive: true }],
  ["mag", "blogs", { published: true }],
  ["disease", "diseases", medical],
  ["drug", "drugs", medical],
  ["symptom", "symptoms", medical],
];
const slug = { slug: { $exists: true, $nin: [null, ""] } };
print("type".padEnd(16) + "records".padStart(9) + "public".padStart(9) + "slug".padStart(9) + "in-sitemap".padStart(12) + "  noindex-type  sample");
for (const [type, col, vis] of types) {
  const c = d[col];
  const total = c.estimatedDocumentCount();
  const v = vis;
  const isPub = c.countDocuments(v);
  const withSlug = c.countDocuments(slug);
  const inMap = c.countDocuments({ ...v, ...slug });
  const path = type === "mag" ? "/mag/[blogSlug]" : `/${type}/[slug]`;
  const noidx = d.seotemplates.countDocuments({ resourceType: path, noIndex: true }) ? "YES" : "-";
  const s = c.findOne({ ...v, ...slug }, { slug: 1 });
  print(type.padEnd(16) + String(total).padStart(9) + String(isPub).padStart(9) + String(withSlug).padStart(9) + String(inMap).padStart(12) + "  " + noidx.padEnd(12) + "  " + (s ? `/${type}/${s.slug}` : ""));
}
JS
docker cp "$STATE/seo-check.js" "$CONTAINER:/tmp/seo-check.js"
docker exec -e S_DB="$DB" "$CONTAINER" mongosh --quiet -u noyanai -p "$PASSWORD" --authenticationDatabase admin --file /tmp/seo-check.js \
  | tee "$STATE/seo-check.txt"
docker exec "$CONTAINER" rm -f /tmp/seo-check.js
echo
echo "live pages (status, robots meta):"
grep -oE ' /[A-Za-z]+/[^ ]+$' "$STATE/seo-check.txt" | while read -r path; do
  html="$(curl -s -m 30 -w '\n%{http_code}' "http://127.0.0.1:3100$(printf '%s' "$path" | sed 's/ /%20/g')" || true)"
  code="$(printf '%s' "$html" | tail -n1)"
  robots="$(printf '%s' "$html" | grep -oE '<meta name="robots" content="[^"]*"' | head -1 | sed 's/.*content=//')"
  printf '  %-60s %s %s\n' "$path" "$code" "${robots:-(no robots meta = indexable)}"
done
echo
echo "sitemap index:"
curl -s -m 30 http://127.0.0.1:3100/sitemap.xml | grep -oE '<loc>[^<]+' | sed 's/<loc>/  /' | head -40
