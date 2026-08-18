-- VisionLoop — Schema inicial da Fase 1 (banco + login)
-- Use este arquivo SÓ para uma instalação NOVA, com o banco ainda vazio.
-- Se você já rodou este arquivo antes (ou seja, já tem a tabela "contas"
-- criada e em uso), NÃO rode de novo — use "schema-migracao-0.4.sql" em vez
-- disso, que ajusta uma tabela "contas" já existente sem apagar dados.
--
-- Login por NOME DA EMPRESA + senha (sem e-mail, por decisão do usuário).

CREATE TABLE contas (
  id                        SERIAL PRIMARY KEY,
  role                      TEXT NOT NULL CHECK (role IN ('adm', 'cliente')),
  nome_negocio              TEXT NOT NULL,
  senha_hash                TEXT NOT NULL,
  licenca_expira_em         TIMESTAMPTZ,           -- null para o ADM; obrigatório para cliente, a não ser que licenca_permanente seja true
  licenca_permanente        BOOLEAN NOT NULL DEFAULT FALSE, -- true = nunca bloqueia por validade, ignora licenca_expira_em
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

-- A tabela "tvs" (pareamento de TV por conta, Fase 3) também já entra numa
-- instalação nova — ver "schema-migracao-0.4.sql" para o comentário
-- completo sobre o que cada coluna faz, e para quem só precisa ADICIONAR
-- essa tabela num banco que já tem "contas".
CREATE TABLE tvs (
  id                 SERIAL PRIMARY KEY,
  device_id          TEXT NOT NULL UNIQUE,
  nome               TEXT NOT NULL DEFAULT 'TV',
  codigo_pareamento  TEXT,
  conta_id           INTEGER REFERENCES contas(id) ON DELETE SET NULL,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  pareada_em         TIMESTAMPTZ
);
CREATE INDEX idx_tvs_device_id ON tvs (device_id);
CREATE INDEX idx_tvs_conta_id ON tvs (conta_id);
CREATE UNIQUE INDEX idx_tvs_codigo_pareamento ON tvs (codigo_pareamento) WHERE codigo_pareamento IS NOT NULL;

-- As tabelas "playlists" e "midia" (mídia/playlists isoladas por conta,
-- Fase 4) também já entram numa instalação nova — ver
-- "schema-migracao-0.5.sql" para o comentário completo sobre o que cada
-- coluna faz, e para quem só precisa ADICIONAR essas tabelas num banco que
-- já tem "contas".
CREATE TABLE playlists (
  id             SERIAL PRIMARY KEY,
  conta_id       INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  nome           TEXT NOT NULL,
  itens          JSONB NOT NULL DEFAULT '[]',
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_playlists_conta_id ON playlists (conta_id);

-- expira_em: prazo de validade do arquivo (0.6.9). NULL = sem prazo, fica
-- até ser excluído à mão. Com data, o servidor apaga o arquivo ao vencer,
-- tira ele das playlists e avisa as TVs que estiverem exibindo.
CREATE TABLE midia (
  id            SERIAL PRIMARY KEY,
  conta_id      INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  nome_arquivo  TEXT NOT NULL UNIQUE,
  expira_em     TIMESTAMPTZ,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_midia_conta_id ON midia (conta_id);
CREATE INDEX idx_midia_expira_em ON midia (expira_em) WHERE expira_em IS NOT NULL;

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
