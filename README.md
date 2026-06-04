# MolaVolt Route API - OSRM Free

Bu paket Google Maps API istemez. Kredi kartı veya Google API key kullanmadan, ücretsiz OSRM public router ile rota kontrolü yapar.

## Dosya yapısı

```text
api/
  health.js
  route-check.js
package.json
README.md
```

## Vercel test

Deploy sonrası sağlık kontrolü:

```text
https://molavolt-route-api.vercel.app/api/health
```

Beklenen cevap:

```json
{
  "ok": true,
  "provider": "osrm-free",
  "googleKeyRequired": false
}
```

## Endpoint

```text
POST /api/route-check
```

API, `origin -> destination` ana rotası ile `origin -> station -> destination` ara durak rotasını karşılaştırır. Ara durak eklenince rota fazla uzuyorsa istasyonu eler.

Not: OSRM ücretsizdir fakat Google kadar şerit/karşı yön hassasiyeti vermez. Bu yüzden toleranslar sıkı tutulmuştur.
