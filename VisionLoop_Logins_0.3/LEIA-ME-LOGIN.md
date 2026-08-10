# VisionLoop_Logins_0.3 — Painel de contas ADM (Fase 2)

## Novidade da 0.3: aba "Contas" no controlador

Quem loga como **ADM** agora vê uma aba nova, **Contas**, ao lado de Vídeos e
Playlists (contas `cliente` não veem essa aba — nem no menu, nem nas rotas
por trás dela, ver "Segurança" abaixo). Nela dá pra:

- **Ver todas as contas cadastradas** como uma lista de cartões (nome da
  empresa, papel ADM/Cliente, se está ativa ou suspensa, e um aviso se a
  licença de uma conta cliente está vencida ou nunca foi definida).
- **Criar uma conta nova** (botão "+ Nova Conta"): nome da empresa, senha,
  papel (ADM ou Cliente), limite de TVs, limite de armazenamento (GB) e
  validade da licença.
- **Clicar numa conta existente** para editar os mesmos campos — inclusive
  trocar o papel dela, suspender/reativar (checkbox "Conta ativa"), e
  **redefinir a senha** (campo opcional — só é aplicado se você digitar algo
  ali; deixando em branco a senha atual continua valendo).
- **Excluir uma conta** de vez, com confirmação: o botão pede pra digitar o
  nome da empresa exatamente como está antes de apagar.

**Duas travas de segurança embutidas**, pra evitar você se trancar pra fora
do próprio painel sem querer: um ADM não consegue excluir a própria conta
logada nem trocar o próprio papel de ADM por essa tela (dá pra fazer isso em
qualquer OUTRA conta livremente — só a sua própria fica travada aqui).
Servidor e tela concordam nisso: mesmo se alguém tentasse contornar a tela,
o servidor recusa a mesma coisa.

**O limite de TVs e de armazenamento por conta ainda não é aplicado
automaticamente em nada** — hoje toda TV/vídeo continua sendo compartilhado
entre quem estiver logado, sem isolar por conta (isso é Fase 3/4 do roteiro,
que ainda vem). Por enquanto esses dois campos só ficam guardados no banco,
prontos pra quando essa amarração existir.

Testado localmente (com o banco simulado) e também com um navegador de
verdade (Playwright): aba aparecendo só pro ADM e escondida pro cliente,
criar conta, editar (limite de TVs mudando e persistindo depois de reabrir),
excluir com a confirmação por nome, conta suspensa perdendo a sessão aberta
na hora, conta cliente tentando acessar `/admin/contas` direto e recebendo
403, e as duas travas de auto-exclusão/auto-rebaixamento recusando como
esperado.

## Atualização (herdada da 0.2): robustez contra travamentos

Depois de entregar esta 0.2, analisei os riscos de travamento que a Fase 1
do login introduziu (a pedido seu — ver relatório separado) e apliquei 4
correções nos bastidores, sem mudar nada visível pra quem usa o site:

- **Timeout nas consultas ao banco:** se o Neon ficar lento ou inacessível
  por um instante, uma tentativa de login (ou de abrir o controlador) agora
  falha com uma mensagem de erro em até ~8 segundos, em vez de ficar
  "pensando" pra sempre.
- **Limite de tamanho nos corpos de requisição JSON** (`/login`,
  `/playlists`, `/setup-adm`): uma requisição malformada ou anormalmente
  grande é recusada na hora (erro 413), em vez de ficar acumulando na
  memória do servidor sem limite.
- **Heartbeat no WebSocket:** o servidor agora "cutuca" (ping) cada TV e
  controlador conectado a cada 30 segundos e derruba quem não responder —
  evita que uma TV que perdeu a rede de um jeito "sujo" (comum em Wi-Fi
  instável) continue aparecendo como conectada no painel sem estar.
- **`/storage-usage` (modo disco local) deixou de ser síncrono:** com
  muitos vídeos salvos, calcular o espaço usado podia travar o processo
  inteiro por um instante (inclusive as mensagens do WebSocket). Agora isso
  roda em paralelo sem bloquear.
