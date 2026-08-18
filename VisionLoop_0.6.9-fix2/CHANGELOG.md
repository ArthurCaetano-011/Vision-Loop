# Changelog

Todas as mudanças relevantes do VisionLoop, da versão mais recente para a mais antiga.

## Como versionar

O padrão de nome é **`AAAA-MM-DD_VisionLoop-X.Y.Z`**, usado igual na pasta e no zip — por exemplo `2026-07-31_VisionLoop-0.0.8.zip`. O campo `"version"` do `package.json` recebe só o número (`0.0.8`) e deve bater sempre com o do nome.

A data vai no formato ano-mês-dia justamente porque assim a ordem alfabética e a cronológica são a mesma coisa: a pasta se organiza sozinha, da versão mais antiga para a mais nova, sem depender de datas de modificação (que se perdem ao copiar ou descompactar arquivos). Escrita como dia-mês-ano isso não funcionaria.

Sobre qual número mexer: suba o último em correções e ajustes, o do meio quando entrar funcionalidade nova, e o primeiro só se algo quebrar a compatibilidade com o que já existia. O "o que mudou" fica aqui neste arquivo, nunca no nome do zip.

---

## 0.6.9-fix2 — 17/08/2026

Limpeza: **os arquivos de migração saíram do pacote**, já que cumpriram o papel.

- **Removidos:** `schema-migracao-0.5.sql` (criou as tabelas `playlists` e `midia`) e `schema-migracao-0.6.9.sql` (criou a coluna `expira_em`). São scripts de uma vez só, já executados no banco em uso — sem nenhuma utilidade depois disso. Mesma limpeza que foi feita na 0.6 com o `schema-migracao-0.4.sql`.
- **Mantido:** `schema-contas.sql`. Ele não é migração: é a planta completa do banco, usada para montar tudo do zero (banco novo, troca de provedor, ambiente de teste). Já inclui a coluna `expira_em`.
- Os avisos que citavam o arquivo de migração pelo nome — no log do servidor e na tela de envio — foram reescritos para falar da **coluna** em si e mostrar o comando que a cria, já que o arquivo não vem mais junto. O comportamento tolerante da 0.6.9-fix continua igual: faltando a coluna, o app funciona sem prazo em vez de quebrar.

Nenhuma mudança de funcionamento: o servidor nunca leu esses arquivos, quem os executava era você, no SQL Editor do Neon.

---

## 0.6.9-fix — 17/08/2026

Correção: **não dava para enviar arquivo depois de atualizar para a 0.6.9**, se a migração do banco ainda não tivesse sido rodada.

### O que estava acontecendo

A 0.6.9 acrescentou a coluna `midia.expira_em`, criada pelo `schema-migracao-0.6.9.sql`. Num banco onde essa migração ainda não rodou, toda consulta que mencionava a coluna falhava — e essas consultas estavam bem no caminho do envio de arquivo:

- **No modo R2** (o do site em produção): a rota que autoriza o upload gravava dono e validade **antes** de responder. A gravação falhava, a resposta virava erro 502 e **o upload nem começava**.
- **Nos dois modos**: a listagem da biblioteca (`/videos-list`) também consultava a validade, então respondia erro e a grade ficava vazia — no disco local o arquivo até subia, mas não aparecia em lugar nenhum. Na prática, "não deu certo".

Era um erro de estreia bem específico: só acontece entre subir a versão nova e rodar a migração. Mas ele derrubava justamente a função principal do app, então a correção é tratar isso como estado normal, não como acidente.

### Corrigido

- **Banco sem a coluna deixou de ser um erro fatal.** As três consultas de validade reconhecem o erro do Postgres para "coluna não existe" (42703) e seguem sem ela: o arquivo é registrado só com o dono, a biblioteca lista tudo normalmente e a varredura não tem nada para varrer. O app fica se comportando exatamente como a 0.6.8 — tudo sem prazo — até a migração ser rodada.
- **Volta a valer sozinho.** Assim que a migração roda, o servidor torna a tentar em até um minuto e o prazo passa a funcionar, **sem precisar reiniciar** nada.
- **Aviso claro em vez de silêncio.** No log do servidor aparece uma mensagem explicando o que fazer, e a tela de envio mostra um alerta em âmbar, com a opção "Expirar em uma data e hora" desabilitada — melhor do que aceitar uma data que nunca ia chegar a valer.
- **Registrar dono/validade deixou de poder derrubar um upload.** No modo R2 essa gravação agora é tolerante a falha, igual já era no modo disco local: se o banco tropeçar, o arquivo sobe assim mesmo e o registro se resolve na listagem seguinte.

### Verificação

Testado com **dois servidores rodando ao mesmo tempo**, um com a coluna e outro sem ela (banco simulado que recusa a coluna, como o Postgres faria):

- **Sem a migração:** os 4 arquivos sobem (200 nos quatro), aparecem na biblioteca, entram na ordem de reprodução; `/videos-list` e `/media-meta` respondem normalmente em vez de 502/500; a tela de envio mostra o aviso e trava a opção de prazo; o log traz a instrução do que rodar.
- **Com a migração:** nada mudou — envio com prazo registra a validade, envio sem prazo não registra, e o selo ⏳ continua aparecendo.
- Nos dois casos, envio de 4 arquivos de uma vez pelo navegador, com a interface real: 4 requisições, 4 itens na playlist, nenhum erro de JavaScript e nenhum alerta.

---

## 0.6.9 — 17/08/2026

Novo: **prazo de validade por arquivo.** Ao enviar qualquer vídeo ou imagem, aparece uma tela perguntando se aquele conteúdo deve ter data para sair do ar.

> ⚠️ **Rode `schema-migracao-0.6.9.sql` no Neon antes do deploy.** É uma coluna nova na tabela `midia` (`ADD COLUMN IF NOT EXISTS`), não mexe em nada que já existe — tudo que está lá hoje fica sem prazo, como sempre foi. Sem essa migração, o envio de arquivos e a listagem da biblioteca quebram.

### Como funciona

- **Sem prazo** (a opção que vem marcada): o arquivo fica por tempo indeterminado, até você excluir à mão. É o comportamento de sempre.
- **Expirar em uma data e hora**: você escolhe dia, mês, ano e horário. Datas passadas não podem ser escolhidas — o próprio calendário já não deixa voltar, e tanto o navegador quanto o servidor conferem de novo antes de aceitar.
- A escolha é feita **uma vez por envio** e vale para todos os arquivos daquela leva. Cancelar a tela cancela o envio inteiro: nada sobe.
- Na biblioteca, o arquivo com prazo ganha um selo **⏳ com a data**, que fica em âmbar quando falta menos de 24 horas.

### O que acontece quando o prazo chega

