# 📺 VisionLoop

**Versão 0.6.9-fix** — 17/08/2026 · O histórico de mudanças fica em [CHANGELOG.md](CHANGELOG.md).

Sistema web de exibição de vídeos e imagens em loop para TVs, voltado a propagandas, cardápios digitais e apresentações.

## Como funciona

```
[Controlador (PC/celular)] ←→ [Servidor VisionLoop (Render)] ←→ [TV 1]
                                                             ←→ [TV 2]
                                                             ←→ [TV 3...]
```

O servidor é hospedado na web (Render) e serve como intermediário. O controlador e as TVs abrem o **mesmo endereço do site** e se comunicam via WebSocket em tempo real. Como tudo passa pela internet, **as TVs não precisam estar na mesma rede do controlador** — podem estar em lojas, andares ou cidades diferentes.

---

## Requisitos

- Navegador nas TVs (Chrome, Edge ou Firefox) com acesso à internet
- Navegador no dispositivo que vai controlar (PC, notebook ou celular)
- Nenhuma instalação, nenhum IP, nenhuma configuração de rede

---

## Como usar

### 1. Abra o site

Acesse o endereço do VisionLoop no navegador. A tela inicial pergunta como você quer entrar: **Controlador** ou **TV**.

### 2. Abra o Controlador

No seu PC ou celular, acesse o site e escolha **🎮 Controlador**.

### 3. Conecte as TVs

Em cada TV, abra o navegador, acesse o mesmo endereço do site e escolha **📺 TV**. A conexão é direta — não existe código nenhum para digitar: a TV já aparece sozinha na lista do controlador em poucos segundos.

⚠️ Como a conexão é direta e sem código, **todo controlador que abrir o site enxerga e comanda todas as TVs conectadas a este servidor**. Isso é o esperado para um único negócio/local usando o VisionLoop. Se um dia for necessário isolar grupos diferentes de TVs (por exemplo, para revender o sistema a mais de um cliente), cada cliente deve rodar sua própria instância do servidor (outro deploy no Render), não compartilhar a mesma.

### 4. Adicione seus vídeos e imagens

Na aba **"Vídeos"** do controlador, clique na zona de upload ou arraste os arquivos:

- Vídeos aceitos: **apenas `.mp4`** (a partir da 0.1.3).
- Imagens aceitas: `.jpg`, `.jpeg`, `.png`, `.webp`
- Qualquer outro formato de vídeo (`.mov`, `.webm`, `.mkv`, `.avi`, etc.) é recusado direto no upload, com uma mensagem explicando o motivo.
- ⚠️ **O vídeo não é mais convertido automaticamente** (a partir da 0.1.2) — ele é salvo exatamente como enviado. Isso existia pra garantir compatibilidade com Smart TVs, mas era o que mais pesava na memória do servidor em vídeos de alguns minutos. Como não há mais conversão, só `.mp4` é aceito (é o formato universalmente suportado); se o vídeo vier de iPhone (`.mov`) ou de outro app, **converta para `.mp4` antes de enviar** (o próprio celular ou qualquer conversor online resolve) — o ideal é já usar H.264 + AAC dentro do `.mp4`.
- **Com o Cloudflare R2 configurado (recomendado — ver seção abaixo), o upload vai direto do navegador pro armazenamento, sem passar pelo Render.** Isso existe porque só de RECEBER um arquivo de vídeo de alguns minutos, o servidor já podia ficar sem memória no plano gratuito. Sem R2 configurado, o upload continua indo pelo servidor (modo disco local, como sempre).
- **Envio em fila (um arquivo por vez)**: se você selecionar ou arrastar vários arquivos de uma só vez, eles **não** sobem todos juntos — evita saturar a conexão. A barra de progresso de cada arquivo aparece na lista; os que ainda estão na fila aguardam a vez.

### 5. Reproduza

Selecione uma TV na lista, escolha um vídeo ou imagem e mande reproduzir — ou monte uma playlist na aba **"Playlists"** e inicie a playlist na TV escolhida.

