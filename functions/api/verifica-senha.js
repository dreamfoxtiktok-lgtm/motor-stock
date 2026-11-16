// Cloudflare Pages Function — responde em POST /api/verifica-senha
//
// 1) Rate-limit por IP via Cloudflare KV (binding env.LOGIN_KV). Fail-open se faltar.
// 2) Se a senha confere E existir o secret env.FB_SERVICE_ACCOUNT (JSON da conta de
//    serviço do Firebase), emite um FIREBASE CUSTOM TOKEN com a claim { equipe:true }.
//    O app entra com esse token (signInWithCustomToken) e as Security Rules passam a
//    exigir essa claim — assim a SENHA protege os DADOS, não só a tela.
//    Sem o secret, devolve { ok:true } sem token (compatível: app usa login anônimo).

const MAX_FAILS = 5;                // falhas antes de bloquear
const LOCK_MS   = 10 * 60 * 1000;   // 10 min de bloqueio
const WINDOW_MS = 15 * 60 * 1000;   // janela de contagem das falhas

// ── helpers de assinatura do custom token (RS256 via Web Crypto) ──
function b64urlFromBytes(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlFromStr(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pemToPkcs8(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '')
                 .replace(/-----END PRIVATE KEY-----/, '')
                 .replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
async function emitirCustomToken(sa, uid, claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: uid,
    claims: claims
  };
  const dados = b64urlFromStr(JSON.stringify(header)) + '.' + b64urlFromStr(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToPkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(dados));
  return dados + '.' + b64urlFromBytes(sig);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let senha;
  try { senha = (await request.json()).senha; }
  catch { return new Response('Bad Request', { status: 400 }); }

  // identifica o cliente pelo IP (defesa contra brute-force casual)
  const ip = request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'desconhecido';
  const key = 'login:' + ip;

  const kv = env.LOGIN_KV || null;

  const agora = Date.now();
  let rec = { fails: 0, first: agora, lockedUntil: 0 };
  if (kv) {
    try { const r = await kv.get(key, { type: 'json' }); if (r) rec = r; } catch {}
  }

  // já bloqueado? → 429 com o tempo restante
  if (rec.lockedUntil && rec.lockedUntil > agora) {
    const retry = Math.ceil((rec.lockedUntil - agora) / 1000);
    return new Response(
      JSON.stringify({ ok: false, bloqueado: true, retryEm: retry }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(retry) } }
    );
  }

  // reseta a janela de contagem se já expirou
  if (rec.first && (agora - rec.first) > WINDOW_MS) {
    rec = { fails: 0, first: agora, lockedUntil: 0 };
  }

  // .trim() no valor da env var: defesa contra newline/espaço colado no painel
  const envSenha = (env.SENHA_EQUIPE || '').trim();
  const ok = senha === envSenha;

  // atraso fixo (anti força-bruta / timing)
  await new Promise(r => setTimeout(r, 400));

  if (ok) {
    if (kv) { try { await kv.delete(key); } catch {} }   // zera o histórico ao acertar

    // Emite o custom token se a conta de serviço estiver configurada (secret).
    // Se não estiver, devolve ok sem token (compatível com o login anônimo).
    let token = null;
    if (env.FB_SERVICE_ACCOUNT) {
      try {
        const sa = JSON.parse(env.FB_SERVICE_ACCOUNT);
        token = await emitirCustomToken(sa, 'equipe', { equipe: true });
      } catch (e) {
        console.error('[verifica-senha] falha ao emitir custom token:', e && e.message || e);
        // não vaza detalhe ao cliente; segue sem token (não bloqueia o login)
      }
    }

    return new Response(
      JSON.stringify(token ? { ok: true, token } : { ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // falhou: incrementa e, se estourar, bloqueia
  rec.fails = (rec.fails || 0) + 1;
  if (!rec.first) rec.first = agora;
  let bloqueado = false, retry = 0, ttlMs = WINDOW_MS;
  if (rec.fails >= MAX_FAILS) {
    rec.lockedUntil = agora + LOCK_MS;
    rec.fails = 0;
    rec.first = agora + LOCK_MS;
    bloqueado = true;
    retry = Math.ceil(LOCK_MS / 1000);
    ttlMs = LOCK_MS;
  }
  if (kv) {
    try {
      await kv.put(key, JSON.stringify(rec), { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)) });
    } catch {}
  }

  const restantes = Math.max(0, MAX_FAILS - rec.fails);
  return new Response(
    JSON.stringify({ ok: false, bloqueado, retryEm: retry, restantes }),
    {
      status: bloqueado ? 429 : 401,
      headers: {
        'Content-Type': 'application/json',
        ...(bloqueado ? { 'Retry-After': String(retry) } : {})
      }
    }
  );
}
