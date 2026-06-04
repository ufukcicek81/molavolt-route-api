// MolaVolt Route Check API
// Vercel Serverless Function
// Google Routes API varsa onu kullanır; yoksa OSRM fallback ile çalışır.
// ENV: GOOGLE_MAPS_API_KEY=...

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function cleanPoint(p) {
  return { lat: n(p?.lat ?? p?.latitude), lon: n(p?.lon ?? p?.lng ?? p?.longitude) };
}

function validPoint(p) {
  return Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function havKm(a, b) {
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function dynamicMaxExtraKm(baseKm, candidate) {
  // Karşı şerit/servis yolu hatalarını yakalamak için kısa tutuyoruz.
  // Büyük rotalarda bile gereksiz dönüşleri elemek için üst sınır 1.5 km.
  const c = n(candidate?.routeDeviation, 0);
  return clamp(Math.max(0.45, baseKm * 0.0025, c * 0.75), 0.45, 1.5);
}

async function googleComputeRoute({ origin, destination, intermediate, sideOfRoad = true }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY yok');

  const waypoint = (p, extra = {}) => ({
    location: { latLng: { latitude: p.lat, longitude: p.lon } },
    ...extra,
  });

  const body = {
    origin: waypoint(origin),
    destination: waypoint(destination),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_UNAWARE',
    computeAlternativeRoutes: false,
    languageCode: 'tr-TR',
    units: 'METRIC',
  };

  if (intermediate) {
    body.intermediates = [waypoint(intermediate, sideOfRoad ? { vehicleStopover: true, sideOfRoad: true } : { vehicleStopover: true })];
  }

  const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.legs.distanceMeters,routes.legs.duration',
    },
    body: JSON.stringify(body),
  });

  const txt = await resp.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }

  if (!resp.ok) {
    // sideOfRoad bazı noktalar için rota üretmezse basic waypoint ile bir kez daha denenebilir.
    const msg = data?.error?.message || `Google Routes HTTP ${resp.status}`;
    throw new Error(msg);
  }

  const route = data?.routes?.[0];
  if (!route || !Number.isFinite(Number(route.distanceMeters))) throw new Error('Google rota boş');
  const legs = Array.isArray(route.legs) ? route.legs : [];
  return {
    distanceKm: Number(route.distanceMeters) / 1000,
    durationMin: parseDurationMin(route.duration),
    legsKm: legs.map(l => Number(l.distanceMeters || 0) / 1000),
  };
}

function parseDurationMin(s) {
  if (!s) return 0;
  const m = String(s).match(/([0-9.]+)s/);
  return m ? Number(m[1]) / 60 : 0;
}

async function osrmRouteKm(points) {
  const coords = points.map(p => `${p.lon},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=false&alternatives=false&steps=false`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`OSRM HTTP ${r.status}`);
  const data = await r.json();
  const route = data?.routes?.[0];
  if (!route) throw new Error('OSRM rota boş');
  return {
    distanceKm: Number(route.distance || 0) / 1000,
    durationMin: Number(route.duration || 0) / 60,
    legsKm: (route.legs || []).map(l => Number(l.distance || 0) / 1000),
  };
}

async function computeBase(origin, destination, provider) {
  if (provider === 'google') return googleComputeRoute({ origin, destination });
  return osrmRouteKm([origin, destination]);
}

