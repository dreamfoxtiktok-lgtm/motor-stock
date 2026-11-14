export async function handler(event) {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: 'Method Not Allowed' };

  let imagemBase64, mime;
  try {
    const body = JSON.parse(event.body);
    imagemBase64 = body.imagem;           // base64 PURO (sem o prefixo data:)
    mime = body.mime || 'image/jpeg';
  } catch { return { statusCode: 400, body: 'Bad Request' }; }

  if (!imagemBase64) return { statusCode: 400, body: 'Sem imagem' };

  // teto de tamanho (o app já comprime; isto é a defesa do servidor)
  if (imagemBase64.length > 4_500_000)
    return { statusCode: 413, body: JSON.stringify({ erro: 'Imagem muito grande' }) };

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

  const accountId = process.env.CF_ACCOUNT_ID;
  const model = process.env.CF_VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct';
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

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
        'Authorization': `Bearer ${process.env.CF_API_TOKEN}`
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
        return { statusCode: resp.status, body: JSON.stringify({ erro: err }) };
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
      return { statusCode: 502, body: JSON.stringify({ erro: 'IA não devolveu JSON', bruto: ultimoBruto }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(campos)
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ erro: String(e) }) };
  }
}
