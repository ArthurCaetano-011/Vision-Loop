const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { version: APP_VERSION } = require("./package.json");
const auth = require("./lib/auth");
const contasAdmin = require("./lib/contas");
const tvsPareamento = require("./lib/tvs");
const midiaOwnership = require("./lib/midia");
const playlistsDb = require("./lib/playlists");

// ⚠️ TEMPORÁRIO — ver pasta "exclua-me/" (contém setup-adm-route.js e
// setup-adm.html). Depois de criar sua conta ADM pela página
// /exclua-me/setup-adm.html, apague a pasta "exclua-me" inteira do projeto
// — este require está protegido por try/catch de propósito, então a
// ausência da pasta não derruba o servidor, só desativa a rota /setup-adm.
let setupAdmRoute = null;
try { setupAdmRoute = require("./exclua-me/setup-adm-route"); } catch {}

// ---------- Armazenamento de mídia (Cloudflare R2, opcional) ----------
// Por padrão os vídeos/imagens ficam no disco local do Render — que é
// EFÊMERO (some a cada deploy/reinício) e cuja banda de saída é muito curta
// no plano gratuito (5GB/mês no total, e uma única TV tocando o dia todo já
// estoura isso). Configurando as 5 variáveis de ambiente abaixo, o servidor
// passa a enviar cada vídeo/imagem pronto para um bucket R2 (compatível com
// S3) e as TVs passam a buscar o arquivo direto de lá — o Render deixa de
// carregar peso de vídeo, e o conteúdo sobrevive a deploys. Sem essas
// variáveis, tudo continua exatamente como antes (disco local).
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL; // ex: https://videos.seudominio.com (sem barra no final)
const R2_ENABLED = !!(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_BASE_URL);

// Trava de segurança contra cobrança surpresa: a Cloudflare NÃO tem um limite
// rígido de uso pra R2 (só um "budget alert" que manda e-mail depois que você
// já passou do grátis, sem impedir a cobrança em si). Então quem impede o
// upload de estourar os 10GB grátis é o próprio VisionLoop, se essa variável
// opcional estiver configurada. Sem ela, não existe teto (sobe à vontade).
const R2_MAX_STORAGE_GB = process.env.R2_MAX_STORAGE_GB ? parseFloat(process.env.R2_MAX_STORAGE_GB) : null;
const R2_MAX_STORAGE_BYTES = Number.isFinite(R2_MAX_STORAGE_GB) ? R2_MAX_STORAGE_GB * 1024 * 1024 * 1024 : null;

const s3Client = R2_ENABLED
  ? new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    })
  : null;

function mimeForName(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  };
  return map[ext] || "application/octet-stream";
}

function uploadToR2(localPath, key) {
  return s3Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: fs.createReadStream(localPath),
    ContentType: mimeForName(key),
    CacheControl: "public, max-age=3600",
  }));
}

function deleteFromR2(key) {
  return s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
}

function listR2Media() {
  return s3Client.send(new ListObjectsV2Command({ Bucket: R2_BUCKET_NAME }))
    .then((data) => (data.Contents || [])
      .map((o) => o.Key)
      .filter((k) => k && !k.startsWith(".") && MEDIA_EXT_REGEX.test(k)));
}

