# MolaVolt Route API

Bu Vercel API, MolaVolt rota planlamasında şarj istasyonunun gerçekten gidiş istikametinde olup olmadığını kontrol eder.

## Kurulum

1. Bu klasörü ayrı bir GitHub reposuna yükleyin. Önerilen repo/proje adı: `molavolt-route-api`.
2. Vercel'de **New Project** ile bu repoyu import edin.
3. Vercel Project Settings > Environment Variables bölümüne şunu ekleyin:

```text
GOOGLE_MAPS_API_KEY=BURAYA_GOOGLE_MAPS_PLATFORM_KEY
```

4. Google Cloud tarafında bu key için **Routes API** açık olmalı.
5. Deploy sonrası test:

```text
https://PROJE_ADI.vercel.app/api/health
```

`googleKeyActive: true` görürsen Google Routes kontrolü aktif demektir.

## Endpoint

```text
POST /api/route-check
```

Body örneği:

```json
{
  "origin": { "lat": 40.84, "lon": 31.15 },
  "destination": { "lat": 39.93, "lon": 32.86 },
  "candidates": [
    { "id": "1", "name": "İstasyon", "lat": 40.1, "lon": 31.9, "routeProgress": 0.4, "routeDeviation": 0.5, "alongKm": 80 }
  ]
}
```

API, ana rota ile `origin -> istasyon -> hedef` rotasını karşılaştırır. İstasyon durak olarak eklenince rota gereksiz uzuyorsa veya geri dönüş yaptırıyorsa aday elenir.