O arquivo é apagado do armazenamento, sai de **todas as playlists** que o usavam e — o ponto principal do pedido — as TVs que estiverem exibindo essas playlists **recebem a fila nova na hora**, então o item sai da execução sozinho, sem ninguém mexer em nada. A playlist que ficar sem itens continua existindo, vazia (playlist vazia é um estado válido desde a 0.6.6).

A varredura roda ao ligar o servidor (pegando o que venceu enquanto ele esteve fora do ar) e depois de minuto em minuto. Ou seja: o corte pode acontecer até cerca de um minuto **depois** do horário marcado, nunca antes. Entre uma varredura e outra, um arquivo já vencido também deixa de aparecer na biblioteca — assim ninguém consegue colocar numa playlist algo que está de saída.

A comparação do vencimento é feita pelo **relógio do banco**, não pelo do processo: o servidor pode reiniciar, mudar de máquina ou de fuso horário que o prazo continua valendo igual. E o horário que você escolhe é o do seu navegador, convertido na hora do envio — não importa em que fuso o servidor esteja.

### Onde mexeu

- **Banco**: coluna `midia.expira_em` (`TIMESTAMPTZ`, nula = sem prazo) e um índice só das linhas que têm prazo. Arquivos de antes ficam com `NULL`, isto é, sem prazo.
- **`lib/midia.js`**: `registrarArquivo` passou a aceitar a validade; novas `validadesPorArquivo()` e `nomesVencidos()`.
- **`server.js`**: `normalizarValidade()` (recusa data inválida ou no passado, tratando como "sem prazo" em vez de erro); os dois pontos de upload (disco local e URL assinada do R2) gravam a validade; rota nova `GET /media-meta`; `/videos-list` esconde o que já venceu; varredura `varrerMidiaVencida()` no boot e a cada minuto.
- **`lib/playlists.js`**: `removerArquivoDeTodas` agora devolve as playlists que mudaram, para que dê para avisar as TVs. Como efeito, **excluir um arquivo à mão também atualiza a TV na hora** — antes só a edição de playlist fazia isso.
- **Interface** (`controller.html`, `css/controller.css`, `js/controller.js`): a tela de escolha do prazo e o selo ⏳ na biblioteca.

### Verificação

**Com o servidor real rodando** (banco simulado em memória): envio sem prazo não registra validade; envio com prazo registra e aparece em `/media-meta`; data no passado é ignorada e o arquivo sobe **sem prazo**, sem virar erro; `/videos-list` para de mostrar o vencido antes mesmo da varredura. E o ciclo completo, com uma TV pareada exibindo uma playlist de dois itens em que um vence em 8 segundos: passada a varredura, a **TV recebeu a fila nova com só o item que continua valendo**, o arquivo vencido sumiu do disco, o que era sem prazo continuou intacto, a playlist salva no banco ficou sem o item vencido e o registro de validade foi limpo.

**No navegador, com a interface real**: escolher o arquivo abre a tela de prazo antes de qualquer envio (nada sobe enquanto ela está aberta); ela abre sempre em "Sem prazo"; marcar "expirar" mostra o campo de data com o mínimo travado no minuto atual; confirmar sem data e confirmar com data passada mostram o erro e mantêm a tela aberta, sem enviar; com data futura o envio sai com o prazo junto e o selo ⏳ aparece no cartão; "Sem prazo" envia sem validade; cancelar não envia nada. Nenhum erro de JavaScript.

### Nada de login foi tocado

Autenticação, sessão, contas, papéis e limites de plano seguem exatamente como estavam.

---

## 0.6.8 — 17/08/2026

Correção: **editar uma playlist não mudava nada na TV que já estava exibindo ela.**

### O problema

Alterar o tempo de duas imagens de 10s para 5s, com a playlist no ar, não surtia efeito — era preciso parar a transmissão e mandar reproduzir de novo para o novo tempo valer.

### Causa

A TV recebe uma **cópia** da playlist no momento em que a reprodução começa (a mensagem `play_playlist` carrega a lista inteira). Dali em diante ela toca a partir dessa cópia na memória, sem consultar o servidor de novo — é justamente esse desenho que faz a reprodução continuar mesmo se a rede oscilar. Só que nada avisava a TV quando a playlist era editada: a versão salva no banco ficava nova, e a que estava tocando, velha. Parar e reenviar funcionava porque forçava uma cópia nova.

### Corrigido

- **Servidor**: ao salvar uma playlist que já existia, ele procura as TVs que estão exibindo **exatamente aquela playlist** e empurra a versão nova na hora (mensagem `update_playlist`). TV tocando outra playlist, ou parada, não recebe nada. Se a edição esvaziou a playlist, a TV recebe `stop` em vez da lista vazia — não faz sentido continuar exibindo um conteúdo que não existe mais.
- **TV**: aplica a lista nova **sem voltar para o primeiro item**. O arquivo que está na tela continua na tela; se ele mudou de posição na fila, o índice acompanha; se ele foi removido da playlist, aí sim recomeça do primeiro. O tempo de uma imagem em exibição é reprogramado na hora, com o valor novo — sem piscar a imagem. Vídeo em exibição toca até o fim normalmente, e o que vem depois já sai da lista nova.
- **Pausada**: uma playlist pausada não volta a andar por causa de uma edição. A lista nova fica guardada e passa a valer quando o controlador mandar continuar.

Criar uma playlist nova não dispara nada disso — ela não pode estar tocando em TV nenhuma ainda.

### Verificação

**Com o servidor real rodando** (banco simulado em memória), duas TVs pareadas exibindo playlists diferentes: editar o tempo de 10s para 5s na playlist da TV A faz chegar `update_playlist` só na TV A, com os dois itens já em 5s, e a **TV B não recebe mensagem nenhuma**; editar uma playlist que ninguém está exibindo não incomoda nenhuma das duas; esvaziar a playlist no ar manda `stop` e o painel passa a mostrar a TV sem playlist; criar playlist nova não gera tráfego.

**No navegador, na tela da TV de verdade**: com dois itens de 10s tocando, a troca para 2s passa a valer imediatamente (o item virou aos ~2,5s em vez dos 10s originais) e a playlist não voltou ao primeiro item; reordenar mantém o arquivo que está na tela (índice foi de 0 para 1 acompanhando o arquivo); remover o item em exibição recomeça do primeiro; esvaziar volta para a tela de espera; com a TV pausada a edição não retoma a reprodução, e o tempo novo só passa a valer no "continuar". Nenhum erro de JavaScript.

### Nada de login foi tocado

As alterações ficaram em `server.js` (uma função nova, `propagarPlaylistAtualizada`, chamada ao salvar playlist já existente) e `js/tv.js` (`aplicarPlaylistAtualizada`). Autenticação, sessão, contas e limites de plano seguem como estavam.

---

## 0.6.7 — 17/08/2026

Mudança de fluxo: **conteúdo só entra dentro de uma playlist.** A tela de criar playlist pede agora **apenas o nome**, e todo o envio/escolha de arquivos passou para um botão **➕ Adicionar vídeos** dentro da playlist já criada.

