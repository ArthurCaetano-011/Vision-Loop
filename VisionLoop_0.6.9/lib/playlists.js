// lib/playlists.js
// Playlists no banco, isoladas por conta (Fase 4 do roteiro de login).
// Antes desta fase, viviam só num arquivo (playlists.json) no disco do
// Render — que é EFÊMERO (some a cada deploy/reinício) e era compartilhado
// entre todo mundo logado, sem dono nenhum. Agora cada playlist pertence a
// uma conta específica e sobrevive a qualquer deploy.

const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

const PLAYLISTS_FILE = path.join(__dirname, "..", "playlists.json");
const PLAYLISTS_FILE_MIGRADO = path.join(__dirname, "..", "playlists.json.migrado");

async function listar(contaId, isAdmin) {
  const { rows } = isAdmin
    ? await pool.query("SELECT * FROM playlists ORDER BY atualizado_em DESC")
    : await pool.query("SELECT * FROM playlists WHERE conta_id = $1 ORDER BY atualizado_em DESC", [contaId]);
  return rows;
}

async function buscarPorId(id) {
  const { rows } = await pool.query("SELECT * FROM playlists WHERE id = $1", [id]);
  return rows[0] || null;
}

async function criar(contaId, nome, itens) {
  const { rows } = await pool.query(
    "INSERT INTO playlists (conta_id, nome, itens) VALUES ($1, $2, $3) RETURNING *",
    [contaId, nome, JSON.stringify(itens)]
  );
  return rows[0];
}

async function atualizar(id, nome, itens) {
  const { rows } = await pool.query(
    "UPDATE playlists SET nome = $1, itens = $2, atualizado_em = now() WHERE id = $3 RETURNING *",
    [nome, JSON.stringify(itens), id]
  );
  return rows[0] || null;
}

async function excluir(id) {
  const { rowCount } = await pool.query("DELETE FROM playlists WHERE id = $1", [id]);
  return rowCount > 0;
}

// Remove referências a um arquivo excluído de TODAS as playlists (de
// qualquer conta — um ADM pode ter montado uma playlist com mídia de
// contas diferentes, já que ele vê a biblioteca de todo mundo). Sem isso, a
// playlist ficaria "quebrada", tentando tocar pra sempre algo que não
// existe mais. Playlist que fica sem nenhum item depois da remoção é
// mantida vazia (playlist vazia é um estado válido desde a 0.6.6).
// Devolve as playlists que REALMENTE mudaram, já no formato de linha do
// banco — quem chama usa isso pra avisar na hora as TVs que estiverem
// exibindo alguma delas (ver propagarPlaylistAtualizada em server.js).
async function removerArquivoDeTodas(nomeArquivo) {
  const { rows } = await pool.query("SELECT id, itens FROM playlists");
  const alteradas = [];
  for (const row of rows) {
    const itensOriginais = Array.isArray(row.itens) ? row.itens : [];
    const itensFiltrados = itensOriginais.filter((item) => {
      const itemName = typeof item === "string" ? item : (item && item.name);
      return itemName !== nomeArquivo;
    });
    if (itensFiltrados.length === itensOriginais.length) continue;
    // A playlist que fica sem itens NÃO é mais apagada: playlist vazia virou
    // um estado válido (dá pra criar só com o nome e preencher depois), então
    // sumir com ela sozinha por causa de uma exclusão de arquivo seria perder
    // o trabalho do usuário sem ele pedir. Ela fica lá, vazia, pronta pra
    // receber conteúdo novo.
    const { rows: atualizadas } = await pool.query(
      "UPDATE playlists SET itens = $1, atualizado_em = now() WHERE id = $2 RETURNING *",
      [JSON.stringify(itensFiltrados), row.id]
    );
    if (atualizadas[0]) alteradas.push(atualizadas[0]);
  }
  return alteradas;
}

// Migração de uma vez só: se o playlists.json antigo ainda existir (só
// sobrevive se nenhum deploy/reinício aconteceu entre a Fase 3 e esta) e a
// tabela `playlists` estiver vazia, importa cada entrada pra dentro do
// banco, atribuída à conta ADM mais antiga (mesma regra da mídia órfã, ver
// lib/midia.js). Depois disso, renomeia o arquivo pra "playlists.json.migrado"
// — só como registro, ele deixa de ser lido pelo servidor a partir daqui.
// Chamado uma vez no boot do servidor (server.js), não bloqueia o startup.
async function migrarDeArquivoSeNecessario(admIdPadrao) {
  if (!admIdPadrao) return;
  if (!fs.existsSync(PLAYLISTS_FILE)) return;

  let dados;
  try {
    dados = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, "utf8"));
  } catch (err) {
    console.error("playlists.json existe mas não é um JSON válido — pulando migração:", err);
    return;
  }

  const entradas = Object.values(dados || {});
  if (!entradas.length) {
    // Arquivo vazio ({}) — nada pra migrar, mas ainda vale marcar como
    // tratado pra não ficar checando de novo a cada boot.
    try { fs.renameSync(PLAYLISTS_FILE, PLAYLISTS_FILE_MIGRADO); } catch {}
    return;
  }

  const { rows } = await pool.query("SELECT COUNT(*)::int AS total FROM playlists");
  if (rows[0].total > 0) {
    // Já existe algo no banco — provavelmente uma migração anterior já
    // rodou (ou alguém já criou playlists direto pela 0.5). Não migra de
    // novo pra não duplicar; só arquiva o arquivo antigo.
    try { fs.renameSync(PLAYLISTS_FILE, PLAYLISTS_FILE_MIGRADO); } catch {}
    return;
  }

  let migradas = 0;
  for (const pl of entradas) {
    if (!pl || !pl.name || !Array.isArray(pl.videos) || !pl.videos.length) continue;
    try {
      await criar(admIdPadrao, pl.name, pl.videos);
      migradas++;
    } catch (err) {
      console.error("Erro ao migrar playlist do playlists.json antigo:", pl.name, err);
    }
  }
  console.log(`[playlists] Migração do playlists.json antigo: ${migradas} playlist(s) movida(s) pro banco (conta ADM).`);
  try { fs.renameSync(PLAYLISTS_FILE, PLAYLISTS_FILE_MIGRADO); } catch (err) {
    console.error("Não consegui renomear playlists.json depois de migrar (não é crítico):", err);
  }
}

module.exports = { listar, buscarPorId, criar, atualizar, excluir, removerArquivoDeTodas, migrarDeArquivoSeNecessario };