// Soma o tamanho de tudo que já está no bucket, paginando (a API só devolve
// até 1000 itens por página). Só é chamada quando R2_MAX_STORAGE_GB está
// configurado — sem isso, não vale a pena o custo extra de uma listagem a
// mais a cada upload.
async function getR2TotalBytes() {
  let total = 0;
  let ContinuationToken;
  do {
    const data = await s3Client.send(new ListObjectsV2Command({ Bucket: R2_BUCKET_NAME, ContinuationToken }));
    total += (data.Contents || []).reduce((sum, o) => sum + (o.Size || 0), 0);
    ContinuationToken = data.IsTruncated ? data.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return total;
}

// Confere se subir mais `incomingBytes` estouraria o teto configurado.
// `incomingBytes` é uma ESTIMATIVA (tamanho do arquivo original, antes da
// transcodificação) — o vídeo final normalmente fica do mesmo tamanho ou
// menor (a conversão comprime e limita a resolução), então checar antes de
// gastar CPU convertendo é uma margem de segurança razoável, não uma conta exata.
async function wouldExceedStorageCap(incomingBytes) {
  if (!R2_ENABLED || R2_MAX_STORAGE_BYTES == null) return false;
  const current = await getR2TotalBytes();
  return (current + (incomingBytes || 0)) > R2_MAX_STORAGE_BYTES;
}

function r2ObjectExists(key) {
  return s3Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
    .then(() => true)
    .catch((err) => {
      const status = err && err.$metadata && err.$metadata.httpStatusCode;
      if (status === 404 || err.name === "NotFound") return false;
      throw err; // erro de rede/credencial: não confundir com "nome livre"
    });
}

// Termina uma requisição de upload com sucesso. Quando o R2 está ligado,
// sobe o arquivo pronto pro bucket e só then apaga a cópia local (o disco do
// Render é só uma escala de passagem, não o destino final); se o envio falhar,
// avisa o controlador para tentar de novo em vez de fingir sucesso com um
// arquivo que vai sumir no próximo deploy.
function respondUploadSuccess(res, localPath, key, extraFields) {
  const payload = Object.assign({ success: true, filename: key }, extraFields || {});
  if (R2_ENABLED) {
    uploadToR2(localPath, key)
      .then(() => {
        fs.unlink(localPath, () => {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      })
      .catch((err) => {
        console.error("Falha ao enviar para o R2:", err);
        fs.unlink(localPath, () => {});
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Arquivo processado, mas falhou o envio para o armazenamento (R2). Tente enviar de novo." }));
      });
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// Rede de segurança contra crash do processo inteiro. Uma exceção não
// capturada em QUALQUER upload/mensagem derrubava o servidor todo — TVs e
// controladores de todo mundo caem juntos e o Render reinicia o app (a
// próxima requisição em voo vê a conexão cair, aparecendo como 502/erro de
// rede). Isso NÃO protege contra o processo ser morto por estourar o limite
// de memória do plano (SIGKILL do sistema operacional não passa pelo Node,
// nada em JS pega isso) — só evita que um bug de código (exceção síncrona ou
// promise sem .catch) tire o servidor do ar por causa de uma requisição só.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException (processo seguiu no ar):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection (processo seguiu no ar):", err);
});

const PORT = process.env.PORT || 3000;
// MEDIA_EXT_REGEX: formatos RECONHECIDOS pro sistema (listagem, exclusão,
// mimetype ao servir) — inclui .mov/.webm pra não esconder/quebrar arquivos
// que já estavam salvos de antes desta versão.
//
// UPLOAD_EXT_REGEX: formatos ACEITOS em NOVOS uploads — só .mp4 pra vídeo.
// A partir da 0.1.2 o servidor NÃO reconverte mais o vídeo pra HD/H.264
// antes de guardar (o arquivo é salvo exatamente como foi enviado, pra não
// gastar a RAM pesada que o FFmpeg exigia e que derrubava o servidor em
// vídeos de alguns minutos). Sem essa conversão automática, um .mov ou
// .webm enviado do jeito que veio da câmera/celular tem grande chance de não
// tocar em Smart TVs — por isso, a partir da 0.1.3, só .mp4 é aceito no
// upload; quem tiver `.mov`/`.webm` precisa converter pra `.mp4` antes.
const IMAGE_EXT_REGEX = /\.(jpg|jpeg|png|webp)$/i;
const MEDIA_EXT_REGEX = /\.(mp4|mov|webm|jpg|jpeg|png|webp)$/i;
const UPLOAD_EXT_REGEX = /\.(mp4|jpg|jpeg|png|webp)$/i;

// Tempo de exibição das imagens na playlist, em segundos (vídeos tocam até o
// fim e ficam com 0). Os mesmos limites existem no controlador; aqui eles são
// aplicados de novo porque o servidor não confia no que chega pela rede.
const IMAGE_DURATION_DEFAULT = 10;
const IMAGE_DURATION_MIN = 1;
const IMAGE_DURATION_MAX = 300;

// ---------- Utilitários ----------

// Acha um nome livre pra esse arquivo. Com o R2 ligado, "livre" é checado no
// BUCKET (via HEAD), não no disco local — o disco do Render é efêmero e some
// a cada deploy, então checar só nele deixaria passar batido um nome que já
// existe no R2 (sobrescrevendo silenciosamente o vídeo/imagem antigo).
async function getUniqueFilename(dir, filename) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = filename;
  let n = 1;
  const taken = R2_ENABLED
    ? (name) => r2ObjectExists(name)
    : (name) => Promise.resolve(fs.existsSync(path.join(dir, name)));
  while (await taken(candidate)) {
    candidate = `${base} (${n})${ext}`;
    n++;
  }
  return candidate;
}

// Converte uma linha do banco (id, conta_id, nome, itens, atualizado_em)
// pro formato que o controlador sempre esperou de uma playlist
// (id, name, videos, updatedAt) — mantém o front-end (js/controller.js)
// funcionando sem nenhuma mudança, mesmo com playlists agora vindo do
// Postgres em vez do playlists.json.
function playlistParaResposta(row) {
  return {
    id: row.id,
    name: row.nome,
    videos: row.itens,
    updatedAt: row.atualizado_em,
  };
}

// Normaliza os itens de uma playlist recebida do controlador (mesma
// validação de sempre: nome, duração dentro dos limites pra imagem, 0 pra
// vídeo) — o servidor é o último ponto antes de gravar, não confia no que
// chega pela rede.
function normalizarItensPlaylist(itensRecebidos) {
  if (!Array.isArray(itensRecebidos)) return [];
  return itensRecebidos.map((item) => {
    const name = typeof item === "string" ? item : (item && item.name);
    if (!name || typeof name !== "string") return null;
    const isImage = IMAGE_EXT_REGEX.test(name);
    let duration = 0;
    if (isImage) {
      const raw = typeof item === "object" ? parseInt(item.duration, 10) : NaN;
      duration = Number.isFinite(raw)
        ? Math.min(IMAGE_DURATION_MAX, Math.max(IMAGE_DURATION_MIN, raw))
        : IMAGE_DURATION_DEFAULT;
    }
    return { name: path.basename(name), duration, isImage };
  }).filter(Boolean);
}

// ---------- Servidor HTTP ----------

// Limite de tamanho para os corpos de requisição JSON pequenos (login,
// playlists, setup-adm) — NÃO se aplica às rotas de upload de vídeo, que
// continuam sem limite de propósito. Sem isso, uma requisição malformada ou
// deliberadamente enorme nessas rotas ficava acumulando na memória do
// processo sem nenhum teto (ver relatório de riscos de travamento,
// 2026-08-10). 1MB é bem folgado para o maior corpo esperado aqui (uma
// playlist com muitos itens).
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;

function readJsonBody(req, res, onBody) {
  let body = "";
  let tooLarge = false;
  req.on("data", (d) => {
    if (tooLarge) return;
    body += d;
    if (Buffer.byteLength(body) > MAX_JSON_BODY_BYTES) {
      tooLarge = true;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Requisição grande demais." }));
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooLarge) return;
    onBody(body);
  });
}

// Limite de tentativas de login por IP (anti força-bruta). Guardado em
// memória — não precisa sobreviver a um reinício do servidor, só precisa
// desestimular um script tentando adivinhar senha por tentativa e erro em
// /login, que é a única rota pública (sem sessão) que consulta senha.
const LOGIN_RATE_LIMIT_MAX = 5;
const LOGIN_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const loginAttemptsByIp = new Map(); // ip -> [timestamps das tentativas na janela atual]

// Atrás do proxy do Render, o IP real de quem acessa vem no header
// "x-forwarded-for" (o proxy troca o IP de origem da conexão TCP pelo dele
// próprio) — pode ter mais de um IP separado por vírgula quando há vários
// proxies na frente; o primeiro é o do visitante. Sem proxy (ex.: teste
// local), cai para o IP da conexão direta.
function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "desconhecido";
}

function isLoginRateLimited(ip) {
  const now = Date.now();
  const attempts = (loginAttemptsByIp.get(ip) || []).filter((t) => now - t < LOGIN_RATE_LIMIT_WINDOW_MS);
  loginAttemptsByIp.set(ip, attempts);
  return attempts.length >= LOGIN_RATE_LIMIT_MAX;
}

function registerLoginAttempt(ip) {
  const attempts = loginAttemptsByIp.get(ip) || [];
  attempts.push(Date.now());
  loginAttemptsByIp.set(ip, attempts);
}

// Limpeza periódica pra não deixar esse Map crescendo pra sempre com IPs
// que já pararam de tentar logar há muito tempo.
setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of loginAttemptsByIp.entries()) {
    const fresh = attempts.filter((t) => now - t < LOGIN_RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) loginAttemptsByIp.delete(ip);
    else loginAttemptsByIp.set(ip, fresh);
  }
}, 10 * 60 * 1000);

