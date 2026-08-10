# VisionLoop_Logins_0.4 — TVs por conta (Fase 3) + licença permanente/aviso de vencimento

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

## Arquivos novos ou alterados (acumulado 0.1 → 0.4)

| Arquivo | Situação |
|---|---|
| `server.js` | Alterado — rotas `POST /parear-tv` e `DELETE /tvs/<id>` novas; WebSocket reescrito pra isolar TVs por conta (`podeControlarTv`, `sendTvListToController`, `notifyAllTvs`, `broadcast` escopados); `tv_connect` agora usa `deviceId` pra reconhecer a TV entre reconexões (0.4) |
| `lib/tvs.js` | **Novo (0.4)** — pareamento de TV por conta: gerar código, buscar/criar TV pelo `device_id`, parear por código (checando limite), desparear, atualizar nome |
| `lib/contas.js` | Alterado — inclui `licenca_permanente` e `tvs_pareadas` (via LEFT JOIN com `tvs`) nas contas retornadas; `criarConta`/`atualizarConta` aceitam `licencaPermanente` (0.4) |
| `lib/auth.js` | Alterado — `licencaValida()` agora também aceita `licenca_permanente` como motivo pra nunca bloquear (0.4) |
| `js/controller.js` | Alterado — caixa "Parear TV", botão "Desparear", checkbox de licença permanente + status colorido de validade, selos de licença/TVs pareadas nos cartões de conta (0.4) |
| `js/tv.js` | Alterado — gera e guarda um `device_id` (UUID) no localStorage da TV; tela de espera mostra código de pareamento ou "✅ TV pareada" (0.4) |
| `tv.html` | Alterado — rótulo e texto de ajuda da caixa de código adaptados pro pareamento (0.4) |
| `controller.html` | Alterado — caixa de pareamento no dropdown de TVs, botão Desparear no painel de detalhes, checkbox + status de licença permanente no formulário de conta (0.4) |
| `css/controller.css` | Alterado — estilo da caixa de pareamento (0.4) |
| `schema-migracao-0.4.sql` | **Novo (0.4)** — migração não-destrutiva pro banco que já está em uso (ver seção no topo) |
| `schema-contas.sql` | Alterado — inclui a coluna `licenca_permanente` e a tabela `tvs`, **só pra instalações novas do zero** (0.4) |

(Tabela de arquivos das fases anteriores — 0.1 a 0.3 — omitida aqui por
brevidade; o histórico completo continua no `CHANGELOG.md`.)

## Passo a passo pra colocar no ar

1. **Rode a migração primeiro:** `schema-migracao-0.4.sql` no SQL Editor do
   Neon (ver seção "⚠️ Antes de colocar no ar" no topo deste arquivo). Se for
   uma instalação nova do zero (banco vazio, sem contas ainda), use
   `schema-contas.sql` em vez disso.
2. **Copiar este projeto** pro seu repositório local, substituindo os
   arquivos alterados.
3. **Deploy:** `git add`, `git commit`, `git push`, redeploy no Render.
4. **Re-parear as TVs:** cada TV que já estava em uso vai mostrar um código
   novo na tela na próxima vez que recarregar — digite cada um no painel
   (Contas → conta certa → "Parear TV").

## Como testei esta versão (0.4)

Rodei localmente com um banco simulado (sem acesso ao seu Neon de verdade
deste ambiente), cobrindo o fluxo inteiro de ponta a ponta:

- TV conecta com um `device_id`, recebe um código de pareamento, mostra ele
  na tela.
- Pareamento pelo painel (`POST /parear-tv`): a TV recebe a confirmação
  "pareada" **ao vivo**, sem recarregar, e passa a aparecer na lista do
  controlador certo.
- Isolamento entre contas: o controlador de uma conta não vê nem consegue
  mandar comando pra TV pareada com OUTRA conta; um comando `play` mandado
  pra uma TV que não é sua é simplesmente ignorado pelo servidor.
- ADM vê e controla as TVs de todas as contas ao mesmo tempo.
- Limite de TVs: pareamento novo é recusado assim que a conta atinge o
  limite configurado, com a mensagem de erro certa.
- Desparear (`DELETE /tvs/<id>`): a TV recebe um código novo ao vivo e some
  da lista do controlador na hora.
- Licença: conta com `licenca_permanente` nunca bloqueia por validade; conta
  sem data definida fica bloqueada até uma data ser definida (ou marcada
  permanente); os textos e cores de aviso (10 dias ou menos, vencida, ok)
  bateram com o esperado em cada caso.
- Limite de login por IP: confirmado erro 429 exatamente na 6ª tentativa
  (certa ou errada) do mesmo IP dentro da janela de 1 hora.

O que eu não consegui testar aqui: a conexão real com o seu Neon, um teste
visual de verdade em duas TVs físicas lado a lado, e o botão de
mostrar/ocultar senha (é só JS de interface, sem lógica de servidor por
trás — não tem como validar clique/ícone rodando o servidor sozinho num
terminal; vale só conferir visualmente ao testar o login).
