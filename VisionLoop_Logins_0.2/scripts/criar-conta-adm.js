// scripts/criar-conta-adm.js
//
// Script de uso ÚNICO pra criar a primeira conta ADM direto no banco (Neon),
// sem precisar rodar SQL na mão. Preencha os dois espaços em branco abaixo,
// rode uma vez, confirme que o login funciona, e pode apagar este arquivo —
// ele não é usado por nenhuma parte do servidor, é só uma ferramenta avulsa.
//
// COMO RODAR:
//   - Pela aba "Shell" do serviço no Render (mais fácil: a DATABASE_URL já
//     está disponível lá automaticamente):
//       node scripts/criar-conta-adm.js
//   - Ou local, na pasta do projeto (depois de "npm install"), passando a
//     DATABASE_URL na mão:
//       DATABASE_URL="sua_connection_string_do_neon" node scripts/criar-conta-adm.js

// ======================= PREENCHA AQUI =======================
const NOME_NEGOCIO = ADM-2322; // ex: "Administração" — vai ser o que você digita no campo "Nome da empresa" da tela de login
const SENHA = 10082026@;        // a senha que você vai usar pra logar (fica só neste arquivo, nunca é enviada a lugar nenhum)
// ===============================================================

const bcrypt = require("bcrypt");
const { pool } = require("../lib/db");

async function main() {
  if (NOME_NEGOCIO === "PREENCHA_AQUI" || SENHA === "PREENCHA_AQUI") {
    console.error(
      "\n❌ Edite este arquivo antes de rodar: troque NOME_NEGOCIO e SENHA " +
        "pelos valores reais (linhas marcadas com PREENCHA AQUI, no topo do arquivo).\n"
    );
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      "\n❌ DATABASE_URL não está definida no ambiente onde este script está " +
        "rodando. Pela Shell do Render ela já vem pronta; rodando local, " +
        "prefixe o comando com DATABASE_URL=\"...\" (ver comentário no topo " +
        "deste arquivo).\n"
    );
    process.exit(1);
  }

  try {
    const hash = await bcrypt.hash(SENHA, 10);
    const { rows } = await pool.query(
      `INSERT INTO contas (role, nome_negocio, senha_hash, limite_tvs, limite_armazenamento_gb)
       VALUES ('adm', $1, $2, 999, 999)
       RETURNING id, nome_negocio`,
      [NOME_NEGOCIO.trim(), hash]
    );
    console.log("\n✅ Conta ADM criada com sucesso:");
    console.log(`   id: ${rows[0].id}`);
    console.log(`   nome_negocio (use este valor no campo "Nome da empresa" do login): ${rows[0].nome_negocio}`);
    console.log("\nAgora é só logar na tela de login com esse nome e a senha que você definiu acima.");
    console.log("Pode apagar este arquivo (scripts/criar-conta-adm.js) depois de confirmar o login.\n");
  } catch (err) {
    if (err && err.code === "23505") {
      // unique_violation — já existe uma conta com esse nome_negocio
      console.error(
        `\n❌ Já existe uma conta com o nome "${NOME_NEGOCIO}" (comparação ignora ` +
          "maiúsculas/minúsculas). Escolha outro nome, ou confirme se essa conta " +
          "já é a sua ADM e você só esqueceu a senha.\n"
      );
    } else {
      console.error("\n❌ Erro ao criar a conta:", err.message || err);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