### Por que

Com a aba Vídeos removida (0.6.1), o envio de arquivos tinha ido parar no formulário de criação da playlist — o que deixava a tela de "criar" carregada e permitia subir arquivo antes mesmo da playlist existir. Agora que playlist vazia é um estado válido (0.6.6), o caminho natural é outro: cria-se a playlist com o nome, e o conteúdo entra depois, sempre de dentro dela. Não existe mais nenhum ponto na interface para subir vídeo ou imagem solto, fora de uma playlist.

### O que mudou

- **Criar playlist**: só o campo de nome, mais um aviso curto explicando que o conteúdo entra depois. A zona de envio, a grade "vídeos disponíveis" e a ordem de reprodução saíram dessa tela.
- **Dentro da playlist**: botão novo **➕ Adicionar vídeos** no cabeçalho, ao lado de ✏️ Editar. Ele abre exatamente aquela tela de conteúdo (envio de arquivos + biblioteca + ordem de reprodução), já rolada até a área de envio.
- **✏️ Editar** continua como era, servindo para renomear e mexer no conteúdo da playlist — é o mesmo formulário.
- Os textos da playlist vazia passaram a apontar para o botão novo em vez de "Editar".

Nada foi removido do sistema: a mesma tela de sempre, com o mesmo envio de arquivos e a mesma biblioteca, só mudou de lugar — saiu da criação e entrou atrás de um botão dentro da playlist.

### Verificação

Testado no navegador com a interface real: ao criar, só o nome aparece — zona de envio, grade de vídeos e ordem de reprodução estão fora da tela (conferido pela visibilidade real dos elementos, não só pelo CSS). Salvando só com o nome, a playlist abre vazia com o botão ➕ Adicionar vídeos visível. Clicando nele, as três seções aparecem; escolhendo um vídeo e salvando, o card vira "1 vídeo(s)" e o botão de transmitir libera. ✏️ Editar carrega nome e itens normalmente. Criando uma segunda playlist, o bloco de conteúdo volta a ficar escondido e o campo de nome volta limpo. Nenhum erro de JavaScript, nenhum alerta inesperado.

### Nada de login foi tocado

As alterações ficaram em `controller.html` e `js/controller.js`, as duas só de interface. Servidor, banco, rotas, autenticação e limites de plano seguem exatamente como estavam.

---

## 0.6.6 — 07/08/2026

Novo: **playlist vazia agora é um estado válido.** Dá para criar a playlist só com o nome e ir preenchendo depois, sem precisar ter os arquivos em mãos na hora de criar.

### O que mudou

- **Criar/salvar**: o formulário não exige mais pelo menos um item. Só o nome continua obrigatório.
- **Servidor**: `POST /playlists` aceita a lista de itens vazia. Continua recusando o que é erro de verdade — nome em branco, campo de itens num formato errado, ou uma lista que veio com itens mas nenhum deles válido.
- **Exclusão em cascata**: apagar um arquivo continua removendo ele das playlists que o usavam, mas a playlist que fica sem itens **não é mais apagada junto**. Ela permanece na lista, vazia. Antes ela sumia sozinha — o que agora seria perder o trabalho do usuário sem ele ter pedido.
- **Na tela**: o card da playlist mostra "vazia — sem conteúdo ainda" e a tela dela explica que é só usar ✏️ Editar para adicionar. Os botões de enviar para uma TV e de transmitir para todas ficam desabilitados enquanto não houver conteúdo, com o motivo aparecendo ao passar o mouse.
- **Proteção no servidor**: o comando `play_playlist` ignora playlist sem itens. Sem isso, uma requisição fora do painel poderia deixar a TV parada numa tela sem nada, com o controlador dizendo que está reproduzindo.

### Verificação

Testado com o **servidor real rodando** (banco simulado em memória): criar com a lista vazia devolve 200 e a playlist aparece na listagem com 0 itens; nome em branco continua devolvendo 400; lista com itens todos inválidos continua devolvendo 400; adicionar um item depois funciona normalmente; mandar a playlist vazia para a TV não envia nada, e a mesma playlist já com um item envia o `play_playlist` corretamente.

Testado também **no navegador**, com a interface real: salvar informando só o nome não mostra erro, o card aparece como "vazia — sem conteúdo ainda", a tela mostra "Nenhum item ainda — clique em Editar para adicionar" e os dois botões de envio ficam desabilitados. Depois de editar e adicionar um item, o card passa a "1 vídeo(s)", a tela a "1 item(ns) · loop contínuo" e o botão de transmitir libera. Nenhum erro de JavaScript no console.

### Nada de login foi tocado

As alterações ficaram em `server.js` (rota de playlists e o comando `play_playlist`), `lib/playlists.js` (exclusão em cascata) e `js/controller.js` (validação e textos da tela). Autenticação, sessão, contas e limites de plano seguem exatamente como estavam.

---

## 0.6.5 — 07/08/2026

Correção: **desparear uma TV derrubava as duas** quando havia duas telas abertas no mesmo computador.

### Causa

A identidade do aparelho (`deviceId`) é gerada uma vez e guardada no `localStorage` da TV — é o que faz o pareamento "grudar" e sobreviver a reinícios. Só que o `localStorage` é **compartilhado por todas as abas do mesmo navegador**. Duas telas abertas no mesmo computador mandavam, portanto, o **mesmo `deviceId`**: o servidor as tratava como uma TV só, ambas apontando para a mesma linha do banco.

O painel mostrava dois cards, mas por trás era um registro único. Desparear "um" deles limpava aquela linha — e as duas telas, que dependiam dela, caíam juntas. Em produção o problema não aparecia, porque duas TVs de verdade são aparelhos diferentes, com `localStorage` separado.

### Corrigido

- Cada aba/janela passou a ter também um identificador próprio, guardado no **`sessionStorage`** (que, ao contrário do `localStorage`, é por aba e sobrevive a um recarregamento dela).
- No `tv_connect`, se já existe outra tela **viva** usando aquele mesmo `deviceId`, esta ganha uma identidade derivada (`deviceId::aba`) — com linha, código de pareamento e vínculo próprios. Com uma tela por aparelho, que é o caso real, nada muda: continua usando o `deviceId` puro e o pareamento segue sobrevivendo a reinícios.
- O servidor informa de volta qual identidade usou (`deviceIdUsado`) e a TV a memoriza na aba. Sem isso, quando a primeira aba fechasse e o `deviceId` base ficasse livre, a aba restante trocaria de identidade no meio do caminho e perderia o pareamento sem motivo.

### Verificação

Testado com o **servidor real rodando** (banco simulado em memória) e dois clientes WebSocket representando as duas telas: elas recebem códigos de pareamento diferentes, pareiam como duas TVs distintas, o painel enxerga as duas e ambas recebem o comando de reprodução. Ao desparear uma: só ela para, **a outra não recebe mensagem nenhuma** (lista de mensagens vazia) e o painel passa a enxergar uma TV. Testado também o fechamento de uma aba seguido do recarregamento da outra: a que sobrou mantém a identidade e continua pareada, sem voltar a pedir código.

