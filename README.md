# AI Trip Planner · AI行程规划

Type any destination, dates and travel style, and AI builds a complete mobile trip app for it, in the same
format as the "Old Japan, Slowly" Kanto trip: a day-by-day timeline with photos, live route maps, where to eat,
where to stay, daily and total budget (local currency + RM), a pre-trip checklist, emergency numbers, travel
tips, and a translator + phrasebook in the local language. Chinese/English.

## Use it
1. Open the app → **🧭 My trips** → **Plan a new trip** (or tap the "Plan a trip" card on the sample).
2. Enter destination, start date, days, people, pace, transport, budget, stay style, interests and notes.
3. Add your OpenAI API key the first time (kept only in this browser), then **Plan my trip** (about 1–3 min).
4. Not happy with a day? Open it and tap **✨ Ask AI to redo this day**, with or without a change request.
5. Move a trip to your phone: **Share** (link) or **Export** (.json file) → open/import it on the phone.

## Run locally
```
node .serve.js
```
then open http://localhost:3031.
