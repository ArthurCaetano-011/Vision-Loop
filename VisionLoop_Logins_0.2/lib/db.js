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

  // ---- Timeouts (ver relatório de riscos de travamento, 2026-08-10) ----
  // Sem isso, uma consulta que nunca volta (Neon lento/inacessível) prende a
  // requisição HTTP ou o handshake do WebSocket pra sempre, sem erro nenhum
  // pro usuário — é o pior cenário do relatório, e o mais barato de corrigir.
  max: 10,                        // teto de conexões simultâneas no pool
  idleTimeoutMillis: 30000,       // fecha conexão ociosa após 30s
  connectionTimeoutMillis: 8000,  // desiste de conseguir uma conexão do pool após 8s
  statement_timeout: 8000,        // o próprio Postgres mata a query após 8s (lado do servidor)
  query_timeout: 8000,            // e o driver também desiste após 8s (lado do cliente, redundante de propósito)
});

pool.on("error", (err) => {
  // Erro em conexão ociosa do pool (ex.: o Neon derrubou uma conexão
  // parada) — não deve derrubar o servidor inteiro.
  console.error("[db] erro inesperado no pool de conexões Postgres:", err);
});

module.exports = { pool };
