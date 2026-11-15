// Cloudflare Pages Function — responde em POST /api/ler-placa
//
// Usa o BINDING NATIVO de Workers AI do Cloudflare Pages (context.env.AI),
// em vez da API REST com token. Isso elimina CF_API_TOKEN e CF_ACCOUNT_ID:
// a autenticação passa a ser feita pela própria plataforma, acabando com o
// "Authentication error" (code 10000).
//
// IMPORTANTE (configuração no painel): é preciso adicionar o binding de
// Workers AI com o nome "AI" em Settings → Functions → Bindings → Workers AI.

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

  const model = env.CF_VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct';

  // Guard: o binding precisa existir. Se faltar, erro claro em vez de crash.
  if (!env.AI || typeof env.AI.run !== 'function') {
    return new Response(JSON.stringify({
      erro: 'Binding de Workers AI ausente. Adicione o binding com o nome "AI" ' +
            'em Settings → Functions → Bindings → Workers AI no Cloudflare Pages.'
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

  // Chama o Workers AI pelo binding nativo (sem token, sem account_id na URL).
  // O binding devolve direto o objeto de resultado (equivalente ao data.result
  // da API REST), normalmente com o texto em .response.
  async function chamarIA() {
    return env.AI.run(model, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imagemBase64}` } }
        ]
      }],
      max_tokens: 500,
      temperature: 0.1          // mais determinístico = menos "enrolação" fora do JSON
    });
  }

  try {
    let campos = null, ultimoBruto = '';
    const MAX_TENTATIVAS = 2;     // 1 chamada + 1 retry automático

    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      const resultado = await chamarIA();

      // Workers AI normalmente devolve o texto em resultado.response,
      // mas dependendo do modelo pode vir objeto já estruturado (ou ausente).
      const resposta = resultado?.response;
      ultimoBruto = typeof resposta === 'string' ? resposta : JSON.stringify(resposta ?? resultado ?? '');
      console.log(`[ler-placa] tentativa ${tentativa}/${MAX_TENTATIVAS} — tipo resposta:`,
                  typeof resposta, '| raw:', JSON.stringify(resultado));

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
