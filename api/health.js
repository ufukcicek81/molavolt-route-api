module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    ok: true,
    service: 'MolaVolt Route API',
    provider: 'osrm-free',
    googleKeyRequired: false,
    version: 'UFUK_ROUTE_API_OSRM_FREE_0611'
  });
};
