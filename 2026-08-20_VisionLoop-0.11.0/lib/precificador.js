// lib/precificador.js
// Precificador automático das tabelas de carnes (0.11.0).
//
// O que este módulo faz, em três passos:
//
//  1) Lê o .txt exportado da balança e extrai nome+preço de cada item — o
//     formato de largura fixa foi descoberto e validado manualmente contra
//     duas exportações reais (700+ linhas, zero erro de leitura) e contra 5
//     fotos das telas de preço já em uso na loja (100% de acerto).
//
//  2) Para cada uma das 60 linhas das 7 tabelas-base (as imagens prontas que
//     o usuário desenhou no Canva, em assets/tabelas/1.png..7.png — título,
//     nome de cada corte e foto já prontos, só falta o preço), busca o preço
//     certo usando um mapeamento FIXO linha→nome-no-txt. Esse mapeamento foi
//     validado à mão contra as fotos reais das telas (inclusive os dois casos
//     em que o nome da tabela não bate literalmente com o nome no txt — ver
//     comentário em cima de MAPEAMENTO_PRECOS) — por isso a busca aqui NÃO
//     tenta adivinhar por aproximação de nome, ela usa a resposta já certa.
//     Quando o mesmo nome aparece duas vezes no txt com preços diferentes,
//     fica sempre o mais caro (regra dada pelo usuário).
//
//  3) Desenha o preço encontrado em cima de uma cópia de cada tabela-base, na
//     posição exata da célula de preço (coordenadas em GEOMETRIA_TABELAS,
//     medidas por varredura de pixel nas imagens reais — ver relatório do
//     projeto). O texto é desenhado via SVG com a fonte (DejaVu Sans Bold)
//     embutida em base64 dentro do próprio SVG — assim o preço aparece igual
//     em qualquer servidor, mesmo um que não tenha essa fonte instalada.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ASSETS_DIR = path.join(__dirname, "..", "assets", "tabelas");
const FONT_PATH = path.join(__dirname, "..", "assets", "fonts", "DejaVuSans-Bold.ttf");
const FONT_BASE64 = fs.readFileSync(FONT_PATH).toString("base64");
const FONT_FAMILY = "VisionLoopPrecos";

// ---------- 1) Leitura do TXT da balança ----------
//
//   [0:2]   "01"              prefixo constante (ignorado)
//   [2:13]  código interno    (ignorado, 11 dígitos)
//   [13:17] preço em centavos (4 dígitos — dividir por 100 pra chegar em R$)
//   [17:20] "000"             sufixo constante (ignorado)
//   [20:70] nome do produto, alinhado à esquerda, resto preenchido com espaço
function parseTxt(conteudo) {
  const linhas = String(conteudo).split(/\r?\n/);
  const itens = [];
  for (const linha of linhas) {
    if (linha.length < 20) continue;
    const precoStr = linha.slice(13, 17);
    if (!/^\d{4}$/.test(precoStr)) continue;
    const preco = parseInt(precoStr, 10) / 100;
    const nome = linha.slice(20).trim();
    if (!nome) continue;
    itens.push({ nome, preco });
  }
  return itens;
}

function normalizarNome(nome) {
  return String(nome).toUpperCase().replace(/\s+/g, " ").trim();
}

// Índice nome-normalizado -> maior preço encontrado pra esse nome. Quando o
// mesmo nome aparece mais de uma vez no txt com preços diferentes (já visto
// na prática: "CARNE BOVINA PATINHO" com dois preços), fica o mais caro —
// regra confirmada pelo usuário ("1_ usar o mais caro").
function construirIndicePrecos(itens) {
  const indice = new Map();
  for (const { nome, preco } of itens) {
    const chave = normalizarNome(nome);
    const atual = indice.get(chave);
    if (atual === undefined || preco > atual) indice.set(chave, preco);
  }
  return indice;
}

