# VisionLoop — checklist de verificação (0.11.0 — precificador automático)

Lista de tudo que precisa ser conferido no sistema no ar antes de confiar
100% no precificador automático (leitura do `.txt` da balança → 7 tabelas de
carne precificadas → entram na playlist). Marque item a item testando direto
no Render, com um `.txt` real.

## Antes de começar

- [ ] **Versão no ar é a 0.11.0**
  - Como testar: Abra o controlador e olhe o número ao lado do logo.
  - Esperado: Mostra **v0.11.0**. Se mostrar outra, o deploy no Render ainda não terminou.
- [ ] **`npm install` no Render não falhou**
  - Como testar: Olhe o log de build do deploy no Render.
  - Esperado: `sharp` aparece instalado sem erro. É a única dependência nova desta versão — se o build da plataforma dela falhar (às vezes precisa compilar binário nativo), o servidor inteiro não sobe.
- [ ] **O servidor não travou no boot**
  - Como testar: Olhe o log do serviço logo depois do deploy.
  - Esperado: Nenhum erro tipo `Cannot find module './lib/precificador'` ou `ENOENT` procurando `assets/tabelas/*.png` / `assets/fonts/DejaVuSans-Bold.ttf`. Esses arquivos precisam ter ido junto no deploy.

## Leitura do .txt e cálculo dos preços

- [ ] **Envio de um .txt válido gera as 7 imagens**
  - Como testar: Dentro de uma playlist, envie um `.txt` real da balança pela zona de envio.
  - Esperado: Sobe, processa e as 7 imagens (`tabela-precos-bovinos-1/2/3.jpg`, `tabela-precos-suinos.jpg`, `tabela-precos-linguicas-1/2.jpg`, `tabela-precos-aves.jpg`) entram na ordem de reprodução, uma a uma.
- [ ] **Os preços batem com o .txt enviado**
  - Como testar: Escolha 3-4 itens ao acaso (ex.: Picanha, Fraldinha, Linguiça Calabresa) e confira o valor na imagem contra o preço daquele item no `.txt`.
  - Esperado: Bate exatamente (dividido por 100, vírgula em vez de ponto).
- [ ] **Item duplicado no .txt usa o mais caro**
  - Como testar: Edite um `.txt` de teste duplicando uma linha (ex.: duas linhas `CARNE BOVINA PATINHO` com preços diferentes) e envie.
  - Esperado: A tabela mostra o valor mais alto dos dois, nunca o mais baixo nem uma soma/média.
- [ ] **Item faltando no .txt não quebra a geração**
  - Como testar: Remova do `.txt` de teste uma linha de item mapeado (ex.: apague a linha da Picanha) e envie.
  - Esperado: As 7 imagens ainda são geradas; a célula de preço da Picanha fica em branco; o alerta final do navegador lista esse item como não encontrado.
- [ ] **.txt vazio ou sem nenhum item reconhecível**
  - Como testar: Envie um `.txt` de 0 bytes, ou um cheio de linhas curtas/lixo.
  - Esperado: Não derruba o servidor — na pior das hipóteses, as 7 imagens saem com todas as células em branco e o aviso lista os 60 itens como não encontrados.
- [ ] **Preço no limite superior (R$99,99) não estoura a célula**
  - Como testar: Use o `Txitens.txt` de teste com a Picanha em 99,99 (já entregue nesta conversa) e confira a imagem 1 (Bovinos).
  - Esperado: O texto encolhe e cabe dentro da célula, sem vazar pra cima da foto nem pra fora da linha.
- [ ] **Acentos do nome do produto não corrompem nada**
  - Como testar: Confira no log do servidor (ou nos itens não encontrados) que nomes com acento no `.txt` foram lidos certo.
  - Esperado: Sem `?` ou caracteres estranhos — a leitura é em latin1, como a balança exporta.

## Geração das imagens

- [ ] **As 7 imagens saem em 16:9, sem tarja preta**
  - Como testar: Abra qualquer uma das 7 imagens geradas e confira a proporção (2821×1587) ou veja na TV.
  - Esperado: Preenche a tela toda de uma TV comum, sem faixa preta nas laterais.