---

## Funcionalidades

| Função | Descrição |
|--------|-----------|
| ▶ Reproduzir | Envia um vídeo ou imagem para a TV selecionada |
| ⏸ Pausar / ▶ Retomar | Pausa e retoma a reprodução na TV |
| ⏹ Parar | Para a reprodução e volta à tela de espera |
| 📡 Transmitir para todas | Envia o mesmo conteúdo para todas as suas TVs ao mesmo tempo |
| 🎬 Playlists | Sequências de vídeos e imagens, com tempo configurável por imagem (1 a 300s) |
| 📝 Playlist vazia | Dá para criar uma playlist só com o nome e ir adicionando o conteúdo depois |
| ➕ Conteúdo dentro da playlist | Vídeos e imagens são enviados pelo botão **Adicionar vídeos**, sempre de dentro de uma playlist — não existe upload solto |
| ♻️ Edição ao vivo | Editar uma playlist que está no ar atualiza a TV na hora, sem precisar parar e reenviar |
| ⏳ Prazo de validade | Ao enviar um arquivo você escolhe: sem prazo, ou uma data e hora em que ele sai sozinho do ar |
| 🔌 Conexão direta | TVs conectam ao controlador sem nenhum código — aparecem sozinhas na lista |
| ⛶ Tela cheia | Coloca a TV em tela cheia remotamente, pelo controlador |
| Loop automático | O conteúdo fica em loop infinito até você mandar parar |
| Nome da TV | Cada TV pode ter um nome personalizado |
| 🗑 Excluir de qualquer lugar | O botão de excluir aparece em toda grade de vídeos/fotos (incluindo dentro da tela de criar playlist) |
| 🔗 Exclusão em cascata | Apagar um vídeo/foto também remove ele de qualquer playlist que o usava |
| 💾 Uso de armazenamento | O cabeçalho do controlador mostra quantos GB já estão sendo usados |
| 🏷️ Versão do app | A versão instalada aparece no canto do controlador e da TV |
| ☁️ Upload direto pro R2 | Com o Cloudflare R2 configurado, o arquivo vai direto do navegador pro bucket — o servidor nunca recebe o vídeo em si |

---

## Dicas

- Para **tela cheia** na TV, use o botão de tela cheia do próprio controlador, ou pressione F11 no navegador da TV.
- O sistema **reconecta automaticamente** se a conexão cair, tanto no controlador quanto nas TVs.
- Toda vez que a aba da TV é fechada e reaberta (ou recarrega sozinha após uma falha), ela volta a um **estado zerado**: conecta direto ao servidor e fica em espera, sem tentar retomar sozinha o que estava tocando antes. Quem decide o que toca é sempre o controlador — mande reproduzir de novo (ou ligue a playlist) depois de um reload. O nome da TV e o modo compatibilidade continuam salvos normalmente.
- Suporta **quantas TVs quiser** — sem limite.
- Cada TV ainda mostra na tela de espera um **código próprio de identificação** (ex: `RU17KD`) — só para você reconhecer qual card do controlador corresponde a qual tela física, antes de dar um nome a ela. Não é preciso digitar esse código em lugar nenhum.

---

## TVs antigas: modo compatibilidade

Para trocar de vídeo sem tela preta, o VisionLoop prepara o próximo vídeo em segundo plano nos últimos segundos do vídeo atual. Isso exige que a TV consiga manter dois vídeos carregados por alguns instantes — e algumas Smart TVs de entrada têm um único decodificador de vídeo por hardware.

Se uma TV específica travar, piscar ou ficar com a tela preta na troca de vídeos, marque **"Modo compatibilidade"** na tela de espera dela. A TV passa a carregar um vídeo por vez: a troca fica um pouco menos suave, mas o risco de travamento cai bastante. A escolha vale só para aquela TV e fica salva nela.

Também dá para deixar isso fixo no endereço, útil quando a TV abre o site sozinha ao ligar:

```
https://SEU-ENDERECO/tv.html?compat=1
```