const server = http.createServer((req, res) => {
  const rawPath = req.url.split("?")[0];
  let decodedPath;
  try { decodedPath = decodeURIComponent(rawPath); }
  catch { decodedPath = rawPath; }
  const urlPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };

  // Com o R2 ligado, o vídeo/imagem em si não mora mais no Render — o
  // servidor só devolve um redirecionamento pra URL pública do bucket. Isso
  // mantém TODO o resto (controller.html, tv.html, double buffer, preload,
  // watchdog) funcionando sem nenhuma mudança: pra eles, `/videos/<nome>`
  // continua sendo a URL do arquivo, só que agora ela responde com um 302 em
  // vez do arquivo. Só os poucos bytes do redirecionamento passam pela banda
  // do Render — o vídeo em si (o que pesava) vem direto do R2.
  if (R2_ENABLED && urlPath.startsWith("/videos/")) {
    const safeName = path.basename(urlPath);
    if (!safeName) { res.writeHead(400); res.end("Nome inválido"); return; }
    res.writeHead(302, {
      Location: `${R2_PUBLIC_BASE_URL.replace(/\/+$/, "")}/${encodeURIComponent(safeName)}`,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (urlPath.startsWith("/videos/") || urlPath.startsWith("/assets/")) {
    const mediaPath = path.join(__dirname, urlPath);
    const safeRoot = path.resolve(__dirname) + path.sep;
    if (!path.resolve(mediaPath).startsWith(safeRoot)) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    if (!fs.existsSync(mediaPath)) {
      res.writeHead(404); res.end("Not found"); return;
    }

    const stat = fs.statSync(mediaPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Se for imagem, não precisa de streaming de range complexo na maioria dos
    // casos, mas mantemos por compatibilidade.
    // O `|| ""` evita quebrar caso sobre na pasta algum arquivo com extensão
    // fora da tabela `mime` (ex: um .mkv antigo, de antes da limpeza de
    // formatos) — sem ele, um acesso a esse arquivo derrubaria o servidor.
    if (range && !(mime[ext] || "").startsWith("image/")) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize) {
        res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
        return res.end();
      }

      const chunkSize = end - start + 1;
      const file = fs.createReadStream(mediaPath, { start, end, highWaterMark: 64 * 1024 });

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": mime[ext] || "video/mp4",
        "Cache-Control": "public, max-age=3600",
      });

      // TÓPICO 4: Tratamento de erro no streaming para evitar que o servidor ou a TV travem em conexões instáveis
      file.on('error', (err) => {
        console.error("Streaming error (206):", err);
        if (!res.writableEnded) res.destroy();
      });

      // Se o cliente fechar a conexão abruptamente, encerramos a leitura do arquivo
      res.on('close', () => {
        file.destroy();
      });

      file.pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": fileSize,
        "Content-Type": mime[ext] || (IMAGE_EXT_REGEX.test(ext) ? "image/jpeg" : "video/mp4"),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      });

      const file = fs.createReadStream(mediaPath, { highWaterMark: 64 * 1024 });

      file.on('error', (err) => {
        console.error("Streaming error (200):", err);
        if (!res.writableEnded) res.destroy();
      });

      res.on('close', () => {
        file.destroy();
      });

      file.pipe(res);
    }
    return;
  }

  // O navegador pede /favicon.ico sozinho; sem esta rota ele registrava um
  // erro 404 no console em toda visita. Reaproveitamos o ícone do app.
  if (urlPath === "/favicon.ico") {
    const iconPath = path.join(__dirname, "assets", "icon.png");
    if (fs.existsSync(iconPath)) {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      });
      fs.createReadStream(iconPath).pipe(res);
    } else {
      res.writeHead(204).end();
    }
    return;
  }

  if (urlPath === "/version") {
    res.writeHead(200, { "Content-Type": "application/json" });
    // r2Enabled diz ao controlador se deve pedir uma URL de upload direto
    // (R2) ou mandar o arquivo pro próprio servidor (modo disco local).
    res.end(JSON.stringify({ version: APP_VERSION, r2Enabled: R2_ENABLED }));
    return;
  }

  // ---------- AUTENTICAÇÃO ----------
  // Login único por nome da empresa + senha (adm/cliente na mesma tabela
  // `contas`, diferenciados pelo campo `role`). Sem e-mail e sem cadastro
  // público — a única forma de uma conta existir é o ADM criando pelo painel
  // (Fase 2). Ver lib/auth.js para as regras de senha/sessão/licença.

  if (req.method === "POST" && urlPath === "/login") {
    const clientIp = getClientIp(req);
    if (isLoginRateLimited(clientIp)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Muitas tentativas de login. Aguarde um pouco antes de tentar de novo." }));
      return;
    }
    readJsonBody(req, res, async (body) => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "JSON inválido." }));
        return;
      }
      // Conta a tentativa antes de checar a senha — certa ou errada, ambas
      // contam pro limite (é o próprio "tentar adivinhar a senha" que se
      // quer desestimular).
      registerLoginAttempt(clientIp);
      try {
        const resultado = await auth.autenticar(parsed.nomeNegocio, parsed.senha);
        if (resultado.erro) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: resultado.erro }));
          return;
        }
        const { token, expiresAt } = await auth.criarSessao(resultado.conta.id);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": auth.buildSessionCookie(req, token, expiresAt),
        });
        res.end(JSON.stringify({
          ok: true,
          role: resultado.conta.role,
          nomeNegocio: resultado.conta.nome_negocio,
        }));
      } catch (err) {
        console.error("Erro no login:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Erro no servidor ao tentar entrar. Tente de novo em instantes." }));
      }
    });
    return;
  }

  if (req.method === "POST" && urlPath === "/logout") {
    (async () => {
      try {
        const conta = await auth.contaDaRequisicao(req);
        if (conta) await auth.encerrarSessao(conta.id);
      } catch (err) {
        console.error("Erro ao encerrar sessão:", err);
        // Mesmo com erro no banco, ainda limpamos o cookie do navegador —
        // não faz sentido deixar o usuário "preso" logado no front porque o
        // UPDATE falhou.
      }
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": auth.buildClearCookie(req) });
      res.end(JSON.stringify({ ok: true }));
    })();
    return;
  }

  // Usada pelo controller.html no carregamento (redireciona pra login.html
  // se der 401) e para mostrar quem está logado no cabeçalho.
  if (req.method === "GET" && urlPath === "/me") {
    auth.contaDaRequisicao(req).then((conta) => {
      if (!conta) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Não autenticado." }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: conta.id,
        role: conta.role,
        nomeNegocio: conta.nome_negocio,
      }));
    }).catch((err) => {
      console.error("Erro ao checar sessão em /me:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro ao checar sessão." }));
    });
    return;
  }

  // ---------- PAREAMENTO DE TV POR CONTA (Fase 3) ----------
  // Diferente do painel ADM logo abaixo, estas duas rotas valem pra
  // QUALQUER conta logada (adm ou cliente) — cada uma pareia TVs pra si
  // mesma. Só o ADM pode desparear a TV de OUTRA conta (checado dentro de
  // lib/tvs.js/despareiar).

  if (req.method === "POST" && urlPath === "/parear-tv") {
    auth.contaDaRequisicao(req).then((conta) => {
      if (!conta) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Não autenticado." }));
        return;
      }
      readJsonBody(req, res, async (body) => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "JSON inválido." }));
          return;
        }
        try {
          const resultado = await tvsPareamento.pareiarPorCodigo(parsed.codigo, conta);
          if (resultado.erro) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: resultado.erro }));
            return;
          }
          // A TV pode já estar conectada (esperando alguém digitar o código
          // dela em algum painel) — se estiver, atualiza a entrada em
          // memória na hora, pra ela aparecer pro controlador e a própria
          // TV saber que já foi pareada sem precisar recarregar a página.
          for (const [, t] of tvs) {
            if (t.deviceId && t.deviceId === resultado.tv.device_id) {
              t.contaId = resultado.tv.conta_id;
              t.tvRowId = resultado.tv.id;
              if (t.ws.readyState === 1) {
                t.ws.send(JSON.stringify({ type: "your_code", code: t.ws._tvCode, paired: true, pairingCode: null }));
              }
            }
          }
          broadcastTvList();
          notifyAllTvs();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, tv: { id: resultado.tv.id, nome: resultado.tv.nome } }));
        } catch (err) {
          console.error("Erro ao parear TV:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Erro no servidor ao parear a TV." }));
        }
      });
    }).catch((err) => {
      console.error("Erro ao checar sessão em /parear-tv:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro ao checar sessão." }));
    });
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/tvs/")) {
    const tvId = parseInt(urlPath.slice("/tvs/".length), 10);
    auth.contaDaRequisicao(req).then(async (conta) => {
      if (!conta) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Não autenticado." }));
        return;
      }
      if (!Number.isFinite(tvId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Id inválido." }));
        return;
      }
      try {
        const resultado = await tvsPareamento.despareiar(tvId, conta);
        if (resultado.erro) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: resultado.erro }));
          return;
        }
        // Se a TV estiver conectada agora, ela cai da lista de quem
        // controlava e volta a mostrar o código de pareamento na hora.
        for (const [code, t] of tvs) {
          if (t.tvRowId === resultado.tv.id) {
            t.contaId = null;
            if (t.ws.readyState === 1) {
              t.ws.send(JSON.stringify({
                type: "your_code", code, paired: false, pairingCode: resultado.tv.codigo_pareamento,
              }));
              t.ws.send(JSON.stringify({ type: "controller_status", online: algumControladorOnline() }));
            }
          }
        }
        broadcastTvList();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("Erro ao desparear TV:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Erro no servidor ao desparear a TV." }));
      }
    }).catch((err) => {
      console.error("Erro ao checar sessão em DELETE /tvs:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro ao checar sessão." }));
    });
    return;
  }

  // ---------- PAINEL ADM: gerenciamento de contas (Fase 2) ----------
  // Todas as rotas abaixo exigem uma sessão de conta com role 'adm'. Ainda
  // não existe isolamento de dados entre contas (isso é Fase 3/4) — qualquer
  // ADM enxerga e edita todas as contas cadastradas, inclusive outros ADMs.
  async function requireAdmin() {
    const conta = await auth.contaDaRequisicao(req);
    if (!conta || conta.role !== "adm") {
      res.writeHead(conta ? 403 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: conta ? "Acesso restrito a contas ADM." : "Não autenticado." }));
      return null;
    }
    return conta;
  }

  if (req.method === "GET" && urlPath === "/admin/contas") {
    requireAdmin().then((admConta) => {
      if (!admConta) return;
      contasAdmin.listarContas()
        .then((lista) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(lista));
        })
        .catch((err) => {
          console.error("Erro ao listar contas:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Erro ao listar contas." }));
        });
    });
    return;
  }

  if (req.method === "POST" && urlPath === "/admin/contas") {
    requireAdmin().then((admConta) => {
      if (!admConta) return;
      readJsonBody(req, res, async (body) => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "JSON inválido." }));
          return;
        }
        try {
          const resultado = await contasAdmin.criarConta(parsed, admConta.id);
          if (resultado.erro) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: resultado.erro }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resultado.conta));
        } catch (err) {
          console.error("Erro ao criar conta:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Erro no servidor ao criar a conta." }));
        }
      });
    });
    return;
  }

  if (req.method === "PUT" && urlPath.startsWith("/admin/contas/")) {
    const id = parseInt(urlPath.slice("/admin/contas/".length), 10);
    requireAdmin().then((admConta) => {
      if (!admConta) return;
      if (!Number.isFinite(id)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Id inválido." }));
        return;
      }
      readJsonBody(req, res, async (body) => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "JSON inválido." }));
          return;
        }
        // Guarda de segurança: um ADM não consegue tirar o próprio acesso de
        // ADM por aqui — evita se trancar pra fora do painel sem querer.
        // Continua podendo mudar o papel de QUALQUER OUTRA conta livremente.
        if (id === admConta.id && parsed.role && parsed.role !== "adm") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Você não pode remover seu próprio acesso de ADM por aqui." }));
          return;
        }
        try {
          const resultado = await contasAdmin.atualizarConta(id, parsed);
          if (resultado.erro) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: resultado.erro }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resultado.conta));
        } catch (err) {
          console.error("Erro ao atualizar conta:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Erro no servidor ao atualizar a conta." }));
        }
      });
    });
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/admin/contas/")) {
    const id = parseInt(urlPath.slice("/admin/contas/".length), 10);
    requireAdmin().then((admConta) => {
      if (!admConta) return;
      if (!Number.isFinite(id)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Id inválido." }));
        return;
      }
      // Guarda de segurança: não deixa o ADM excluir a própria conta logada
      // por aqui (ficaria sem sessão no meio da própria exclusão).
      if (id === admConta.id) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Você não pode excluir a própria conta logada aqui." }));
        return;
      }
      contasAdmin.excluirConta(id)
        .then((ok) => {
          if (!ok) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Conta não encontrada." }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        })
        .catch((err) => {
          console.error("Erro ao excluir conta:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Erro no servidor ao excluir a conta." }));
        });
    });
    return;
  }

  // ⚠️ TEMPORÁRIO — ver pasta "exclua-me/". Delega pra lá a criação da 1ª
  // conta ADM pela web. Se a pasta "exclua-me" for apagada, "setupAdmRoute"
  // fica null (o require abaixo falha em silêncio) e este bloco não faz
  // nada — ou seja, é seguro apagar só a pasta sem precisar tocar aqui.
  if (req.method === "POST" && urlPath === "/setup-adm" && setupAdmRoute) {
    setupAdmRoute.handle(req, res);
    return;
  }

  // Quanto espaço já está sendo usado pelos vídeos/imagens — no R2 (bucket
  // inteiro) ou no disco local, dependendo do modo ativo. Serve tanto para
  // mostrar no controlador quanto para o usuário acompanhar o teto configurado.
  if (urlPath === "/storage-usage") {
    const respond = (bytes) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        bytes,
        gb: bytes / (1024 * 1024 * 1024),
        capGb: R2_MAX_STORAGE_GB,
      }));
    };
    if (R2_ENABLED) {
      getR2TotalBytes()
        .then(respond)
        .catch((err) => {
          console.error("Erro ao calcular uso de armazenamento no R2:", err);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Erro ao calcular uso de armazenamento." }));
        });
      return;
    }
    // Versão assíncrona (era fs.readdirSync + fs.statSync num loop síncrono)
    // — numa pasta de vídeos grande, o statSync um por um bloqueava o
    // processo inteiro (inclusive mensagens do WebSocket de TVs/controladores
    // esperando resposta) pela duração da listagem inteira. fs.promises +
    // Promise.all faz os stats em paralelo sem travar o event loop (ver
    // relatório de riscos de travamento, 2026-08-10).
    const dir = path.join(__dirname, "videos");
    fs.promises.readdir(dir)
      .then((allFiles) => {
        const files = allFiles.filter((f) => !f.startsWith(".") && MEDIA_EXT_REGEX.test(f));
        return Promise.all(
          files.map((f) => fs.promises.stat(path.join(dir, f)).then((s) => s.size).catch(() => 0))
        );
      })
      .then((sizes) => respond(sizes.reduce((sum, size) => sum + size, 0)))
      .catch(() => respond(0));
    return;
  }

  // ---------- MÍDIA (vídeos/imagens) — isolada por conta (Fase 4) ----------
  // O arquivo em si continua no mesmo lugar físico de sempre (disco local
  // ou bucket R2) — só a LISTAGEM é filtrada por conta, usando a tabela
  // `midia` (lib/midia.js) como índice de posse. Qualquer arquivo físico
  // que ainda não tenha dono registrado (mídia de antes da Fase 4) é
  // adotado automaticamente pela conta ADM mais antiga na primeira
  // listagem depois do deploy — não precisa de passo manual nenhum.
  if (urlPath === "/videos-list") {
    auth.contaDaRequisicao(req).then(async (conta) => {
      if (!conta) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Não autenticado." }));
        return;
      }
      try {
        const todosOsArquivos = R2_ENABLED
          ? await listR2Media()
          : await (async () => {
              const dir = path.join(__dirname, "videos");
              if (!fs.existsSync(dir)) fs.mkdirSync(dir);
              const allFiles = await fs.promises.readdir(dir);
              return allFiles.filter((f) => !f.startsWith(".") && MEDIA_EXT_REGEX.test(f));
            })();

        const admIdPadrao = await contasAdmin.buscarPrimeiroAdmId();
        await midiaOwnership.garantirDonos(todosOsArquivos, admIdPadrao);

        const donos = await midiaOwnership.donosPorArquivo();
        const isAdmin = conta.role === "adm";
        const arquivosDaConta = todosOsArquivos.filter((nome) => {
          const donoId = donos.get(nome);
          return isAdmin || donoId === conta.id;
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(arquivosDaConta));
      } catch (err) {
        console.error("Erro ao listar mídia:", err);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Erro ao listar mídia no armazenamento." }));
      }
    }).catch((err) => {
      console.error("Erro ao checar sessão em /videos-list:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro ao checar sessão." }));
    });
    return;
  }

  // ---------- PLAYLISTS API — isolada por conta (Fase 4) ----------
  // Playlists agora moram no banco (tabela `playlists`, ver lib/playlists.js)
  // em vez do playlists.json antigo — sobrevivem a deploys e cada uma
  // pertence a uma conta. Cliente vê só as próprias; ADM vê as de todo mundo
  // (mesmo padrão de visibilidade já usado pras TVs na Fase 3).

  if (urlPath === "/playlists" && req.method === "GET") {
    auth.contaDaRequisicao(req).then(async (conta) => {
      if (!conta) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Não autenticado." }));
        return;
      }
      try {
        const linhas = await playlistsDb.listar(conta.id, conta.role === "adm");
        const resposta = {};
        linhas.forEach((row) => { resposta[row.id] = playlistParaResposta(row); });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resposta));
      } catch (err) {
        console.error("Erro ao listar playlists:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Erro ao carregar playlists." }));
      }
    }).catch((err) => {
      console.error("Erro ao checar sessão em GET /playlists:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro ao checar sessão." }));
    });
    return;
  }

  if (urlPath === "/playlists" && req.method === "POST") {
    auth.contaDaRequisicao(req).then((conta) => {
      if (!conta) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Não autenticado." }));
        return;
      }
      readJsonBody(req, res, async (body) => {
        try {
          const playlist = JSON.parse(body);
          if (!playlist.name || !playlist.name.trim()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Nome da playlist é obrigatório." }));
            return;
          }
          if (!Array.isArray(playlist.videos) || playlist.videos.length === 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "A playlist deve ter ao menos 1 item." }));
            return;
          }
          const videos = normalizarItensPlaylist(playlist.videos);
          if (!videos.length) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Nenhum item válido na playlist." }));
            return;
          }

          const nome = playlist.name.trim();
          const idExistente = parseInt(playlist.id, 10);
          let salva;

          if (Number.isFinite(idExistente)) {
            const atual = await playlistsDb.buscarPorId(idExistente);
            if (!atual) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Playlist não encontrada." }));
              return;
            }
            if (conta.role !== "adm" && atual.conta_id !== conta.id) {
              res.writeHead(403, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Essa playlist não pertence à sua conta." }));
              return;
            }
            salva = await playlistsDb.atualizar(idExistente, nome, videos);
          } else {
            salva = await playlistsDb.criar(conta.id, nome, videos);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(playlistParaResposta(salva)));
        } catch (err) {
          if (err instanceof SyntaxError) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "JSON inválido." }));
            return;
          }
          console.error("Erro ao salvar playlist:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Erro no servidor ao salvar a playlist." }));
        }
      });
    }).catch((err) => {
      console.error("Erro ao checar sessão em POST /playlists:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro ao checar sessão." }));
    });
    return;
  }

  if (urlPath.startsWith("/playlists/") && req.method === "DELETE") {
    const id = parseInt(urlPath.slice("/playlists/".length), 10);
    auth.contaDaRequisicao(req).then(async (conta) => {
      if (!conta) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Não autenticado." }));
        return;
      }
      if (!Number.isFinite(id)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Id inválido." }));
        return;
      }
      try {
        const atual = await playlistsDb.buscarPorId(id);
        if (!atual) {
          // Já não existe (ou nunca existiu) — DELETE é idempotente, trata
          // como sucesso mesmo assim, igual o comportamento de sempre.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (conta.role !== "adm" && atual.conta_id !== conta.id) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Essa playlist não pertence à sua conta." }));
          return;
        }
        await playlistsDb.excluir(id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("Erro ao excluir playlist:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Erro no servidor ao excluir a playlist." }));
      }
    }).catch((err) => {
      console.error("Erro ao checar sessão em DELETE /playlists:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro ao checar sessão." }));
    });
    return;
  }

  if (req.method === "DELETE" && urlPath.startsWith("/delete-video")) {
    const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const rawName = reqUrl.searchParams.get("name") || "";
    const safeName = path.basename(rawName);

    if (!safeName) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Nome de arquivo inválido." }));
      return;
    }

    auth.contaDaRequisicao(req).then(async (conta) => {
      if (!conta) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Não autenticado." }));
        return;
      }

      // Checagem de posse: só o dono do arquivo (ou o ADM) pode apagar.
      // Um arquivo ainda sem dono registrado (órfão de antes da Fase 4) é
      // adotado pela conta ADM na hora, igual já acontece em /videos-list —
      // assim só o ADM consegue apagar mídia órfã, ninguém mais.
      let donoId = await midiaOwnership.donoDoArquivo(safeName);
      if (donoId == null) {
        const admIdPadrao = await contasAdmin.buscarPrimeiroAdmId();
        await midiaOwnership.garantirDonos([safeName], admIdPadrao);
        donoId = admIdPadrao;
      }
      if (conta.role !== "adm" && donoId !== conta.id) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Esse arquivo não pertence à sua conta." }));
        return;
      }

      if (R2_ENABLED) {
        deleteFromR2(safeName)
          .then(async () => {
            await midiaOwnership.removerArquivo(safeName);
            await playlistsDb.removerArquivoDeTodas(safeName);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          })
          .catch((err) => {
            console.error("Erro ao excluir do R2:", err);
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Erro ao excluir do armazenamento (R2)." }));
          });
        return;
      }

      const dir = path.join(__dirname, "videos");
      const targetPath = path.join(dir, safeName);
      const safeRoot = path.resolve(dir) + path.sep;

      if (!path.resolve(targetPath).startsWith(safeRoot)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Nome de arquivo inválido." }));
        return;
      }
      if (!fs.existsSync(targetPath)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Arquivo não encontrado." }));
        return;
      }
      fs.unlink(targetPath, async (err) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Erro ao excluir o arquivo." }));
          return;
        }
        await midiaOwnership.removerArquivo(safeName);
        await playlistsDb.removerArquivoDeTodas(safeName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    }).catch((err) => {
      console.error("Erro ao checar sessão/posse em DELETE /delete-video:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro ao checar sessão." }));
    });
    return;
  }

  // Upload direto pro R2: o navegador faz o PUT do arquivo direto pro bucket,
  // sem passar pelo Render — essa rota só devolve uma URL assinada de curta
  // duração (5 min) autorizando esse PUT num nome específico. Isso existe
  // porque um upload de alguns minutos de vídeo passando pelo processo do
  // servidor (mesmo sem transcodificar) ainda soma banda/tempo de conexão;
  // tirando o arquivo do caminho do Render inteiramente, o servidor nunca
  // mais vê o peso do vídeo em si — só troca essa mensagem pequena.
  if (req.method === "GET" && urlPath === "/request-upload") {
    if (!R2_ENABLED) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Upload direto só está disponível com o armazenamento R2 configurado." }));
      return;
    }
    auth.contaDaRequisicao(req).then((conta) => {
      if (!conta) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Não autenticado." }));
        return;
      }
      const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const rawName = reqUrl.searchParams.get("name") || "media";
      const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, "_").trim();
      if (!safeName || !UPLOAD_EXT_REGEX.test(safeName)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Formato não suportado. Vídeos: apenas .mp4. Imagens: .jpg, .png ou .webp." }));
        return;
      }
      // Tamanho informado pelo próprio navegador (igual ao Content-Length de
      // antes) — só usado pra checar o teto de armazenamento com antecedência;
      // não é uma garantia, é a mesma confiança de antes no que o cliente diz.
      const incomingBytes = parseInt(reqUrl.searchParams.get("size"), 10) || 0;

      wouldExceedStorageCap(incomingBytes).then((overCap) => {
        if (overCap) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: `Armazenamento no limite configurado (${R2_MAX_STORAGE_GB}GB). Apague vídeos antigos ou aumente o limite (R2_MAX_STORAGE_GB) antes de enviar mais.`,
          }));
          return;
        }
        getUniqueFilename(null, safeName).then((finalName) => {
          const contentType = mimeForName(finalName);
          const command = new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: finalName,
            ContentType: contentType,
          });
          getSignedUrl(s3Client, command, { expiresIn: 300 })
            .then(async (url) => {
              // Registra o dono já aqui, com o nome final reservado — o
              // servidor nunca vai ver o PUT em si acontecer (vai direto
              // navegador→R2), então este é o único ponto em que dá pra
              // saber de quem é esse arquivo. Se o upload falhar depois
              // (raro), fica uma linha órfã sem arquivo nenhum atrás dela —
              // inofensivo, nunca aparece em nenhuma listagem porque a
              // listagem sempre parte do que existe DE VERDADE no bucket.
              await midiaOwnership.registrarArquivo(finalName, conta.id);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ url, filename: finalName, contentType }));
            })
            .catch((err) => {
              console.error("Erro ao gerar URL de upload assinada:", err);
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Erro ao preparar o upload no armazenamento (R2)." }));
            });
        }).catch((err) => {
          console.error("Erro ao checar nome único no armazenamento:", err);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Erro ao verificar o armazenamento (R2) antes do upload. Tente de novo." }));
        });
      }).catch((err) => {
        console.error("Erro ao checar teto de armazenamento no R2:", err);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Erro ao checar o armazenamento (R2) antes do upload. Tente de novo." }));
      });
    }).catch((err) => {
      console.error("Erro ao checar sessão em /request-upload:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro ao checar sessão." }));
    });
    return;
  }

  // Upload pelo próprio servidor: usado só no modo disco local (sem R2
  // configurado), onde não existe bucket pra apontar uma URL direta. O
  // arquivo é salvo exatamente como chegou — sem nenhuma reconversão.
  if (req.method === "POST" && req.url.startsWith("/upload-video")) {
    // Checa a sessão ANTES de tocar no corpo da requisição (o arquivo em
    // si) — auth.contaDaRequisicao só lê os cookies/headers, não consome o
    // stream, então é seguro fazer essa checagem primeiro.
    auth.contaDaRequisicao(req).then((conta) => {
      if (!conta) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Não autenticado." }));
        req.destroy();
        return;
      }

      const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const rawName = reqUrl.searchParams.get("name") || "media";
      const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, "_").trim();
      if (!safeName || !UPLOAD_EXT_REGEX.test(safeName)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Formato não suportado. Vídeos: apenas .mp4. Imagens: .jpg, .png ou .webp." }));
        req.destroy();
        return;
      }
      const dir = path.join(__dirname, "videos");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);

      const incomingBytes = parseInt(req.headers["content-length"], 10) || 0;
      wouldExceedStorageCap(incomingBytes).then((overCap) => {
        if (overCap) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: `Armazenamento no limite configurado (${R2_MAX_STORAGE_GB}GB). Apague vídeos antigos ou aumente o limite (R2_MAX_STORAGE_GB) antes de enviar mais.`,
          }));
          req.destroy();
          return;
        }
        startUploadReceive();
      }).catch((err) => {
        console.error("Erro ao checar teto de armazenamento no R2:", err);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Erro ao checar o armazenamento (R2) antes do upload. Tente de novo." }));
        req.destroy();
      });

      function startUploadReceive() {
      // O nome final depende de checar se já existe (no R2 ou localmente), e
      // isso agora é assíncrono — então só começamos a receber o corpo da
      // requisição (o arquivo) depois de decidir o nome.
      getUniqueFilename(dir, safeName).then((finalName) => {
        const destPath = path.join(dir, finalName);
        const writeStream = fs.createWriteStream(destPath);
        let failed = false;
        req.on("aborted", () => {
          failed = true; writeStream.destroy(); fs.unlink(destPath, () => {});
        });
        writeStream.on("error", () => {
          failed = true;
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Erro ao salvar o arquivo no disco." }));
          }
          fs.unlink(destPath, () => {});
        });
        writeStream.on("finish", () => {
          if (failed) return;
          midiaOwnership.registrarArquivo(finalName, conta.id)
            .catch((err) => console.error("Erro ao registrar dono do arquivo (upload segue normalmente):", err))
            .finally(() => respondUploadSuccess(res, destPath, finalName));
        });
        req.pipe(writeStream);
      }).catch((err) => {
        console.error("Erro ao checar nome único no armazenamento:", err);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Erro ao verificar o armazenamento (R2) antes do upload. Tente de novo." }));
        req.destroy();
      });
      } // fim de startUploadReceive()
    }).catch((err) => {
      console.error("Erro ao checar sessão em /upload-video:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Erro ao checar sessão." }));
      req.destroy();
    });

    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end("Not found"); return;
  }
  res.writeHead(200, { "Content-Type": mime[ext] || "text/plain" });
  fs.createReadStream(filePath).pipe(res);
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ server });
const tvs = new Map();
const controllers = new Set();

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Alguma conexão de controlador da conta `contaId` está online agora? ADM
// conta como "online" pra QUALQUER conta (visão de super-admin, decisão
// tomada junto com o resto da Fase 3) — então uma TV de um cliente mostra
// "controlador conectado" tanto quando é o dono dela quanto quando é um ADM
// dando suporte.
function controllersOnlineParaConta(contaId) {
  for (const c of controllers) {
    if (c.readyState !== 1) continue;
    if (c._role === "adm" || c._accountId === contaId) return true;
  }
  return false;
}

