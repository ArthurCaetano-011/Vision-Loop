// lib/midia.js
// Índice de POSSE dos vídeos/imagens (Fase 4 do roteiro de login).
//
// IMPORTANTE: este módulo NÃO guarda os arquivos em si — o armazenamento
// físico continua exatamente como sempre foi (disco local do Render, ou
// bucket R2). Esta tabela é só um mapa "esse nome de arquivo pertence a
// essa conta" por cima do que já existe fisicamente, permitindo que cada
// conta veja só a própria biblioteca sem precisar reorganizar pastas/bucket.

const { pool } = require("./db");

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
  await pool.query(
    "INSERT INTO midia (conta_id, nome_arquivo, expira_em) VALUES ($1, $2, $3) ON CONFLICT (nome_arquivo) DO UPDATE SET conta_id = EXCLUDED.conta_id, expira_em = EXCLUDED.expira_em",
    [contaId, nomeArquivo, expiraEm]
  );
}

// Validades registradas, pra desenhar o selo "⏳ vence em ..." na biblioteca.
// contaId null = todas as contas (visão do ADM). Arquivo sem validade não
// aparece aqui — a ausência é justamente o "sem prazo".
async function validadesPorArquivo(contaId) {
  const { rows } = contaId == null
    ? await pool.query("SELECT nome_arquivo, expira_em FROM midia WHERE expira_em IS NOT NULL")
    : await pool.query("SELECT nome_arquivo, expira_em FROM midia WHERE expira_em IS NOT NULL AND conta_id = $1", [contaId]);
  const mapa = new Map();
  rows.forEach((r) => mapa.set(r.nome_arquivo, r.expira_em));
  return mapa;
}

// Arquivos cujo prazo já passou. A comparação é feita pelo RELÓGIO DO BANCO
// (now()), não pelo do processo: o servidor pode reiniciar, mudar de máquina
// ou de fuso, e o vencimento continua valendo igual.
async function nomesVencidos() {
  const { rows } = await pool.query(
    "SELECT nome_arquivo FROM midia WHERE expira_em IS NOT NULL AND expira_em <= now()"
  );
  return rows.map((r) => r.nome_arquivo);
}

async function donoDoArquivo(nomeArquivo) {
  const { rows } = await pool.query("SELECT conta_id FROM midia WHERE nome_arquivo = $1", [nomeArquivo]);
  return rows[0] ? rows[0].conta_id : null;
}

async function removerArquivo(nomeArquivo) {
  await pool.query("DELETE FROM midia WHERE nome_arquivo = $1", [nomeArquivo]);
}

module.exports = { donosPorArquivo, garantirDonos, registrarArquivo, validadesPorArquivo, nomesVencidos, donoDoArquivo, removerArquivo };