Se uma TV travar três vezes em dois minutos, ela se recarrega sozinha e volta a exibir o mesmo conteúdo, sem precisar de intervenção.

---

## Hospedagem (Render)

O projeto roda como um Web Service Node.js:

- **Build command**: `npm install`
- **Start command**: `npm start`
- **Porta**: definida automaticamente pela variável de ambiente `PORT` — não é preciso configurar nada.

⚠️ **Atenção ao armazenamento e à banda**: o disco do Render é efêmero por padrão — vídeos, imagens e `playlists.json` **são apagados a cada novo deploy ou reinício**. E o plano gratuito do Render inclui só **5GB de banda de saída por mês** no total, o que uma única TV tocando vídeo o dia todo já consome sozinha em poucas horas. Os dois problemas têm a mesma solução: guardar e servir os vídeos/imagens de um armazenamento externo em vez do disco do Render (ver seção seguinte).

---

## Armazenamento externo (Cloudflare R2) — recomendado para produção

Por padrão o servidor guarda tudo no próprio disco (comportamento de sempre). Configurando as variáveis de ambiente abaixo no Render, ele passa a usar um bucket Cloudflare R2 pra guardar vídeos/imagens, e o upload passa a ir **direto do navegador pro bucket, sem passar pelo Render** — resolvendo de uma vez o disco efêmero (o R2 persiste entre deploys), o teto de banda (baixar do R2 não é cobrado) e o consumo de memória do servidor durante o envio (que já não recebe mais o arquivo).

**Como configurar:**