// Pra uma TV ainda SEM DONO, "controlador da conta" não existe (ela não tem
// conta ainda) — mas isso não significa que ninguém está no ar: qualquer
// controlador logado (de qualquer conta, e claro, o ADM) pode parear essa TV
// agora mesmo, bastando digitar o código dela. Reportar "offline" pra uma TV
// não pareada mesmo com o ADM logado na tela ao lado é enganoso (bug visto
// em produção, 2026-08-10) — então aqui o critério é só "existe ALGUM
// controlador conectado", sem checar dono nenhum.
function algumControladorOnline() {
  for (const c of controllers) {
    if (c.readyState === 1) return true;
  }
  return false;
}

// Recalcula e reenvia o status de "controlador online" pra cada TV
// conectada agora. Chamado sempre que algum controlador entra ou sai do ar.
// TVs já pareadas só se importam com os controladores da PRÓPRIA conta (+
// ADM); TVs ainda sem dono mostram "online" se QUALQUER controlador estiver
// no ar (ver algumControladorOnline() acima).
function notifyAllTvs() {
  const semDonoOnline = algumControladorOnline();
  tvs.forEach((tv) => {
    if (tv.ws.readyState !== 1) return;
    const online = tv.contaId != null ? controllersOnlineParaConta(tv.contaId) : semDonoOnline;
    tv.ws.send(JSON.stringify({ type: "controller_status", online }));
  });
}