- **Limite de tentativas de login por hora:** cada IP só pode tentar logar
  (certo ou errado) 20 vezes por hora em `/login`. Depois disso, a rota
  responde erro 429 ("Muitas tentativas de login...") até a janela de 1 hora
  passar — dificulta um script tentando adivinhar senha por tentativa e
  erro, sem atrapalhar uso normal (ninguém erra a senha 20 vezes numa hora).
  É por IP, guardado só em memória (reinicia zerado a cada deploy, igual ao
  resto do estado do servidor).

Nada disso muda o comportamento normal do site — só como ele reage quando
algo (rede, banco, requisição estranha, tentativa repetida de login) sai do
esperado. Testei os cinco pontos localmente (login certo/errado, corpo
grande sendo recusado, heartbeat entregando ping e a conexão continuando
aberta normalmente, `/storage-usage` respondendo certo, e o bloqueio de
login aparecendo exatamente na 21ª tentativa do mesmo IP) antes de
reempacotar.

## ⚠️ Importante: base deste pacote

Este pacote foi construído em cima do **VisionLoop 0.1.3** que você me enviou
(`VisionLoop0.1.3iconeplaylists.zip`) — a pedido seu, mesmo eu tendo avisado
que a versão rodando hoje é a **0.1.5**, que tem duas coisas que este pacote
**não tem**:

- Tabela de preços de carnes (botão que gera as imagens a partir do
  `Txitens.txt`, adicionado na 0.1.4).
- Validade de mídia (upload com data de expiração, adicionado na 0.1.5).

Se você substituir o projeto que está no Render por este pacote direto, essas
duas funcionalidades somem. Se quiser as duas coisas juntas (login + tabela
de preços + validade de mídia), me avise que eu preciso que você me mande o
zip da 0.1.5 pra eu aplicar essas mesmas mudanças de login em cima dela.

## O que foi implementado (Fase 1 do roteiro)

- Login único por **nome da empresa + senha** (sem e-mail, por decisão do
  usuário — o nome da empresa é único na tabela, sem diferenciar
  maiúsculas/minúsculas), com dois papéis (`adm` / `cliente`) — mesma tela,
  o servidor decide o que liberar depois.
- Botão **Voltar** na tela de login (mesmo padrão do controlador — fecha o
  app se estiver dentro do launcher, ou manda pra raiz do site).
- Sessão única por conta: logar em um dispositivo novo derruba a sessão do
  dispositivo anterior automaticamente (cookie `httpOnly` + `Secure` em
  produção + `SameSite=Lax`, válido por 30 dias).
- Bloqueio de login (e de sessão já aberta) quando a licença da conta venceu
  ou ela foi suspensa manualmente.
- `controller.html` agora exige login: sem sessão válida, redireciona pra
  `login.html` antes de carregar qualquer coisa.
- O handshake do WebSocket também valida a sessão antes de aceitar um
  controlador — mesmo que alguém burle o redirecionamento do front, o
  servidor recusa `controller_connect` sem cookie válido.
- Chip no cabeçalho do controlador mostrando quem está logado, com botão
  **Sair**.

**Fora do escopo ainda (vêm depois, conforme o roteiro):** TVs vinculadas por
conta e pareamento por código (Fase 3), mídia/playlists isoladas por conta
(Fase 4). Por enquanto continua existindo só uma "área" de vídeos/playlists
compartilhada por quem estiver logado — o painel de contas novo (0.3)
cadastra e organiza as contas, mas ainda não isola o que cada uma vê.

## Arquivos novos ou alterados (acumulado 0.1 → 0.3)