async function computeVia(origin, station, destination, provider) {
  if (provider === 'google') {
    try {
      return await googleComputeRoute({ origin, destination, intermediate: station, sideOfRoad: true });
    } catch (e) {
      // Nokta side-of-road ile erişilemiyorsa basic waypoint dene; yine uzarsa zaten elenecek.
      return await googleComputeRoute({ origin, destination, intermediate: station, sideOfRoad: false });
    }
  }
  return osrmRouteKm([origin, station, destination]);
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, name: 'MolaVolt route-check', google: Boolean(process.env.GOOGLE_MAPS_API_KEY) });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Sadece POST desteklenir' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const origin = cleanPoint(body.origin);
    const destination = cleanPoint(body.destination);
    const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, n(body.maxCandidates, 18)) : [];

    if (!validPoint(origin) || !validPoint(destination)) {
      return res.status(400).json({ ok: false, error: 'origin/destination eksik veya hatalı' });
    }
    if (!candidates.length) {
      return res.status(200).json({ ok: true, accepted: [], rejected: [], message: 'Aday istasyon yok' });
    }

    let provider = process.env.GOOGLE_MAPS_API_KEY ? 'google' : 'osrm';
    let base;
    try {
      base = await computeBase(origin, destination, provider);
    } catch (e) {
      provider = 'osrm';
      base = await computeBase(origin, destination, provider);
    }

    const baseKm = base.distanceKm || havKm(origin, destination) * 1.18;
    const accepted = [];
    const rejected = [];

    for (const cand of candidates) {
      const station = cleanPoint(cand);
      if (!validPoint(station)) {
        rejected.push({ ...cand, ok: false, reason: 'koordinat hatalı' });
        continue;
      }

      try {
        const via = await computeVia(origin, station, destination, provider);
        const viaKm = via.distanceKm;
        const extraKm = viaKm - baseKm;
        const maxExtraKm = n(body.maxExtraKm, dynamicMaxExtraKm(baseKm, cand));
        const legsKm = via.legsKm || [];
        const leg1 = n(legsKm[0], 0);
        const leg2 = n(legsKm[1], 0);
        const alongKm = n(cand.alongKm, baseKm * n(cand.routeProgress, 0));
        const backtrackKm = leg1 - alongKm;

        // Ana karar: Google/OSRM ile ara durak eklenince rota gereksiz uzuyorsa eliyoruz.
        // Ek olarak ilk leg, ana rota üzerindeki beklenen ilerlemeden çok uzunsa ters yön/servis yolu şüphesi var.
        const ok = extraKm >= -0.2 && extraKm <= maxExtraKm && backtrackKm <= Math.max(0.9, maxExtraKm + 0.6) && leg1 > 0 && leg2 > 0;
        const result = {
          ...cand,
          ok,
          provider,
          baseKm: Number(baseKm.toFixed(3)),
          viaKm: Number(viaKm.toFixed(3)),
          extraKm: Number(extraKm.toFixed(3)),
          maxExtraKm: Number(maxExtraKm.toFixed(3)),
          leg1Km: Number(leg1.toFixed(3)),
          leg2Km: Number(leg2.toFixed(3)),
          backtrackKm: Number(backtrackKm.toFixed(3)),
          durationMin: Number((via.durationMin || 0).toFixed(1)),
          reason: ok ? 'gidiş istikametinde kabul' : 'ters yön / karşı şerit / fazla sapma',
        };
        if (ok) accepted.push(result); else rejected.push(result);
      } catch (e) {
        rejected.push({ ...cand, ok: false, provider, reason: 'rota kontrol edilemedi', error: String(e.message || e).slice(0, 180) });
      }
    }

    accepted.sort((a, b) => {
      const sa = (n(a.routeProgress) * 100) - (n(a.extraKm) * 80) - (n(a.routeDeviation) * 25) + Math.min(20, n(a.routeKw) / 8);
      const sb = (n(b.routeProgress) * 100) - (n(b.extraKm) * 80) - (n(b.routeDeviation) * 25) + Math.min(20, n(b.routeKw) / 8);
      return sb - sa;
    });

    return res.status(200).json({
      ok: true,
      provider,
      baseKm: Number(baseKm.toFixed(3)),
      checked: candidates.length,
      accepted,
      rejected: rejected.slice(0, 50),
      googleKeyActive: Boolean(process.env.GOOGLE_MAPS_API_KEY),
      note: provider === 'google'
        ? 'Google Routes ile gerçek durak ekleme kontrolü yapıldı.'
        : 'GOOGLE_MAPS_API_KEY olmadığı için OSRM fallback kullanıldı; Google Haritalar dönüşlerini yakalamak için Google key ekleyin.',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

