-- VisionLoop_Logins_0.4 — migração do banco já em uso
--
-- Use ESTE arquivo (não o schema-contas.sql) porque a sua tabela "contas"
-- já existe no Neon, com contas de verdade cadastradas — o schema-contas.sql
-- tem um CREATE TABLE que falharia (ou, pior, se você tivesse apagado a
-- tabela antes, perderia tudo). Este arquivo só ADICIONA o que falta.
--
-- Rode isso UMA VEZ no SQL Editor do Neon antes de colocar a 0.4 no ar.
-- Pode colar o arquivo inteiro de uma vez e rodar tudo junto — cada comando
-- é seguro de rodar mesmo que parte já exista (usa IF NOT EXISTS onde dá).

-- 1) Licença permanente — nova coluna na tabela "contas". Contas existentes
--    ganham FALSE por padrão (ninguém vira "permanente" sozinho; se você
--    quiser marcar alguma conta como permanente, faça isso depois pelo
--    painel Contas, ou rode um UPDATE manual).
ALTER TABLE contas ADD COLUMN IF NOT EXISTS licenca_permanente BOOLEAN NOT NULL DEFAULT FALSE;

-- 2) Tabela nova "tvs" — guarda o PAREAMENTO de cada TV com uma conta (Fase
--    3). Não guarda o que está tocando agora nem o status de conexão —
--    isso continua só na memória do servidor, igual sempre foi; aqui só
--    fica "essa TV (identificada pelo aparelho) pertence a essa conta".
--
--    device_id:         gerado sozinho no navegador da TV (guardado no
--                        localStorage dela) — é o que identifica o MESMO
--                        aparelho entre uma reconexão e outra.
--    codigo_pareamento: código de 6 caracteres mostrado na tela da TV
--                        enquanto ela ainda não pertence a nenhuma conta.
--                        Vira NULL assim que a TV é pareada (o código para
--                        de existir depois de usado).
--    conta_id:           NULL = TV ainda não pareada com ninguém. Depois de
--                        pareada, aponta pra conta dona da TV.
CREATE TABLE IF NOT EXISTS tvs (
  id                 SERIAL PRIMARY KEY,
  device_id          TEXT NOT NULL UNIQUE,
  nome               TEXT NOT NULL DEFAULT 'TV',
  codigo_pareamento  TEXT,
  conta_id           INTEGER REFERENCES contas(id) ON DELETE SET NULL,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  pareada_em         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tvs_device_id ON tvs (device_id);
CREATE INDEX IF NOT EXISTS idx_tvs_conta_id ON tvs (conta_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tvs_codigo_pareamento ON tvs (codigo_pareamento) WHERE codigo_pareamento IS NOT NULL;

-- ---------------------------------------------------------------------
-- Depois de rodar o acima: TODA TV que já estava em uso vai pedir
-- pareamento de novo na primeira vez que a página dela recarregar depois
-- do deploy da 0.4 — isso é esperado (o pareamento é uma funcionalidade
-- nova, nenhuma TV tinha um "device_id" registrado antes). Basta abrir o
-- painel Contas → a conta certa → "Parear TV" e digitar o código que vai
-- aparecer na tela de cada TV.