// ---------- 2) Mapeamento linha-da-tabela -> nome-no-txt ----------
//
// Ordem e nomes das linhas são exatamente os das 7 imagens em
// assets/tabelas/ (o usuário confirmou que essa ordem é sempre a mesma).
// O valor de cada linha é o nome EXATO (já normalizado: maiúsculo, espaços
// simples) que esse corte tem dentro do txt da balança — não é o nome bonito
// que aparece na tabela, é o nome cru de dentro do arquivo.
//
// Dois cuidados que já causaram erro antes e por isso ficam registrados aqui:
//  - Muita coisa existe no txt em duas versões: uma "crua" (ex: "PEITO DE
//    VACA", "ACEM", "COXAO MOLE") e uma com o prefixo "CARNE BOVINA "/"...
//    SUINA"/"... DE FRANGO" (ex: "CARNE BOVINA PEITO"). As fotos reais das
//    telas da loja mostram que é SEMPRE a versão com o prefixo de espécie que
//    vale — a versão crua é de outro contexto (ex.: seção de conveniência) e
//    tem preço diferente. Por isso o mapa abaixo aponta pro nome COM prefixo,
//    mesmo quando existe uma versão mais curta do mesmo corte.
//  - "Pé de Frango" na tabela NÃO é "PE DE FRANGO" no txt (esse é um item
//    mais barato e diferente) — é "PE E PESCOSSO DE FRANGO". Confirmado
//    comparando com a foto real da tela de Aves.
const TEMPLATES = [
  {
    arquivo: "1.png",
    titulo: "Bovinos",
    linhas: [
      { rotulo: "Picanha", txt: "CARNE BOVINA PICANHA" },
      { rotulo: "Filé Mignon", txt: "CARNE BOVINA FILE MIGNON" },
      { rotulo: "Cupim", txt: "CARNE BOVINA CUPIM" },
      { rotulo: "Contra Filé", txt: "CARNE BOVINA CONTRA FILE" },
      { rotulo: "Alcatra", txt: "CARNE BOVINA ALCATRA" },
      { rotulo: "Maminha", txt: "CARNE BOVINA MAMINHA" },
      { rotulo: "Coxão Mole", txt: "CARNE BOVINA COXAO MOLE" },
      { rotulo: "Fraldinha", txt: "CARNE BOVINA FRALDINHA" },
      { rotulo: "Coxão Duro", txt: "CARNE BOVINA COXAO DURO" },
      { rotulo: "Lagarto", txt: "CARNE BOVINA LAGARTO" },
    ],
  },
  {
    arquivo: "2.png",
    titulo: "Bovinos",
    linhas: [
      { rotulo: "Patinho", txt: "CARNE BOVINA PATINHO" },
      { rotulo: "Paloma", txt: "CARNE BOVINA PALOMA" },
      { rotulo: "Lombão", txt: "CARNE BOVINA LOMBAO" },
      { rotulo: "Peixinho", txt: "CARNE BOVINA PEIXINHO" },
      { rotulo: "Capa Contra Filé", txt: "CARNE BOVINA CAPA CONTR FILE" },
      { rotulo: "Peito", txt: "CARNE BOVINA PEITO" },
      { rotulo: "Açém", txt: "CARNE BOVINA ACEM" },
      { rotulo: "Paleta", txt: "CARNE BOVINA PALETA" },
      { rotulo: "Almôndega", txt: "ALMONDEGAS BOVINA" },
      { rotulo: "Músculo", txt: "CARNE BOVINA MUSCULO" },
    ],
  },
  {
    arquivo: "3.png",
    titulo: "Bovinos",
    linhas: [
      { rotulo: "Rabada", txt: "CARNE BOVINA RABADA" },
      { rotulo: "Costela Gaúcha", txt: "CARNE BOVINA COSTELA GAUCHA" },
      { rotulo: "Chambari", txt: "CARNE BOVINA CHAMBARI" },
      { rotulo: "Costela P.A.", txt: "COSTELA BOVINA P.A" },
      { rotulo: "Bucho", txt: "BUCHO BOVINO" },
      { rotulo: "Açém c/ Osso", txt: "ACEM BOVINO COM OSSO" },
      { rotulo: "Fígado", txt: "FIGADO BOVINO" },
      { rotulo: "Mocotó", txt: "MOCOTO BOVINO" },
      { rotulo: "Carne Temperada", txt: "CARNE BOVINA TEMPERADA" },
      { rotulo: "Carne de Sol", txt: "CARNE DE SOL BOVINA" },
    ],
  },
  {
    arquivo: "4.png",
    titulo: "Suínos",
    linhas: [
      { rotulo: "Costelinha", txt: "COSTELINHA SUINA" },
      { rotulo: "Lombo Suíno", txt: "LOMBO SUINO" },
      { rotulo: "Panceta", txt: "PANCETA SUINA" },
      { rotulo: "Pernil S/ Osso", txt: "PERNIL SEM OSSO SUINO" },
      { rotulo: "Pernil C/ Osso", txt: "PERNIL SUINO COM OSSO" },
      { rotulo: "Toucinho", txt: "TOUCINHO SUINO" },
      { rotulo: "Pé e Orelha", txt: "PE E ORELHA SUINA" },
      { rotulo: "Suan", txt: "SUAN SUINA" },
      { rotulo: "Almôndega Suína", txt: "ALMONDEGA SUINA" },
      { rotulo: "Bacon", txt: "BACON SUINO" },
    ],
  },
  {
    arquivo: "5.png",
    titulo: "Linguiças",
    linhas: [
      { rotulo: "Linguiça Porco Fina", txt: "LINGUICA PORCO FINA" },
      { rotulo: "Linguiça de Frango Fina", txt: "LINGUICA DE FRANGO FINA" },
      { rotulo: "Linguiça Caseira Porco", txt: "LINGUICA CASEIRA PORCO" },
      { rotulo: "Linguiça Caseira Porco Apimentada", txt: "LINGUICA CASEIRA PORCO APIMENTADA" },
      { rotulo: "Linguiça Suína Fina Apimentada", txt: "LINGUICA SUINA FINA APIMENTADA" },
      { rotulo: "Linguiça Cost./Queijo/Mandioca", txt: "LINGUICA COST/ QUEIJO/MANDIOCA" },
      { rotulo: "Linguiça Toscana Sadia/Perdigão", txt: "LINGUICA TOSCANA SADIA PERDIGAO" },
      { rotulo: "Linguiça Pernil Perdigão", txt: "LINGUICA PERNIL PERDIGAO KG" },
      { rotulo: "Linguiça Calabresa Grossa e Fina", txt: "LINGUICA CALABRESA GROSSA E FINA" },
      { rotulo: "Linguiça Porco Seca", txt: "LINGUICA PORCO SECA" },
    ],
  },
  {
    arquivo: "6.png",
    titulo: "Linguiças",
    // Mesmas 10 linhas do 5.png — só a foto de fundo é diferente (o usuário
    // fez duas artes de Linguiças). O preço é o mesmo corte, então usa o
    // mesmo mapeamento.
    linhas: [
      { rotulo: "Linguiça Porco Fina", txt: "LINGUICA PORCO FINA" },
      { rotulo: "Linguiça de Frango Fina", txt: "LINGUICA DE FRANGO FINA" },
      { rotulo: "Linguiça Caseira Porco", txt: "LINGUICA CASEIRA PORCO" },
      { rotulo: "Linguiça Caseira Porco Apimentada", txt: "LINGUICA CASEIRA PORCO APIMENTADA" },
      { rotulo: "Linguiça Suína Fina Apimentada", txt: "LINGUICA SUINA FINA APIMENTADA" },
      { rotulo: "Linguiça Cost./Queijo/Mandioca", txt: "LINGUICA COST/ QUEIJO/MANDIOCA" },
      { rotulo: "Linguiça Toscana Sadia/Perdigão", txt: "LINGUICA TOSCANA SADIA PERDIGAO" },
      { rotulo: "Linguiça Pernil Perdigão", txt: "LINGUICA PERNIL PERDIGAO KG" },
      { rotulo: "Linguiça Calabresa Grossa e Fina", txt: "LINGUICA CALABRESA GROSSA E FINA" },
      { rotulo: "Linguiça Porco Seca", txt: "LINGUICA PORCO SECA" },
    ],
  },
  {
    arquivo: "7.png",
    titulo: "Aves",
    linhas: [
      { rotulo: "Meio da Asa", txt: "MEIO DA ASA" },
      { rotulo: "Meio da Asa Temperada", txt: "MEIO DA ASA TEMPERADA" },
      { rotulo: "Coxinha Asa Temperada", txt: "COXINHA DA ASA TEMPERADA" },
      { rotulo: "Filé de Frango", txt: "FILE DE FRANGO" },
      { rotulo: "Coxinha Asa", txt: "COXINHA DA ASA" },
      { rotulo: "Asa Frango", txt: "ASA DE FRANGO" },
      { rotulo: "Peito c/ Osso", txt: "PEITO DE FRANGO COM OSSO" },
      { rotulo: "Coxa/Sobrecoxa", txt: "COXA SOBRE COXA FRANGO" },
      { rotulo: "Pé de Frango", txt: "PE E PESCOSSO DE FRANGO" },
      { rotulo: "Frango", txt: "FRANGO" },
    ],
  },
];