- [ ] **A coluna de nome + preço não foi distorcida pelo ajuste de tela cheia**
  - Como testar: Compare o texto (nomes e preços) das imagens novas com as 7 tabelas-base originais do Canva.
  - Esperado: Mesma fonte, mesmo tamanho, mesma posição — só a foto do lado direito mudou (um pouco mais ampliada/cortada).
- [ ] **A foto não ficou esticada/deformada**
  - Como testar: Olhe as 7 imagens finais, com atenção especial na 7.png (Aves, foto mais "fechada").
  - Esperado: A foto parece só um pouco mais ampliada (zoom), nunca esticada ou com proporção errada.
- [ ] **Enviar o mesmo .txt de novo substitui as imagens antigas**
  - Como testar: Envie um `.txt`, depois envie outro com preços diferentes.
  - Esperado: Os nomes de arquivo continuam os mesmos 7 de sempre (não vira `tabela-precos-bovinos-1 (1).jpg`) e o conteúdo reflete o `.txt` mais recente.
- [ ] **Espaço de armazenamento não cresce a cada envio**
  - Como testar: Confira o indicador 💾 antes e depois de enviar o mesmo `.txt` três vezes seguidas.
  - Esperado: O uso de espaço não sobe a cada rodada (as imagens são sobrescritas, não acumuladas).

## Fluxo de envio no controlador

- [ ] **O seletor de arquivo aceita .txt**
  - Como testar: Clique em "clique para selecionar" na zona de envio de uma playlist e procure o `.txt`.
  - Esperado: O arquivo aparece selecionável (não fica acinzentado/escondido pelo filtro do sistema operacional).
- [ ] **Arrastar um .txt solto também funciona**
  - Como testar: Arraste o `.txt` direto pra dentro da zona de envio.
  - Esperado: Mesmo comportamento de quando é selecionado pelo clique.
- [ ] **Não pede prazo de validade pro .txt**
  - Como testar: Envie um `.txt`.
  - Esperado: Não aparece a tela "até quando este conteúdo deve ficar no ar" — isso é só pra vídeo/imagem comum.
- [ ] **Barra de progresso e alerta final aparecem**
  - Como testar: Envie um `.txt` e acompanhe a zona de envio.
  - Esperado: Aparece um item "precificando tabelas…", termina com ✓, e um alerta resume quantas tabelas foram geradas e quantos itens do `.txt` foram lidos.
- [ ] **Enviar .txt + outro arquivo ao mesmo tempo é recusado**
  - Como testar: Selecione/arraste um `.txt` junto com um `.jpg`, os dois de uma vez.
  - Esperado: Mensagem "Envie um arquivo por vez" — mesma regra que já vale pra vídeo/imagem.
- [ ] **Arquivo com extensão errada mas conteúdo de balança**
  - Como testar: Renomeie um `.txt` de teste para `.csv` ou sem extensão e tente enviar.
  - Esperado: Cai no fluxo de upload comum (não reconhece como balança) e provavelmente é recusado por formato — comportamento aceitável, mas confirme que não trava a tela.

## O que NÃO deve acontecer (importante — foi pedido explicitamente)

- [ ] **Nenhuma playlist nova é criada sozinha**
  - Como testar: Envie um `.txt` dentro da playlist "Promoções" (ou qualquer uma seguindo o exemplo) e olhe a lista de playlists inteira depois.
  - Esperado: Não aparece nenhuma playlist nova chamada "Tabela de Preços" nem qualquer outro nome — só a playlist que já estava aberta ganhou os 7 itens novos.
- [ ] **Nenhuma TV é acionada sozinha**
  - Como testar: Com uma ou mais TVs pareadas exibindo qualquer coisa, envie um `.txt`.
  - Esperado: Nenhuma TV muda de conteúdo na hora. Elas só mudam quando você, manualmente, mandar tocar a playlist.
- [ ] **As imagens não são salvas na playlist sem confirmação**
  - Como testar: Envie um `.txt`, veja os 7 itens na ordem de reprodução, mas feche o formulário SEM clicar em Salvar.
  - Esperado: Reabrindo a playlist depois, os 7 itens não estão lá — precisa ter clicado Salvar pra valer de verdade.