// Um controlador só pode mandar comando (play/pause/stop/...) pra uma TV
// que seja da PRÓPRIA conta — ou qualquer TV, se for ADM (mesma visão de
// super-admin da listagem). Sem essa checagem, uma vez que existissem
// várias contas usando o mesmo servidor, o código (efêmero, só de uso
// interno) de uma TV de outra empresa ainda seria endereçável se alguém
// adivinhasse ou capturasse ele.
function podeControlarTv(tv, ws) {
  return !!tv && (ws._role === "adm" || tv.contaId === ws._accountId);
}

function sendTvListToController(ws) {
  if (ws.readyState !== 1) return;
  const isAdmin = ws._role === "adm";
  // TVs ainda não pareadas (contaId null) nunca aparecem em lista nenhuma
  // — nem pro ADM. A única forma de "achar" uma TV nova é pelo código de
  // pareamento mostrado na tela dela, não navegando uma lista.
  const list = Array.from(tvs.entries())
    .filter(([, t]) => t.contaId != null && (isAdmin || t.contaId === ws._accountId))
    .map(([code, t]) => ({
      code,
      name: t.name,
      video: t.video,
      playlist: t.playlist || null,
      paused: t.paused,
      connected: t.ws.readyState === 1,
      tvRowId: t.tvRowId,
    }));
  ws.send(JSON.stringify({ type: "tv_list", tvs: list }));
}

