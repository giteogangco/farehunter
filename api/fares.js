/* =============================================================
   api/fares.js — FareHunter live-fare proxy (Vercel serverless)
   -------------------------------------------------------------
   Backed by the Duffel Flights API (https://duffel.com).
   Returns data for the panels Duffel can serve:
     • pairs        — cheapest round-trip per nearby origin/dest combo
     • best         — cheapest pairing
     • roundTrip    — cheapest bundled total for the best pair
     • split        — cheapest one-way out + cheapest one-way back
     • cheapestDates— [] (Duffel has no flexible-date search; the
                      calendar heatmap stays on simulated data)

   ENV (set in Vercel dashboard, never commit):
     DUFFEL_TOKEN   — a Duffel access token. A test token
                      (duffel_test_...) returns sandbox "Duffel Airways"
                      offers — fake prices, predictable for development.
                      A live token returns real, bookable fares.
   ============================================================= */

const BASE = "https://api.duffel.com";
const DUFFEL_VERSION = "v2";
const MAX_ORIGINS = 3, MAX_DESTS = 3, MAX_PAIRS = 4, CONCURRENCY = 2;
const SUPPLIER_TIMEOUT = 5000; // ms Duffel waits on suppliers per request

function headers() {
  return {
    Authorization: "Bearer " + process.env.DUFFEL_TOKEN,
    "Duffel-Version": DUFFEL_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
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

/* one Duffel offer request -> cheapest {price, carrier, stops} or null.
   `legs` is an array of slices: [{from,to,date}, ...] (1 = one-way, 2 = round trip). */
async function cheapestOffer({ legs, adults }) {
  const slices = legs.map((l) => ({ origin: l.from, destination: l.to, departure_date: l.date }));
  const passengers = Array.from({ length: Math.max(1, parseInt(adults || "1", 10)) }, () => ({ type: "adult" }));
  const u = new URL(BASE + "/air/offer_requests");
  u.searchParams.set("return_offers", "true");
  u.searchParams.set("supplier_timeout", String(SUPPLIER_TIMEOUT));
  const res = await fetch(u, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ data: { slices, passengers, cabin_class: "economy" } }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const offers = ((j.data && j.data.offers) || []).map((o) => ({
    price: parseFloat(o.total_amount),
    carrier: (o.owner && (o.owner.iata_code || o.owner.name)) || "??",
    stops: Math.max(0, (((o.slices || [])[0] || {}).segments || []).length - 1),
  })).filter((o) => !isNaN(o.price));
  if (!offers.length) return null;
  return offers.reduce((a, b) => (b.price < a.price ? b : a));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!process.env.DUFFEL_TOKEN) {
    return res.status(200).json({ error: "DUFFEL_TOKEN is not set on the server" });
  }

  try {
    const p = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
    const origins = String(p.origins || p.from || "").split(",").filter(Boolean).slice(0, MAX_ORIGINS);
    const dests = String(p.dests || p.to || "").split(",").filter(Boolean).slice(0, MAX_DESTS);
    const depart = p.depart, ret = p.return || null, adults = p.adults || "1";
    if (!origins.length || !dests.length || !depart) {
      return res.status(400).json({ error: "origins, dests and depart are required" });
    }

    // 1) round-trip (or one-way) price per origin/dest pair, capped
    const combos = [];
    for (const o of origins) for (const d of dests) if (o !== d) combos.push({ o, d });
    const capped = combos.slice(0, MAX_PAIRS);
    const priced = await pMap(capped, async ({ o, d }) => {
      const legs = ret ? [{ from: o, to: d, date: depart }, { from: d, to: o, date: ret }]
                       : [{ from: o, to: d, date: depart }];
      const c = await cheapestOffer({ legs, adults });
      return c ? { origin: o, dest: d, roundTrip: c.price, carrier: c.carrier } : null;
    });
    const pairs = priced.filter(Boolean);

    // 2) best pairing
    const best = pairs.length ? pairs.reduce((a, b) => (b.roundTrip < a.roundTrip ? b : a)) : null;

    // 3) split ticket on the best pair (two independent one-ways)
    let split = null;
    if (best && ret) {
      const [out, back] = await Promise.all([
        cheapestOffer({ legs: [{ from: best.origin, to: best.dest, date: depart }], adults }),
        cheapestOffer({ legs: [{ from: best.dest, to: best.origin, date: ret }], adults }),
      ]);
      if (out && back) {
        split = {
          out: { price: out.price, carrier: out.carrier },
          back: { price: back.price, carrier: back.carrier },
          total: out.price + back.price,
        };
      }
    }

    if (!pairs.length) {
      return res.status(200).json({ error: "no live results for this route (sandbox tokens only cover Duffel Airways test routes)" });
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json({
      pairs,
      best: best ? { origin: best.origin, dest: best.dest } : null,
      roundTrip: best ? { total: best.roundTrip, carrier: best.carrier } : null,
      split,
      cheapestDates: [],
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
