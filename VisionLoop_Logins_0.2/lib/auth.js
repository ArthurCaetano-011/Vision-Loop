// lib/auth.js
// Funções puras de autenticação: conferir senha, gerar/validar sessão,
// checar licença. Reaproveitado pelas rotas HTTP (/login, /logout, /me e,
// nas próximas fases, o painel do ADM) e pelo handshake do WebSocket
// (validação da conexão do controlador).
//
// Modelo de sessão: 1 sessão ativa por conta (decisão do planejamento). O
// token e a validade ficam direto nas colunas `sessao_token` /
// `sessao_expira_em` da própria conta — não existe tabela de sessões à
// parte. Logar de novo sobrescreve o token antigo, que passa a não bater
// mais com nenhum cookie válido (o dispositivo anterior é deslogado na
// próxima ação que fizer).

const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { pool } = require("./db");

const SESSION_COOKIE_NAME = "vl_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

// ---------- Cookies ----------
// Implementado na mão (sem dependência extra tipo "cookie" ou "cookie-parser")
// porque o servidor já é http puro, sem framework.

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) {
      try { cookies[key] = decodeURIComponent(val); }
      catch { cookies[key] = val; }
    }
  });
  return cookies;
}

// Só adiciona o atributo "Secure" quando a requisição chegou por HTTPS —
// direto (raro em produção atrás de proxy) ou via "x-forwarded-proto" (é
// assim que o proxy do Render informa isso ao Node). Sem essa checagem, um
// teste local em http://localhost nunca conseguiria guardar o cookie,
// porque navegadores ignoram "Secure" fora de HTTPS.
function isHttps(req) {
  return req.headers["x-forwarded-proto"] === "https" || !!(req.socket && req.socket.encrypted);
}

function buildSessionCookie(req, token, expiresAt) {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (isHttps(req)) attrs.push("Secure");
  return attrs.join("; ");
}

function buildClearCookie(req) {
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (isHttps(req)) attrs.push("Secure");
  return attrs.join("; ");
}

// ---------- Licença ----------

// ADM não tem validade de licença (licenca_expira_em fica null pra ele).
// Conta cliente com licença vencida, ou suspensa manualmente (ativa=false),
// não consegue logar nem manter uma sessão já aberta.
function licencaValida(conta) {
  if (!conta.ativa) return false;
  if (conta.role === "adm") return true;
  if (!conta.licenca_expira_em) return false;
  return new Date(conta.licenca_expira_em).getTime() > Date.now();
}

// ---------- Login / logout ----------

async function autenticar(nomeNegocio, senha) {
  const nomeNormalizado = String(nomeNegocio || "").trim();
  if (!nomeNormalizado || !senha) {
    return { erro: "Informe o nome da empresa e a senha." };
  }
  // Comparação sem diferenciar maiúsculas/minúsculas — nome de empresa não
  // tem a mesma convenção de "sempre minúsculo" que e-mail tem, então seria
  // fácil digitar com uma letra maiúscula diferente e a conta não bater.
  const { rows } = await pool.query("SELECT * FROM contas WHERE LOWER(nome_negocio) = LOWER($1)", [nomeNormalizado]);
  const conta = rows[0];
  // Mesma mensagem genérica pros dois casos (nome não existe / senha
  // errada) — não dar pista de qual dos dois estava errado.
  if (!conta) return { erro: "Nome da empresa ou senha inválidos." };

  const senhaOk = await bcrypt.compare(String(senha), conta.senha_hash);
  if (!senhaOk) return { erro: "Nome da empresa ou senha inválidos." };

  if (!conta.ativa) return { erro: "Conta suspensa. Entre em contato com o suporte." };
  if (!licencaValida(conta)) return { erro: "Licença expirada. Entre em contato com o suporte." };

  return { conta };
}

async function criarSessao(contaId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    "UPDATE contas SET sessao_token = $1, sessao_expira_em = $2 WHERE id = $3",
    [token, expiresAt, contaId]
  );
  return { token, expiresAt };
}

async function encerrarSessao(contaId) {
  await pool.query(
    "UPDATE contas SET sessao_token = NULL, sessao_expira_em = NULL WHERE id = $1",
    [contaId]
  );
}

// ---------- Validação de sessão ----------

async function contaPorToken(token) {
  if (!token) return null;
  const { rows } = await pool.query("SELECT * FROM contas WHERE sessao_token = $1", [token]);
  const conta = rows[0];
  if (!conta) return null;
  if (!conta.sessao_expira_em || new Date(conta.sessao_expira_em).getTime() < Date.now()) return null;
  // Uma licença vencida (ou conta suspensa) depois do login também derruba
  // a sessão já aberta — não só bloqueia logins novos. Trata os dois casos
  // com a mesma regra (licencaValida), pra não ter duas fontes de verdade.
  if (!licencaValida(conta)) return null;
  return conta;
}

// Função central reaproveitada por toda rota HTTP protegida e pelo
// handshake do WebSocket: lê o cookie da requisição, valida contra o banco,
// devolve a conta logada ou null.
async function contaDaRequisicao(req) {
  const cookies = parseCookies(req);
  return contaPorToken(cookies[SESSION_COOKIE_NAME]);
}

module.exports = {
  SESSION_COOKIE_NAME,
  parseCookies,
  buildSessionCookie,
  buildClearCookie,
  licencaValida,
  autenticar,
  criarSessao,
  encerrarSessao,
  contaPorToken,
  contaDaRequisicao,
};