// Reenvia a lista de TVs para todos os controladores conectados
function broadcastTvList() {
  controllers.forEach((ws) => sendTvListToController(ws));
}

wss.on("connection", (ws, req) => {
  // O handshake HTTP de upgrade carrega os mesmos headers da requisição
  // original, inclusive o cookie de sessão — guardamos aqui pra validar
  // quando (e se) essa conexão se identificar como controlador logo abaixo.
  // TVs não têm sessão (a identidade delas é o device_id do pareamento, ver
  // lib/tvs.js), então isso não afeta o fluxo delas.
  const cookiesDoHandshake = auth.parseCookies(req);

  // Heartbeat (ver relatório de riscos de travamento, 2026-08-10): marca a
  // conexão como "viva" agora, e de novo a cada "pong" que ela responder. O
  // ws.ping()/terminate() periódico logo abaixo usa essa flag pra descobrir
  // TVs/controladores "zumbis" — conexões que a rede deixou pra trás sem
  // fechar de forma limpa (comum em Wi-Fi instável) — e derrubá-las, em vez
  // de deixá-las paradas na lista enganando quem está controlando.
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "controller_connect") {
      // Conexão direta: sem código de sala. Todo controlador logado enxerga
      // e controla as TVs PAREADAS COM A PRÓPRIA CONTA (ou todas, se for
      // ADM) — ver sendTvListToController() e podeControlarTv().
      const token = cookiesDoHandshake[auth.SESSION_COOKIE_NAME];
      auth.contaPorToken(token).then((conta) => {
        if (!conta) {
          ws.send(JSON.stringify({
            type: "auth_error",
            message: "Sessão inválida ou expirada. Faça login novamente.",
          }));
          ws.close();
          return;
        }
        ws._accountId = conta.id;
        ws._role = conta.role;
        controllers.add(ws);
        sendTvListToController(ws);
        notifyAllTvs();
      }).catch((err) => {
        console.error("Erro ao validar sessão do controlador no WebSocket:", err);
        ws.send(JSON.stringify({
          type: "auth_error",
          message: "Erro ao validar sua sessão. Recarregue a página e tente de novo.",
        }));
        ws.close();
      });
      return;
    }

    if (msg.type === "tv_connect") {
      // deviceId é gerado e guardado no localStorage da própria TV (ver
      // js/tv.js) — é o que permite reconhecer "essa é a mesma TV de
      // sempre" mesmo com o código de sessão (variável `code` abaixo)
      // mudando a cada reconexão. Sem deviceId (TV rodando um tv.js antigo,
      // de antes da 0.4, ainda em cache), a TV funciona só enquanto durar
      // esta conexão — sem pareamento, e some da lista de qualquer um assim
      // que desconectar, exatamente como era antes da Fase 3.
      const deviceId = typeof msg.deviceId === "string" && msg.deviceId ? msg.deviceId.slice(0, 100) : null;
      const nomeSugerido = msg.name;

      const registrarSemPareamento = () => {
        const code = generateCode();
        tvs.set(code, {
          ws, deviceId: null, tvRowId: null, contaId: null,
          name: nomeSugerido || `TV ${tvs.size + 1}`,
          video: null, playlist: null, paused: false,
        });
        ws._tvCode = code;
        ws.send(JSON.stringify({ type: "your_code", code, paired: false, pairingCode: null, semPareamento: true }));
        ws.send(JSON.stringify({ type: "controller_status", online: algumControladorOnline() }));
      };

      if (!deviceId) { registrarSemPareamento(); return; }

      tvsPareamento.buscarOuCriarPorDeviceId(deviceId, nomeSugerido).then((registro) => {
        const code = generateCode();
        const paired = registro.conta_id != null;
        tvs.set(code, {
          ws,
          deviceId,
          tvRowId: registro.id,
          contaId: registro.conta_id,
          name: nomeSugerido || registro.nome || `TV ${tvs.size + 1}`,
          video: null,
          playlist: null,
          paused: false,
        });
        ws._tvCode = code;
        ws.send(JSON.stringify({
          type: "your_code",
          code,
          paired,
          pairingCode: paired ? null : registro.codigo_pareamento,
        }));
        ws.send(JSON.stringify({
          type: "controller_status",
          online: paired ? controllersOnlineParaConta(registro.conta_id) : algumControladorOnline(),
        }));
        broadcastTvList();
      }).catch((err) => {
        console.error("Erro ao registrar/parear TV (seguindo sem pareamento nesta conexão):", err);
        registrarSemPareamento();
      });
      return;
    }

    if (msg.type === "tv_set_name") {
      const tv = tvs.get(ws._tvCode);
      if (tv) {
        tv.name = msg.name;
        broadcastTvList();
        if (tv.tvRowId) {
          tvsPareamento.atualizarNome(tv.tvRowId, msg.name).catch((err) => {
            console.error("Erro ao salvar nome da TV no banco (não crítico, nome já mudou na tela):", err);
          });
        }
      }
    }

    if (msg.type === "play") {
      const tv = tvs.get(msg.code);
      if (tv && tv.ws.readyState === 1 && podeControlarTv(tv, ws)) {
        tv.video = msg.video;
        tv.playlist = null;
        tv.paused = false;
        tv.ws.send(JSON.stringify({ type: "play", video: msg.video }));
        broadcastTvList();
      }
    }

    if (msg.type === "play_playlist") {
      const tv = tvs.get(msg.code);
      if (tv && tv.ws.readyState === 1 && podeControlarTv(tv, ws)) {
        tv.playlist = msg.playlist;
        tv.video = msg.playlist.videos[0] || null;
        tv.paused = false;
        tv.ws.send(JSON.stringify({ type: "play_playlist", playlist: msg.playlist }));
        broadcastTvList();
      }
    }

    if (msg.type === "pause") {
      const tv = tvs.get(msg.code);
      if (tv && tv.ws.readyState === 1 && podeControlarTv(tv, ws)) {
        tv.paused = true;
        tv.ws.send(JSON.stringify({ type: "pause" }));
        broadcastTvList();
      }
    }

    if (msg.type === "resume") {
      const tv = tvs.get(msg.code);
      if (tv && tv.ws.readyState === 1 && podeControlarTv(tv, ws)) {
        tv.paused = false;
        tv.ws.send(JSON.stringify({ type: "resume" }));
        broadcastTvList();
      }
    }

    if (msg.type === "stop") {
      const tv = tvs.get(msg.code);
      if (tv && tv.ws.readyState === 1 && podeControlarTv(tv, ws)) {
        tv.video = null;
        tv.playlist = null;
        tv.paused = false;
        tv.ws.send(JSON.stringify({ type: "stop" }));
        broadcastTvList();
      }
    }

    if (msg.type === "enter_fullscreen") {
      const tv = tvs.get(msg.code);
      if (tv && tv.ws.readyState === 1 && podeControlarTv(tv, ws)) tv.ws.send(JSON.stringify({ type: "enter_fullscreen" }));
    }

    if (msg.type === "exit_fullscreen") {
      const tv = tvs.get(msg.code);
      if (tv && tv.ws.readyState === 1 && podeControlarTv(tv, ws)) tv.ws.send(JSON.stringify({ type: "exit_fullscreen" }));
    }

    if (msg.type === "broadcast") {
      // "Transmitir pra todas" agora quer dizer "todas as TVs DA MINHA
      // CONTA" — pra uma conta cliente. Só o ADM de fato alcança TVs de
      // todo mundo aqui, igual em tudo mais (visão de super-admin).
      const isAdmin = ws._role === "adm";
      tvs.forEach((tv) => {
        if (tv.ws.readyState !== 1) return;
        if (!isAdmin && tv.contaId !== ws._accountId) return;
        tv.video = msg.video;
        tv.playlist = null;
        tv.paused = false;
        tv.ws.send(JSON.stringify({ type: "play", video: msg.video }));
      });
      broadcastTvList();
    }
  });

  ws.on("close", () => {
    const eraControlador = controllers.delete(ws);
    if (eraControlador) {
      // Alguém saiu do ar — recalcula o status de "controlador online" de
      // cada TV (pode ter sido o único controlador daquela conta).
      notifyAllTvs();
    }
    if (ws._tvCode) { tvs.delete(ws._tvCode); broadcastTvList(); }
  });
});

