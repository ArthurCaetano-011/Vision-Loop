-- VisionLoop 0.6.9 — migração do banco já em uso
--
-- Mesma ideia das migrações anteriores: seu banco no Neon já tem contas,
-- playlists e mídia de verdade, então use ESTE arquivo (não o
-- schema-contas.sql) — ele só ADICIONA o que falta, com IF NOT EXISTS.
-- É seguro rodar mesmo que a coluna já exista.
--
-- Rode isso UMA VEZ no SQL Editor do Neon ANTES de colocar a 0.6.9 no ar.
-- Sem isso, o upload e a listagem de mídia quebram, porque o servidor passa
-- a ler e gravar a coluna abaixo.

-- Prazo de validade de cada vídeo/imagem.
--
-- NULL (o padrão, e o que fica em tudo que já existe hoje) = sem prazo: o
-- arquivo fica no ar por tempo indeterminado, até alguém excluir à mão —
-- exatamente o comportamento de sempre. Quando tem data, o servidor apaga o
-- arquivo assim que o prazo chega, tira ele das playlists que o usavam e
-- avisa na hora as TVs que estiverem exibindo essas playlists.
--
-- TIMESTAMPTZ (com fuso) de propósito: quem envia escolhe a data no horário
-- do próprio navegador, e a comparação é feita pelo relógio do banco. Assim
-- o vencimento não muda se o servidor reiniciar, mudar de máquina ou de fuso.
ALTER TABLE midia ADD COLUMN IF NOT EXISTS expira_em TIMESTAMPTZ;

-- Índice pequeno, só das linhas que TÊM prazo: é o que a varredura de
-- minuto em minuto consulta. Arquivo sem validade nem entra no índice.
CREATE INDEX IF NOT EXISTS idx_midia_expira_em ON midia (expira_em) WHERE expira_em IS NOT NULL;
