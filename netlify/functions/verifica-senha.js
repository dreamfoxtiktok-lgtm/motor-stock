// Import dinâmico e opcional: em deploy manual (sem npm install no Netlify) o
// pacote pode não estar empacotado. Se faltar, o login segue SEM rate-limit
// (fail-open), em vez de quebrar a Function inteira com 502 no import.

const MAX_FAILS = 5;                // falhas antes de bloquear
const LOCK_MS   = 10 * 60 * 1000;   // 10 min de bloqueio
const WINDOW_MS = 15 * 60 * 1000;   // janela de contagem das falhas

export async function handler(event) {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: 'Method Not Allowed' };

  let senha;
  try { senha = JSON.parse(event.body).senha; }
  catch { return { statusCode: 400, body: 'Bad Request' }; }

  // identifica o cliente pelo IP (defesa contra brute-force casual)
  const h = event.headers || {};
  const ip = h['x-nf-client-connection-ip']
    || (h['x-forwarded-for'] || '').split(',')[0].trim()
    || 'desconhecido';
  const key = 'login:' + ip;

  // store no servidor (Netlify Blobs). Se indisponível, segue sem travar (fail-open).
  let store = null;
  try {
    const { getStore } = await import('@netlify/blobs');
    store = getStore('login-tentativas');
  } catch { store = null; }   // módulo ausente ou indisponível → segue sem rate-limit

  const agora = Date.now();
  let rec = { fails: 0, first: agora, lockedUntil: 0 };
  if (store) {
    try { const r = await store.get(key, { type: 'json' }); if (r) rec = r; } catch {}
  }

  // já bloqueado? → 429 com o tempo restante
  if (rec.lockedUntil && rec.lockedUntil > agora) {
    const retry = Math.ceil((rec.lockedUntil - agora) / 1000);
    return {
      statusCode: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(retry) },
      body: JSON.stringify({ ok: false, bloqueado: true, retryEm: retry })
    };
  }

  // reseta a janela de contagem se já expirou
  if (rec.first && (agora - rec.first) > WINDOW_MS) {
    rec = { fails: 0, first: agora, lockedUntil: 0 };
  }

  // .trim() no valor da env var: defesa contra o footgun clássico de newline/espaço
  // no fim do valor ao configurar (netlify env:set, colar no painel, etc.)
  const envSenha = (process.env.SENHA_EQUIPE || '').trim();

  // log seguro de diagnóstico (NÃO loga a senha em texto): confirma injeção em runtime
  console.log('[verifica-senha] env presente:', !!process.env.SENHA_EQUIPE,
              '| len env:', envSenha.length, '| len recebida:', (senha || '').length);

  const ok = senha === envSenha;

  // atraso fixo (anti força-bruta / timing)
  await new Promise(r => setTimeout(r, 400));

  if (ok) {
    if (store) { try { await store.delete(key); } catch {} }   // zera o histórico ao acertar
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  }

  // falhou: incrementa e, se estourar, bloqueia
  rec.fails = (rec.fails || 0) + 1;
  if (!rec.first) rec.first = agora;
  let bloqueado = false, retry = 0;
  if (rec.fails >= MAX_FAILS) {
    rec.lockedUntil = agora + LOCK_MS;
    rec.fails = 0;                 // nova janela só depois do bloqueio
    rec.first = agora + LOCK_MS;
    bloqueado = true;
    retry = Math.ceil(LOCK_MS / 1000);
  }
  if (store) { try { await store.setJSON(key, rec); } catch {} }

  const restantes = Math.max(0, MAX_FAILS - rec.fails);
  return {
    statusCode: bloqueado ? 429 : 401,
    headers: {
      'Content-Type': 'application/json',
      ...(bloqueado ? { 'Retry-After': String(retry) } : {})
    },
    body: JSON.stringify({ ok: false, bloqueado, retryEm: retry, restantes })
  };
}
