# AI Trip Planner (AI行程规划)

Type any destination → AI writes a full day-by-day trip in the same format as the Kanto trip app
(`../kanto-trip-app`, which this was copied from and which stays untouched). Single static `index.html`,
no build step, mobile-first, Chinese/English. The Kanto trip is built in as the sample trip (`kanto27`).

## How a trip is made (`startGen`)
1. **Outline**: one OpenAI Responses call (`OUTLINE_SCHEMA`, effort medium): title, currency, local language,
   flight estimate, cover stats and one line per day (`plan`, `mode`, `night_area`, colour, emoji).
2. **Days + extras in parallel** (`pool`, 6 at a time): `genDay` per day (`DAY_SCHEMA`: stops, places, legs,
   eat, stay_info, cost) and `genExtras` (`EXTRAS_SCHEMA`: car, prep, sos, transport tips, tips, phrasebook).
3. **Photos**: `resolvePhotos` → English Wikipedia REST summary per `wiki` title; only Commons jpg/png/webp,
   960px thumb, credited to the Commons file page. Day photo falls back to the day's first stop photo.
4. **Rate**: `liveRate` → open.er-api.com (MYR base), else the AI's `myr_per_unit`.
5. Saved as `tripai:trip:<id>` = `{id, input, src:{outline, days[], extras}, img, rate, rateDate, created}`;
   the list lives in `tripai:trips`; `tripai:active` picks the trip; switching trips reloads the page.

`buildTrip(rec)` (in the "Trips" block after `PHOTO`) converts a record into the exact globals the Kanto
renderer uses (`META`, `UI` overrides, `THEME`, `STAYN`, `DAYS`, `EXTRA`, `CAR`, `PREP`, `SOS`, `DRIVE_TIPS`,
`TIPS`, `PL`, `LEGS`, `PHOTO`, `PHR` via `TRIP_PHR`). Place ids are namespaced per day (`d0_icn`).
Cost labels carry `c` (0 food, 1 stay, 2 fun, 3 transit) so `cat()` doesn't need the Kanto regexes.

Model: `genModel()` = `tripai:aimodel` or `AI_MODEL` (gpt-5.4-mini); the form offers gpt-5.4. Optional
web-search tool ("check hours and prices"). The OpenAI key is the user's own, in `tripai:aikey` only.

## META (trip-level settings the renderer reads)
`start` (ISO), `travellers` (`NPPL`), `cur {code, sym, zh, rate}` (rate = MYR per unit), `cc` (calling code
for tel links), `lang {code, bcp, name, native, them, test}` → translator (`TLC`, `TLB`, `TLN`, `TLZ`, `TLE`),
`flightRM`, `eyebrow`, `season`, `snow`, `stats`, `docTitle`, `img {hero[2], day[], stay[]}`, `sample`.
Dates come from `META.start` (`dayISO`, `isoAdd`, `monAbbr`); day count from `DAYS.length` (`LAST`).
Money: `jp()` prints the local symbol; `fx()` converts "{sym}1,500–2,000" (and "N{zh name}") text to RM;
`fxUnit()` picks ¥100 / ₩1,000 / €1 for the rate box. Translate tab is hidden when the local language is zh/en.

## Storage (`store`, prefix `tripai:`)
App-wide keys (`GLOBAL_KEYS`): lang, money, elkey, elv, aikey, vlang, trdir, trhist, instdismiss, warmed,
active, trips, aimodel. Everything else is per trip at `tripai:<tripId>:<key>` (day, done-N, prep, bookings,
exp, rate). ElevenLabs / OpenAI keys typed into the Kanto app on the same site are copied over once.

## Trip library (`#tripsheet`, `paintTrips`)
List (open / edit-and-regenerate / share / export / delete), new-trip form (`tsDraft`, last input remembered in
`tripai:lastinput`), progress view. Share = `#trip=<deflate-raw base64url>` link (`packTrip`/`importTripLink`,
asks before importing); export/import = the record as .json. Per-day "✨ redo this day" (`redoHTML`/`wireRedo`)
regenerates one day with an optional change request.

Everything else (bookings import, receipts/expenses, voice translator, PWA, install bar) works as in
`../kanto-trip-app/CLAUDE.md`, but for the active trip.

## Run / host
`node .serve.js` → http://localhost:3031 (or the `trip-planner` entry in the parent `.claude/launch.json`).
Static hosting (GitHub Pages) works as is. Never commit API keys; trips stay in each browser.