// ---------- 3) Geometria de cada tabela-base ----------
// Medida por varredura de pixel nas 7 imagens reais (ver relatório do
// projeto) — onde termina a coluna do nome / começa a célula de preço, onde
// termina a célula de preço / começa a foto, e a faixa vertical de cada uma
// das 10 linhas. Todas as 7 imagens têm 2245x1587px.
const GEOMETRIA_TABELAS = {
  "1.png": {
    precoEsquerda: 1031, precoDireita: 1281,
    linhas: [[211, 341], [347, 477], [483, 613], [619, 749], [755, 885], [891, 1021], [1027, 1157], [1163, 1293], [1299, 1429], [1435, 1565]],
  },
  "2.png": {
    precoEsquerda: 1043, precoDireita: 1296,
    linhas: [[213, 345], [351, 483], [489, 621], [626, 758], [764, 896], [902, 1034], [1039, 1171], [1177, 1309], [1315, 1447], [1452, 1584]],
  },
  "3.png": {
    precoEsquerda: 1041, precoDireita: 1294,
    linhas: [[213, 345], [350, 482], [488, 619], [625, 757], [763, 894], [900, 1032], [1037, 1169], [1175, 1306], [1312, 1444], [1450, 1581]],
  },
  "4.png": {
    precoEsquerda: 1043, precoDireita: 1296,
    linhas: [[213, 345], [351, 483], [489, 621], [626, 758], [764, 896], [902, 1034], [1039, 1171], [1177, 1309], [1315, 1447], [1452, 1584]],
  },
  "5.png": {
    precoEsquerda: 1041, precoDireita: 1294,
    linhas: [[213, 345], [350, 482], [488, 619], [625, 757], [763, 894], [900, 1032], [1037, 1169], [1175, 1306], [1312, 1444], [1450, 1581]],
  },
  "6.png": {
    precoEsquerda: 1041, precoDireita: 1294,
    linhas: [[213, 345], [350, 482], [488, 619], [625, 757], [763, 894], [900, 1032], [1037, 1169], [1175, 1306], [1312, 1444], [1450, 1581]],
  },
  "7.png": {
    precoEsquerda: 1041, precoDireita: 1294,
    linhas: [[213, 345], [350, 482], [488, 619], [625, 757], [763, 894], [900, 1032], [1037, 1169], [1175, 1306], [1312, 1444], [1450, 1581]],
  },
};
const LARGURA_IMAGEM = 2245;
const ALTURA_IMAGEM = 1587;

