-- VisionLoop_Logins_0.5 — migração do banco já em uso
--
-- Igual da 0.4: seu banco no Neon já tem contas de verdade, então use ESTE
-- arquivo (não o schema-contas.sql) — só ADICIONA o que falta, com
-- IF NOT EXISTS em tudo. Seguro rodar mesmo que parte já exista.
--
-- Rode isso UMA VEZ no SQL Editor do Neon antes de colocar a 0.5 no ar.

-- 1) Playlists — antes viviam só num arquivo (playlists.json) no disco do
--    Render, que é apagado a cada deploy/reinício. Agora moram no banco:
--    sobrevivem a qualquer deploy, e cada uma pertence a uma conta
--    específica (isolamento por conta, Fase 4).
--
--    conta_id: dona da playlist. Se a conta for excluída, as playlists dela
--              somem junto (ON DELETE CASCADE) — mesma lógica de "dado que só
--              faz sentido existindo dentro de uma conta", igual às TVs.
--    itens:    a lista de vídeos/imagens da playlist, no mesmo formato que
--              já era salvo no JSON: [{name, duration, isImage}, ...].
CREATE TABLE IF NOT EXISTS playlists (
  id             SERIAL PRIMARY KEY,
  conta_id       INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  nome           TEXT NOT NULL,
  itens          JSONB NOT NULL DEFAULT '[]',
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_playlists_conta_id ON playlists (conta_id);

-- 2) Mídia — os vídeos/imagens em si CONTINUAM salvos do jeito que sempre
--    foram (disco local do Render ou bucket R2, sem mudar nada nisso). Esta
--    tabela é só um ÍNDICE por cima, guardando de quem é cada arquivo pelo
--    nome — é o que permite cada conta ver só a própria biblioteca.
--
--    nome_arquivo: o nome do arquivo tal como está salvo (único em todo o
--                  sistema, igual sempre foi — duas contas nunca têm um
--                  arquivo de mesmo nome, o servidor já garante isso há
--                  muito tempo com getUniqueFilename()).
CREATE TABLE IF NOT EXISTS midia (
  id            SERIAL PRIMARY KEY,
  conta_id      INTEGER NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
  nome_arquivo  TEXT NOT NULL UNIQUE,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_midia_conta_id ON midia (conta_id);

-- ---------------------------------------------------------------------
-- Depois de rodar o acima: os vídeos/imagens que já estão no seu
-- armazenamento hoje (sem dono nenhum registrado ainda) são atribuídos
-- automaticamente à sua conta ADM na primeira vez que a aba Vídeos for
-- aberta depois do deploy — não precisa fazer nada manual pra isso, o
-- próprio servidor reconcilia sozinho (ver LEIA-ME-LOGIN.md). O mesmo vale
-- pra eventuais playlists que ainda estivessem no playlists.json antigo, se
-- esse arquivo sobreviveu até este deploy (o servidor migra elas pro banco
-- sozinho, uma vez só, também pra conta ADM).
