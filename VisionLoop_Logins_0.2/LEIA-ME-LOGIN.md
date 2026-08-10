# VisionLoop_Logins_0.2 — Login multi-usuário (Fase 1)

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

**Fora do escopo desta fase (vêm depois, conforme o roteiro):** painel do
ADM pra criar contas pela interface (Fase 2), TVs vinculadas por conta e
pareamento por código (Fase 3), mídia/playlists isoladas por conta (Fase 4).
Por enquanto continua existindo só uma "área" de vídeos/playlists
compartilhada por quem estiver logado — igual era antes, só que agora exige
login pra entrar.

## Arquivos novos ou alterados

| Arquivo | Situação |
|---|---|
| `server.js` | Alterado — rotas `/login`, `/logout`, `/me`, validação de sessão no handshake do WebSocket |
| `package.json` | Alterado — dependências novas `pg` e `bcrypt`, versão `0.2` |
| `controller.html` | Alterado — chip de conta logada + botão Sair no cabeçalho |
| `js/controller.js` | Alterado — checa sessão (`/me`) antes de iniciar; redireciona pra login se não houver sessão; trata desconexão por sessão inválida |
| `login.html` | **Novo** — tela de login (nome da empresa + senha), com botão Voltar |
| `lib/db.js` | **Novo** — pool de conexão com o Postgres (Neon) |
| `lib/auth.js` | **Novo** — autenticação, sessão, checagem de licença |
| `schema-contas.sql` | **Novo** — script pra criar a tabela `contas` no Neon |
| `scripts/criar-conta-adm.js` | **Novo** — uso único, cria a primeira conta ADM rodando num terminal (Shell do Render ou Node local). Pode apagar depois. |
| `exclua-me/` (pasta inteira) | **Novo** — alternativa ao script acima, pra quem não tem terminal disponível: cria a 1ª conta ADM por uma página no navegador. Ver seção própria abaixo. **Apague a pasta inteira depois de usar.** |

Nenhum outro arquivo foi tocado — `tv.html`, `index.html`, o resto do
`css/`, `playlists.json` etc. continuam exatamente como estavam no zip que
você mandou.

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
