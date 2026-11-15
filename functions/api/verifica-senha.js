// Cloudflare Pages Function — responde em POST /api/verifica-senha
//
// Rate-limit por IP usando Cloudflare KV (binding env.LOGIN_KV). Se o binding
// não estiver configurado, o login segue SEM rate-limit (fail-open), em vez de
// quebrar a função inteira — mesma filosofia da versão Netlify (Blobs).

const MAX_FAILS = 5;                // falhas antes de bloquear
const LOCK_MS   = 10 * 60 * 1000;   // 10 min de bloqueio
const WINDOW_MS = 15 * 60 * 1000;   // janela de contagem das falhas

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

  // store no servidor (Cloudflare KV). Se o binding faltar, segue sem travar (fail-open).
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

  // .trim() no valor da env var: defesa contra o footgun clássico de newline/espaço
  // no fim do valor ao configurar (colar no painel do Cloudflare, etc.)
  const envSenha = (env.SENHA_EQUIPE || '').trim();

  // log seguro de diagnóstico (NÃO loga a senha em texto): confirma injeção em runtime
  console.log('[verifica-senha] env presente:', !!env.SENHA_EQUIPE,
              '| len env:', envSenha.length, '| len recebida:', (senha || '').length);

  const ok = senha === envSenha;

  // atraso fixo (anti força-bruta / timing)
  await new Promise(r => setTimeout(r, 400));

  if (ok) {
    if (kv) { try { await kv.delete(key); } catch {} }   // zera o histórico ao acertar
    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // falhou: incrementa e, se estourar, bloqueia
  rec.fails = (rec.fails || 0) + 1;
  if (!rec.first) rec.first = agora;
  let bloqueado = false, retry = 0, ttlMs = WINDOW_MS;
  if (rec.fails >= MAX_FAILS) {
    rec.lockedUntil = agora + LOCK_MS;
    rec.fails = 0;                 // nova janela só depois do bloqueio
    rec.first = agora + LOCK_MS;
    bloqueado = true;
    retry = Math.ceil(LOCK_MS / 1000);
    ttlMs = LOCK_MS;
  }
  if (kv) {
    // KV com TTL: o registro expira sozinho (mínimo do KV é 60 s). Grava a janela
    // (ou o bloqueio) como tempo de vida — limpeza automática sem job extra.
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