---

## 0.6.4 — 07/08/2026

Correção: **TV despareada continuava exibindo o conteúdo para sempre.**

### O que estava acontecendo

Ao desparear, o servidor apagava o vínculo da TV com a conta (`contaId = null`) e avisava a TV que ela tinha voltado a ficar sem par. Mas duas coisas faltavam:

- O servidor **não limpava o que estava tocando** (`video`/`playlist`/`paused`) nem mandava a TV parar.
- Na TV, o aviso de despareamento só repintava a caixinha do código de pareamento — que fica na tela de espera, escondida enquanto o vídeo está no ar. Ou seja, a mensagem chegava e não tinha efeito visível nenhum.

O resultado era o pior dos dois mundos: a TV sumia da lista do painel (porque o vínculo já tinha sido apagado) e **seguia reproduzindo em loop**, agora sem ninguém conseguindo comandá-la — nem a conta antiga, que perdeu o acesso, nem outra, que ainda não pareou. Conteúdo de uma conta continuava no ar numa TV que já não era dela, e só desligando o aparelho ou recarregando a página aquilo parava.

### Corrigido

- **No servidor**: ao desparear, o estado de reprodução daquela TV é zerado e um `stop` é enviado a ela antes do aviso de despareamento.
- **Na TV**: receber `paired: false` agora, por si só, encerra a reprodução — sai da playlist, limpa os players e volta para a tela de espera com o novo código de pareamento. A TV não depende mais de uma segunda mensagem para largar um conteúdo que já não tem dono; se o `stop` se perder no caminho, ela para do mesmo jeito.

A TV continua conectada ao servidor depois disso, mostrando o código na tela — pronta para ser pareada de novo, por esta conta ou por outra, sem precisar recarregar nada.

### Verificação

Testado num navegador de verdade, com a TV reproduzindo uma playlist em loop e as mensagens do servidor injetadas na conexão: ao desparear, a reprodução para, os players são liberados (nenhum vídeo carregado), a tela de espera reaparece e o novo código de pareamento é exibido. Testado também o caso em que **só** o aviso de despareamento chega, sem o `stop` — a TV para do mesmo jeito, que é a garantia de que o conserto não depende das duas mensagens chegarem juntas. Nenhum erro de JavaScript.

---

## 0.6.3 — 07/08/2026

Controles de reprodução por TV, direto na lista do topo. **Nada de login/contas foi alterado.**

### Adicionado

- Clicar numa TV pareada abre, dentro do próprio card, os três controles: **▶ Retomar**, **⏸ Pausar** e **⏹ Parar**. Clicar de novo fecha.
- Os botões refletem o estado real daquela TV: *Pausar* só fica ativo quando ela está reproduzindo, *Retomar* só quando está pausada, e os três ficam desativados quando a TV não tem nada no ar. O estado vem da própria lista que o servidor manda (`tv_list`), então acompanha o que está acontecendo de verdade, inclusive se alguém mexer de outro navegador.

### Isolamento entre TVs

Cada botão carrega o **código da própria TV** e envia o comando com esse código explícito — nada depende de "qual TV está selecionada" no instante do envio, que é justamente o tipo de estado global capaz de fazer um clique atingir a TV errada. Do outro lado, o servidor já resolvia isso por aparelho: `tvs.get(msg.code)` acha uma única TV, entrega a mensagem só para o WebSocket dela e ainda confere se ela pertence à conta logada (`podeControlarTv`). Pausar, parar ou retomar uma TV não alcança nenhuma outra, mesmo com várias pareadas na mesma conta — e nenhuma linha do servidor precisou mudar para isso.

### Verificação

Testado num navegador de verdade com **três TVs em estados diferentes** (uma reproduzindo, uma pausada, uma sem conteúdo) e o WebSocket interceptado para inspecionar exatamente o que sai do painel: os controles aparecem só no card clicado; os botões habilitados batem com o estado de cada TV; e os comandos enviados foram exatamente `pause→AAA111`, `resume→BBB222` e `stop→BBB222`, sem nenhuma mensagem sem código e sem nenhuma dirigida à terceira TV. Nenhum erro de JavaScript.

---

## 0.6.2 — 07/08/2026

Recoloca as duas coisas que a 0.6.1 tinha levado junto ao remover a aba "Vídeos". **Nada de login/contas foi alterado.**

### Adicionado

- **Zona de envio dentro do formulário de playlist.** Aceita clique ou arrastar, nos mesmos formatos de sempre (`.mp4`, `.jpg`, `.png`, `.webp`). Era a última peça faltando: sem a aba Vídeos, não existia mais nenhuma forma de colocar arquivo novo no sistema.
  - O que sobe por ali **já entra na ordem de reprodução da playlist**, sem precisar clicar de novo na grade de disponíveis. Imagem entra com o tempo padrão, pronta para ajustar.
  - O item usa o **nome final devolvido pelo servidor**, não o nome do arquivo no computador — quando já existe um arquivo com aquele nome, o servidor salva como `Nome (1).png`, e usar o original faria a playlist apontar para o arquivo errado. Vale nos dois modos de envio (pelo servidor e direto pro R2).
  - O envio continua sequencial, um arquivo por vez, com a mesma barra de progresso de antes.
- **Botão "Desparear" no card de cada TV**, na lista do topo. É onde ele fica natural agora que o painel da TV não existe mais: a ação é por TV, e é ali que cada TV aparece. O clique não seleciona o card (`stopPropagation`), e a confirmação e a chamada `DELETE /tvs/<id>` seguem exatamente as de antes.

### Detalhe técnico

`despairTv()` passou a aceitar o código da TV como argumento, vindo do botão do card; sem argumento, mantém o comportamento anterior (TV selecionada). A lógica de desemparelhamento em si não mudou uma linha.

### Verificação

Testado num navegador de verdade, com as rotas de API simuladas (o servidor real exige Postgres): criar playlist, enviar dois arquivos pela zona nova e vê-los entrar sozinhos na ordem com campo de tempo; reenviar um nome já existente e confirmar que a playlist recebeu `Promo (1).png`, o nome renomeado pelo servidor; e o botão Desparear disparando `DELETE /tvs/7` sem selecionar o card. Nenhum erro de JavaScript.

---

## 0.6.1 — 07/08/2026

Remoção da aba "Vídeos" do controlador, a pedido. **Nada de login/contas foi tocado.**

### O que saiu

