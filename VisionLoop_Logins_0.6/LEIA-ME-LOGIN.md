# VisionLoop_Logins_0.6 — Limite de armazenamento por conta, limpeza de arquivos e correção do bug de exclusão de playlist

## Correção de bug reportado: excluir playlist não fechava o painel dela

Você reportou: ao excluir uma playlist enquanto estava com o painel dela
aberto (visualizando ou editando os vídeos), o painel continuava na tela
mesmo depois da exclusão — em vez de fechar/voltar pro estado vazio, como já
acontecia em outros casos.

**Causa:** um problema de tipo em JavaScript, não de lógica. O id de cada
playlist chega de dois jeitos diferentes no painel:

- Como **texto** (`"3"`), quando vem de um clique num botão da lista (o
  `onclick` do HTML sempre vira string).
- Como **número** (`3`), quando vem direto da resposta da API logo depois de
  criar ou editar uma playlist (o id é uma coluna numérica no Postgres).

O código guardava "qual playlist está selecionada" numa variável só, e
comparava esse valor com `===` (comparação estrita, que também compara o
tipo). Assim que você criava ou salvava uma playlist, essa variável passava
a guardar um **número**; se em seguida você excluía aquela mesma playlist
pelo botão × da lista (que manda um **texto**), a comparação `3 === "3"`
dava **falso** — o código concluía (errado) que a playlist excluída não era
a que estava com o painel aberto, e por isso não fechava nada. Fora do
cenário de "criar/editar e já excluir em seguida", os dois lados por
coincidência tendiam a ser sempre texto, por isso o problema não aparecia em
todo teste.

**Correção:** os quatro pontos do código que faziam essa comparação ou
guardavam esse id (`js/controller.js`) agora sempre convertem pra texto
antes de comparar ou guardar, então o tipo nunca mais pode divergir. De
brinde, corrigi também um efeito colateral do mesmo bug que você não tinha
mencionado: o destaque visual (cartão da playlist selecionada, com borda
diferente na lista) também podia falhar em ficar marcado certo pelo mesmo
motivo — agora fica consistente.

**Nenhuma migração de banco, rota nova ou mudança de comportamento** além
dessa correção — só o front-end (`js/controller.js`).

## Novidade da 0.6: limite de armazenamento por conta, agora valendo de verdade

O campo **"Limite de armazenamento (GB)"** já existia no formulário de cada
conta desde bem cedo, mas até a 0.5 ele era só um número salvo, sem efeito
nenhum — uma conta conseguia subir mídia à vontade mesmo passando do que
estava configurado pra ela. A partir de agora esse limite é **aplicado de
verdade**, mesmo padrão que o "Limite de TVs" já tinha desde a Fase 3:

- Cada conta cliente só consegue subir vídeo/imagem novo enquanto a soma do
  que ELA já tem armazenado (mais o arquivo novo) não passar do limite
  configurado pra ela. Ao tentar passar, o upload é recusado com uma
  mensagem clara mostrando o limite configurado — tanto no modo R2 quanto no
  modo disco local.
- O ADM também tem um limite (999GB por padrão, na prática nunca chega
  perto) — mesmo mecanismo aplicado a todo mundo, sem caso especial.
- Apagar mídia libera espaço na hora — a próxima checagem de limite já
  considera o espaço liberado, sem precisar reiniciar nada.
- O indicador de armazenamento no topo do painel (💾 ícone, ao lado da
  versão) agora mostra **o que faz sentido pra quem está olhando**: uma
  conta cliente vê o próprio uso contra o próprio limite; o ADM continua
  vendo o total geral (todas as contas somadas) contra o teto do bucket
  inteiro (`R2_MAX_STORAGE_GB`, se você tiver configurado essa variável de
  ambiente — independente do limite por conta, os dois tetos podem estar
  ativos ao mesmo tempo, e o que estourar primeiro é o que barra o upload).

**Não precisa de nenhuma migração de banco nova pra isso** — a coluna
`limite_armazenamento_gb` já existia na tabela `contas` desde a Fase 1, só
não era usada pra nada até agora. Se algum cliente seu já está usando mais
espaço do que o limite configurado hoje (porque nunca foi checado antes),
ele não perde nada disso — só passa a não conseguir subir mídia **nova**
até apagar algo ou você aumentar o limite dele no painel Contas.

## Novidade da 0.6: arquivos de uso único removidos do pacote

A pedido do usuário, três arquivos que já cumpriram o papel deles e não são
mais necessários foram retirados desta entrega:

- **`schema-migracao-0.4.sql`** — migração pontual pra levar o banco da
  Fase 2 pra Fase 3 (colunas/tabela que já foram criadas há tempos). Se você
  precisar montar um banco novo do zero algum dia, use `schema-contas.sql`
  (já vem com tudo, incluindo o que esse arquivo adicionava).
- **Pasta `exclua-me/`** (`setup-adm-route.js` + `setup-adm.html`) — página
  temporária pra criar a primeira conta ADM pelo navegador, sem precisar de
  SQL. Só funciona com o banco de contas vazio, então já não fazia nada
  desde que sua primeira conta ADM foi criada. `server.js` também foi
  limpo da referência a essa pasta (a rota `/setup-adm` não existe mais).
