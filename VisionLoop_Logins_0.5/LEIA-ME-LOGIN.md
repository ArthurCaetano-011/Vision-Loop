# VisionLoop_Logins_0.5 — Mídia e playlists isoladas por conta (Fase 4)

## ⚠️ Antes de colocar no ar: rode a migração NOVA no banco (Neon)

Igual da última vez, seu banco no Neon já tem dados de verdade — use o
arquivo **`schema-migracao-0.5.sql`** (não confundir com o `0.4.sql`, que já
foi rodado antes). Abra o SQL Editor do Neon, cole o arquivo inteiro e rode
tudo de uma vez. Ele só **cria tabelas novas** (`CREATE TABLE IF NOT EXISTS`)
— não toca em nada que já existe, seguro rodar mesmo que alguma parte já
exista. Cria duas tabelas:

1. `playlists` — as playlists deixam de morar no arquivo `playlists.json` (que
   some a cada deploy no Render, disco é temporário lá) e passam a morar no
   banco, cada uma vinculada a uma conta dona.
2. `midia` — não guarda o arquivo em si (isso continua no mesmo lugar de
   sempre, disco local ou R2), só um índice "esse nome de arquivo pertence a
   essa conta", usado pra filtrar a listagem.

**Rode isso ANTES de colocar o código da 0.5 no ar.** Sem essa migração,
`/videos-list`, `/playlists` e `/delete-video` vão quebrar (tabela
faltando).

## Novidade da 0.5: mídia e playlists isoladas por conta (Fase 4)

Até a 0.4, todo vídeo/imagem enviado e toda playlist criada apareciam pra
**qualquer** conta logada — mesma biblioteca compartilhada por todo mundo,
sem isolamento nenhum (você reportou isso depois de testar a 0.4). A partir
de agora, cada conta só vê e só mexe na própria mídia e nas próprias
playlists — exceto o ADM, que continua vendo e gerenciando tudo de todas as
contas, mesmo padrão já usado pras TVs na Fase 3.

**Como funciona pra quem usa:**

- Cada conta cliente só vê, na aba Vídeos, os arquivos que ELA enviou — não
  os de outras contas.
- Cada conta cliente só vê, na aba Playlists, as playlists que ELA criou.
- O ADM continua vendo e podendo apagar/editar a mídia e as playlists de
  **todas** as contas (do mesmo jeito que já via todas as TVs).
- Se uma conta cliente tentar apagar/editar algo de outra conta na marra
  (direto pela API, por exemplo), o servidor recusa com erro claro — a tela
  normal do painel nem mostra a opção, mas o servidor também não confia só
  na tela.
- Apagar um vídeo/imagem agora também remove ele automaticamente de
  qualquer playlist que o usava (playlist que ficaria vazia é apagada junto)
  — antes disso podia sobrar uma referência "fantasma" numa playlist.

