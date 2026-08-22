// lib/contas.js
// CRUD de contas para o painel do ADM (Fase 2 do roteiro de login).
// Só é chamado por rotas já protegidas em server.js (requireAdmin) — este
// módulo não faz nenhuma checagem de permissão sozinho, assume que quem
// chamou já confirmou que é uma sessão ADM válida.

const bcrypt = require("bcrypt");
const { pool } = require("./db");

// Nunca inclui senha_hash, sessao_token nem sessao_expira_em nas respostas —
// mesmo sendo o próprio ADM olhando, não há motivo pra esses dados saírem
// do banco.
const COLUNAS_PUBLICAS =
  "id, role, nome_negocio, licenca_expira_em, licenca_permanente, limite_tvs, limite_armazenamento_gb, ativa, criado_em, criado_por";

// Versão com prefixo "c." — usada nas duas queries abaixo que fazem LEFT
// JOIN com "tvs" pra trazer, de brinde, quantas TVs cada conta já tem
// pareadas (Fase 3). Sem esse número junto, o painel Contas precisaria de
// uma segunda requisição só pra mostrar "3 de 5 TVs pareadas".
const COLUNAS_COM_ALIAS = COLUNAS_PUBLICAS.split(", ").map((c) => "c." + c).join(", ");
const JOIN_CONTAGEM_TVS = `
  LEFT JOIN (SELECT conta_id, COUNT(*)::int AS total FROM tvs GROUP BY conta_id) t
    ON t.conta_id = c.id
`;

async function listarContas() {
  const { rows } = await pool.query(
    `SELECT ${COLUNAS_COM_ALIAS}, COALESCE(t.total, 0) AS tvs_pareadas
     FROM contas c
     ${JOIN_CONTAGEM_TVS}
     ORDER BY c.criado_em DESC`
  );
  return rows;
}

async function buscarContaPorId(id) {
  const { rows } = await pool.query(
    `SELECT ${COLUNAS_COM_ALIAS}, COALESCE(t.total, 0) AS tvs_pareadas
     FROM contas c
     ${JOIN_CONTAGEM_TVS}
     WHERE c.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// Normaliza/valida os campos numéricos e de licença que create/update têm em
// comum. `atual` (opcional) fornece os valores de fallback numa edição —
// campos não enviados no PUT mantêm o valor que já estava salvo.
function normalizarCampos(input, atual) {
  const erros = [];

  let limiteTvs = atual ? atual.limite_tvs : 1;
  if (input.limiteTvs !== undefined && input.limiteTvs !== null && input.limiteTvs !== "") {
    const n = parseInt(input.limiteTvs, 10);
    if (!Number.isFinite(n) || n < 1) erros.push("Limite de TVs deve ser um número inteiro de pelo menos 1.");
    else limiteTvs = n;
  }

  let limiteGb = atual ? atual.limite_armazenamento_gb : 5;
  if (input.limiteArmazenamentoGb !== undefined && input.limiteArmazenamentoGb !== null && input.limiteArmazenamentoGb !== "") {
    const n = parseFloat(input.limiteArmazenamentoGb);
    if (!Number.isFinite(n) || n < 0) erros.push("Limite de armazenamento deve ser um número de 0 ou mais.");
    else limiteGb = n;
  }

  // licencaExpiraEm: string "AAAA-MM-DD" (ou vazio/null para "sem validade
  // definida" — contas cliente sem essa data ficam bloqueadas no login, por
  // regra já existente em lib/auth.js/licencaValida, A NÃO SER que
  // licencaPermanente esteja marcado). O valor da data fica guardado mesmo
  // quando licencaPermanente é true — assim, se o ADM desmarcar depois, a
  // data anterior continua lá em vez de sumir.
  let licenca = atual ? atual.licenca_expira_em : null;
  if (input.licencaExpiraEm !== undefined) {
    if (!input.licencaExpiraEm) {
      licenca = null;
    } else {
      const d = new Date(input.licencaExpiraEm);
      if (isNaN(d.getTime())) erros.push("Data de validade da licença inválida.");
      else licenca = d;
    }
  }

  const licencaPermanente = input.licencaPermanente !== undefined
    ? !!input.licencaPermanente
    : (atual ? atual.licenca_permanente : false);

  const roleValido = input.role === "adm" || input.role === "cliente";
  const role = roleValido ? input.role : (atual ? atual.role : "cliente");

  const ativa = input.ativa !== undefined ? !!input.ativa : (atual ? atual.ativa : true);

  return { erros, limiteTvs, limiteGb, licenca, licencaPermanente, role, ativa };
}

async function criarConta(input, criadoPorId) {
  const nomeNormalizado = String(input.nomeNegocio || "").trim();
  if (!nomeNormalizado) return { erro: "Informe o nome da empresa." };
  if (!input.senha || String(input.senha).length < 6) {
    return { erro: "A senha deve ter pelo menos 6 caracteres." };
  }

  const { erros, limiteTvs, limiteGb, licenca, licencaPermanente, role, ativa } = normalizarCampos(input, null);
  if (erros.length) return { erro: erros[0] };

  const hash = await bcrypt.hash(String(input.senha), 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO contas (role, nome_negocio, senha_hash, licenca_expira_em, licenca_permanente, limite_tvs, limite_armazenamento_gb, ativa, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUNAS_PUBLICAS}`,
      [role, nomeNormalizado, hash, licenca, licencaPermanente, limiteTvs, limiteGb, ativa, criadoPorId || null]
    );
    const conta = rows[0];
    conta.tvs_pareadas = 0; // conta recém-criada, ainda não pode ter TV pareada
    return { conta };
  } catch (err) {
    if (err && err.code === "23505") return { erro: "Já existe uma conta com esse nome." };
    throw err;
  }
}