- **`scripts/criar-conta-adm.js`** — alternativa em linha de comando pro
  mesmo passo acima (criar a 1ª conta ADM). Mesma lógica: uma vez que existe
  pelo menos uma conta ADM, o próprio painel Contas já cobre criar quantas
  contas você quiser, então esse script parou de ter uso.

**Se um dia você precisar recriar o banco do zero** (Neon novo, por
exemplo) e quiser voltar a ter uma dessas ferramentas de bootstrap, é só
pedir — eu regenero o arquivo, elas não desapareceram de propósito pra
sempre, só saíram do pacote porque não tinham mais função no seu ambiente
atual.

## ⚠️ Antes de colocar no ar: já rodou a migração da 0.5?

Se você já rodou o `schema-migracao-0.5.sql` (playlists/mídia isoladas por
conta) antes do deploy da 0.5, **não precisa rodar nada novo agora** — a
0.6 não muda o banco, só o comportamento do servidor. Se por acaso ainda
não rodou aquela migração, veja a seção logo abaixo antes de colocar a 0.6
no ar (sem ela, `/videos-list`, `/playlists` e `/delete-video` continuam
quebrados, independente desta atualização).

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

## Arquivos novos ou alterados (acumulado 0.1 → 0.6)

| Arquivo | Situação |
|---|---|
| `js/controller.js` | Corrigido (0.6) — comparação de id de playlist (`selectedPlaylistId`) sempre convertida pra texto antes de comparar/guardar, corrigindo o painel que ficava aberto após excluir uma playlist recém criada/editada |
| `server.js` | Alterado — `getSizesMap()` novo (lista tamanho de tudo que está no armazenamento, R2 ou disco local, num só lugar); `wouldExceedStorageCap()` agora checa o limite DA CONTA além do global; `/storage-usage` passou a exigir login e responde o uso certo pra cada papel (0.6) |
| `server.js` | Removido (0.6) — a rota `POST /setup-adm` e o `require` condicional de `./exclua-me/setup-adm-route` (a pasta que ela dependia foi retirada do pacote, ver abaixo) |
| `exclua-me/` (pasta inteira) | **Removido (0.6)** — bootstrap da 1ª conta ADM pelo navegador, só funcionava com banco vazio; sem uso desde que sua conta ADM foi criada |
| `scripts/criar-conta-adm.js` | **Removido (0.6)** — mesmo bootstrap, versão linha de comando; substituído pelo painel Contas há tempos |
| `schema-migracao-0.4.sql` | **Removido (0.6)** — migração pontual da Fase 2→3, já rodada no seu banco; `schema-contas.sql` (instalação nova) já inclui o que ela adicionava |
| `server.js` | Alterado — `/videos-list`, `POST/GET /playlists`, `DELETE /playlists/<id>` e `DELETE /delete-video` agora exigem login e filtram por dono; upload (`/request-upload` e `POST /upload-video`) registra o dono do arquivo assim que ele é criado; migração automática do `playlists.json` antigo pro banco no boot (0.5) |
| `lib/midia.js` | Novo (0.5) — índice "arquivo → conta dona": registrar, consultar, remover, e adotar em massa arquivos órfãos pra conta ADM |
| `lib/playlists.js` | Novo (0.5) — CRUD de playlists no banco (antes vivia em `playlists.json`); inclui a migração única do arquivo antigo pro banco e a limpeza de referências quando um vídeo é apagado |
| `lib/contas.js` | Alterado (0.5) — nova `buscarPrimeiroAdmId()`, usada pra decidir quem adota mídia/playlists órfãs |
| `schema-migracao-0.5.sql` | Novo (0.5) — cria as tabelas `playlists` e `midia` num banco que já está em uso (ver seção no topo) |
| `server.js` | Alterado (0.4) — rotas `POST /parear-tv` e `DELETE /tvs/<id>` novas; WebSocket reescrito pra isolar TVs por conta (`podeControlarTv`, `sendTvListToController`, `notifyAllTvs`, `broadcast` escopados); `tv_connect` agora usa `deviceId` pra reconhecer a TV entre reconexões |
| `lib/tvs.js` | Novo (0.4) — pareamento de TV por conta: gerar código, buscar/criar TV pelo `device_id`, parear por código (checando limite), desparear, atualizar nome |
| `lib/contas.js` | Alterado (0.4) — inclui `licenca_permanente` e `tvs_pareadas` (via LEFT JOIN com `tvs`) nas contas retornadas; `criarConta`/`atualizarConta` aceitam `licencaPermanente` |
| `lib/auth.js` | Alterado (0.4) — `licencaValida()` agora também aceita `licenca_permanente` como motivo pra nunca bloquear |
| `js/controller.js` | Alterado (0.4) — caixa "Parear TV", botão "Desparear", checkbox de licença permanente + status colorido de validade, selos de licença/TVs pareadas nos cartões de conta |
| `js/tv.js` | Alterado (0.4) — gera e guarda um `device_id` (UUID) no localStorage da TV; tela de espera mostra código de pareamento ou "✅ TV pareada" |
| `tv.html` | Alterado (0.4) — rótulo e texto de ajuda da caixa de código adaptados pro pareamento |
| `controller.html` | Alterado (0.4) — caixa de pareamento no dropdown de TVs, botão Desparear no painel de detalhes, checkbox + status de licença permanente no formulário de conta |
| `css/controller.css` | Alterado (0.4) — estilo da caixa de pareamento |
| `schema-contas.sql` | Alterado — inclui `licenca_permanente`, `tvs`, `playlists` e `midia`, **só pra instalações novas do zero** |