## Integração com a playlist

- [ ] **As 7 imagens entram na ordem certa**
  - Como testar: Depois de enviar o `.txt`, olhe a lista "Ordem de reprodução".
  - Esperado: As 7 aparecem lá (a ordem entre elas e o resto do conteúdo pode ser reorganizada manualmente, isso é esperado).
- [ ] **Dá pra reordenar/remover como qualquer mídia**
  - Como testar: Mova uma das tabelas de posição, ou remova uma delas da lista.
  - Esperado: Funciona normalmente, sem erro nenhum — pro sistema é só mais uma imagem.
- [ ] **Duração de imagem aplicada normalmente**
  - Como testar: Confira o tempo de exibição (segundos) atribuído a cada tabela na lista.
  - Esperado: Usa o padrão de imagem (mesmo valor que qualquer .jpg enviado), e dá pra editar manualmente como qualquer outra.
- [ ] **Salvar a playlist grava de verdade**
  - Como testar: Depois de enviar o `.txt`, clique em Salvar, saia da playlist e volte a abrir.
  - Esperado: As 7 tabelas continuam lá, na ordem que ficaram.

## Exibição na TV

- [ ] **Mandar tocar a playlist mostra as tabelas normalmente**
  - Como testar: Depois de salvar, envie essa playlist pra uma TV pareada (do jeito manual de sempre).
  - Esperado: As tabelas aparecem no rodízio, em tela cheia, sem tarja preta, com o preço legível a alguns metros de distância.
- [ ] **Mistura com vídeo/outras imagens na mesma playlist funciona**
  - Como testar: Numa playlist com vídeos e imagens comuns junto com as tabelas, mande tocar numa TV.
  - Esperado: Alterna entre tudo normalmente, sem travar nem pular a tabela.

## Casos de erro / resiliência

- [ ] **Sem sessão ativa, o envio é recusado**
  - Como testar: Deslogado (ou sessão expirada), tente forçar o envio (ex.: reenviando a requisição).
  - Esperado: Erro 401 "Não autenticado", sem gerar nada.
- [ ] **.txt gigante (não é o formato esperado) não trava o servidor**
  - Como testar: Envie um arquivo de texto bem grande (vários MB) renomeado pra `.txt`.
  - Esperado: É recusado com "Arquivo .txt grande demais" antes de processar, sem consumir memória à toa.
- [ ] **Falha do R2 no meio do envio não deixa lixo**
  - Como testar: Difícil simular sem derrubar o R2 de propósito — pelo menos confirme visualmente que, em uso normal, todas as 7 imagens aparecem na biblioteca (nenhuma "sumida" por erro silencioso).
  - Esperado: Ou as 7 sobem com sucesso, ou o envio inteiro falha com uma mensagem clara pedindo pra tentar de novo.

## Desempenho

- [ ] **O tempo de processamento é aceitável**
  - Como testar: Cronometre do clique de envio até o alerta final aparecer.
  - Esperado: Alguns segundos (ordem de 5-15s) — não trava a tela do controlador por mais tempo que isso.
- [ ] **O resto do sistema continua respondendo durante o processamento**
  - Como testar: Enquanto o `.txt` está sendo processado, abra outra aba do controlador ou veja se uma TV continua respondendo a comandos.
  - Esperado: Nada trava — outras ações no sistema continuam normais enquanto as 7 tabelas são geradas.

## Regressão (garantir que nada quebrou)

- [ ] **Upload comum de vídeo/imagem continua igual**
  - Como testar: Envie um `.mp4` e depois um `.jpg` normalmente.
  - Esperado: Mesmo comportamento de sempre (tela de prazo, barra de progresso, entra na playlist).
- [ ] **Playlists sem nenhum .txt envolvido continuam normais**
  - Como testar: Crie/edite uma playlist qualquer sem usar o precificador.
  - Esperado: Nada mudou.
- [ ] **Recursos da 0.9.0 continuam no ar**
  - Como testar: Confira o selo de conta em cada TV (visão ADM) e o botão de tela cheia.
  - Esperado: Ambos continuam funcionando como na versão anterior.

Total: 33 itens.