async function atualizarConta(id, input) {
  const atual = await buscarContaPorId(id);
  if (!atual) return { erro: "Conta não encontrada." };

  const nomeNormalizado = input.nomeNegocio !== undefined ? String(input.nomeNegocio).trim() : atual.nome_negocio;
  if (!nomeNormalizado) return { erro: "Informe o nome da empresa." };

  const { erros, limiteTvs, limiteGb, licenca, licencaPermanente, role, ativa } = normalizarCampos(input, atual);
  if (erros.length) return { erro: erros[0] };

  let novoHash = null;
  if (input.senha) {
    if (String(input.senha).length < 6) return { erro: "A nova senha deve ter pelo menos 6 caracteres." };
    novoHash = await bcrypt.hash(String(input.senha), 10);
  }

  try {
    const { rows } = await pool.query(
      `UPDATE contas SET
         nome_negocio = $1,
         role = $2,
         limite_tvs = $3,
         limite_armazenamento_gb = $4,
         licenca_expira_em = $5,
         licenca_permanente = $6,
         ativa = $7,
         senha_hash = COALESCE($8, senha_hash)
       WHERE id = $9
       RETURNING ${COLUNAS_PUBLICAS}`,
      [nomeNormalizado, role, limiteTvs, limiteGb, licenca, licencaPermanente, ativa, novoHash, id]
    );
    if (!rows[0]) return { erro: "Conta não encontrada." };

    // Conta suspensa (ou rebaixada) perde a sessão aberta na hora — sem
    // isso, quem já estava logado continuaria controlando TVs até o cookie
    // expirar sozinho (até 30 dias).
    if (!ativa) {
      await pool.query(
        "UPDATE contas SET sessao_token = NULL, sessao_expira_em = NULL WHERE id = $1",
        [id]
      );
    }

    const conta = rows[0];
    conta.tvs_pareadas = atual.tvs_pareadas || 0; // editar a conta não muda quantas TVs ela tem pareadas
    return { conta };
  } catch (err) {
    if (err && err.code === "23505") return { erro: "Já existe uma conta com esse nome." };
    throw err;
  }
}

async function excluirConta(id) {
  const { rowCount } = await pool.query("DELETE FROM contas WHERE id = $1", [id]);
  return rowCount > 0;
}

// Usado pela Fase 4 (isolamento de mídia/playlists) pra decidir de quem é
// um vídeo/imagem ou playlist que ainda não tem dono nenhum registrado —
// por decisão do usuário, mídia/playlists "órfãs" (de antes desse
// isolamento existir) passam a pertencer à primeira conta ADM cadastrada.
// `criado_em ASC` pra ser sempre a MESMA conta (a mais antiga), não uma
// escolhida meio ao acaso entre vários ADMs.
async function buscarPrimeiroAdmId() {
  const { rows } = await pool.query(
    "SELECT id FROM contas WHERE role = 'adm' ORDER BY criado_em ASC LIMIT 1"
  );
  return rows[0] ? rows[0].id : null;
}

module.exports = { listarContas, buscarContaPorId, criarConta, atualizarConta, excluirConta, buscarPrimeiroAdmId };