| Arquivo | Situação |
|---|---|
| `server.js` | Alterado — rotas `/login`, `/logout`, `/me`, validação de sessão no handshake do WebSocket, robustez (0.2) e agora as rotas `/admin/contas*` do painel ADM (0.3) |
| `package.json` | Alterado — dependências `pg` e `bcrypt`, versão `0.3` |
| `controller.html` | Alterado — chip de conta logada + botão Sair (0.2); aba **Contas** nova, só visível pra ADM (0.3) |
| `js/controller.js` | Alterado — checa sessão (`/me`) antes de iniciar (0.2); toda a lógica da aba Contas — listar, criar, editar, excluir (0.3) |
| `css/controller.css` | Alterado — uma classe nova (`.tag-accent`) pro selo "ADM" na lista de contas (0.3) |
| `login.html` | **Novo (0.1)** — tela de login (nome da empresa + senha), com botão Voltar |
| `lib/db.js` | **Novo (0.1)** — pool de conexão com o Postgres (Neon); timeouts adicionados na 0.2 |
| `lib/auth.js` | **Novo (0.1)** — autenticação, sessão, checagem de licença |
| `lib/contas.js` | **Novo (0.3)** — CRUD de contas usado pelo painel ADM (listar, criar, editar, excluir) |
| `schema-contas.sql` | **Novo (0.1)** — script pra criar a tabela `contas` no Neon (sem mudança na 0.3 — as colunas que o painel usa já existiam desde a Fase 1) |
| `scripts/criar-conta-adm.js` | **Novo (0.1)** — uso único, cria a primeira conta ADM rodando num terminal. Pode apagar depois. |
| `exclua-me/` (pasta inteira) | **Novo (0.1)** — alternativa ao script acima, cria a 1ª conta ADM por uma página no navegador. Ver seção própria abaixo. **Apague a pasta inteira depois de usar** (e depois disso, use o painel Contas normal pra criar as próximas). |

Nenhum outro arquivo foi tocado — `tv.html`, `index.html`, `js/tv.js`, o
resto do `css/`, `playlists.json` etc. continuam exatamente como estavam no
zip original.

## Passo a passo pra colocar no ar

1. **Banco (Neon):** se ainda não fez, crie a conta/projeto no Neon e copie
   a connection string (`DATABASE_URL`) — combinamos isso na conversa
   anterior.
2. **Render:** cole a `DATABASE_URL` nas variáveis de ambiente do serviço
   (Environment → Add Environment Variable).
3. **Rodar o schema:** abra o SQL Editor do Neon, cole e rode o
   `CREATE TABLE` de `schema-contas.sql`.
4. **Copiar este projeto** pro seu repositório local (substituindo os
   arquivos da tabela acima, criando `lib/` e `login.html`).
5. **Instalar dependências novas:** `npm install` dentro da pasta do
   projeto — baixa `pg` e `bcrypt` de verdade.
6. **Criar sua conta ADM** — três formas, escolha uma:
   - **Pelo navegador (mais fácil se você não tem terminal disponível):**
     depois do deploy, acesse `https://seu-site.onrender.com/exclua-me/setup-adm.html`,
     preencha nome da empresa e senha. Só funciona uma vez, com o banco
     vazio. **Apague a pasta `exclua-me/` inteira depois de usar** (e suba o
     código de novo sem ela).
   - **Por script, num terminal:** edite `scripts/criar-conta-adm.js`
     (preencha `NOME_NEGOCIO` e `SENHA` no topo) e rode
     `node scripts/criar-conta-adm.js` (pela aba Shell do Render, ou local
     com `DATABASE_URL="..."` na frente do comando). Pode apagar o arquivo
     depois.
   - **Na mão:** o `INSERT` comentado no fim do `schema-contas.sql`.
7. **Deploy:** `git add`, `git commit`, `git push` do jeito que você já faz,
   e redeploy no Render.

## Como testar

1. Abra o site — deve cair direto na tela de login (`login.html`), mesmo
   digitando `/controller.html` na URL.
2. Tente logar com senha errada — mensagem de erro clara, sem dizer se foi
   o nome da empresa ou a senha que errou.
3. Logue com a conta ADM que você criou — deve entrar no controlador
   normalmente, com seu nome aparecendo no cabeçalho.
4. Abra o mesmo login em outra aba/navegador — a primeira sessão deve cair
   sozinha na próxima ação (ex.: só de recarregar a página, ela volta pro
   login).
5. Clique em **Sair** — volta pro login, e tentar acessar `/controller.html`
   direto também redireciona de novo.
6. (Quando tiver uma conta `cliente` com `licenca_expira_em` no passado pra
   testar) confirme que o login dela é recusado com mensagem sobre licença
   vencida.

Testei localmente todo esse fluxo (login certo/errado, sessão única por
conta, bloqueio por licença vencida, logout, e a validação do WebSocket
recusando conexão sem sessão) com um banco simulado — comportou-se como
esperado em todos os casos. O que eu não consegui testar aqui é a conexão
real com o seu Neon (não tenho acesso a ele deste ambiente), então vale
confirmar os passos 1–7 acima com calma no seu primeiro deploy.
