// lib/midia.js
// Índice de POSSE dos vídeos/imagens (Fase 4 do roteiro de login).
//
// IMPORTANTE: este módulo NÃO guarda os arquivos em si — o armazenamento
// físico continua exatamente como sempre foi (disco local do Render, ou
// bucket R2). Esta tabela é só um mapa "esse nome de arquivo pertence a
// essa conta" por cima do que já existe fisicamente, permitindo que cada
// conta veja só a própria biblioteca sem precisar reorganizar pastas/bucket.

const { pool } = require("./db");

// ---------- Tolerância à migração 0.6.9 ainda não rodada ----------
// A coluna `midia.expira_em` guarda o prazo de validade. Ela já existe no
// banco em uso (foi adicionada na 0.6.9) e no `schema-contas.sql`, usado pra
// montar um banco do zero. Se por algum motivo ela faltar — um banco novo
// criado por um schema antigo, por exemplo — o Postgres devolve o erro 42703
// ("column does not exist"), e sem este cuidado esse erro derrubava a
// LISTAGEM da biblioteca e, no modo R2, o próprio upload.
//
// Com o cuidado abaixo, o app segue funcionando (todo arquivo sem prazo) e
// volta a honrar a validade sozinho em até um minuto depois que a coluna
// aparecer — sem precisar reiniciar o servidor.
const COLUNA_AUSENTE = "42703";
const REPETIR_CHECAGEM_MS = 60 * 1000;
let semColunaDesde = 0;

function colunaIndisponivel() {
  return semColunaDesde > 0 && Date.now() - semColunaDesde < REPETIR_CHECAGEM_MS;
}

function marcarColunaAusente(err) {
  if (!err || err.code !== COLUNA_AUSENTE) return false;
  const primeiraVez = semColunaDesde === 0;
  semColunaDesde = Date.now();
  if (primeiraVez) {
    console.error(
      "\n⚠️  A coluna midia.expira_em não existe neste banco.\n" +
      "   O prazo de validade dos arquivos fica DESLIGADO até ela ser criada.\n" +
      "   Para criar, rode no SQL Editor do Neon:\n" +
      "     ALTER TABLE midia ADD COLUMN IF NOT EXISTS expira_em TIMESTAMPTZ;\n" +
      "   O resto do app (upload, biblioteca, playlists, TVs) continua normal.\n"
    );
  }
  return true;
}

// Usado pelo servidor pra avisar o painel que a opção de prazo não vale agora.
function validadeDisponivel() {
  return !colunaIndisponivel();
}

// Devolve um Map<nome_arquivo, conta_id> com TODO mundo que já tem dono
// registrado — usado pra filtrar a listagem física (disco/R2) por conta.
async function donosPorArquivo() {
  const { rows } = await pool.query("SELECT nome_arquivo, conta_id FROM midia");
  const mapa = new Map();
  rows.forEach((r) => mapa.set(r.nome_arquivo, r.conta_id));
  return mapa;
}

// Auto-adoção: qualquer nome de arquivo que exista FISICAMENTE (a lista
// vem de quem chamou, olhando o disco/bucket de verdade) mas ainda não
// tenha uma linha em `midia` passa a pertencer à `contaPadraoId` (a conta
// ADM mais antiga, decidida em server.js). Sem isso, todo vídeo/imagem de
// antes da Fase 4 ficaria invisível pra sempre (sem dono, filtrado de toda
// listagem) até alguém arrumar isso na mão — aqui ele se resolve sozinho na
// primeira vez que a aba Vídeos for aberta depois do deploy.
async function garantirDonos(nomesArquivos, contaPadraoId) {
  if (!contaPadraoId || !nomesArquivos.length) return;
  const existentes = await donosPorArquivo();
  const semDono = nomesArquivos.filter((n) => !existentes.has(n));
  for (const nome of semDono) {
    try {
      await pool.query(
        "INSERT INTO midia (conta_id, nome_arquivo) VALUES ($1, $2) ON CONFLICT (nome_arquivo) DO NOTHING",
        [contaPadraoId, nome]
      );
    } catch (err) {
      // Não deixa uma falha isolada (ex.: corrida entre duas requisições
      // simultâneas) derrubar a listagem inteira — o arquivo só fica sem
      // dono até a próxima tentativa.
      console.error("Erro ao adotar mídia órfã pra conta ADM:", nome, err);
    }
  }
}

