// MolaVolt Route Check API - OSRM FREE VERSION
// Google API key gerekmez. Ücretsiz OSRM public router ile ana rota ve ara durak rotasını karşılaştırır.
// Version: UFUK_ROUTE_API_OSRM_FREE_0611

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

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function havKm(a, b) {
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

async function osrmRoute(points, overview = false) {
  const coords = points.map(p => `${p.lon},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=${overview ? 'full' : 'false'}&geometries=geojson&alternatives=false&steps=false`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`OSRM HTTP ${r.status}`);
  const data = await r.json();
  const route = data?.routes?.[0];
  if (!route) throw new Error('OSRM rota boş');
  return {
    distanceKm: Number(route.distance || 0) / 1000,
    durationMin: Number(route.duration || 0) / 60,
    legsKm: (route.legs || []).map(l => Number(l.distance || 0) / 1000),
    coordinates: route.geometry?.coordinates || []
  };
}

function routeScore(c) {
  // Daha az ekstra yol, daha az sapma, daha ileri rota ve yüksek kW öncelikli.
  return (n(c.routeProgress) * 120) - (n(c.extraKm) * 130) - (n(c.routeDeviation) * 35) + Math.min(25, n(c.routeKw) / 6);
}

function dynamicMaxExtraKm(baseKm, cand) {
  // Ücretsiz OSRM'de karşı şerit detayı yok, bu yüzden toleransı sıkı tutuyoruz.
  // Kısa/orta rotada 0.8-2.2 km arası; çok uzun rotada en fazla 3 km.
  const dev = n(cand?.routeDeviation, 0);
  return clamp(Math.max(0.8, baseKm * 0.004, dev * 0.9), 0.8, 3.0);
}

function isProgressValid(cand) {
  const p = n(cand.routeProgress, -1);
  // Başlangıca çok yakın veya hedefe çok yakın noktaları durak diye zorlamayalım.
  return p > 0.03 && p < 0.97;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'MolaVolt route-check', provider: 'osrm-free', googleKeyRequired: false, version: 'UFUK_ROUTE_API_OSRM_FREE_0611' });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Sadece POST desteklenir' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const origin = cleanPoint(body.origin);
    const destination = cleanPoint(body.destination);
    const maxCandidates = clamp(n(body.maxCandidates, 18), 1, 35);
    const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, maxCandidates) : [];

    if (!validPoint(origin) || !validPoint(destination)) {
      return res.status(400).json({ ok: false, error: 'origin/destination eksik veya hatalı' });
    }
    if (!candidates.length) {
      return res.status(200).json({ ok: true, provider: 'osrm-free', accepted: [], rejected: [], message: 'Aday istasyon yok' });
    }

    let base;
    try {
      base = await osrmRoute([origin, destination], false);
    } catch (e) {
      // OSRM geçici yanıt vermezse düz mesafe yedeği. Adaylar yine çok sıkı elenir.
      base = { distanceKm: havKm(origin, destination) * 1.18, durationMin: 0, legsKm: [] };
    }

    const baseKm = Math.max(1, n(base.distanceKm, havKm(origin, destination) * 1.18));
    const accepted = [];
    const rejected = [];

    for (const cand of candidates) {
      const station = cleanPoint(cand);
      if (!validPoint(station)) {
        rejected.push({ ...cand, ok: false, reason: 'koordinat hatalı' });
        continue;
      }
      if (!isProgressValid(cand)) {
        rejected.push({ ...cand, ok: false, reason: 'rota ilerlemesi uygunsuz' });
        continue;
      }

      try {
        const via = await osrmRoute([origin, station, destination], false);
        const viaKm = n(via.distanceKm);
        const extraKm = viaKm - baseKm;
        const legs = via.legsKm || [];
        const leg1 = n(legs[0], 0);
        const leg2 = n(legs[1], 0);
        const alongKm = n(cand.alongKm, baseKm * n(cand.routeProgress, 0));
        const routeDeviation = n(cand.routeDeviation, 999);
        const maxExtraKm = n(body.maxExtraKm, dynamicMaxExtraKm(baseKm, cand));
        const maxBacktrackKm = Math.max(1.0, maxExtraKm + 0.75);
        const backtrackKm = leg1 - alongKm;

        // Kabul kriteri:
        // 1) Durak eklenince ana rota çok uzamayacak.
        // 2) İlk bacak, ana rota üzerindeki beklenen ilerlemeden çok fazla uzun olmayacak.
        // 3) Yol hattına sapma düşük kalacak.
        // Bu kurallar ücretsiz OSRM ile ters dönüş/servis yolu riskini büyük ölçüde azaltır.
        const ok =
          extraKm >= -0.4 &&
          extraKm <= maxExtraKm &&
          backtrackKm <= maxBacktrackKm &&
          routeDeviation <= n(body.maxRouteDeviationKm, 4.5) &&
          leg1 > 0.05 &&
          leg2 > 0.05;

        const result = {
          ...cand,
          ok,
          provider: 'osrm-free',
          baseKm: Number(baseKm.toFixed(3)),
          viaKm: Number(viaKm.toFixed(3)),
          extraKm: Number(extraKm.toFixed(3)),
          maxExtraKm: Number(maxExtraKm.toFixed(3)),
          leg1Km: Number(leg1.toFixed(3)),
          leg2Km: Number(leg2.toFixed(3)),
          alongKm: Number(alongKm.toFixed(3)),
          backtrackKm: Number(backtrackKm.toFixed(3)),
          durationMin: Number(n(via.durationMin).toFixed(1)),
          reason: ok ? 'OSRM ile rota üstü kabul' : 'fazla sapma / geri dönüş riski'
        };
        if (ok) accepted.push(result); else rejected.push(result);
      } catch (e) {
        rejected.push({ ...cand, ok: false, provider: 'osrm-free', reason: 'OSRM rota kontrol edemedi', error: String(e.message || e).slice(0, 180) });
      }
    }

    accepted.sort((a, b) => routeScore(b) - routeScore(a));

    return res.status(200).json({
      ok: true,
      provider: 'osrm-free',
      version: 'UFUK_ROUTE_API_OSRM_FREE_0611',
      googleKeyRequired: false,
      baseKm: Number(baseKm.toFixed(3)),
      checked: candidates.length,
      accepted,
      rejected: rejected.slice(0, 80),
      note: 'Google API kullanılmadı. Ücretsiz OSRM ile ana rota ve ara durak rotası karşılaştırıldı.'
    });
  } catch (e) {
    return res.status(500).json({ ok: false, provider: 'osrm-free', error: String(e.message || e) });
  }
};
