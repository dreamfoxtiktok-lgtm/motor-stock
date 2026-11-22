# Motor Stock

PWA de cadastro de motores elétricos do estoque. Arquivo único (`index.html`, HTML/JS vanilla), banco **Firebase Firestore** (tempo real + offline), **foto do motor** guardada no Firestore (doc separado, carregada sob demanda) e gate de senha de equipe via **Cloudflare Pages Function** + custom token. Sem CDN em runtime.

## Estrutura

```
motor-stock/
├── index.html              ← o app
├── manifest.json           ← PWA
├── sw.js                   ← service worker (offline + cache)
├── icons/                  ← icon-192.png, icon-512.png
├── lib/                    ← chart.umd.min.js, exceljs.min.js (locais)
├── functions/api/
│   └── verifica-senha.js   ← confere a senha da equipe (env SENHA_EQUIPE) + emite custom token → /api/verifica-senha
├── _headers                ← headers de segurança (CSP) + no-cache do sw.js
├── .env.example            ← modelo das variáveis de ambiente
└── .gitignore
```

## Modos de execução

- **Modo LOCAL (padrão até configurar o Firebase):** se o `firebaseConfig` no `index.html` ainda está `COLE_AQUI`, o app usa `localStorage`, sem tela de senha. Serve pra testar a UI, o dashboard e o Excel.
- **Modo NUVEM:** com o `firebaseConfig` colado, o app pede a senha da equipe, faz login anônimo no Firebase e sincroniza o estoque em tempo real entre aparelhos (com cache offline).

## O que falta você fazer (ações manuais)

1. **Firebase (Passo 3):** criar projeto → Firestore em produção (região `southamerica-east1`) → ativar login **Anônimo** → colar as Security Rules do arquivo **`firestore.rules`** (já com validação de campos) na aba "Regras" → colar o `firebaseConfig` no `index.html` (procure `⚠️ VOCÊ FAZ`).
2. **Cloudflare Pages → Settings → Variables and Secrets:** `SENHA_EQUIPE` e o secret `FB_SERVICE_ACCOUNT` (JSON da conta de serviço do Firebase, pro custom token) — veja `.env.example`.
3. **Cloudflare Pages → Settings → Functions → KV namespace bindings:** criar um namespace KV e vincular com o nome de binding **`LOGIN_KV`** (store do bloqueio de login por IP).
4. **Deploy:** conectar o repositório no Cloudflare Pages (build command vazio, output directory `/`) ou `npx wrangler pages dev .` para testar as Functions localmente.

## Dependências

Sem dependências npm. O bloqueio de login usa **Cloudflare KV** (binding `LOGIN_KV`), que é um recurso de runtime do Pages — não precisa de pacote. O resto (Chart.js, SheetJS, Firebase) também não é npm.

## Segurança — reforços aplicados

- **Firestore rules com validação** (`firestore.rules`): exige auth, trava os campos permitidos (`hasOnly`) e valida tipo/tamanho.
- **Foto do motor** comprimida no cliente (maior lado ≤ 1024 px, JPEG ~700 KB) e guardada em doc separado `/fotos/{id}` no Firestore (sob demanda), sem custo extra.
- **Bloqueio de brute-force**: 5 tentativas → bloqueio de 10 min por IP, com store no servidor (Cloudflare KV, binding `LOGIN_KV`, com TTL). Fail-open se o binding faltar (a senha ainda protege).

## Regra de deploy

A cada novo deploy, **incremente `CACHE_NAME`** no `sw.js` (`motor-stock-v1` → `-v2`...), senão os aparelhos continuam vendo a versão em cache.
