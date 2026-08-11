# Changelog

Todas as mudanças relevantes do VisionLoop, da versão mais recente para a mais antiga.

## Como versionar

O padrão de nome é **`AAAA-MM-DD_VisionLoop-X.Y.Z`**, usado igual na pasta e no zip — por exemplo `2026-07-31_VisionLoop-0.0.8.zip`. O campo `"version"` do `package.json` recebe só o número (`0.0.8`) e deve bater sempre com o do nome.

A data vai no formato ano-mês-dia justamente porque assim a ordem alfabética e a cronológica são a mesma coisa: a pasta se organiza sozinha, da versão mais antiga para a mais nova, sem depender de datas de modificação (que se perdem ao copiar ou descompactar arquivos). Escrita como dia-mês-ano isso não funcionaria.

Sobre qual número mexer: suba o último em correções e ajustes, o do meio quando entrar funcionalidade nova, e o primeiro só se algo quebrar a compatibilidade com o que já existia. O "o que mudou" fica aqui neste arquivo, nunca no nome do zip.

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
