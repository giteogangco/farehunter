# FareHunter

A deep-search cheapest-fare finder. It doesn't just list flights — it runs the
strategies that actually cut airfare: flexible-date heatmap, nearby-airport
pairing, split-ticket vs round-trip comparison, and true cost including bags.

Ships in **demo mode** (simulated prices, works offline) and flips to **live
mode** (real Amadeus fares) with one config change plus a deploy.

## Files

| File             | Purpose                                                        |
|------------------|----------------------------------------------------------------|
| `index.html`     | The whole app — static, no build step.                         |
| `api/fares.js`   | Serverless proxy that queries Amadeus (keeps your key private).|
| `vercel.json`    | Function settings.                                             |
| `package.json`   | Enables ES-module serverless functions.                        |
| `.env.example`   | The two credentials you need.                                  |

## Run the demo

Open `index.html` in a browser, or serve the folder:

```bash
npx serve .
```

## Go live (real fares)

1. **Get keys** — sign up at <https://developers.amadeus.com>, create a
   Self-Service app, copy the API Key and Secret.

2. **Deploy to Vercel**

   ```bash
   npm i -g vercel
   vercel            # first deploy
   vercel env add AMADEUS_ID
   vercel env add AMADEUS_SECRET
   vercel --prod     # redeploy with secrets
   ```

   Or push the folder to GitHub and "Import Project" in the Vercel dashboard,
   adding `AMADEUS_ID` and `AMADEUS_SECRET` under Settings → Environment Variables.

3. **Switch the app to live** — in `index.html`:

   ```js
   const CONFIG = { mode: "live", proxyUrl: "/api/fares" };
   ```

   Redeploy. The app now pulls real prices for the calendar, the best pairing,
   the bundled round-trip, and the split-ticket comparison.

## Notes & honest limits

- The **free Amadeus tier uses the test host** (`test.api.amadeus.com`) with
  limited routes and not-always-current prices — great for building, not for
  production. Switch `BASE` in `api/fares.js` to `https://api.amadeus.com`
  once you have production keys.
- Checked-bag fees in live mode are a **flat $55/leg estimate** — Amadeus basic
  offers don't itemise baggage. The app labels this.
- The proxy caps work at 3 origins × 3 dests (max 6 pairs) to stay within rate
  limits. Raise the constants at the top of `api/fares.js` if your plan allows.
- **Split tickets** (two separate one-ways) can beat a round-trip but aren't
  protected if a leg is missed or delayed. The app surfaces that trade-off
  rather than hiding it. Avoid hidden-city ticketing — it violates most airline
  contracts of carriage.

Not affiliated with any airline or booking service.
