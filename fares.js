/* =============================================================
   api/fares.js — FareHunter live-fare proxy (Vercel serverless)
   -------------------------------------------------------------
   Returns real data for every panel:
     • pairs        — cheapest round-trip per nearby origin/dest combo
     • best         — cheapest pairing
     • roundTrip    — cheapest bundled total for the best pair
     • split        — cheapest one-way out + cheapest one-way back
     • cheapestDates— flexible-date heatmap source

   ENV (set in Vercel dashboard, never commit):
     AMADEUS_ID, AMADEUS_SECRET
   Free tier uses the TEST host with limited routes. Switch BASE
   to https://api.amadeus.com after upgrading to production keys.
   ============================================================= */

const BASE = "https://test.api.amadeus.com";
const MAX_ORIGINS = 3, MAX_DESTS = 3, MAX_PAIRS = 6, CONCURRENCY = 3;

let cachedToken = null, tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30000) return cachedToken;
  const res = await fetch(BASE + "/v1/security/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_ID,
      client_secret: process.env.AMADEUS_SECRET,
    }),
  });
  if (!res.ok) throw new Error("amadeus auth failed: " + res.status);
  const j = await res.json();
  cachedToken = j.access_token;
  tokenExpiry = Date.now() + j.expires_in * 1000;
  return cachedToken;
}

/* run an async fn over items with bounded concurrency */
async function pMap(items, fn, concurrency = CONCURRENCY) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

/* one offer search -> cheapest {price, carrier, stops} or null */
async function cheapestOffer(token, { from, to, depart, ret, adults }) {
  const u = new URL(BASE + "/v2/shopping/flight-offers");
  u.searchParams.set("originLocationCode", from);
  u.searchParams.set("destinationLocationCode", to);
  u.searchParams.set("departureDate", depart);
  if (ret) u.searchParams.set("returnDate", ret);
  u.searchParams.set("adults", adults || "1");
  u.searchParams.set("currencyCode", "USD");
  u.searchParams.set("max", "10");
  const res = await fetch(u, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) return null;
  const j = await res.json();
  const offers = (j.data || []).map((o) => ({
    price: parseFloat(o.price.grandTotal),
    carrier: o.validatingAirlineCodes?.[0] || "??",
    stops: (o.itineraries?.[0]?.segments?.length || 1) - 1,
  })).filter((o) => !isNaN(o.price));
  if (!offers.length) return null;
  return offers.reduce((a, b) => (b.price < a.price ? b : a));
}

/* Flight Cheapest Date Search — flexible-date heatmap */
async function cheapestDates(token, { from, to }) {
  const u = new URL(BASE + "/v1/shopping/flight-dates");
  u.searchParams.set("origin", from);
  u.searchParams.set("destination", to);
  u.searchParams.set("oneWay", "true");
  const res = await fetch(u, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) return [];
  const j = await res.json();
  return (j.data || []).map((d) => ({ date: d.departureDate, price: parseFloat(d.price.total) }))
    .filter((d) => !isNaN(d.price));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const p = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
    const origins = String(p.origins || p.from || "").split(",").filter(Boolean).slice(0, MAX_ORIGINS);
    const dests = String(p.dests || p.to || "").split(",").filter(Boolean).slice(0, MAX_DESTS);
    const depart = p.depart, ret = p.return || null, adults = p.adults || "1";
    if (!origins.length || !dests.length || !depart) {
      return res.status(400).json({ error: "origins, dests and depart are required" });
    }

    const token = await getToken();

    // 1) round-trip (or one-way) price per origin/dest pair, capped
    const combos = [];
    for (const o of origins) for (const d of dests) if (o !== d) combos.push({ o, d });
    const capped = combos.slice(0, MAX_PAIRS);
    const priced = await pMap(capped, async ({ o, d }) => {
      const c = await cheapestOffer(token, { from: o, to: d, depart, ret, adults });
      return c ? { origin: o, dest: d, roundTrip: c.price, carrier: c.carrier } : null;
    });
    const pairs = priced.filter(Boolean);

    // 2) best pairing
    const best = pairs.length ? pairs.reduce((a, b) => (b.roundTrip < a.roundTrip ? b : a)) : null;

    // 3) split ticket on the best pair (two independent one-ways)
    let split = null;
    if (best && ret) {
      const [out, back] = await Promise.all([
        cheapestOffer(token, { from: best.origin, to: best.dest, depart, adults }),
        cheapestOffer(token, { from: best.dest, to: best.origin, depart: ret, adults }),
      ]);
      if (out && back) {
        split = {
          out: { price: out.price, carrier: out.carrier },
          back: { price: back.price, carrier: back.carrier },
          total: out.price + back.price,
        };
      }
    }

    // 4) flexible-date calendar for the primary route
    const dates = await cheapestDates(token, { from: origins[0], to: dests[0] });

    if (!pairs.length && !dates.length) {
      return res.status(200).json({ error: "no live results for this route (test host has limited coverage)" });
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json({
      pairs,
      best: best ? { origin: best.origin, dest: best.dest } : null,
      roundTrip: best ? { total: best.roundTrip, carrier: best.carrier } : null,
      split,
      cheapestDates: dates,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
