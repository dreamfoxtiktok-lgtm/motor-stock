// Cloudflare Pages Function — responde em POST /api/ler-placa
//
// Mesma lógica da versão Netlify: chama o Cloudflare Workers AI (mesmo token/
// modelo). Só muda o wrapper (onRequestPost) e a leitura de env via context.env.

export async function onRequestPost(context) {
  const { request, env } = context;

  let imagemBase64, mime;
  try {
    const body = await request.json();
    imagemBase64 = body.imagem;           // base64 PURO (sem o prefixo data:)
    mime = body.mime || 'image/jpeg';
  } catch { return new Response('Bad Request', { status: 400 }); }

  if (!imagemBase64) return new Response('Sem imagem', { status: 400 });

  // teto de tamanho (o app já comprime; isto é a defesa do servidor)
  if (imagemBase64.length > 4_500_000)
    return new Response(JSON.stringify({ erro: 'Imagem muito grande' }), { status: 413 });

  const prompt = `Você é um especialista em motores elétricos industriais.
Analise a imagem (placa de motor ou etiqueta de tag). Extraia só o que estiver
claramente visível; campo não encontrado = null.

REGRAS DE SAÍDA (OBRIGATÓRIAS):
- Responda APENAS com um objeto JSON válido — nada além dele.
- NÃO escreva nenhuma palavra, explicação ou comentário antes ou depois do JSON.
- NÃO use markdown, crases, nem blocos de código.
- A resposta DEVE começar com "{" e terminar com "}".
- Use EXATAMENTE estas chaves, com null quando o dado não existir:
{"tag":null,"carcaca":null,"fabricante":null,"potencia":null,"amp":null,"fs":null,"rpm":null,"eixo":null,"obs":null}`;

  // IMPORTANTE: .trim() defende contra espaço/quebra de linha colados junto do
  // valor no painel do Cloudflare Pages — causa clássica de "Authentication
  // error" (code 10000) mesmo com token válido, pois o header vira
  // "Bearer <token>\n" e a API rejeita.
  const accountId = (env.CF_ACCOUNT_ID || '').trim();
  const apiToken  = (env.CF_API_TOKEN  || '').trim();
  const model = env.CF_VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct';
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  // LOG TEMPORÁRIO DE DIAGNÓSTICO (não expõe o valor, só presença/tamanho).
  // Remover depois de confirmar que as credenciais chegam à Function.
  console.log('[ler-placa] diag credenciais —',
              'CF_API_TOKEN presente:', !!apiToken, '| tamanho:', apiToken.length,
              '| CF_ACCOUNT_ID presente:', !!accountId, '| tamanho:', accountId.length);

  // Guard: se faltar credencial, devolve erro claro em vez de bater na API e
  // receber o 10000 genérico (que confunde "token errado" com "token ausente").
  if (!apiToken || !accountId) {
    return new Response(JSON.stringify({
      erro: 'Credenciais do Cloudflare ausentes no ambiente da Function. ' +
            'Verifique CF_API_TOKEN e CF_ACCOUNT_ID em Settings → Variables and Secrets ' +
            '(e confirme que estão no ambiente Production do deploy).',
      tokenPresente: !!apiToken,
      accountIdPresente: !!accountId
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  // Extrator robusto: isola um objeto JSON mesmo com texto/markdown em volta.
  // Aceita string OU objeto (alguns modelos já devolvem JSON estruturado).
  function extrairJSON(resposta) {
    if (resposta == null) return null;

    // já veio como objeto estruturado? usa direto, sem .replace/parse.
    if (typeof resposta === 'object') return resposta;

    const texto = String(resposta);           // garante string antes do .replace
    if (!texto) return null;
    const limpo = texto.replace(/```json|```/gi, '').trim();

    // 1) tentativa direta (caso ideal: já veio JSON puro)
    try { return JSON.parse(limpo); } catch {}

    // 2) varredura de chaves balanceadas a partir do 1º '{' — pega o 1º objeto
    //    completo mesmo que haja texto/outro bloco depois.
    const ini = limpo.indexOf('{');
    if (ini !== -1) {
      let nivel = 0;
      for (let i = ini; i < limpo.length; i++) {
        if (limpo[i] === '{') nivel++;
        else if (limpo[i] === '}' && --nivel === 0) {
          try { return JSON.parse(limpo.slice(ini, i + 1)); } catch { break; }
        }
      }
    }

    // 3) fallback guloso: do 1º '{' ao último '}' (recupera objetos "sujos")
    const m = limpo.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }

    return null;
  }

  async function chamarIA() {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${imagemBase64}` } }
          ]
        }],
        max_tokens: 500,
        temperature: 0.1          // mais determinístico = menos "enrolação" fora do JSON
      })
    });
  }

  try {
    let campos = null, ultimoBruto = '';
    const MAX_TENTATIVAS = 2;     // 1 chamada + 1 retry automático

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      const resp = await chamarIA();

      // erro de infra/credencial do Cloudflare: retry não ajuda → devolve na hora
      if (!resp.ok) {
        const err = await resp.text();
        return new Response(JSON.stringify({ erro: err }), { status: resp.status });
      }

      const data = await resp.json();
      // Workers AI normalmente devolve o texto em data.result.response,
      // mas dependendo do modelo pode vir objeto já estruturado (ou ausente).
      const resposta = data?.result?.response;
      ultimoBruto = typeof resposta === 'string' ? resposta : JSON.stringify(resposta ?? data?.result ?? '');
      console.log(`[ler-placa] tentativa ${tentativa}/${MAX_TENTATIVAS} — tipo resposta:`,
                  typeof resposta, '| raw:', JSON.stringify(data?.result));

      campos = extrairJSON(resposta);
      if (campos) break;

      console.warn(`[ler-placa] tentativa ${tentativa} sem JSON válido` +
                   (tentativa < MAX_TENTATIVAS ? ' — repetindo...' : ' — desistindo.'));
    }

    if (!campos) {
      console.error('[ler-placa] Falha no parse após retry. Bruto:', ultimoBruto);
      return new Response(JSON.stringify({ erro: 'IA não devolveu JSON', bruto: ultimoBruto }), { status: 502 });
    }

    return new Response(
      JSON.stringify(campos),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500 });
  }
}