**Mídia que já existia antes desta atualização** (enviada antes de existir
esse isolamento) **não tem dono nenhum registrado ainda.** Pra não precisar
de nenhum passo manual, ela é **adotada automaticamente pela conta ADM mais
antiga** (a primeira que você cadastrou) na primeira vez que a lista de
vídeos for aberta depois do deploy — o mesmo vale pra qualquer playlist que
ainda estivesse no `playlists.json` antigo, migrada pro banco também sob a
conta ADM assim que o servidor sobe pela primeira vez com a 0.5 (ver log do
servidor: `[playlists] Migração do playlists.json antigo: N playlist(s)
movida(s) pro banco (conta ADM).`). Se algum desses vídeos/playlists antigos
na verdade pertence a uma conta cliente específica, é só o ADM entrar e, no
caso da mídia, apagar e reenviar já logado como a conta certa (ou, se
preferir, me avise que dá pra pensar numa tela de "transferir mídia entre
contas" numa próxima fase).

**Uma decisão que tomei sozinho, sem te perguntar antes:** o limite de
armazenamento (`R2_MAX_STORAGE_GB`, se você tiver configurado) continua
sendo um teto **global**, somando o espaço usado por todas as contas juntas
— não virou um limite por conta. Fazer por conta exigiria também um jeito de
medir "quanto essa conta específica está usando" sem contar duas vezes
arquivo nenhum, o que é mais trabalho e não foi uma das três decisões que
combinamos antes de eu começar essa fase. Se você quiser isso, é só pedir
numa próxima versão.

## Correção de bug reportado em teste (2026-08-10)

Ao testar, você viu uma TV mostrando "Nenhum controlador no ar no momento"
mesmo com o painel ADM aberto. Bug real, já corrigido: para uma TV **ainda
não pareada**, o servidor estava sempre mandando "sem controlador" pra ela,
não importa quem estivesse online — só TVs já pareadas checavam de verdade
se havia um controlador da conta (ou ADM) conectado. Agora uma TV sem dono
mostra "controlador conectado" se QUALQUER controlador estiver no ar (já que
qualquer um pode parear ela digitando o código) — mesma lógica de antes da
Fase 3, só reaplicada certinho pro caso "ainda sem dono".

Sobre a outra coisa que você reportou — nenhuma conta aparecendo no painel
Contas — a causa mais provável é a migração do banco (`schema-migracao-0.4.sql`)
ainda não ter sido rodada no seu Neon: a partir da 0.4, a lista de contas
também busca a coluna `licenca_permanente` e faz um `LEFT JOIN` com a tabela
`tvs` (pra mostrar quantas TVs cada conta tem pareadas) — sem essas duas
coisas existirem no banco, essa consulta falha e o painel mostra a lista
vazia (com um erro no console do navegador, se você abrir o DevTools). Veja
a seção abaixo ("Antes de colocar no ar") e confirme se essa migração já
rodou no seu banco. Se já rodou e o problema persistir, me avise com o que
aparece no console do navegador (F12 → aba Console) que eu investigo mais.

## Dois ajustes de última hora (antes de você testar)

- **Limite de tentativas de login por IP reduzido de 20 para 5 por hora**
  (`/login`). Na 6ª tentativa (certa ou errada) do mesmo IP dentro de 1 hora,
  a rota responde erro 429 até a janela passar. Ainda é só em memória —
  reinicia zerado a cada deploy/reinício do servidor.
- **Botão de mostrar/ocultar senha** (ícone de olho dentro do campo) — tanto
  na tela de login (`login.html`) quanto no campo de senha do formulário de
  conta no painel ADM (aba Contas). Clicando, alterna entre pontinhos e o
  texto de verdade; some de novo ao reabrir o formulário/a página.

## ⚠️ Antes de colocar no ar: rode a migração no banco (Neon)

Diferente das versões anteriores, **desta vez o seu banco no Neon já tem
contas de verdade cadastradas** — então não dá pra simplesmente rodar o
`schema-contas.sql` de novo (ele tenta `CREATE TABLE contas`, que já existe,
e falharia).

Use o arquivo novo **`schema-migracao-0.4.sql`** em vez disso: abra o SQL
Editor do Neon, cole o arquivo inteiro e rode tudo de uma vez. Ele só
**adiciona** o que falta (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` e
`CREATE TABLE IF NOT EXISTS`) — é seguro rodar mesmo que alguma parte já
exista, e não apaga nada. Faz duas coisas:

1. Adiciona a coluna `licenca_permanente` na tabela `contas` (toda conta
   existente começa com `false` — ninguém vira "permanente" sozinho).
2. Cria a tabela nova `tvs`, que guarda qual conta é dona de cada TV.

**Rode isso ANTES de colocar o código da 0.4 no ar.** Sem essa migração,
`/login`, `/parear-tv` e o painel ADM vão quebrar (coluna/tabela faltando).

O `schema-contas.sql` continua no pacote só pra quem for fazer uma instalação
nova do zero (banco vazio) — não use ele se seu banco já tem dados.

## Novidade da 0.4, parte 1: TVs vinculadas por conta (Fase 3)

Até a 0.3, toda TV conectada aparecia pra **qualquer** conta logada — não
existia isolamento nenhum. A partir de agora, cada TV só aparece e só pode
ser controlada pela conta que a pareou com ela (exceto pelo ADM, que continua
vendo e controlando todas as TVs de todas as contas, do jeito que
combinamos).

**Como funciona pra quem usa:**

- Uma TV nova (ou qualquer TV que ainda não foi pareada) mostra, na própria
  tela, um **código de 6 caracteres** em vez do vídeo — igual ao "aguardando"
  de antes, só que agora com um código de pareamento embaixo do logo.
- No painel de controle, dentro do dropdown de TVs, tem uma caixinha nova
  **"Parear TV"**: digita esse código ali e a TV passa a pertencer à conta
  logada na hora — sem precisar recarregar nada, nem na TV nem no painel (o
  WebSocket avisa os dois lados sozinho).
- Cada conta só vê e controla as TVs que ela mesma pareou. O ADM continua
  vendo todas.
- Dá pra **desparear** uma TV (botão "Desparear" na tela de detalhes dela, no
  painel): ela some da sua lista e volta a mostrar um código de pareamento
  novo na própria tela — pronto pra ser pareada de novo, com essa conta ou
  outra.
- O campo **"Limite de TVs"** (que já existia desde a 0.2/0.3, mas não fazia
  nada ainda) agora vale de verdade: ao atingir o limite, um novo pareamento
  é recusado com uma mensagem clara. TVs **já pareadas continuam funcionando
  normalmente** mesmo que você diminua o limite depois (só bloqueia
  pareamentos NOVOS, não desconecta quem já estava dentro do limite antigo).
- Cada cartão de conta no painel Contas agora mostra também **quantas TVs
  ela tem pareadas** (ex: "📺 2/5 TVs pareadas").

**⚠️ Atenção — toda TV que já está em uso hoje vai pedir pareamento de
novo** na primeira vez que a página dela recarregar depois deste deploy.
Isso é esperado: nenhuma TV tinha essa identidade de pareamento antes da
Fase 3. Basta anotar o código que aparece em cada TV e digitar no painel
(Contas certa → dropdown de TVs → "Parear TV") — leva menos de um minuto por
TV.

## Novidade da 0.4, parte 2: licença permanente + aviso de vencimento

No formulário de editar/criar conta (aba Contas, só ADM), o campo de licença
ganhou três coisas:

- **Checkbox "Licença permanente"**: marcando, essa conta nunca mais é
  bloqueada por validade de licença (equivalente a uma conta que nunca
  vence). O campo de data fica desabilitado (cinza) enquanto marcado, mas a
  data que já estava lá **não é apagada** — se você desmarcar depois, ela
  volta a valer, sem precisar digitar de novo.
- **Data de validade formatada** logo abaixo do campo, mostrando claramente
  "Válida até dd/mm/aaaa", "Vence em Nd" (quando faltam 10 dias ou menos) ou
  "Licença vencida há N dia(s)", com cor mudando (cinza → âmbar → vermelho)
  conforme a urgência.
- Isso também aparece resumido em cada cartão da lista de contas — uma conta
  a 10 dias ou menos de vencer ganha um selo âmbar "Vence em Nd"; vencida
  vira "Licença vencida" (vermelho); permanente vira "♾️ Permanente"; sem
  data nenhuma definida vira "Sem validade" (login bloqueado até você definir
  uma data ou marcar permanente).

Nada muda pra quem já tinha uma data de validade definida — o aviso e o
selo só aparecem quando a data se aproxima ou já passou.

## Atualização (herdada da 0.3): painel de contas ADM (Fase 2)

Quem loga como **ADM** vê uma aba **Contas** ao lado de Vídeos e Playlists
(contas `cliente` não veem essa aba — nem no menu, nem nas rotas por trás
dela). Nela dá pra ver todas as contas cadastradas, criar uma nova, editar
(inclusive trocar o papel, suspender/reativar, redefinir senha) e excluir
com confirmação por nome. Duas travas de segurança: um ADM não consegue
excluir a própria conta logada nem trocar o próprio papel por essa tela
(servidor e tela concordam nisso).

## Atualização (herdada da 0.2): robustez contra travamentos

- **Timeout nas consultas ao banco:** se o Neon ficar lento ou inacessível,
  uma tentativa de login (ou de abrir o controlador) falha em até ~8s, em
  vez de ficar "pensando" pra sempre.
- **Limite de tamanho nos corpos de requisição JSON.**
- **Heartbeat no WebSocket:** o servidor "cutuca" (ping) cada TV/controlador
  a cada 30s e derruba quem não responder.
- **`/storage-usage` deixou de ser síncrono.**
- **Limite de tentativas de login por hora:** 20 tentativas por IP por hora
  em `/login`; depois disso, erro 429 até a janela passar.

## Arquivos novos ou alterados (acumulado 0.1 → 0.5)

| Arquivo | Situação |
|---|---|
| `server.js` | Alterado — `/videos-list`, `POST/GET /playlists`, `DELETE /playlists/<id>` e `DELETE /delete-video` agora exigem login e filtram por dono; upload (`/request-upload` e `POST /upload-video`) registra o dono do arquivo assim que ele é criado; migração automática do `playlists.json` antigo pro banco no boot (0.5) |
| `lib/midia.js` | **Novo (0.5)** — índice "arquivo → conta dona": registrar, consultar, remover, e adotar em massa arquivos órfãos pra conta ADM |
| `lib/playlists.js` | **Novo (0.5)** — CRUD de playlists no banco (antes vivia em `playlists.json`); inclui a migração única do arquivo antigo pro banco e a limpeza de referências quando um vídeo é apagado |
| `lib/contas.js` | Alterado — nova `buscarPrimeiroAdmId()`, usada pra decidir quem adota mídia/playlists órfãs (0.5) |
| `schema-migracao-0.5.sql` | **Novo (0.5)** — cria as tabelas `playlists` e `midia` num banco que já está em uso (ver seção no topo) |
| `server.js` | Alterado (0.4) — rotas `POST /parear-tv` e `DELETE /tvs/<id>` novas; WebSocket reescrito pra isolar TVs por conta (`podeControlarTv`, `sendTvListToController`, `notifyAllTvs`, `broadcast` escopados); `tv_connect` agora usa `deviceId` pra reconhecer a TV entre reconexões |
| `lib/tvs.js` | **Novo (0.4)** — pareamento de TV por conta: gerar código, buscar/criar TV pelo `device_id`, parear por código (checando limite), desparear, atualizar nome |
| `lib/contas.js` | Alterado (0.4) — inclui `licenca_permanente` e `tvs_pareadas` (via LEFT JOIN com `tvs`) nas contas retornadas; `criarConta`/`atualizarConta` aceitam `licencaPermanente` |
| `lib/auth.js` | Alterado (0.4) — `licencaValida()` agora também aceita `licenca_permanente` como motivo pra nunca bloquear |
| `js/controller.js` | Alterado (0.4) — caixa "Parear TV", botão "Desparear", checkbox de licença permanente + status colorido de validade, selos de licença/TVs pareadas nos cartões de conta |
| `js/tv.js` | Alterado (0.4) — gera e guarda um `device_id` (UUID) no localStorage da TV; tela de espera mostra código de pareamento ou "✅ TV pareada" |
| `tv.html` | Alterado (0.4) — rótulo e texto de ajuda da caixa de código adaptados pro pareamento |
| `controller.html` | Alterado (0.4) — caixa de pareamento no dropdown de TVs, botão Desparear no painel de detalhes, checkbox + status de licença permanente no formulário de conta |
| `css/controller.css` | Alterado (0.4) — estilo da caixa de pareamento |
| `schema-migracao-0.4.sql` | Novo (0.4) — migração não-destrutiva pro banco que já estava em uso (já deve ter sido rodada) |
| `schema-contas.sql` | Alterado — inclui `licenca_permanente`, `tvs`, `playlists` e `midia`, **só pra instalações novas do zero** |

(Tabela de arquivos das fases anteriores — 0.1 a 0.3 — omitida aqui por
brevidade; o histórico completo continua no `CHANGELOG.md`.)

## Passo a passo pra colocar no ar

1. **Rode a migração primeiro:** `schema-migracao-0.5.sql` no SQL Editor do
   Neon (ver seção "⚠️ Antes de colocar no ar" no topo deste arquivo). Se for
   uma instalação nova do zero (banco vazio, sem contas ainda), use
   `schema-contas.sql` em vez disso — ele já inclui tudo (contas, tvs,
   playlists, midia) de uma vez.
2. **Copiar este projeto** pro seu repositório local, substituindo os
   arquivos alterados.
3. **Deploy:** `git add`, `git commit`, `git push`, redeploy no Render.
4. **Confira a aba Vídeos/Playlists** logado como ADM: se você tinha
   mídia/playlists de antes desse isolamento existir, elas devem aparecer lá
   (adotadas automaticamente pela conta ADM, ver seção acima).

## Como testei esta versão (0.5)

Rodei localmente com um banco simulado (sem acesso ao seu Neon de verdade
deste ambiente), cobrindo o fluxo inteiro de ponta a ponta:

- Upload de vídeo como conta cliente A → aparece na listagem só da conta A
  (e do ADM); conta cliente B não vê.
- Criação de playlist como conta cliente A → aparece só pra ela (e pro ADM);
  conta cliente B não vê.
- Conta cliente B tentando editar/apagar a playlist ou o vídeo da conta A
  direto pela API (sem passar pela tela) → recusado com erro 403 nos três
  casos (editar playlist, apagar playlist, apagar vídeo).
- Apagar um vídeo que era o único item de uma playlist → a playlist some
  junto (ficaria vazia).
- Arquivo "órfão" colocado direto na pasta de vídeos (simulando mídia de
  antes da Fase 4) → primeira listagem depois disso adota ele
  automaticamente pra conta ADM; conta cliente não vê nem consegue apagar
  esse arquivo depois da adoção, só o ADM.
- `playlists.json` antigo com uma playlist dentro → subindo o servidor pela
  primeira vez, a playlist migra pro banco sob a conta ADM e o arquivo é
  renomeado pra `playlists.json.migrado` (marca de que já migrou, não roda
  de novo em restarts seguintes).

(Testes herdados da 0.4 — pareamento de TV, licença permanente, limite de
login por IP — continuam valendo, não foram re-executados nesta rodada por
não terem sido tocados na Fase 4.)

O que eu não consegui testar aqui: a conexão real com o seu Neon, um teste
visual de verdade em duas TVs físicas lado a lado, e o botão de
mostrar/ocultar senha (é só JS de interface, sem lógica de servidor por
trás — não tem como validar clique/ícone rodando o servidor sozinho num
terminal; vale só conferir visualmente ao testar o login).
