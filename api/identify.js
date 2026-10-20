const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { ACR_HOST, ACR_KEY, ACR_SECRET } = process.env;
  if (!ACR_HOST || !ACR_KEY || !ACR_SECRET) {
    return res.status(500).json({ error: 'المفاتيح غير مضبوطة في إعدادات Vercel (ACR_HOST, ACR_KEY, ACR_SECRET).' });
  }
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const audio = Buffer.concat(chunks);
    if (audio.length < 2000) return res.status(400).json({ error: 'التسجيل قصير جدًا.' });

    const ts = Math.floor(Date.now() / 1000);
    const toSign = ['POST', '/v1/identify', ACR_KEY, 'audio', '1', ts].join('\n');
    const signature = crypto.createHmac('sha1', ACR_SECRET).update(toSign).digest('base64');

    const fd = new FormData();
    fd.append('sample', new Blob([audio], { type: 'audio/wav' }), 'sample.wav');
    fd.append('sample_bytes', String(audio.length));
    fd.append('access_key', ACR_KEY);
    fd.append('data_type', 'audio');
    fd.append('signature_version', '1');
    fd.append('signature', signature);
    fd.append('timestamp', String(ts));

    const r = await fetch(`https://${ACR_HOST}/v1/identify`, { method: 'POST', body: fd });
    const j = await r.json();
    const code = j.status && j.status.code;
    if (code !== 0 && code !== 1001) {
      return res.status(200).json({ results: [], error: `ACRCloud: ${j.status ? j.status.msg : 'خطأ'} (${code})` });
    }

    const best = new Map();
    const add = (t, score) => {
      const artist = (t.artists || []).map(a => a.name).join('، ');
      const key = (t.title + '|' + artist).toLowerCase();
      const em = t.external_metadata || {};
      const item = {
        title: t.title, artist, score: Math.max(0, Math.min(100, score || 0)),
        spotify: em.spotify && em.spotify.track && em.spotify.track.id ? 'https://open.spotify.com/track/' + em.spotify.track.id : null,
        youtube: em.youtube && em.youtube.vid ? 'https://www.youtube.com/watch?v=' + em.youtube.vid : null,
        deezer: em.deezer && em.deezer.track && em.deezer.track.id ? 'https://www.deezer.com/track/' + em.deezer.track.id : null
      };
      const old = best.get(key);
      if (!old || old.score < item.score) best.set(key, item);
    };
    const md = j.metadata || {};
    (md.humming || []).forEach(t => add(t, Math.round(parseFloat(t.score) * 100)));
    (md.music || []).forEach(t => add(t, Math.round(parseFloat(t.score))));

    const results = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 5);
    return res.status(200).json({ results });
  } catch (e) {
    return res.status(500).json({ error: 'خطأ في الخادم: ' + e.message });
  }
};