(Tabela de arquivos das fases anteriores — 0.1 a 0.3 — omitida aqui por
brevidade; o histórico completo continua no `CHANGELOG.md`.)

## Passo a passo pra colocar no ar

1. **Rode a migração, se ainda não rodou:** `schema-migracao-0.5.sql` no SQL
   Editor do Neon (ver seção "⚠️ Antes de colocar no ar" acima) — só é
   necessário se você ainda não tinha rodado ela antes do deploy da 0.5. A
   0.6 não precisa de nenhuma migração nova. Instalação nova do zero (banco
   vazio, sem contas ainda): use `schema-contas.sql` em vez disso — já inclui
   tudo (contas, tvs, playlists, midia) de uma vez.
2. **Copiar este projeto** pro seu repositório local, **substituindo a pasta
   inteira** (não só colando por cima) — a 0.6 removeu arquivos que a 0.5
   tinha (`exclua-me/`, `scripts/`, `schema-migracao-0.4.sql`); só copiar os
   alterados por cima deixaria esses arquivos removidos ainda no seu
   repositório.
3. **Deploy:** `git add`, `git commit`, `git push`, redeploy no Render.
4. **Confira o limite de armazenamento de cada conta** no painel Contas — se
   nunca tinha configurado esse campo antes, todas as contas começaram com
   5GB por padrão (exceto a primeira conta ADM, que já vem com 999GB);
   ajuste o que fizer sentido pra cada cliente antes que alguém seja pego de
   surpresa por um upload recusado.

## Como testei esta versão (0.6)

**Bug da exclusão de playlist:** reproduzi o bug reportado rodando o
servidor localmente com um banco simulado (sem acesso ao seu Neon de
verdade deste ambiente): logei, criei uma playlist nova (o que já deixava
`selectedPlaylistId` como número, a causa raiz), abri o painel dela e chamei
a exclusão pelo mesmo fluxo do botão × — confirmei que, no código de antes,
a comparação de tipos realmente falhava (`3 === "3"` dá falso), e que com a
correção aplicada (`String(...)` dos dois lados) a mesma sequência agora
fecha o painel corretamente. Também conferi os outros três pontos que
guardavam/comparavam esse id (seleção pela lista, destaque visual do cartão
selecionado, exclusão vinda de um id só-texto sem nunca ter criado/editado
antes) — nenhum regrediu.

**Limite de armazenamento por conta:** rodei localmente com um banco e um
bucket R2 simulados (sem acesso ao seu
Neon/Cloudflare de verdade deste ambiente), cobrindo o teto por conta nos
dois modos de armazenamento:

- Conta cliente com limite bem pequeno configurado → upload dentro do limite
  passa normalmente; upload que estouraria o limite é recusado (HTTP 413)
  com a mensagem certa, tanto no modo disco local quanto no modo R2.
- Apagar mídia libera espaço na hora — um upload que tinha sido recusado por
  falta de espaço passa a funcionar assim que espaço suficiente é liberado.
- Conta ADM (999GB por padrão) não é afetada por um limite de conta pequeno
  configurado em outra conta — cada conta só é medida pela própria mídia.
- Os dois tetos (por conta E o global `R2_MAX_STORAGE_GB`, quando
  configurado) coexistem sem conflito: testei um caso onde só o teto global
  estourava (limite de conta bem folgado) e outro onde só o teto da conta
  estourava (limite de conta apertado, teto global folgado) — cada um dispara
  com a mensagem certa, independente do outro.
- `/storage-usage`: conta cliente recebe o próprio uso contra o próprio
  limite; ADM recebe o total geral contra o teto global — confirmado que os
  dois casos respeitam a sessão logada (a rota agora exige login).
- Servidor sobe normalmente sem a pasta `exclua-me/` nem `scripts/` (o
  `require` condicional que dependia da pasta foi removido junto, não fica
  mais try/catch morto no código).

(Testes herdados da 0.5 — isolamento de mídia/playlists por conta, adoção
automática de órfãos, migração do `playlists.json` — e da 0.4 — pareamento
de TV, licença permanente, limite de login por IP — continuam valendo, não
foram re-executados nesta rodada por não terem sido tocados na 0.6.)

O que eu não consegui testar aqui: a conexão real com o seu Neon/R2, um
teste visual de verdade em duas TVs físicas lado a lado, e o botão de
mostrar/ocultar senha (é só JS de interface, sem lógica de servidor por
trás — não tem como validar clique/ícone rodando o servidor sozinho num
terminal; vale só conferir visualmente ao testar o login).
