# Motor Stock

PWA de cadastro de motores elétricos do estoque. Arquivo único (`index.html`, HTML/JS vanilla), banco **Firebase Firestore** (tempo real + offline), IA de leitura de placa via **Cloudflare Workers AI** atrás de **Cloudflare Pages Functions**. Sem CDN em runtime.

## Estrutura

```
motor-stock/
├── index.html              ← o app
├── manifest.json           ← PWA
├── sw.js                   ← service worker (offline + cache)
├── icons/                  ← icon-192.png, icon-512.png
├── lib/                    ← chart.umd.min.js, xlsx.full.min.js (locais)
├── functions/api/
│   ├── verifica-senha.js   ← confere a senha da equipe (env SENHA_EQUIPE) → /api/verifica-senha
│   └── ler-placa.js        ← proxy Cloudflare Workers AI (envs CF_*) → /api/ler-placa
├── _headers                ← headers de segurança (CSP) + no-cache do sw.js
├── .env.example            ← modelo das variáveis de ambiente
└── .gitignore
```

## Modos de execução

- **Modo LOCAL (padrão até configurar o Firebase):** se o `firebaseConfig` no `index.html` ainda está `COLE_AQUI`, o app usa `localStorage`, sem tela de senha. Serve pra testar a UI, o dashboard e o Excel.
- **Modo NUVEM:** com o `firebaseConfig` colado, o app pede a senha da equipe, faz login anônimo no Firebase e sincroniza o estoque em tempo real entre aparelhos (com cache offline).

## O que falta você fazer (ações manuais)

1. **Firebase (Passo 3):** criar projeto → Firestore em produção (região `southamerica-east1`) → ativar login **Anônimo** → colar as Security Rules do arquivo **`firestore.rules`** (já com validação de campos) na aba "Regras" → colar o `firebaseConfig` no `index.html` (procure `⚠️ VOCÊ FAZ`).
2. **Cloudflare (Passo 5):** criar conta → Account ID + API Token (Workers AI Read) → aceitar a licença do Llama Vision uma vez.
3. **Cloudflare Pages → Settings → Variables and Secrets:** `SENHA_EQUIPE`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_VISION_MODEL` (veja `.env.example`).
4. **Cloudflare Pages → Settings → Functions → KV namespace bindings:** criar um namespace KV e vincular com o nome de binding **`LOGIN_KV`** (store do bloqueio de login por IP).
5. **Deploy:** conectar o repositório no Cloudflare Pages (build command vazio, output directory `/`) ou `npx wrangler pages dev .` para testar as Functions localmente.

## Dependências

Sem dependências npm. O bloqueio de login usa **Cloudflare KV** (binding `LOGIN_KV`), que é um recurso de runtime do Pages — não precisa de pacote. O resto (Chart.js, SheetJS, Firebase) também não é npm.

## Segurança — reforços aplicados

- **Firestore rules com validação** (`firestore.rules`): exige auth, trava os campos permitidos (`hasOnly`) e valida tipo/tamanho.
- **Compressão de imagem** no cliente (maior lado ≤ 1600 px, JPEG até caber em ~3,5 MB) + teto no servidor (413 acima de ~4,5 MB base64).
- **Bloqueio de brute-force**: 5 tentativas → bloqueio de 10 min por IP, com store no servidor (Cloudflare KV, binding `LOGIN_KV`, com TTL). Fail-open se o binding faltar (a senha ainda protege).

## Regra de deploy

A cada novo deploy, **incremente `CACHE_NAME`** no `sw.js` (`motor-stock-v1` → `-v2`...), senão os aparelhos continuam vendo a versão em cache.