- O botão da aba **Vídeos** e todo o painel que ele abria: a tela "Selecione uma TV", o bloco "Transmitir para todas", as duas zonas de envio de arquivo, a grade de mídias e o painel de controle da TV (retomar, pausar, parar, tela cheia, transmissão em massa).
- No `js/controller.js`, as funções que só serviam a esse painel: `renderVideoGrid`, `renderBroadcastList`, `selectBroadcastVideo`, `selectVideo`, `updatePanel`, `pauseTv`, `resumeTv`, `stopTv`, `toggleFullscreen`, `broadcastSelected`, `broadcastCurrent`, e o registro das duas zonas de envio.
- `switchTab()` não conhece mais a aba de vídeos (a de contas segue igual), e `loadVideos()` agora só alimenta a grade de dentro do formulário de playlist.

### O que ficou igual

- **Layout inalterado**: cabeçalho, barra "TVs conectadas" no topo (com o campo de parear TV) e o gerenciador de playlists continuam exatamente onde estavam. Playlists passou a ser a aba ativa por padrão.
- **Nada de login/contas foi alterado**: `lib/auth.js`, `lib/contas.js`, `lib/db.js`, `lib/tvs.js`, `lib/midia.js`, `lib/playlists.js`, `login.html`, `server.js` e os `.sql` estão byte a byte iguais ao que você enviou. A aba Contas (só para ADM) segue intacta.
- Clicar numa TV na lista do topo agora apenas destaca aquela TV; o alvo de uma playlist continua sendo escolhido no seletor "Enviar para TV".

### Consequências que precisam de decisão

- **Não existe mais nenhuma forma de enviar arquivos pelo painel.** As duas zonas de envio ficavam no painel removido, e o formulário de playlist desta versão só deixa escolher entre arquivos já enviados. Levar a zona de envio para dentro do formulário de playlist (como foi feito na linha 0.1.4-fix) resolve.
- **O botão "Desparear" saiu junto**, porque ficava no cabeçalho do painel da TV. Ele é de pareamento/conta, não de vídeo — a função `despairTv()` continua no arquivo, agora sem nenhum botão que a chame. Basta dizer onde colocá-la (o card da TV na lista do topo é o lugar natural).
- Também deixaram de existir os controles por TV (retomar/pausar/parar/tela cheia) e o "Transmitir para todas".

---

## 0.1.3 — 03/08/2026

Ajuste pequeno em cima da 0.1.2: já que o vídeo não é mais convertido automaticamente, restringir o formato aceito no upload evita que alguém envie sem querer um `.mov`/`.webm` que pode não tocar em Smart TVs mais simples.

### O que mudou

- **Upload de vídeo agora aceita só `.mp4`** — `.mov` e `.webm` deixaram de ser aceitos (tanto no filtro do seletor de arquivos quanto na validação do servidor, nos dois modos de upload: direto pro R2 e pelo servidor). Imagens continuam aceitando `.jpg`, `.png` e `.webp` normalmente.
- A listagem/exclusão de mídia (`MEDIA_EXT_REGEX`) continua reconhecendo `.mov`/`.webm` — isso é só pra não esconder ou quebrar arquivos desses formatos que já estejam salvos de antes desta versão. A restrição é só pra uploads **novos**.
- Mensagens de erro do upload agora dizem claramente quais formatos são aceitos.

## 0.1.2 — 03/08/2026

Correção do 502 que continuava acontecendo em vídeos de alguns minutos mesmo depois das mitigações da 0.0.9-fix3 e da migração pro R2 na 0.1.0.

### Por quê

Diagnóstico em produção: vídeos de ~3 minutos travavam a 100% do upload e caíam com 502. A causa raiz nunca tinha sido o "arquivo passando pelo servidor" em si (isso já era feito em streaming, sem segurar o arquivo inteiro na memória) — era a **conversão automática pra HD/H.264 via FFmpeg**, que decodifica e recodifica o vídeo inteiro quadro a quadro. Esse processo é pesado de RAM por natureza, e nenhum ajuste de flags do FFmpeg (feito na 0.0.9-fix3) elimina isso de verdade num plano de 512MB — só adia o problema pra vídeos um pouco maiores.

### O que mudou

- **A conversão automática pra HD foi removida por completo.** O vídeo/imagem é salvo exatamente como foi enviado, sem passar pelo FFmpeg. Isso elimina o maior consumidor de RAM do processo de upload — não é mais possível esse tipo de 502 acontecer, porque o servidor não abre mais o arquivo pra processar. Em troca, a responsabilidade por mandar um vídeo compatível com Smart TVs (`.mp4`, H.264 + AAC) passa a ser de quem envia — o controlador agora avisa isso claramente na zona de upload.
- **Upload direto do navegador pro Cloudflare R2**, quando o R2 está configurado. Antes, mesmo sem transcodificar, o arquivo ainda passava pelo servidor a caminho do bucket (recebido e reenviado). Agora o controlador pede uma **URL de upload assinada** (`GET /request-upload`, válida por 5 minutos) e manda o arquivo com um `PUT` direto pro R2 — o Render nunca vê o vídeo em si, só essa mensagem pequena. Sem R2 configurado, o upload continua indo pelo servidor (modo disco local, como sempre foi).
- Dependências `fluent-ffmpeg` e `ffmpeg-static` removidas do projeto (não são mais usadas); adicionada `@aws-sdk/s3-request-presigner` (gera as URLs assinadas do R2).
- **Requisito novo pra quem já usa R2**: como o navegador passa a falar direto com o bucket (um domínio diferente do site), é preciso liberar isso na política de CORS do bucket — sem isso o upload falha com erro de conexão. Passo a passo novo no README.
- Novo campo `r2Enabled` na resposta de `GET /version`, usado pelo controlador pra decidir automaticamente se faz upload direto (R2) ou pelo servidor (disco local) — nenhuma configuração manual necessária na tela.

## 0.1.1 — 02/08/2026

Leva de simplificações pedidas depois de testar a 0.1.0 em produção: tirar a fricção do pareamento por código, deixar a TV sempre num estado previsível, e fechar buracos de uso do dia a dia (exclusão que não limpava playlist, exclusão só disponível num lugar, nenhuma visibilidade de versão ou de quanto espaço estava sendo usado).

### O que mudou