// Chamado logo após um upload terminar (ou a URL assinada do R2 ser
// gerada) — grava/atualiza o dono do arquivo recém-criado.
//
// `expiraEm` (opcional, desde a 0.6.9) é a data/hora em que este arquivo deve
// sair do ar sozinho. `null` significa "sem validade": fica até alguém excluir
// à mão, que continua sendo o padrão.
async function registrarArquivo(nomeArquivo, contaId, expiraEm = null) {
  const semValidade = () => pool.query(
    "INSERT INTO midia (conta_id, nome_arquivo) VALUES ($1, $2) ON CONFLICT (nome_arquivo) DO UPDATE SET conta_id = EXCLUDED.conta_id",
    [contaId, nomeArquivo]
  );
  if (colunaIndisponivel()) { await semValidade(); return; }
  try {
    await pool.query(
      "INSERT INTO midia (conta_id, nome_arquivo, expira_em) VALUES ($1, $2, $3) ON CONFLICT (nome_arquivo) DO UPDATE SET conta_id = EXCLUDED.conta_id, expira_em = EXCLUDED.expira_em",
      [contaId, nomeArquivo, expiraEm]
    );
  } catch (err) {
    // Banco sem a coluna: registra o dono do jeito antigo pra o upload não
    // se perder. O arquivo fica sem prazo, e é isso que o painel avisa.
    if (!marcarColunaAusente(err)) throw err;
    await semValidade();
  }
}

// Validades registradas, pra desenhar o selo "⏳ vence em ..." na biblioteca.
// contaId null = todas as contas (visão do ADM). Arquivo sem validade não
// aparece aqui — a ausência é justamente o "sem prazo".
async function validadesPorArquivo(contaId) {
  if (colunaIndisponivel()) return new Map();
  try {
    const { rows } = contaId == null
      ? await pool.query("SELECT nome_arquivo, expira_em FROM midia WHERE expira_em IS NOT NULL")
      : await pool.query("SELECT nome_arquivo, expira_em FROM midia WHERE expira_em IS NOT NULL AND conta_id = $1", [contaId]);
    const mapa = new Map();
    rows.forEach((r) => mapa.set(r.nome_arquivo, r.expira_em));
    return mapa;
  } catch (err) {
    // Nenhuma validade conhecida é o mesmo que "ninguém tem prazo" — a
    // biblioteca lista tudo normalmente em vez de quebrar.
    if (!marcarColunaAusente(err)) throw err;
    return new Map();
  }
}

// Arquivos cujo prazo já passou. A comparação é feita pelo RELÓGIO DO BANCO
// (now()), não pelo do processo: o servidor pode reiniciar, mudar de máquina
// ou de fuso, e o vencimento continua valendo igual.
async function nomesVencidos() {
  if (colunaIndisponivel()) return [];
  try {
    const { rows } = await pool.query(
      "SELECT nome_arquivo FROM midia WHERE expira_em IS NOT NULL AND expira_em <= now()"
    );
    return rows.map((r) => r.nome_arquivo);
  } catch (err) {
    // Sem a coluna não há prazo nenhum registrado: nada a varrer.
    if (!marcarColunaAusente(err)) throw err;
    return [];
  }
}

async function donoDoArquivo(nomeArquivo) {
  const { rows } = await pool.query("SELECT conta_id FROM midia WHERE nome_arquivo = $1", [nomeArquivo]);
  return rows[0] ? rows[0].conta_id : null;
}

async function removerArquivo(nomeArquivo) {
  await pool.query("DELETE FROM midia WHERE nome_arquivo = $1", [nomeArquivo]);
}

module.exports = { donosPorArquivo, garantirDonos, registrarArquivo, validadesPorArquivo, nomesVencidos, validadeDisponivel, donoDoArquivo, removerArquivo };
