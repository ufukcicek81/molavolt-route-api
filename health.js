module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ ok: true, service: 'MolaVolt Route API', googleKeyActive: Boolean(process.env.GOOGLE_MAPS_API_KEY) });
};