// ---------- Preenchimento de tela cheia (16:9) ----------
// As 7 artes do usuário saem do Canva em 2245x1587 (proporção ~1.41:1) —
// mais "quadradas" que a tela de uma TV (quase sempre 16:9, ~1.78:1). Exibida
// do jeito que veio, sobra tarja preta nas laterais. Em vez de recortar a
// tabela (perderia linha) ou esticar a imagem inteira (deformaria o texto),
// só a FOTO do lado direito é ampliada/recortada (não esticada — mantém a
// proporção da foto) até fechar exatamente 16:9. A coluna de nome+preço
// permanece pixel a pixel igual à arte original, incluindo a posição de cada
// preço — por isso a geometria em GEOMETRIA_TABELAS não precisa mudar.
const RAZAO_TELA_TV = 16 / 9;
const LARGURA_SAIDA = Math.round(ALTURA_IMAGEM * RAZAO_TELA_TV); // 2822

// Monta a base "tela cheia" de um template: recorta a coluna de nome+preço
// exatamente como está na arte original e recorta/amplia (sharp fit:"cover",
// sem deformar) a foto do lado direito até preencher a largura que falta
// pra fechar LARGURA_SAIDA. Devolve um Buffer PNG pronto pra receber o SVG
// dos preços por cima.
async function montarBaseTelaCheia(template) {
  const geo = GEOMETRIA_TABELAS[template.arquivo];
  const base = path.join(ASSETS_DIR, template.arquivo);
  const larguraFotoAtual = LARGURA_IMAGEM - geo.precoDireita;
  const larguraFotoNova = LARGURA_SAIDA - geo.precoDireita;

  const [colunaTabela, foto] = await Promise.all([
    sharp(base).extract({ left: 0, top: 0, width: geo.precoDireita, height: ALTURA_IMAGEM }).toBuffer(),
    sharp(base)
      .extract({ left: geo.precoDireita, top: 0, width: larguraFotoAtual, height: ALTURA_IMAGEM })
      .resize(larguraFotoNova, ALTURA_IMAGEM, { fit: "cover", position: "centre" })
      .toBuffer(),
  ]);

  return sharp({
    create: { width: LARGURA_SAIDA, height: ALTURA_IMAGEM, channels: 3, background: "#0a0a0a" },
  })
    .composite([
      { input: colunaTabela, left: 0, top: 0 },
      { input: foto, left: geo.precoDireita, top: 0 },
    ])
    .png()
    .toBuffer();
}