// A cada 30s, cutuca (ping) toda conexão aberta. Quem não respondeu ao
// ping anterior (ws.isAlive ainda false) é considerado zumbi e derrubado
// com terminate() — isso dispara o "close" normal dela lá em cima, que já
// limpa `tvs`/`controllers` e avisa quem precisa saber. Quem respondeu tem
// a flag resetada pra false até o próximo ciclo confirmar de novo.
const HEARTBEAT_INTERVAL_MS = 30000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeatInterval));

const videosDir = path.join(__dirname, "videos");
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir);

server.requestTimeout = 0;

// Migração de uma vez só (Fase 4): se o playlists.json antigo ainda
// existir (só sobrevive se nenhum deploy/reinício aconteceu entre a Fase 3
// e esta), move o conteúdo dele pro banco, atribuído à conta ADM mais
// antiga. Roda em paralelo com o boot do servidor — não atrasa ele
// começar a aceitar conexões, só loga o resultado quando terminar.
contasAdmin.buscarPrimeiroAdmId()
  .then((admId) => playlistsDb.migrarDeArquivoSeNecessario(admId))
  .catch((err) => console.error("Erro ao checar/migrar playlists.json antigo (não é crítico):", err));

// A porta é sempre definida pelo ambiente de hospedagem (Render define PORT
// automaticamente). O valor fixo abaixo é apenas o padrão quando a variável
// não existe.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor rodando na porta ${PORT} (VisionLoop v${APP_VERSION})`);
  console.log(`📺 Controlador: /controller.html`);
  console.log(`📺 TV receiver: /tv.html`);
  if (R2_ENABLED) {
    console.log(`☁️  Armazenamento de mídia: Cloudflare R2 (bucket "${R2_BUCKET_NAME}", URL pública ${R2_PUBLIC_BASE_URL})`);
  } else {
    console.log(`💾 Armazenamento de mídia: disco local (${videosDir})`);
    console.log(`   Defina R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME e R2_PUBLIC_BASE_URL para usar o Cloudflare R2.`);
  }
});