- **Conexão direta, sem código de sala.** Antes, cada controlador sorteava um código de 5 dígitos e cada TV precisava digitar esse código pra aparecer na lista dele — pensado pra isolar vários controladores/TVs diferentes usando o mesmo servidor. Como o uso real é um controlador com suas TVs, esse código só criava fricção sem benefício. Agora todo controlador que abre o site já enxerga e comanda todas as TVs conectadas ao servidor, e toda TV que abre o site já aparece sozinha, sem digitar nada. A tela de "digitar código" foi removida do `tv.html`; a TV continua mostrando um código próprio de identificação (só informativo, pra reconhecer qual card do controlador é qual tela física).
- **TV sempre abre num estado "zero".** A TV guardava no navegador dela (localStorage) qual foi o último vídeo/playlist tocado, pra retomar sozinha depois de a página recarregar. Isso causava um problema real: depois de qualquer mudança que remova conteúdo antigo do servidor (ex: a migração pro R2 na 0.1.0, ou simplesmente apagar um vídeo), a TV insistia em tentar tocar algo que não existe mais, travando numa tela de erro de formato sem nenhum jeito de se recuperar sozinha. Agora esse "retomar sozinho" foi removido de propósito: toda vez que a aba é fechada e reaberta (ou recarrega sozinha após uma falha), a TV conecta limpa e fica em espera até o controlador mandar algo. Configurações do aparelho (nome da TV, modo compatibilidade) continuam salvas normalmente — só o que estava tocando não é mais lembrado.
- **Excluir um vídeo/foto agora limpa as playlists que o usavam.** Antes, apagar um arquivo que estava dentro de uma playlist deixava a playlist "quebrada" — com uma referência a um arquivo que não existe mais. Agora o servidor remove automaticamente esse item de toda playlist ao excluir o arquivo; se a playlist ficar sem nenhum item, ela é apagada junto (uma playlist vazia nunca foi um estado válido).
- **Botão de excluir em toda grade de mídia.** Antes só a grade principal de vídeos tinha o ícone de lixeira; agora ele também aparece na lista de "Transmitir para todas" e na grade de seleção de vídeos dentro do formulário de playlist — não é mais preciso voltar pra aba de vídeos só pra apagar algo.
- **Uso de armazenamento visível no controlador.** Novo endpoint `GET /storage-usage` (soma o bucket R2 ou o disco local, dependendo do modo ativo) mostrado no cabeçalho do controlador como "💾 X.XX GB usados" (e "de Y GB", se `R2_MAX_STORAGE_GB` estiver configurado), atualizado a cada upload/exclusão.
- **Versão do app visível.** Novo endpoint `GET /version` (lê direto do `package.json`), mostrado num canto discreto tanto no controlador quanto na tela de espera da TV.

## 0.1.0 — 01/08/2026

Nova funcionalidade (por isso o número do meio subiu, não o último): **armazenamento de vídeos/imagens no Cloudflare R2**, opcional.

### Por quê

Duas dores do plano gratuito do Render descobertas em produção: o disco é efêmero (vídeos somem a cada deploy) e a banda de saída é de só 5GB/mês — o suficiente para poucas horas de UMA TV tocando vídeo em loop, muito antes de "quantas TVs simultâneas" virar a pergunta relevante. As duas têm a mesma solução: parar de guardar/servir o arquivo de vídeo pelo Render.

### O que mudou

- Com as variáveis de ambiente `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` e `R2_PUBLIC_BASE_URL` configuradas no Render, o servidor passa a **subir cada vídeo/imagem pronto para um bucket Cloudflare R2** depois de processar, e a listagem/exclusão de mídia passam a falar com o bucket em vez do disco.
- **`controller.html` e `tv.html` não mudaram uma linha.** A rota `/videos/<nome>` continua existindo — com o R2 ligado, ela só responde com um redirecionamento (302) para a URL pública do bucket, em vez de entregar o arquivo. Isso mantém intacto tudo que já tinha sido endurecido no player da TV (double buffer, preload tardio, watchdog, recuperação de emergência) sem precisar mexer nem testar de novo essa parte.
- Sem as variáveis configuradas, o comportamento é **idêntico ao de antes** (disco local) — testado neste sandbox as duas formas, uma do lado da outra.
- Corrigido de quebra um bug que essa mudança ia introduzir se não fosse pego: a checagem de "nome já existe" (pro sufixo ` (1)`) olhava só o disco local, que é efêmero — depois de um redeploy ela sempre acharia "nome livre" mesmo quando o arquivo já existia no R2, e o upload novo sobrescreveria o antigo silenciosamente. Agora, com R2 ligado, essa checagem é feita no bucket (via `HEAD`), não no disco.
- **Trava opcional contra cobrança surpresa**: a Cloudflare não tem limite rígido de uso para o R2 — só um alerta por e-mail que avisa *depois* que a fatura já passou do grátis, sem impedir a cobrança. Nova variável de ambiente `R2_MAX_STORAGE_GB`: se configurada, o servidor confere o total já guardado no bucket **antes** de aceitar cada upload (usando o `Content-Length` da requisição, sem gastar CPU convertendo à toa) e recusa com uma mensagem clara (HTTP 413) se isso for estourar o teto. Sem essa variável, não existe limite — comportamento igual ao de antes.
- README com uma seção nova (**Armazenamento externo**) explicando passo a passo como criar o bucket, o token de API e configurar as variáveis no Render, incluindo o `R2_MAX_STORAGE_GB`.

### Verificação

Testado neste sandbox com um stub do `@aws-sdk/client-s3` (bucket simulado por uma pasta local + um servidor HTTP simples fazendo o papel da URL pública do R2) e o `ws` real: upload de vídeo (passa pelo ffmpeg normalmente, depois sobe pro "bucket" e apaga a cópia local), `/videos-list` refletindo o bucket, `/videos/<nome>` respondendo 302 e os bytes do vídeo chegando certos do outro lado do redirecionamento (`ffprobe` confirmou a duração do arquivo baixado), reenvio do mesmo nome gerando corretamente `Nome (1).mp4` (a checagem de colisão contra o bucket, não o disco), exclusão removendo do bucket, e a trava `R2_MAX_STORAGE_GB` (configurada bem apertada no teste) recusando corretamente o segundo upload com 413 sem gravar nada, enquanto sem essa variável um segundo upload igual passa normal. Rodado o mesmo roteiro sem as variáveis de R2 para confirmar que o modo local ficou igual ao de antes. **Não testado**: um bucket R2 real (peço pro usuário confirmar quando configurar as credenciais dele) e o fluxo completo controlador+TV pela interface visual (só a API HTTP) — como nada em `controller.html`/`tv.html` nem nas mensagens WebSocket foi tocado, o risco de regressão aí é baixo, mas vale um teste de duas abas antes de confiar 100%.

---

## 0.0.9-fix3 — 01/08/2026

Correção: upload de vídeo dando **erro 502 (Bad Gateway)** na tela do controlador, em qualquer vídeo enviado.

### O que estava acontecendo

O plano gratuito do Render tem só 512MB de RAM, e a conversão do vídeo (ffmpeg) roda dentro do mesmo processo do servidor. O encode em `libx264` com múltiplas threads usa buffers de codificação paralela que, somados ao restante do app, estouravam esse limite — o Render mata e reinicia o container no meio do upload. O navegador não recebe nenhuma resposta de erro estruturada, só vê a conexão cair: daí o 502. Como o estouro é por overhead do processo de conversão (não pelo tamanho do arquivo), acontecia até com vídeos pequenos de teste.

### Corrigido

