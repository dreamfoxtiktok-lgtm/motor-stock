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

  const prompt = `Você é um ENGENHEIRO ELETRICISTA SÊNIOR, especialista em motores
elétricos industriais, com domínio das placas de identificação (nameplate) segundo
as normas ABNT NBR 17094 / IEC 60034 / NEMA MG-1 e das convenções dos fabricantes
do mercado brasileiro (WEG, Eberle, Kohlbach, Voges, Bombas, Nova, Motron, etc.).
Sua tarefa é LER a placa do motor na imagem e extrair as especificações com rigor
técnico. Extraia apenas o que estiver CLARAMENTE legível; se um dado não existir ou
estiver ilegível, use null. NÃO invente nem estime valores que não estão na placa.

COMO INTERPRETAR CADA CAMPO (conhecimento de placa de motor):
- "tag": código de TAG do equipamento (etiqueta de identificação do ativo, ex.:
  "M-101", "TAG 2345"). Só preencha se houver uma TAG; não confunda com modelo.
- "carcaca": carcaça / frame (ex.: "90L", "112M", "132S", "63", "IEC 100L").
- "fabricante": marca/fabricante do motor (ex.: "WEG").
- "potencia": a potência EXATAMENTE como aparece escrita na placa (texto literal,
  ex.: "5 cv", "3,7 kW", "7.5 HP", "5cv / 3,7kW").
- "potencia_cv": o valor NUMÉRICO da potência em cv/HP, se a placa mostrar em
  cv, c.v., HP ou mocv (apenas o número, use ponto decimal; ex.: 5 ou 7.5). Se a
  placa só mostrar em kW, deixe null — NÃO converta você mesmo.
- "potencia_kw": o valor NUMÉRICO da potência em kW, se a placa mostrar em kW
  (apenas o número, use ponto decimal; ex.: 3.7). Se a placa só mostrar em cv/HP,
  deixe null — NÃO converta você mesmo.
- "amp": corrente nominal em ampères (A). Se houver mais de uma (ex.: por tensão
  220/380/440 V), traga todas como aparecem (ex.: "14,2/8,2 A").
- "fs": fator de serviço (ex.: "1.15"). É um número adimensional, geralmente 1,00 a 1,35.
- "rpm": rotação nominal em RPM (ex.: "1740", "3500"). Use o valor de carga nominal.
- "eixo": diâmetro do eixo em mm, se indicado (ex.: "24 mm", "Ø28").
- "obs": demais dados técnicos relevantes que ajudem o cadastro, de forma curta:
  tensão(ões) (V), nº de polos, frequência (Hz), grau de proteção (IPxx), classe de
  isolamento, categoria, rendimento, ligação (estrela/triângulo), modelo, Nº de série.

REGRAS DE SAÍDA (OBRIGATÓRIAS):
- Responda APENAS com um objeto JSON válido — nada além dele.
- NÃO escreva nenhuma palavra, explicação ou comentário antes ou depois do JSON.
- NÃO use markdown, crases, nem blocos de código.
- A resposta DEVE começar com "{" e terminar com "}".
- Use EXATAMENTE estas chaves, com null quando o dado não existir:
{"tag":null,"carcaca":null,"fabricante":null,"potencia":null,"potencia_cv":null,"potencia_kw":null,"amp":null,"fs":null,"rpm":null,"eixo":null,"obs":null}`;

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

  // ─── Potência em CV e kW ────────────────────────────────────────────────
  // Regra do app: SEMPRE mostrar as duas unidades. Se a placa só trouxer uma,
  // o cálculo é feito aqui no servidor (determinístico, mais confiável que a
  // IA fazer conta). Conversão padrão BR: 1 cv = 0,7355 kW.
  const CV_PARA_KW = 0.7355;

  // número puro a partir de number OU string ("3,7" / "3.7" / "5 cv")
  function paraNumero(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  // formata com vírgula decimal (padrão BR), até 2 casas, sem zeros à toa
  function fmtBR(n) {
    if (n == null || !isFinite(n)) return null;
    const arred = Math.round(n * 100) / 100;         // 2 casas
    return String(arred).replace('.', ',');
  }

  // Monta campos.potencia como "X cv / Y kW" preenchendo o que faltar.
  function normalizarPotencia(campos) {
    let cv = paraNumero(campos.potencia_cv);
    let kw = paraNumero(campos.potencia_kw);

    // fallback: tenta extrair do texto literal da placa se os números vieram vazios
    if (cv == null && kw == null && campos.potencia) {
      const txt = String(campos.potencia).toLowerCase();
      const mcv = txt.match(/(\d+[.,]?\d*)\s*(cv|hp|c\.?v\.?)/);
      const mkw = txt.match(/(\d+[.,]?\d*)\s*kw/);
      if (mcv) cv = paraNumero(mcv[1]);
      if (mkw) kw = paraNumero(mkw[1]);
      // número sem unidade nenhuma → assume cv (padrão BR em motores)
      if (cv == null && kw == null) {
        const m = txt.match(/\d+[.,]?\d*/);
        if (m) cv = paraNumero(m[0]);
      }
    }

    // chaves auxiliares não fazem parte do contrato de saída
    delete campos.potencia_cv;
    delete campos.potencia_kw;

    if (cv == null && kw == null) return;   // nada reconhecido: mantém como veio

    // completa a unidade que faltar
    if (cv == null && kw != null) cv = kw / CV_PARA_KW;
    if (kw == null && cv != null) kw = cv * CV_PARA_KW;

    const cvStr = fmtBR(cv), kwStr = fmtBR(kw);
    if (cvStr != null && kwStr != null) {
      campos.potencia = `${cvStr} cv / ${kwStr} kW`;
    }
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

    // Sempre apresenta a potência em cv E kW (calcula a que faltar).
    normalizarPotencia(campos);

    return new Response(
      JSON.stringify(campos),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ erro: String(e) }), { status: 500 });
  }
}