1. Crie uma conta gratuita em [cloudflare.com](https://cloudflare.com), se ainda não tiver.
2. No painel, vá em **R2 Object Storage** e crie um bucket (ex: `visionloop-videos`).
3. Ative o acesso público do bucket. A Cloudflare avisa que a URL de teste automática (`*.r2.dev`) **é limitada e não deve ser usada em produção** — para TVs ligadas o dia todo, o certo é conectar um domínio próprio (ex: `videos.seudominio.com`) ao bucket. A URL de teste serve para validar a configuração antes disso.
4. Em **Manage API tokens**, crie um token com permissão de leitura e escrita para esse bucket. Isso dá um **Access Key ID**, um **Secret Access Key** e o **endpoint** da conta (`https://<ID-da-conta>.r2.cloudflarestorage.com`).
5. No painel do Render, na aba **Environment** do serviço, cadastre estas 5 variáveis (nunca no código, nunca compartilhadas fora do Render):
   - `R2_ENDPOINT` — o endpoint do passo 4.
   - `R2_ACCESS_KEY_ID` e `R2_SECRET_ACCESS_KEY` — as chaves do passo 4.
   - `R2_BUCKET_NAME` — o nome do bucket do passo 2.
   - `R2_PUBLIC_BASE_URL` — a URL pública do passo 3 (dev ou domínio próprio), sem barra no final.
6. ⚠️ **Passo obrigatório a partir da 0.1.2**: como o upload agora vai direto do navegador pro bucket (um endereço diferente do seu site), o R2 precisa de uma permissão de CORS liberando isso — sem ela, o upload falha com um erro de conexão/CORS mesmo com tudo mais certo. No bucket, vá em **Settings → CORS Policy → Add CORS policy** e cole:
   ```json
   [
     {
       "AllowedOrigins": ["https://SEU-SERVICO.onrender.com"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["Content-Type"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   Troque `https://SEU-SERVICO.onrender.com` pelo endereço real do seu site no Render (sem barra no final). Salve.

Com as 5 variáveis + o CORS configurados, o próximo deploy já passa a usar o R2 automaticamente — nada muda na tela do controlador nem da TV, exceto o aviso de que o vídeo não é mais convertido (ver seção **Como usar** acima). **Atenção**: vídeos que já estavam só no disco local do Render antes de ligar o R2 não são migrados sozinhos; suba-os de novo pelo controlador se ainda precisar deles.

### Evitando cobrança surpresa (`R2_MAX_STORAGE_GB`)

A Cloudflare não tem um limite rígido de uso para o R2 — só um alerta por e-mail que avisa *depois* que você já passou da faixa grátis, sem impedir a cobrança. Por isso o VisionLoop tem sua própria trava, opcional: configure a variável de ambiente **`R2_MAX_STORAGE_GB`** (ex: `9.5`) e o servidor passa a **recusar novos uploads** assim que o total guardado no bucket chegasse perto desse valor, com um aviso claro na tela do controlador — nunca deixando passar do limite que você definiu. Sem essa variável, não existe teto (fica só por sua conta acompanhar o uso no painel da Cloudflare).

---

## Solução de problemas

**TV não aparece no controlador**
→ Não existe mais código de pareamento — confirme só que a TV abriu o **mesmo endereço do site** que o controlador e escolheu a opção **TV**.
→ Verifique se a TV está com acesso à internet (veja o indicador de conexão na tela de espera dela).
→ Se a TV foi aberta antes do controlador, ela já deve aparecer sozinha assim que o controlador conectar — não precisa recarregar nenhum dos dois.

**Vídeo não toca na TV**
→ O upload já exige `.mp4`, mas o vídeo não é mais convertido — então o que está *dentro* do arquivo importa. Se o `.mp4` foi exportado com um codec incomum (HEVC/H.265, por exemplo) ou resolução muito alta (4K), pode não tocar em Smart TVs mais simples. O ideal é H.264 + AAC, que é o que praticamente todo conversor/celular gera por padrão.
→ Navegadores de Smart TV muito antigos podem não suportar WebSocket ou vídeo HTML5 — nesse caso, um dispositivo externo (Chromecast, Fire Stick, mini PC) resolve.

**Vídeo trava e não volta mais**
→ A TV detecta sozinha quando um vídeo "congela" (sem erro explícito) e pula para o próximo automaticamente. Mas se o travamento for por incompatibilidade de formato (não por rede), reenviar o mesmo arquivo não resolve — converta pra `.mp4` H.264/AAC antes de subir de novo.

**Aparece um vídeo com nome estranho, terminado em `(1)`**
→ Comportamento esperado: acontece quando você envia um arquivo com um nome que **já existe** na biblioteca. Nesse caso os dois são mantidos, e nenhum arquivo é sobrescrito.

**Erro 404 de `/favicon.ico` no console do navegador**
→ Era só o ícone do site faltando; não afetava a reprodução. O servidor agora responde `/favicon.ico` com o ícone do app, e as páginas declaram o ícone diretamente.

**Enviei vários arquivos e eles estão subindo um de cada vez**
→ Isso é o comportamento esperado. O envio é sequencial de propósito: subir e converter vários vídeos ao mesmo tempo satura a conexão e o servidor, deixando *todos* os uploads mais lentos e sujeitos a falha. Na fila, cada arquivo termina de verdade antes do próximo começar.

**Meus vídeos sumiram depois de um deploy**
→ Comportamento do disco efêmero do Render (veja a seção **Hospedagem** acima). Configure o armazenamento no Cloudflare R2 (seção **Armazenamento externo** acima) para que o conteúdo sobreviva a deploys.

**Depois de configurar o R2, meus vídeos antigos sumiram da lista**
→ Esperado. Os vídeos que estavam só no disco local do Render não são migrados automaticamente para o R2 — suba-os de novo pelo controlador.

**Depois de atualizar para a 0.1.1, uma TV que já estava aberta ficou travada numa tela preta / erro de formato**
→ Isso acontece só uma vez, em TVs que já estavam abertas ANTES da atualização: o navegador delas guardava localmente qual foi o último vídeo tocado, para retomar sozinho depois de um religamento. A partir da 0.1.1 esse comportamento foi removido de propósito (a TV sempre abre "zerada"), mas uma aba que já estava aberta com a versão antiga carregada ainda tenta usar essa memória antiga uma última vez. Basta **recarregar a página da TV** (ou limpar os dados do site nela) uma vez — dali em diante ela já segue sempre no novo comportamento.

**Como funciona o prazo de validade dos arquivos**
→ Toda vez que você envia um arquivo, aparece uma tela perguntando se ele deve ter prazo. "Sem prazo" (o padrão) faz o arquivo ficar por tempo indeterminado, até você excluir. Escolhendo data e hora, o servidor apaga o arquivo assim que o prazo chega, remove ele de todas as playlists que o usavam e avisa na hora as TVs que estiverem exibindo essas playlists — o item sai da fila de execução sem ninguém precisar mexer em nada. Datas passadas não podem ser escolhidas. A escolha vale para todos os arquivos daquele mesmo envio.

**Excluí um vídeo/foto e ele sumiu de uma playlist que eu tinha criado**
→ Esperado a partir da 0.1.1: apagar um arquivo agora também remove ele de qualquer playlist que o usava, para a playlist nunca ficar "quebrada" tentando tocar algo que não existe mais. A partir da 0.6.6 a playlist que fica sem nenhum item **não é mais apagada**: ela continua na lista, vazia, pronta para receber conteúdo novo.

**Enviei arquivos e eles não apareceram / o envio falhou**
→ Se acabou de atualizar para a 0.6.9, confira se rodou o `schema-migracao-0.6.9.sql` no banco. A partir da 0.6.9-fix isso não impede mais o envio — o app funciona sem prazo até a migração rodar, e a tela de envio avisa quando é esse o caso.

**Um arquivo sumiu sozinho da playlist**
→ Ele provavelmente foi enviado com prazo de validade (o selo ⏳ aparece no canto do cartão dele na biblioteca). Ao chegar o prazo, o arquivo é apagado, sai das playlists que o usavam e as TVs que estavam exibindo essas playlists são avisadas na hora. Arquivo enviado como "sem prazo" nunca some sozinho.

**Escolhi um prazo e o arquivo continuou no ar depois do horário**
→ A varredura de vencidos roda de minuto em minuto, então o corte pode acontecer até cerca de um minuto depois do horário marcado — nunca antes. Se passou muito disso, confira se a migração `schema-migracao-0.6.9.sql` foi rodada no banco.

**Editei a playlist e a TV continuou com o conteúdo antigo**
→ Corrigido na 0.6.8: agora a TV que está exibindo aquela playlist recebe a versão nova na hora, sem precisar parar e mandar reproduzir de novo. O arquivo que está na tela continua nele; o que muda é o resto da fila (e o tempo da imagem em exibição, se você o alterou). Em versões anteriores era mesmo necessário parar e reenviar.

**A primeira requisição demora muito**
→ No plano gratuito do Render o serviço "dorme" após um período sem uso e leva alguns segundos para acordar na primeira visita.

**Upload de vídeo trava em 100% / dá erro 502 (Bad Gateway)**
→ Isso era causado pela conversão automática do vídeo (FFmpeg), que consumia memória suficiente para estourar o limite do plano gratuito do Render (512MB) — o Render matava e reiniciava o app no meio do upload, mais comum em vídeos de alguns minutos. A partir da 0.1.2 essa conversão foi **removida por completo**, e com o Cloudflare R2 configurado (ver seção **Armazenamento externo**) o upload nem passa mais pelo servidor — então esse erro específico não deve mais acontecer. Se ainda acontecer: confirme que o R2 está configurado (sem ele, o upload volta a passar pelo Render) e confira os **Logs** do serviço no Render por volta do horário do erro.

**Upload dá erro de conexão / CORS ao usar o R2 (a partir da 0.1.2)**
→ Como o upload agora vai direto do navegador pro bucket, o R2 precisa de uma política de CORS liberando isso — sem ela, toda tentativa de envio falha com esse erro mesmo com as 5 variáveis certas. Veja o passo 6 da seção **Armazenamento externo** acima e confirme que o `AllowedOrigins` da política tem exatamente o endereço do seu site no Render (sem barra no final).
