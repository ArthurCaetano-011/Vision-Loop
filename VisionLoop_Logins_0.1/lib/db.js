// lib/db.js
// Pool de conexão com o Postgres (Neon), reaproveitável pelo resto do
// servidor (lib/auth.js, rotas de login/logout/me etc.).
//
// Depende da variável de ambiente DATABASE_URL — a connection string que o
// Neon mostra na tela "Connect to your database", colada nas variáveis de
// ambiente do serviço no Render.

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error(
    "[db] DATABASE_URL não está definida — configure essa variável de ambiente " +
      "no Render (Environment → Add Environment Variable) com a connection " +
      "string do Neon antes de subir o servidor. Login e tudo que depende do " +
      "banco vão falhar até isso ser configurado."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // O Neon (e o Postgres do Render) exigem SSL; rejectUnauthorized: false
  // evita erro de certificado autoassinado sem desabilitar a criptografia.
  ssl: { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  // Erro em conexão ociosa do pool (ex.: o Neon derrubou uma conexão
  // parada) — não deve derrubar o servidor inteiro.
  console.error("[db] erro inesperado no pool de conexões Postgres:", err);
});

module.exports = { pool };