- **Conversão de vídeo com bem menos memória**: `-threads 1` (evita os buffers extras de codificação paralela) e lookahead/referências do x264 reduzidos (`rc-lookahead=20:ref=2`). Perda de eficiência de compressão desprezível para o uso aqui (propaganda/cardápio em loop).
- **Rede de segurança contra crash do processo**: um `uncaughtException`/`unhandledRejection` não capturado em qualquer parte do servidor derrubava o processo inteiro (afetando todos os controladores e TVs conectados, não só o upload que falhou). Agora esses erros são logados e o processo continua no ar. **Isso não protege contra o processo ser morto por estourar o limite de memória do plano** — esse tipo de encerramento (SIGKILL do sistema operacional) não passa pelo Node, nada em JavaScript consegue interceptar.
- README: nova entrada em "Solução de problemas" sobre o 502 no upload, incluindo como confirmar nos Logs do Render se é mesmo estouro de memória.

### Se o 502 persistir

Confira os **Logs** do serviço no painel do Render, por volta do horário do erro. Se aparecer algo como "out of memory" ou o processo saindo com "exit code 137", é confirmação de estouro de memória — nesse caso a correção acima ajuda mas não elimina o risco por completo em vídeos maiores, e a solução definitiva é subir para um plano do Render com mais RAM (Starter ou superior).

### Verificação

Testado o pipeline de transcodificação isoladamente neste ambiente (ffmpeg real via `spawn`, com os novos parâmetros `-threads 1` e `-x264-params`) confirmando que o `.mp4` de saída continua válido (H.264 Main, AAC, faststart) e o processo de conversão conclui normalmente. Não foi possível reproduzir o estouro de memória do plano gratuito do Render neste sandbox (não há limite de 512MB aqui) — a confirmação definitiva da causa raiz depende dos Logs do Render, que o usuário ainda não compartilhou.

---

## 0.0.9-fix2 — 01/08/2026

Correção urgente: **a TV não conseguia mais ser pareada com o controlador**. Regressão introduzida pela 0.0.9.

### O que estava acontecendo

O servidor sorteia um código de sala novo toda vez que o controlador se conecta. Ou seja, **recarregar a página do controlador sempre gerou um código diferente e deixou as TVs órfãs** — isso é anterior à 0.0.9 e estava até documentado no README como "as TVs precisam ser pareadas de novo".

O que a 0.0.9 fez foi transformar esse incômodo num beco sem saída: a retomada automática passou a reconectar a TV com o código guardado e a **pular a tela de digitação**. Com o controlador já usando outro código, a TV ficava presa a um código morto, invisível para o controlador e sem nenhuma forma de digitar o código novo.

### Corrigido

- **O controlador mantém o mesmo código de sala entre recargas.** O código passou a ser guardado no navegador do controlador e reenviado ao conectar; o servidor o devolve se ninguém mais estiver usando. Recarregar o controlador — ou reabrir a aba — não desemparelha mais nenhuma TV. Isso resolve a causa raiz, que existia desde antes da 0.0.9.
- **A TV ganhou o botão "Trocar código"**, sempre visível na tela de espera, que esquece o pareamento e volta para a tela de digitação. É a saída garantida para qualquer situação em que o código mude.
- **A TV mostra a que controlador está pareada** e se ele está no ar. Antes não havia como distinguir "sem controlador" de "controlador com outro código" — a tela simplesmente ficava parada.
- Se dois controladores forem abertos ao mesmo tempo, o segundo avisa que o código salvo já está em uso e explica o que fazer, em vez de trocar de código silenciosamente.

### Verificação

Testado de ponta a ponta com controlador e TV em abas separadas, com WebSocket real: parear, recarregar o controlador (código mantido, TV continua na lista), recarregar a TV (volta sozinha e segue pareada), usar o "Trocar código" e parear de novo. Também conferido que o fluxo principal segue intacto — enviar vídeo e pausar pelo controlador chegam na TV — e que a TV passa a indicar quando o controlador é fechado.

---

## 0.0.9-fix — 01/08/2026

Correção do tempo de exibição das imagens na playlist.

### Corrigido

- **O tempo definido para uma imagem sempre voltava para 10 segundos.** No campo de tempo da playlist, o nome do arquivo era interpolado dentro do atributo `onchange` do HTML e havia uma aspa fora de lugar: em vez de `updatePlItemDuration('Banner.png', this.value)`, o navegador recebia `updatePlItemDuration('Banner.png'`. O atributo terminava ali, o resto virava lixo, e o handler não compilava — o console acusava `SyntaxError: missing ) after argument list` a cada digitação. Como a função nunca executava, o valor digitado era descartado e a playlist salvava sempre o padrão de 10 segundos.

  A correção não foi apenas fechar o parêntese: o campo passa a mandar o **índice** do item, que é um número e não precisa de escape, em vez do nome do arquivo. Isso elimina de vez essa classe de erro, inclusive o caso de um nome de arquivo com aspas quebrar o atributo.

- O campo passou a atualizar durante a digitação (`oninput`) e não só ao sair dele, evitando perder o valor de quem digita e clica direto em Salvar.
- O valor agora é limitado a 1–300 segundos também no código. Antes o `min`/`max` do campo era só visual: um valor fora da faixa seguia adiante.
- **O servidor passou a validar o tempo em vez de confiar no que chega.** Tempo ausente, negativo, absurdo ou não numérico é corrigido antes de gravar — sem isso, uma requisição malformada podia deixar uma imagem parada na tela indefinidamente. Itens sem nome válido são descartados e o nome passa por `path.basename()`.
- Imagem salva sem tempo (playlist antiga) agora aparece com o tempo padrão em vez de "0s".
- Os valores 10, 1 e 300, espalhados pelo código, viraram constantes únicas no controlador e no servidor.

### Verificação

Reproduzido e comparado nas duas versões com um navegador de verdade: na anterior, digitar 25s e 7s em duas imagens gravava `10s` e `10s` e lançava o `SyntaxError`; nesta, grava `25s` e `7s` sem nenhum erro de JavaScript. Também foram testados o ciclo de reedição (reabrir a playlist mostra os tempos certos e permite alterá-los), os limites do servidor (99999 → 300, −5 → 1, texto → padrão) e o comportamento final na TV, que exibiu cada imagem exatamente pelo tempo configurado.

---

## 0.0.9 — 31/07/2026

Versão focada em **não travar em TV nenhuma**. O preload continua existindo, mas deixou de manter dois vídeos carregados o tempo todo — que era justamente o maior risco em TVs de entrada.

### O problema

Muitas Smart TVs, principalmente as de entrada e as mais antigas, têm **um único decodificador H.264 por hardware**. Até a 0.0.8 os dois elementos de vídeo ficavam carregados durante toda a reprodução, disputando esse recurso. Quando o segundo não conseguia um decodificador, o resultado variava entre falhar em silêncio, cair para decodificação por software (que engasga numa CPU de TV) ou fazer o vídeo que estava tocando congelar — exatamente o que o preload pretendia evitar.

