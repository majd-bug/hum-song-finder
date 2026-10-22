// Cloudflare Worker: serves the static site and handles POST /api/identify
// Runtime variables (Settings > Variables and secrets): ACR_HOST, ACR_KEY, ACR_SECRET
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

async function identify(request, env) {
  const { ACR_HOST, ACR_KEY, ACR_SECRET } = env;
  if (!ACR_HOST || !ACR_KEY || !ACR_SECRET) {
    return json({ error: 'المفاتيح غير مضبوطة في إعدادات Cloudflare (ACR_HOST, ACR_KEY, ACR_SECRET).' }, 500);
  }
  try {
    const audio = new Uint8Array(await request.arrayBuffer());
    if (audio.length < 2000) return json({ error: 'التسجيل قصير جدًا.' }, 400);

    const ts = Math.floor(Date.now() / 1000);
    const toSign = ['POST', '/v1/identify', ACR_KEY, 'audio', '1', ts].join('\n');
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(ACR_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(toSign)));
    let bin = '';
    for (const b of sig) bin += String.fromCharCode(b);
    const signature = btoa(bin);

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
      return json({ results: [], error: `ACRCloud: ${j.status ? j.status.msg : 'خطأ'} (${code})` });
    }

    const best = new Map();
    const add = (t, score) => {
      const artist = (t.artists || []).map(a => a.name).join('، ');
      const k = (t.title + '|' + artist).toLowerCase();
      const em = t.external_metadata || {};
      const item = {
        title: t.title, artist, score: Math.max(0, Math.min(100, score || 0)),
        spotify: em.spotify && em.spotify.track && em.spotify.track.id ? 'https://open.spotify.com/track/' + em.spotify.track.id : null,
        youtube: em.youtube && em.youtube.vid ? 'https://www.youtube.com/watch?v=' + em.youtube.vid : null,
        deezer: em.deezer && em.deezer.track && em.deezer.track.id ? 'https://www.deezer.com/track/' + em.deezer.track.id : null
      };
      const old = best.get(k);
      if (!old || old.score < item.score) best.set(k, item);
    };
    const md = j.metadata || {};
    (md.humming || []).forEach(t => add(t, Math.round(parseFloat(t.score) * 100)));
    (md.music || []).forEach(t => add(t, Math.round(parseFloat(t.score))));
    const results = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 5);
    return json({ results });
  } catch (e) {
    return json({ error: 'خطأ في الخادم: ' + e.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/identify') {
      return request.method === 'POST' ? identify(request, env) : json({ error: 'POST only' }, 405);
    }
    return env.ASSETS.fetch(request);
  }
};
