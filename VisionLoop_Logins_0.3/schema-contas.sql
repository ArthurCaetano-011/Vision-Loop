-- VisionLoop — Schema inicial da Fase 1 (banco + login)
-- Rodar UMA VEZ, manualmente, no SQL Editor do Neon (ou via psql com a DATABASE_URL),
-- antes do primeiro deploy que já dependa de login.
--
-- Só cria a tabela "contas" — "tvs" e "playlists" entram nas Fases 3 e 4
-- do roteiro, quando o resto do sistema estiver pronto pra usá-las.
--
-- Login por NOME DA EMPRESA + senha (sem e-mail, por decisão do usuário).

CREATE TABLE contas (
  id                        SERIAL PRIMARY KEY,
  role                      TEXT NOT NULL CHECK (role IN ('adm', 'cliente')),
  nome_negocio              TEXT NOT NULL,
  senha_hash                TEXT NOT NULL,
  licenca_expira_em         TIMESTAMPTZ,           -- null para o ADM; obrigatório para cliente (checado na aplicação)
  limite_tvs                INTEGER NOT NULL DEFAULT 1,
  limite_armazenamento_gb   NUMERIC NOT NULL DEFAULT 5,
  ativa                     BOOLEAN NOT NULL DEFAULT TRUE,
  sessao_token              TEXT,
  sessao_expira_em          TIMESTAMPTZ,
  criado_em                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_por                INTEGER REFERENCES contas(id)
);

-- Índice ÚNICO por nome da empresa, ignorando maiúsculas/minúsculas — é o
-- que garante que não existam duas contas com o "mesmo" nome (diferindo só
-- na caixa) E, de quebra, já serve como índice pra busca no login (que
-- compara com LOWER(nome_negocio) em lib/auth.js).
CREATE UNIQUE INDEX idx_contas_nome_negocio_lower ON contas (LOWER(nome_negocio));
CREATE INDEX idx_contas_sessao_token ON contas (sessao_token);

-- ---------------------------------------------------------------------
-- Depois de rodar o CREATE TABLE acima, insira a primeira conta ADM.
-- Ela precisa da senha já em hash bcrypt — gere localmente, na pasta do
-- projeto, DEPOIS de rodar "npm install" (é o "bcrypt" real que vai ser
-- usado, não o stub):
--
--   node -e "require('bcrypt').hash('SUA_SENHA_AQUI', 10).then(console.log)"
--
-- Copie o hash gerado (começa com $2b$10$...) e cole no lugar de
-- 'HASH_GERADO_AQUI' abaixo antes de rodar. O "nome_negocio" do ADM é o que
-- você vai digitar no campo "Nome da empresa" da tela de login:
--
-- INSERT INTO contas (role, nome_negocio, senha_hash, limite_tvs, limite_armazenamento_gb)
-- VALUES ('adm', 'Administração', 'HASH_GERADO_AQUI', 999, 999);