// ---------- Medidas da fonte (DejaVu Sans Bold), pra centralizar e caber o
// preço na célula sem precisar de nenhuma lib de texto em tempo de execução
// (extraídas uma vez com fonttools — ver unidades de fonte / unitsPerEm). ----------
const UNITS_PER_EM = 2048;
const GLYPHS = {
  "0": { av: 1425, yMin: -29, yMax: 1520 }, "1": { av: 1425, yMin: 0, yMax: 1493 },
  "2": { av: 1425, yMin: 0, yMax: 1520 }, "3": { av: 1425, yMin: -29, yMax: 1520 },
  "4": { av: 1425, yMin: 0, yMax: 1493 }, "5": { av: 1425, yMin: -29, yMax: 1493 },
  "6": { av: 1425, yMin: -29, yMax: 1518 }, "7": { av: 1425, yMin: 0, yMax: 1493 },
  "8": { av: 1425, yMin: -29, yMax: 1520 }, "9": { av: 1425, yMin: -29, yMax: 1518 },
  "R": { av: 1577, yMin: 0, yMax: 1493 }, "$": { av: 1425, yMin: -301, yMax: 1556 },
  ",": { av: 778, yMin: -291, yMax: 387 }, " ": { av: 713, yMin: 0, yMax: 0 },
};
const GLYPH_PADRAO = { av: 1425, yMin: -29, yMax: 1520 };

function medirTexto(texto) {
  let largura = 0, yMin = Infinity, yMax = -Infinity;
  for (const ch of texto) {
    const g = GLYPHS[ch] || GLYPH_PADRAO;
    largura += g.av;
    if (g.av > 0 || ch !== " ") { yMin = Math.min(yMin, g.yMin); yMax = Math.max(yMax, g.yMax); }
  }
  if (yMin === Infinity) { yMin = 0; yMax = 0; }
  return { largura, yMin, yMax };
}

// Formata em Real sem símbolo de milhar (preço de balança nunca passa de
// R$99,99, não precisa) — ex.: 29.9 -> "R$29,90".
function formatarPreco(valor) {
  const centavos = Math.round(valor * 100);
  const inteiro = Math.floor(centavos / 100);
  const cents = String(centavos % 100).padStart(2, "0");
  return `R$${inteiro},${cents}`;
}

const FONTE_MAXIMA = 92;
const FONTE_MINIMA = 30;
const PADDING_CELULA = 18;
const COR_TEXTO = "#151208";

// Monta o <text> (dentro de um <tspan> já posicionado) de uma linha,
// encolhendo a fonte até caber na largura disponível da célula de preço.
function montarTextoPreco(preco, celulaEsquerda, celulaDireita, faixaY) {
  const texto = formatarPreco(preco);
  const larguraDisponivel = (celulaDireita - celulaEsquerda) - PADDING_CELULA * 2;
  const centroX = (celulaEsquerda + celulaDireita) / 2;
  const centroY = (faixaY[0] + faixaY[1]) / 2;

  let fonte = FONTE_MAXIMA;
  let medida = medirTexto(texto);
  while (fonte > FONTE_MINIMA && (medida.largura / UNITS_PER_EM) * fonte > larguraDisponivel) {
    fonte -= 2;
  }
  const escala = fonte / UNITS_PER_EM;
  const baselineY = centroY + ((medida.yMax + medida.yMin) / 2) * escala;

  return `<text x="${centroX.toFixed(1)}" y="${baselineY.toFixed(1)}" font-family="${FONT_FAMILY}" font-size="${fonte}" font-weight="bold" fill="${COR_TEXTO}" text-anchor="middle">${escaparXml(texto)}</text>`;
}

function escaparXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Gera o SVG (tamanho igual à imagem-base) com todos os preços de uma tabela,
// pronto pra ser composto por cima do PNG original.
function montarSvgTabela(template, precosPorLinha) {
  const geo = GEOMETRIA_TABELAS[template.arquivo];
  const textos = template.linhas.map((linha, i) => {
    const preco = precosPorLinha[i];
    if (preco == null) return ""; // sem preço encontrado: célula fica em branco
    return montarTextoPreco(preco, geo.precoEsquerda, geo.precoDireita, geo.linhas[i]);
  }).join("\n");

  return `<svg width="${LARGURA_SAIDA}" height="${ALTURA_IMAGEM}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      @font-face {
        font-family: '${FONT_FAMILY}';
        src: url(data:font/truetype;charset=utf-8;base64,${FONT_BASE64}) format('truetype');
        font-weight: bold;
      }
    </style>
  </defs>
  ${textos}
</svg>`;
}

// Pra cada uma das 10 linhas do template, busca o preço no índice (pelo
// nome-no-txt já mapeado) — devolve um array paralelo a template.linhas
// (preço numérico, ou null quando não achou esse item no txt enviado).
function precosDoTemplate(template, indicePrecos) {
  return template.linhas.map((linha) => {
    const chave = normalizarNome(linha.txt);
    const preco = indicePrecos.get(chave);
    return preco === undefined ? null : preco;
  });
}

// Gera as 7 imagens finais (Buffer JPEG) a partir do conteúdo do .txt.
// Devolve { imagens: [{arquivo, nomeSaida, titulo, buffer, faltando}],
//           itensNaoEncontrados: Set<string> } — faltando/itensNaoEncontrados
// existem só pra log/aviso, nunca derrubam a geração (célula sem preço fica
// em branco em vez de quebrar a tabela inteira).
async function gerarTabelasDePrecos(conteudoTxt) {
  const itens = parseTxt(conteudoTxt);
  const indice = construirIndicePrecos(itens);

  const imagens = [];
  const itensNaoEncontrados = new Set();

  for (const template of TEMPLATES) {
    const precos = precosDoTemplate(template, indice);
    template.linhas.forEach((linha, i) => {
      if (precos[i] == null) itensNaoEncontrados.add(`${template.arquivo} — ${linha.rotulo} (esperado no txt: "${linha.txt}")`);
    });

    const svg = montarSvgTabela(template, precos);
    const baseTelaCheia = await montarBaseTelaCheia(template);
    const buffer = await sharp(baseTelaCheia)
      .composite([{ input: Buffer.from(svg) }])
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();

    imagens.push({
      arquivo: template.arquivo,
      nomeSaida: NOMES_SAIDA[template.arquivo],
      titulo: template.titulo,
      buffer,
      faltando: precos.filter((p) => p == null).length,
    });
  }

  return { imagens, itensNaoEncontrados, totalItensTxt: itens.length };
}

// Nome de arquivo FIXO por template — de propósito, pra cada novo .txt
// enviado SOBRESCREVER a imagem anterior em vez de acumular lixo no
// armazenamento. Como o nome não muda, quem já colocou essas 7 imagens numa
// playlist não precisa mexer em mais nada: a mesma playlist passa a mostrar
// os preços novos assim que a TV recarregar a imagem.
const NOMES_SAIDA = {
  "1.png": "tabela-precos-bovinos-1.jpg",
  "2.png": "tabela-precos-bovinos-2.jpg",
  "3.png": "tabela-precos-bovinos-3.jpg",
  "4.png": "tabela-precos-suinos.jpg",
  "5.png": "tabela-precos-linguicas-1.jpg",
  "6.png": "tabela-precos-linguicas-2.jpg",
  "7.png": "tabela-precos-aves.jpg",
};

module.exports = {
  parseTxt,
  normalizarNome,
  construirIndicePrecos,
  formatarPreco,
  gerarTabelasDePrecos,
  TEMPLATES,
  NOMES_SAIDA,
};