### Alterado

- **Preload tardio.** O próximo item passa a ser carregado cerca de 8 segundos antes do fim do atual, em vez de logo no início dele. A janela em que dois decodificadores são disputados caiu do vídeo inteiro para poucos segundos.
- **Liberação imediata do player que sai de cena.** Antes o elemento antigo segurava decodificador e memória até a troca seguinte; agora o `src` é removido na hora. Fora da janela de preload, apenas um vídeo fica carregado.
- **Nenhum decodificador preso durante imagens.** Enquanto uma imagem está na tela, os dois elementos de vídeo são liberados.
- **Conversão mais conservadora**: nível H.264 baixado de 4.0 para **3.1** (o exato necessário para 720p30 — o 4.0 sinalizava exigências de 1080p, e decodificadores antigos que checam esse campo podiam recusar o arquivo); teto de bitrate de **3 Mbps** com `maxrate`/`bufsize`, porque picos de bitrate travam mais TVs do que média alta; e keyframe a cada 2 segundos, o que acelera a recuperação depois de um engasgo.

### Adicionado

- **Modo compatibilidade**, por TV. Uma caixinha nas telas de pareamento e de espera desliga o pré-carregamento duplo e usa um único elemento de vídeo. É a saída para uma TV específica que continue engasgando, sem precisar de nova versão. A escolha fica salva na própria TV, e o endereço aceita `?compat=1` para já abrir nesse modo.
- **Recuperação de emergência.** Se a TV travar três vezes em dois minutos, a página se recarrega sozinha. Um único arquivo com problema no meio de uma playlist saudável não dispara isso: o contador zera sempre que um item reproduz normalmente por 10 segundos, e erro de formato — que recarregar não resolveria — não conta.
- **Retomada automática.** A TV guarda localmente o código de pareamento, o nome e o que estava tocando, e volta ao ar sozinha depois de um reload, seja o de emergência, seja uma queda de energia. Ninguém precisa ir até a TV digitar o código de novo.

### Corrigido

- Playlist com um único item recarregava o mesmo vídeo a cada volta, em vez de repetir o que já estava na memória.

---

## 0.0.8 — 31/07/2026

Versão de limpeza: o app deixou de ser um sistema de rede local e passou a assumir de vez que roda na web (Render). Junto vieram correções de bugs de upload e o enxugamento dos formatos aceitos.

### Formatos aceitos

- **Vídeo**: `.mp4`, `.mov` (formato padrão do iPhone) e `.webm`.
- **Imagem**: `.jpg`/`.jpeg`, `.png` e `.webp`.
- Removidos `.mkv`, `.avi` e `.gif` — formatos pouco usados neste cenário. O upload agora os recusa com "Formato não suportado".
- Arquivos desses formatos que já estejam na pasta `videos/` do servidor continuam sendo listados e reproduzidos; só o envio de novos está bloqueado.

### Corrigido

- **Todo upload `.mp4` ganhava ` (1)` no nome.** Depois da conversão, o nome final era calculado enquanto o arquivo original ainda estava no disco. Como para um `.mp4` o nome desejado era idêntico ao do original, o sistema enxergava uma colisão do arquivo consigo mesmo e renomeava para `Nome (1).mp4`. Uploads de outras extensões não sofriam, porque a extensão mudava para `.mp4` no caminho. Agora o arquivo convertido substitui o original e o nome enviado é preservado. Colisão real com um arquivo já existente continua gerando ` (1)`, sem sobrescrever nada.
- **Arquivo temporário aparecia na biblioteca.** Os temporários `.transcoding_*.mp4` criados durante a conversão podiam surgir na grade do controlador com nome estranho. Agora ficam ocultos.
- **Sobras de conversões interrompidas.** Se o servidor caísse ou reiniciasse no meio de um upload, o temporário ficava no disco para sempre. Agora são apagados na inicialização.
- **Erro 404 de `/favicon.ico` no console.** Adicionada a rota servindo o ícone do app, e as páginas passaram a declarar o ícone.
- **Aviso `Allow attribute will take precedence over 'allowfullscreen'`.** O iframe da tela inicial declarava os dois atributos equivalentes; ficou só o `allowfullscreen`, que funciona tanto em navegador moderno quanto nos navegadores antigos de Smart TV.
- **Falha que derrubava o servidor.** Um acesso a arquivo com extensão fora da tabela de tipos MIME lançava erro não tratado e encerrava o processo — cenário que a própria remoção de formatos tornava possível.

### Alterado

- **Uploads múltiplos agora são sequenciais.** Ao selecionar ou arrastar vários arquivos, eles entram numa fila e sobem um de cada vez; o próximo só começa quando o anterior termina de enviar e de ser convertido. Antes todos subiam em paralelo, saturando a conexão e o servidor.
- **Removido tudo que era específico de rede local**: o endpoint que descobria o IP da máquina, a varredura de porta livre (a porta agora vem sempre da variável de ambiente `PORT`, definida pelo Render) e o endereço de fallback `localhost:3000` na conexão em tempo real.
- A mensagem "nenhuma TV conectada" passou a explicar o fluxo real (abrir o site na TV e digitar o código de sala) em vez de mandar abrir um arquivo.
- `README.md` reescrito para o cenário web, com seção de hospedagem no Render e solução de problemas atualizada.

### Removido

- `NOVAS_FUNCIONALIDADES.md` — documentação obsoleta, não lida pelo app; o conteúdo relevante está no README e o histórico, aqui.
- `videos/Video-Teste1.mp4` e `videos/Video-Teste2.mp4` — vídeos de exemplo que apareciam na grade como se fossem conteúdo do usuário. O pacote caiu de ~12 MB para ~291 KB.

### Interno

- As constantes de formato foram unificadas: nove cópias da mesma verificação de imagem no controlador viraram uma constante única, o que evita que uma mudança de formato fique pela metade no futuro.

---

## Versões anteriores

Reconstruído a partir da documentação que acompanhava os pacotes; pode não estar completo.

### 0.0.7 — junho/2026

- Suporte a imagens além de vídeos, com tempo de exibição configurável por imagem (1 a 300 segundos, padrão 10).
- Playlists mistas, combinando vídeos e imagens na mesma sequência; vídeos tocam até o fim, imagens respeitam o tempo configurado.
- Conversão automática de todo vídeo enviado para HD (1280x720, H.264 Main + AAC, com o índice no início do arquivo), resolvendo travamentos causados por codec incompatível, resolução alta demais ou arquivos sem índice.
- Detecção de vídeo "congelado" na TV, sem erro explícito, com pulo automático para o próximo item.
- Pareamento por código de sala de 5 dígitos: cada controlador só enxerga e comanda as TVs pareadas com ele.

### 0.0.6

Versão base: controle de vídeos em loop para TVs, com reprodução, pausa, retomada, parada e transmissão simultânea para todas as TVs.
