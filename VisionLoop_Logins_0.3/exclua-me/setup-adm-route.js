// exclua-me/setup-adm-route.js
//
// Handler da rota temporária POST /setup-adm, chamada pela página
// setup-adm.html (mesma pasta). Cria a 1ª conta ADM pela web, sem precisar
// de terminal — só funciona UMA VEZ, enquanto a tabela `contas` estiver
// vazia; depois disso qualquer tentativa é recusada.
//
// TUDO relacionado a essa configuração inicial fica dentro desta pasta
// "exclua-me/". Depois de criar sua conta e confirmar que o login funciona,
// apague a pasta inteira (este arquivo + setup-adm.html) — o server.js já
// está preparado pra isso (o require dela está protegido por try/catch, e
// se falhar a rota /setup-adm simplesmente some, sem quebrar o resto do
// site).

const bcrypt = require("bcrypt");
const { pool } = require("../lib/db");

async function existeAlgumaConta() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS total FROM contas");
  return rows[0].total > 0;
}

async function criarPrimeiraContaAdm(nomeNegocio, senha) {
  const nomeNormalizado = String(nomeNegocio || "").trim();
  if (!nomeNormalizado || !senha) {
    return { erro: "Informe o nome da empresa e a senha." };
  }
  if (String(senha).length < 6) {
    return { erro: "Use uma senha com pelo menos 6 caracteres." };
  }
  if (await existeAlgumaConta()) {
    return { erro: "Já existe uma conta cadastrada — essa configuração inicial só funciona uma vez, com o banco vazio." };
  }
  const hash = await bcrypt.hash(String(senha), 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO contas (role, nome_negocio, senha_hash, limite_tvs, limite_armazenamento_gb)
       VALUES ('adm', $1, $2, 999, 999)
       RETURNING id, nome_negocio`,
      [nomeNormalizado, hash]
    );
    return { conta: rows[0] };
  } catch (err) {
    if (err && err.code === "23505") {
      return { erro: "Já existe uma conta com esse nome." };
    }
    throw err;
  }
}

// Mesmo teto de tamanho aplicado às outras rotas JSON pequenas do projeto
// (ver server.js e o relatório de riscos de travamento, 2026-08-10) — essa
// rota é pública (qualquer um na internet alcança enquanto a pasta
// "exclua-me" existir), então também não pode acumular corpo sem limite.
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;

function handle(req, res) {
  let body = "";
  let tooLarge = false;
  req.on("data", (d) => {
    if (tooLarge) return;
    body += d;
    if (Buffer.byteLength(body) > MAX_JSON_BODY_BYTES) {
      tooLarge = true;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Requisição grande demais." }));
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (tooLarge) return;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "JSON inválido." }));
      return;
    }
    try {
      const resultado = await criarPrimeiraContaAdm(parsed.nomeNegocio, parsed.senha);
      if (resultado.erro) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: resultado.erro }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, nomeNegocio: resultado.conta.nome_negocio }));
    } catch (err) {
      console.error("Erro em /setup-adm:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro no servidor ao criar a conta. Tente de novo em instantes." }));
    }
  });
}

module.exports = { handle };
