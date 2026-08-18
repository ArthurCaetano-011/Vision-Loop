// lib/tvs.js
// Pareamento de TV por conta (Fase 3 do roteiro de login).
//
// IMPORTANTE: este módulo só guarda a IDENTIDADE de cada TV (a qual conta
// ela pertence) — NÃO guarda o que está tocando agora, se está pausada, nem
// se está conectada neste instante. Isso continua vivendo só na memória do
// processo (o Map `tvs` dentro de server.js), exatamente como sempre foi —
// misturar os dois deixaria o servidor mais lento e mais frágil sem
// necessidade nenhuma (reprodução não precisa sobreviver a um restart; a
// identidade "essa TV é da Padaria do João" precisa).

const crypto = require("crypto");
const { pool } = require("./db");

// Sem 0/O/1/I — parecidos demais na tela de uma TV vistos de longe.
const ALFABETO_CODIGO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function gerarCodigo() {
  let codigo = "";
  for (let i = 0; i < 6; i++) {
    codigo += ALFABETO_CODIGO[crypto.randomInt(ALFABETO_CODIGO.length)];
  }
  return codigo;
}

// Busca a TV pelo device_id (gerado e guardado no localStorage do próprio
// navegador da TV — sobrevive a reconexões, mas NÃO sobrevive a limpar o
// localStorage da TV ou trocar de aparelho). Se for a primeira vez que esse
// device_id aparece, cria uma linha nova com um código de pareamento fresco
// e conta_id = null (ainda não pertence a ninguém).
async function buscarOuCriarPorDeviceId(deviceId, nomeSugerido) {
  const { rows } = await pool.query("SELECT * FROM tvs WHERE device_id = $1", [deviceId]);
  if (rows[0]) return rows[0];

  // Colisão de código é rara (33^6 combinações possíveis) mas o índice
  // único garante que nunca duas TVs fiquem com o mesmo código ao mesmo
  // tempo; se colidir, só tenta de novo com outro código.
  let ultimoErro = null;
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    try {
      const { rows: criada } = await pool.query(
        `INSERT INTO tvs (device_id, nome, codigo_pareamento) VALUES ($1, $2, $3) RETURNING *`,
        [deviceId, (nomeSugerido || "TV").slice(0, 60), gerarCodigo()]
      );
      return criada[0];
    } catch (err) {
      if (err && err.code === "23505") { ultimoErro = err; continue; }
      throw err;
    }
  }
  throw ultimoErro || new Error("Não foi possível gerar um código de pareamento único.");
}

async function contarTvsDaConta(contaId) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS total FROM tvs WHERE conta_id = $1",
    [contaId]
  );
  return rows[0].total;
}

// `conta` é o objeto completo já carregado por quem chamou (server.js já
// tem ele em mãos de auth.contaDaRequisicao) — evita lib/tvs.js precisar
// importar lib/contas.js só pra buscar o limite_tvs.
async function pareiarPorCodigo(codigo, conta) {
  const codigoNormalizado = String(codigo || "").trim().toUpperCase();
  if (!codigoNormalizado) return { erro: "Informe o código de pareamento." };

  const { rows } = await pool.query(
    "SELECT * FROM tvs WHERE codigo_pareamento = $1 AND conta_id IS NULL",
    [codigoNormalizado]
  );
  const tv = rows[0];
  if (!tv) return { erro: "Código inválido, expirado, ou essa TV já foi pareada com outra conta." };

  const jaTem = await contarTvsDaConta(conta.id);
  const limite = Number.isFinite(conta.limite_tvs) ? conta.limite_tvs : 1;
  if (jaTem >= limite) {
    return {
      erro: `Limite de TVs atingido (${limite}). Aumente o limite no painel de Contas ou despareie uma TV antes de adicionar outra.`,
    };
  }

  const { rows: atualizada } = await pool.query(
    `UPDATE tvs SET conta_id = $1, codigo_pareamento = NULL, pareada_em = now() WHERE id = $2 RETURNING *`,
    [conta.id, tv.id]
  );
  return { tv: atualizada[0] };
}

// Libera a TV de volta pro estado "sem dono", com um código de pareamento
// novo (o antigo já foi consumido no pareamento anterior). `conta` é quem
// está pedindo — só pode desparear uma TV que já é dela, exceto ADM, que
// pode desparear qualquer uma (mesma regra de visibilidade do painel).
async function despareiar(tvId, conta) {
  const { rows } = await pool.query("SELECT * FROM tvs WHERE id = $1", [tvId]);
  const tv = rows[0];
  if (!tv) return { erro: "TV não encontrada." };
  if (conta.role !== "adm" && tv.conta_id !== conta.id) {
    return { erro: "Essa TV não pertence à sua conta." };
  }

  let ultimoErro = null;
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    try {
      const { rows: atualizada } = await pool.query(
        `UPDATE tvs SET conta_id = NULL, codigo_pareamento = $1, pareada_em = NULL WHERE id = $2 RETURNING *`,
        [gerarCodigo(), tvId]
      );
      return { tv: atualizada[0] };
    } catch (err) {
      if (err && err.code === "23505") { ultimoErro = err; continue; }
      throw err;
    }
  }
  throw ultimoErro || new Error("Não foi possível gerar um novo código de pareamento.");
}

// Atualiza só o nome guardado no banco (best-effort — chamado quando alguém
// renomeia a TV pelo tv_set_name; se falhar, não é crítico, a TV continua
// funcionando normalmente com o nome só na memória até a próxima vez).
async function atualizarNome(tvId, nome) {
  if (!tvId || !nome) return;
  await pool.query("UPDATE tvs SET nome = $1 WHERE id = $2", [String(nome).slice(0, 60), tvId]);
}

module.exports = {
  buscarOuCriarPorDeviceId,
  contarTvsDaConta,
  pareiarPorCodigo,
  despareiar,
  atualizarNome,
};
