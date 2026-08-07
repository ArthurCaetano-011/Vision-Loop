// ==================== FORMATOS ACEITOS ====================
// Apenas formatos de uso comum. Vídeo: .mp4 (universal), .mov (padrão do
// iPhone) e .webm. Imagem: .jpg/.jpeg, .png e .webp.
// Declarados aqui no topo porque são usados por funções de todo o arquivo.
const UPLOAD_EXT_REGEX = /\.(mp4|jpg|jpeg|png|webp)$/i;
const IMAGE_EXT_REGEX = /\.(jpg|jpeg|png|webp)$/i;

// Tempo de exibição das imagens na playlist (vídeos tocam até o fim).
const IMAGE_DURATION_DEFAULT = 10; // segundos
const IMAGE_DURATION_MIN = 1;
const IMAGE_DURATION_MAX = 300;

// ==================== STATE ====================
let ws;
let tvs = [];
let selectedTvCode = null;
let selectedVideo = null;
let broadcastVideo = null;
let videos = [];
let playlists = {};
let selectedPlaylistId = null;
let editingPlaylistId = null;    // null = nova playlist
let plSelectedVideos = [];       // vídeos escolhidos no form (em ordem)
let plSelectedDurations = {};    // duração (em segundos) para cada item da playlist
let r2Enabled = false;           // define se o upload vai direto pro R2 (sem passar pelo servidor)

// ==================== WebSocket ====================
function connect() {
  // O endereço do servidor é sempre o próprio host que serviu esta página
  // (ex: visionloop.onrender.com), então não há configuração manual de IP.
  // Conexão direta: não existe mais código de sala — todo controlador que
  // abrir esta página já enxerga e controla todas as TVs conectadas.
  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${wsProtocol}//${location.host}`);
  ws.onopen = () => {
    setStatus(true);
    ws.send(JSON.stringify({ type: 'controller_connect' }));
    loadVideos();
    loadPlaylists();
    loadStorageUsage();
  };
  ws.onclose = () => { setStatus(false); setTimeout(connect, 2000); };
  ws.onerror = (err) => console.error("WebSocket Error:", err);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'tv_list') {
      const fsMap = {};
      tvs.forEach(t => { if (t.fullscreen) fsMap[t.code] = true; });
      tvs = msg.tvs.map(t => ({ ...t, fullscreen: !!fsMap[t.code] }));
      renderTvList();
      if (selectedTvCode) updatePanel();
      renderPlTvSelect();
    }
  };
}

function setStatus(ok) {
  document.getElementById('statusDot').className = 'status-dot' + (ok ? ' ok' : '');
  document.getElementById('statusText').textContent = ok ? 'Conectado' : 'Reconectando...';
}

// ==================== VERSÃO ====================
function loadVersion() {
  fetch('/version')
    .then(r => r.json())
    .then(d => {
      if (d.version) document.getElementById('appVersion').textContent = 'v' + d.version;
      r2Enabled = !!d.r2Enabled;
    })
    .catch(() => {});
}

// ==================== ARMAZENAMENTO ====================
function loadStorageUsage() {
  fetch('/storage-usage')
    .then(r => { if (!r.ok) throw new Error(); return r.json(); })
    .then(d => {
      const el = document.getElementById('storageUsage');
      const valueEl = document.getElementById('storageUsageValue');
      const gb = d.gb.toFixed(2);
      valueEl.textContent = d.capGb ? `${gb} GB de ${d.capGb} GB usados` : `${gb} GB usados`;
      el.style.display = 'flex';
    })
    .catch(() => {});
}

// A função switchTab() foi removida junto com a barra de abas: as áreas de
// mídia/TV e de playlists agora aparecem juntas na mesma tela, então não há
// mais nada para alternar. Nenhuma outra parte do código a chamava.

// ==================== VIDEOS ====================
function loadVideos(btn) {
  if (btn && btn.tagName === 'BUTTON') { btn.textContent = '...'; btn.disabled = true; }
  fetch('/videos-list')
    .then(r => { if (!r.ok) throw new Error('Erro no servidor'); return r.json(); })
    // Busca a validade junto: os selos precisam dela para serem desenhados.
    .then(list => loadMediaMeta().then(() => list))
    .then(list => {
      videos = list;
      renderVideoGrid();
      renderBroadcastList();
      renderPlVideoGrid();
    })
    .catch(err => {
      console.error("Erro ao carregar vídeos:", err);
      alert("Erro ao carregar lista de vídeos.");
    })
    .finally(() => {
      if (btn && btn.tagName === 'BUTTON') { btn.textContent = '↻ atualizar'; btn.disabled = false; }
    });
}

function renderVideoGrid() {
  const grid = document.getElementById('videoGrid');
  if (!videos.length) {
    grid.innerHTML = `<div style="color:var(--muted);font-size:12px;grid-column:1/-1;">
      Nenhum vídeo encontrado. Coloque arquivos .mp4 ou .webm na pasta <code style="font-family:monospace">videos/</code>.
    </div>`;
    return;
  }
  grid.innerHTML = videos.map(v => {
    const isImg = IMAGE_EXT_REGEX.test(v);
    const thumbStyle = isImg ? `style="background-image: url('/videos/${encodeURIComponent(v)}');"` : '';
    return `
      <div class="video-item ${selectedVideo === v ? 'selected' : ''}" onclick="selectVideo('${v.replace(/'/g,"\\'")}')">
        ${expiryBadgeHtml(v)}
        <button class="video-delete-btn" onclick="deleteVideo('${v.replace(/'/g,"\\'")}', event)" title="Excluir">🗑</button>
        <div class="video-thumb" ${thumbStyle}>${isImg ? '' : '🎬'}</div>
        <div class="video-name">${v}</div>
      </div>`;
  }).join('');
}

function deleteVideo(name, event) {
  if (event) event.stopPropagation();
  if (!confirm(`Excluir "${name}"?\n\nEssa ação apaga o arquivo do servidor (e de qualquer playlist que o use) e não pode ser desfeita.`)) return;
  fetch('/delete-video?name=' + encodeURIComponent(name), { method: 'DELETE' })
    .then(r => { if (!r.ok) return r.json().then(d => { throw new Error(d.error || 'Erro ao excluir'); }); return r.json(); })
    .then(() => {
      if (selectedVideo === name) selectedVideo = null;
      if (broadcastVideo === name) broadcastVideo = null;
      // Reflete a remoção imediatamente no formulário de playlist aberto (se
      // o vídeo excluído estivesse selecionado ali), sem esperar o usuário
      // reabrir a playlist para perceber a inconsistência.
      const idx = plSelectedVideos.indexOf(name);
      if (idx !== -1) {
        plSelectedVideos.splice(idx, 1);
        delete plSelectedDurations[name];
        renderPlOrderList();
      }
      loadVideos();
      loadPlaylists();
      loadStorageUsage();
    })
    .catch(err => alert('Erro ao excluir: ' + err.message));
}

function renderBroadcastList() {
  const grid = document.getElementById('broadcastVideoList');
  if (!grid) return;
  if (!videos.length) {
    grid.innerHTML = `<div style="color:var(--muted);font-size:12px;grid-column:1/-1;">Nenhum vídeo na pasta videos/</div>`;
    return;
  }
  grid.innerHTML = videos.map(v => {
    const isImg = IMAGE_EXT_REGEX.test(v);
    const thumbStyle = isImg ? `style="background-image: url('/videos/${encodeURIComponent(v)}');"` : '';
    return `
    <div class="video-item ${broadcastVideo === v ? 'selected' : ''}" onclick="selectBroadcastVideo('${v.replace(/'/g,"\\'")}')">
      ${expiryBadgeHtml(v)}
      <button class="video-delete-btn" onclick="deleteVideo('${v.replace(/'/g,"\\'")}', event)" title="Excluir">🗑</button>
      <div class="video-thumb" ${thumbStyle}>${isImg ? '' : '🎬'}</div>
      <div class="video-name">${v}</div>
    </div>`;
  }).join('');
}

function selectBroadcastVideo(v) {
  broadcastVideo = v;
  renderBroadcastList();
  document.getElementById('broadcastBtn').disabled = !broadcastVideo;
}

function selectVideo(v) {
  selectedVideo = v;
  if (selectedTvCode) ws.send(JSON.stringify({ type: 'play', code: selectedTvCode, video: v }));
  renderVideoGrid();
}

// ==================== TV LIST ====================
function renderTvList() {
  const list = document.getElementById('tvList');
  document.getElementById('tvCount').textContent = tvs.length;
  if (!tvs.length) {
    list.innerHTML = `<div class="empty-tvs"><img src="/assets/empty-tv.png" class="empty-tvs-img" alt=""><p>Nenhuma TV conectada.<br>Abra o site na TV e escolha <strong>TV</strong> — ela aparece aqui automaticamente.</p></div>`;
    return;
  }
  list.innerHTML = tvs.map(tv => {
    const statusClass = !tv.video ? '' : tv.paused ? 'paused' : 'playing';
    let statusLabel = !tv.video ? 'Aguardando' : tv.paused ? 'Pausado' : 'Reproduzindo';
    let extra = '';
    if (tv.playlist) extra = ' · 📋 ' + tv.playlist.name;
    else if (tv.video) extra = ' · ' + tv.video;
    return `
    <div class="tv-card ${selectedTvCode === tv.code ? 'selected' : ''}" onclick="selectTv('${tv.code}')">
      <div class="tv-card-top">
        <div class="tv-icon">📺</div>
        <div>
          <div class="tv-name">${tv.name}</div>
          <div class="tv-code-badge">${tv.code}</div>
        </div>
      </div>
      <div class="tv-status">
        <div class="dot ${statusClass}"></div>
        ${statusLabel}${extra}
      </div>
    </div>`;
  }).join('');
}

function selectTv(code) {
  selectedTvCode = code;
  selectedVideo = null;
  document.getElementById('noSelection').style.display = 'none';
  document.getElementById('tvPanel').style.display = 'flex';
  renderTvList();
  updatePanel();
  renderVideoGrid();
  closeTvPanel(); // fecha o painel dropdown ao escolher uma TV (sobretudo util no celular)
}

function deselectTv() {
  selectedTvCode = null;
  document.getElementById('noSelection').style.display = 'flex';
  document.getElementById('tvPanel').style.display = 'none';
  const btn = document.getElementById('btnFullscreen');
  btn.dataset.fs = '0'; btn.textContent = '⛶ Tela cheia'; btn.disabled = true;
  renderTvList();
}

function updatePanel() {
  const tv = tvs.find(t => t.code === selectedTvCode);
  if (!tv) return deselectTv();
  document.getElementById('panelTvName').textContent = tv.name;
  document.getElementById('panelTvCode').textContent = tv.code;

  const hasVideo = !!(tv.video || tv.playlist);
  document.getElementById('btnPause').disabled = !hasVideo || tv.paused;
  document.getElementById('btnResume').disabled = !hasVideo || !tv.paused;
  document.getElementById('btnStop').disabled = !hasVideo;

  const btn = document.getElementById('btnFullscreen');
  btn.disabled = false;
  btn.textContent = tv.fullscreen ? '⊡ Sair tela cheia' : '⛶ Tela cheia';
  btn.dataset.fs = tv.fullscreen ? '1' : '0';

  const nowBar = document.getElementById('nowPlayingBar');
  if (hasVideo) {
    nowBar.style.display = 'flex';
    if (tv.playlist) {
      document.getElementById('nowPlayingLabel').textContent = '🔁 Playlist em loop';
      document.getElementById('nowPlayingName').textContent = tv.playlist.name + ' (' + tv.playlist.videos.length + ' vídeo(s))';
    } else {
      document.getElementById('nowPlayingLabel').textContent = 'Reproduzindo agora';
      document.getElementById('nowPlayingName').textContent = tv.video;
    }
  } else {
    nowBar.style.display = 'none';
  }

  const statusEl = document.getElementById('panelTvStatus');
  if (!hasVideo) statusEl.innerHTML = '<span class="tag tag-muted">Aguardando</span>';
  else if (tv.paused) statusEl.innerHTML = '<span class="tag tag-amber">⏸ Pausado</span>';
  else statusEl.innerHTML = '<span class="tag tag-green">▶ Reproduzindo</span>';
}

function pauseTv() { if (selectedTvCode) ws.send(JSON.stringify({ type: 'pause', code: selectedTvCode })); }
function resumeTv() { if (selectedTvCode) ws.send(JSON.stringify({ type: 'resume', code: selectedTvCode })); }
function stopTv() { if (selectedTvCode) ws.send(JSON.stringify({ type: 'stop', code: selectedTvCode })); }
function toggleFullscreen() {
  if (!selectedTvCode) return;
  const tv = tvs.find(t => t.code === selectedTvCode);
  if (!tv) return;
  const isFs = !!tv.fullscreen;
  ws.send(JSON.stringify({ type: isFs ? 'exit_fullscreen' : 'enter_fullscreen', code: selectedTvCode }));
  tv.fullscreen = !isFs;
  updatePanel();
}
function broadcastSelected() {
  if (broadcastVideo) ws.send(JSON.stringify({ type: 'broadcast', video: broadcastVideo }));
}
function broadcastCurrent() {
  if (selectedVideo) ws.send(JSON.stringify({ type: 'broadcast', video: selectedVideo }));
  else if (selectedTvCode) {
    const tv = tvs.find(t => t.code === selectedTvCode);
    if (tv && tv.video) ws.send(JSON.stringify({ type: 'broadcast', video: tv.video }));
  }
}

// ==================== UPLOAD ====================
const MAX_IMAGE_DIMENSION = 1920; // px, no maior lado
const IMAGE_JPEG_QUALITY = 0.85;

// Redimensiona/comprime a imagem no navegador antes de enviar, pra evitar
// que fotos gigantes de celular (vários MB, 4000px+) travem a decodificação na TV.
function resizeImageIfNeeded(file) {
  if (!IMAGE_EXT_REGEX.test(file.name)) return Promise.resolve(file); // vídeos passam direto

  // TÓPICO 1: Proteção contra imagens gigantes que travam o navegador no redimensionamento.
  // Se o arquivo original for muito grande (ex: > 10MB), não tentamos redimensionar no canvas
  // para evitar estouro de memória/congelamento da aba.
  const MAX_FILE_SIZE_FOR_RESIZE = 10 * 1024 * 1024; // 10MB
  if (file.size > MAX_FILE_SIZE_FOR_RESIZE) {
    console.warn("Imagem muito grande para redimensionamento seguro no navegador. Enviando original.");
    return Promise.resolve(file);
  }

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const { width, height } = img;

      // Se já é pequena o suficiente, não mexe (evita recomprimir à toa)
      if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
        resolve(file);
        return;
      }

      const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      canvas.toBlob((blob) => {
        if (!blob) { resolve(file); return; } // falhou por algum motivo, manda o original
        const newName = file.name.replace(/\.(jpe?g|png|webp)$/i, '.jpg');
        resolve(new File([blob], newName, { type: 'image/jpeg' }));
      }, 'image/jpeg', IMAGE_JPEG_QUALITY);
    };

    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); }; // falhou, manda o original
    img.src = objectUrl;
  });
}

// onUploaded (opcional): chamado com o NOME FINAL de cada arquivo que subiu
// com sucesso. Usado pela zona de envio de dentro do formulário de playlist,
// para o arquivo recém-enviado já entrar na ordem de reprodução. O nome final
// pode ser diferente do escolhido no computador (o servidor acrescenta " (1)"
// quando já existe um arquivo com aquele nome), por isso quem o informa é o
// servidor, e não o navegador.
function setupDropzone(zoneId, inputId, listId, onUploaded) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  if (!zone || !input) return;
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { handleFiles(input.files, listId, onUploaded); input.value = ''; });
  ['dragenter', 'dragover'].forEach(evt => zone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); zone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(evt => zone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove('dragover');
  }));
  zone.addEventListener('drop', (e) => { handleFiles(e.dataTransfer.files, listId, onUploaded); });
}

// ==================== VALIDADE DA MÍDIA ====================
// Guarda o que o servidor sabe sobre validade: { "arquivo.mp4": {expiresAt} }.
let mediaMeta = {};

function loadMediaMeta() {
  return fetch('/media-meta')
    .then(r => r.ok ? r.json() : {})
    .then(d => { mediaMeta = d || {}; })
    .catch(() => { mediaMeta = {}; });
}

function formatExpiry(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Selo mostrado no canto do cartão de mídia que tem prazo para sair do ar.
// Fica em âmbar quando falta menos de 24h, para o vencimento não pegar de
// surpresa quem está olhando a biblioteca.
function expiryBadgeHtml(name) {
  const entry = mediaMeta[name];
  if (!entry || !entry.expiresAt) return '';
  const restante = new Date(entry.expiresAt).getTime() - Date.now();
  const classe = restante < 24 * 60 * 60 * 1000 ? 'expiry-badge soon' : 'expiry-badge';
  return `<div class="${classe}" title="Expira em ${formatExpiry(entry.expiresAt)}">⏳ ${formatExpiry(entry.expiresAt)}</div>`;
}

// O modal é resolvido por uma Promise: quem chama espera a decisão do usuário.
// Resolve com { cancelado: true } ou { expiresAt: <ISO|null> }.
let expiryResolver = null;

function onExpiryChoiceChange() {
  const querData = document.querySelector('input[name="expiryChoice"]:checked').value === 'date';
  document.getElementById('expiryField').classList.toggle('show', querData);
  document.getElementById('expiryError').textContent = '';
  if (querData) document.getElementById('expiryInput').focus();
}

function askExpiry(qtdArquivos) {
  return new Promise((resolve) => {
    expiryResolver = resolve;
    document.getElementById('expirySub').textContent = qtdArquivos > 1
      ? `Escolha até quando estes ${qtdArquivos} arquivos devem ficar no ar.`
      : 'Escolha até quando este conteúdo deve ficar no ar.';
    // Sempre reabre no padrão "sem validade" — a escolha não fica grudada de
    // um envio para o outro.
    document.querySelector('input[name="expiryChoice"][value="never"]').checked = true;
    document.getElementById('expiryInput').value = '';
    document.getElementById('expiryError').textContent = '';
    document.getElementById('expiryField').classList.remove('show');
    document.getElementById('expiryModal').classList.add('show');
  });
}

function closeExpiryModal(resultado) {
  document.getElementById('expiryModal').classList.remove('show');
  const resolve = expiryResolver;
  expiryResolver = null;
  if (resolve) resolve(resultado || { cancelado: true });
}

function confirmExpiry() {
  const querData = document.querySelector('input[name="expiryChoice"]:checked').value === 'date';
  if (!querData) { closeExpiryModal({ expiresAt: null }); return; }

  const valor = document.getElementById('expiryInput').value;
  const erro = document.getElementById('expiryError');
  if (!valor) { erro.textContent = 'Escolha a data e a hora de expiração.'; return; }
  // O campo devolve a hora LOCAL do navegador; convertemos para UTC (ISO) para
  // o servidor comparar sem depender do fuso de quem enviou.
  const quando = new Date(valor);
  if (isNaN(quando)) { erro.textContent = 'Data inválida.'; return; }
  if (quando.getTime() <= Date.now()) { erro.textContent = 'A data precisa estar no futuro.'; return; }
  closeExpiryModal({ expiresAt: quando.toISOString() });
}

function handleFiles(fileList, listId, onUploaded) {
  // Monta uma fila apenas com os arquivos válidos/confirmados e processa
  // um de cada vez (em vez de disparar todos os uploads em paralelo).
  const queue = [];
  Array.from(fileList || []).forEach(file => {
    if (!UPLOAD_EXT_REGEX.test(file.name)) {
      alert(`Formato não suportado: ${file.name}\nVídeos: apenas .mp4. Imagens: .jpg, .png ou .webp.`);
      return;
    }

    // TÓPICO 6: Limitação de Memória da TV.
    // TVs geralmente têm pouca RAM. Recomendamos arquivos de no máximo 50MB.
    // Imagens são redimensionadas, mas vídeos grandes podem travar a TV.
    const MAX_RECOMMENDED_SIZE = 50 * 1024 * 1024; // 50MB
    if (file.size > MAX_RECOMMENDED_SIZE) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      const proceed = confirm(`Atenção: O arquivo "${file.name}" é muito grande (${sizeMB}MB).\n\nSmart TVs possuem memória RAM limitada e vídeos acima de 50MB podem causar travamentos ou fechamento do aplicativo.\n\nDeseja continuar o upload mesmo assim?`);
      if (!proceed) return;
    }

    queue.push(file);
  });

  if (!queue.length) return;

  // A escolha da validade é feita UMA vez por envio e vale para todos os
  // arquivos daquela leva. Cancelar aqui cancela o envio inteiro.
  askExpiry(queue.length).then((decisao) => {
    if (!decisao || decisao.cancelado) return;
    processUploadQueue(queue, listId, onUploaded, decisao.expiresAt);
  });
}

// Processa a fila sequencialmente: só começa o próximo upload depois que o
// anterior terminar (com sucesso ou erro). Isso evita que vários vídeos
// grandes sejam enviados/transcodificados ao mesmo tempo, o que sobrecarrega
// a rede local e o servidor (ffmpeg) quando há vários arquivos de uma vez.
async function processUploadQueue(files, listId, onUploaded, expiresAt) {
  for (const file of files) {
    const finalFile = await resizeImageIfNeeded(file);
    await uploadFile(finalFile, listId, onUploaded, expiresAt);
  }
}

function uploadFile(file, listId, onUploaded, expiresAt) {
  return new Promise((resolve) => {
    const list = document.getElementById(listId);
    if (!list) { resolve(); return; }
    const itemId = 'up-' + Math.random().toString(36).slice(2);
    const isImg = IMAGE_EXT_REGEX.test(file.name);
    const item = document.createElement('div');
    item.className = 'upload-item'; item.id = itemId;
    item.innerHTML = `
      <span>${isImg ? '🖼' : '🎬'}</span>
      <div class="name">${file.name}</div>
      <div class="upload-bar-track"><div class="upload-bar-fill" id="${itemId}-bar"></div></div>
      <div class="upload-pct" id="${itemId}-pct">0%</div>
    `;
    list.prepend(item);

    const onProgress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      const bar = document.getElementById(itemId + '-bar');
      const pctEl = document.getElementById(itemId + '-pct');
      if (bar) bar.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
    };
    const onDone = (ok, errMsg, finalName) => {
      const el = document.getElementById(itemId);
      if (ok && onUploaded && finalName) onUploaded(finalName);
      if (!el) { resolve(); return; }
      if (ok) {
        el.classList.add('done');
        document.getElementById(itemId + '-pct').textContent = '✓';
        document.getElementById(itemId + '-bar').style.width = '100%';
        loadVideos();
        loadStorageUsage();
        setTimeout(() => el.remove(), 4000);
      } else {
        el.classList.add('error');
        document.getElementById(itemId + '-pct').textContent = '✗';
        el.title = errMsg || 'Falha no upload';
      }
      resolve();
    };

    if (r2Enabled) {
      uploadDirectToR2(file, onProgress, onDone, expiresAt);
    } else {
      uploadViaServer(file, onProgress, onDone, expiresAt);
    }
  });
}

// Modo padrão (sem R2 configurado): o arquivo sobe pro próprio servidor, que
// salva no disco local — igual ao comportamento de sempre.
function uploadViaServer(file, onProgress, onDone, expiresAt) {
  const xhr = new XMLHttpRequest();
  const validade = expiresAt ? '&expiresAt=' + encodeURIComponent(expiresAt) : '';
  xhr.open('POST', '/upload-video?name=' + encodeURIComponent(file.name) + validade);
  xhr.upload.onprogress = onProgress;
  xhr.onload = () => {
    if (xhr.status === 200) {
      // O servidor devolve o nome com que o arquivo realmente ficou salvo.
      let finalName = file.name;
      try { finalName = JSON.parse(xhr.responseText).filename || finalName; } catch {}
      onDone(true, null, finalName);
      return;
    }
    let msg = 'Falha no upload';
    try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
    onDone(false, msg);
  };
  xhr.onerror = () => onDone(false, 'Erro de conexão durante o upload');
  xhr.send(file);
}

// Modo R2: o arquivo vai DIRETO do navegador pro bucket, sem passar pelo
// Render — o servidor só empresta uma URL de upload assinada, válida por
// alguns minutos. Isso tira do servidor o peso de receber o arquivo inteiro
// (que em vídeos de alguns minutos era o que estourava a memória do plano
// gratuito), e a barra de progresso continua funcionando normalmente porque
// o PUT direto pro R2 também dispara eventos de progresso.
function uploadDirectToR2(file, onProgress, onDone, expiresAt) {
  const validade = expiresAt ? '&expiresAt=' + encodeURIComponent(expiresAt) : '';
  fetch('/request-upload?name=' + encodeURIComponent(file.name) + '&size=' + file.size + validade)
    .then(r => r.json().then(data => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) { onDone(false, data.error || 'Falha ao preparar o upload'); return; }
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', data.url);
      xhr.setRequestHeader('Content-Type', data.contentType);
      xhr.upload.onprogress = onProgress;
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { onDone(true, null, data.filename); return; }
        onDone(false, 'Falha ao enviar pro armazenamento (R2) — status ' + xhr.status);
      };
      xhr.onerror = () => onDone(false, 'Erro de conexão durante o upload direto pro R2 (confira o CORS do bucket)');
      xhr.send(file);
    })
    .catch(() => onDone(false, 'Erro de conexão ao preparar o upload'));
}

// ==================== PLAYLISTS ====================
function loadPlaylists() {
  fetch('/playlists')
    .then(r => r.json())
    .then(data => {
      playlists = data;
      renderPlList();
    })
    .catch(err => console.error("Erro ao carregar playlists:", err));
}

function renderPlList() {
  const list = document.getElementById('plList');
  const count = Object.keys(playlists).length;
  document.getElementById('plCount').textContent = count;
  if (!count) {
    list.innerHTML = `<div class="empty-tvs" style="padding:30px 16px;"><div class="icon">📋</div><p>Nenhuma playlist.<br>Clique em <strong>+ Nova Playlist</strong> para criar.</p></div>`;
    return;
  }
  list.innerHTML = Object.values(playlists).map(pl => `
    <div class="pl-card ${selectedPlaylistId === pl.id ? 'selected' : ''}" onclick="selectPlaylist('${pl.id}')">
      <div class="pl-card-icon">📋</div>
      <div class="pl-card-info">
        <div class="pl-card-name">${pl.name}</div>
        <div class="pl-card-count">${pl.videos.length} vídeo(s)</div>
      </div>
      <button class="pl-card-del" onclick="event.stopPropagation(); deletePlaylist('${pl.id}')" title="Excluir">×</button>
    </div>
  `).join('');
}

function selectPlaylist(id) {
  selectedPlaylistId = id;
  editingPlaylistId = null;
  renderPlList();
  showPlView(playlists[id]);
}

function showPlView(pl) {
  document.getElementById('plEmptyState').style.display = 'none';
  document.getElementById('plForm').style.display = 'none';
  document.getElementById('plView').style.display = 'flex';

  document.getElementById('plViewName').textContent = pl.name;
  const itemCount = pl.videos.length;
  document.getElementById('plViewCount').textContent = itemCount + ' item(ns) · loop contínuo';

  const ol = document.getElementById('plViewOrderList');
  ol.innerHTML = pl.videos.map((item, i) => {
    let name, duration, isImage;
    if (typeof item === 'string') {
      name = item;
      isImage = IMAGE_EXT_REGEX.test(item);
      duration = isImage ? IMAGE_DURATION_DEFAULT : 0;
    } else {
      name = item.name;
      isImage = item.isImage || IMAGE_EXT_REGEX.test(name);
      // Imagem salva sem tempo (playlist antiga) mostra o padrão, não "0s".
      duration = item.duration || (isImage ? IMAGE_DURATION_DEFAULT : 0);
    }
    const icon = isImage ? '🖼' : '🎬';
    const durationText = isImage ? ` • ${duration}s` : '';
    return `
    <div class="pl-order-item">
      <div class="pl-order-num">${i + 1}</div>
      <div>${icon}</div>
      <div class="pl-order-name">${name}${durationText}</div>
    </div>
  `}).join('');

  renderPlTvSelect();
}

function renderPlTvSelect() {
  const sel = document.getElementById('plTvSelect');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Selecione uma TV —</option>' +
    tvs.filter(t => t.connected !== false).map(t =>
      `<option value="${t.code}" ${prev === t.code ? 'selected' : ''}>${t.name} (${t.code})</option>`
    ).join('');
  sel.onchange = () => {
    document.getElementById('plSendBtn').disabled = !sel.value;
  };
  document.getElementById('plSendBtn').disabled = !sel.value;
}

function sendPlaylistToTv() {
  const code = document.getElementById('plTvSelect').value;
  if (!code || !selectedPlaylistId) return;
  const pl = playlists[selectedPlaylistId];
  ws.send(JSON.stringify({ type: 'play_playlist', code, playlist: pl }));
  // Feedback visual
  const btn = document.getElementById('plSendBtn');
  btn.textContent = '✓ Enviada!';
  setTimeout(() => { btn.textContent = '▶ Iniciar Playlist'; }, 2000);
}

function broadcastPlaylist() {
  if (!selectedPlaylistId) return;
  const pl = playlists[selectedPlaylistId];
  tvs.forEach(tv => {
    ws.send(JSON.stringify({ type: 'play_playlist', code: tv.code, playlist: pl }));
  });
  const btn = document.getElementById('plBroadcastBtn');
  btn.textContent = '✓ Enviada para todas!';
  setTimeout(() => { btn.textContent = '📡 Enviar para todas as TVs'; }, 2000);
}

function deletePlaylist(id) {
  if (!confirm('Excluir esta playlist?')) return;
  fetch('/playlists/' + id, { method: 'DELETE' })
    .then(() => {
      delete playlists[id];
      if (selectedPlaylistId === id) {
        selectedPlaylistId = null;
        document.getElementById('plEmptyState').style.display = 'flex';
        document.getElementById('plForm').style.display = 'none';
        document.getElementById('plView').style.display = 'none';
      }
      renderPlList();
    });
}

function openNewPlaylist() {
  selectedPlaylistId = null;
  editingPlaylistId = null;
  plSelectedVideos = [];
  plSelectedDurations = {};
  renderPlList();
  showPlForm(null);
}

function editPlaylist() {
  if (!selectedPlaylistId) return;
  editingPlaylistId = selectedPlaylistId;
  const pl = playlists[selectedPlaylistId];
  plSelectedVideos = [];
  plSelectedDurations = {};
  // Converter formato antigo (array de strings) para novo (array de objetos)
  if (Array.isArray(pl.videos)) {
    pl.videos.forEach(item => {
      if (typeof item === 'string') {
        plSelectedVideos.push(item);
        const isImg = IMAGE_EXT_REGEX.test(item);
        plSelectedDurations[item] = isImg ? IMAGE_DURATION_DEFAULT : 0; // imagens: padrão; vídeos: 0 = duração natural
      } else if (item.name) {
        plSelectedVideos.push(item.name);
        plSelectedDurations[item.name] = item.duration || (item.isImage ? IMAGE_DURATION_DEFAULT : 0);
      }
    });
  }
  showPlForm(pl);
}

function showPlForm(pl) {
  document.getElementById('plEmptyState').style.display = 'none';
  document.getElementById('plView').style.display = 'none';
  document.getElementById('plForm').style.display = 'flex';
  document.getElementById('plFormTitle').textContent = pl ? 'Editar Playlist' : 'Nova Playlist';
  document.getElementById('plNameInput').value = pl ? pl.name : '';
  document.getElementById('plNameError').textContent = '';
  document.getElementById('plVideosError').textContent = '';
  renderPlVideoGrid();
  renderPlOrderList();
}

function cancelPlaylistEdit() {
  plSelectedVideos = [];
  editingPlaylistId = null;
  document.getElementById('plForm').style.display = 'none';
  if (selectedPlaylistId && playlists[selectedPlaylistId]) {
    showPlView(playlists[selectedPlaylistId]);
  } else {
    document.getElementById('plEmptyState').style.display = 'flex';
  }
}

function renderPlVideoGrid() {
  const grid = document.getElementById('plVideoGrid');
  if (!videos.length) {
    grid.innerHTML = `<div style="color:var(--muted);font-size:12px;grid-column:1/-1;">Nenhum vídeo na pasta videos/</div>`;
    return;
  }
  grid.innerHTML = videos.map(v => {
    const sel = plSelectedVideos.includes(v);
    const isImg = IMAGE_EXT_REGEX.test(v);
    const thumbStyle = isImg ? `style="background-image: url('/videos/${encodeURIComponent(v)}');"` : '';
    return `
      <div class="pl-video-item ${sel ? 'selected' : ''}" onclick="togglePlVideo('${v.replace(/'/g,"\\'")}')">
        ${expiryBadgeHtml(v)}
        <button class="video-delete-btn" onclick="deleteVideo('${v.replace(/'/g,"\\'")}', event)" title="Excluir">🗑</button>
        <div class="check">✓</div>
        <div class="pl-video-thumb" ${thumbStyle}>${isImg ? '' : '🎬'}</div>
        <div class="pl-video-name">${v}</div>
      </div>`;
  }).join('');
}

// Chamada quando um arquivo termina de subir pela zona de envio de DENTRO do
// formulário de playlist: além de entrar na biblioteca, ele já é incluído na
// ordem de reprodução — que é o que se espera de "enviar para esta playlist".
function addUploadedToPlaylist(name) {
  if (!name) return;
  const form = document.getElementById('plForm');
  if (!form || getComputedStyle(form).display === 'none') return; // formulário fechado
  if (plSelectedVideos.includes(name)) return;                    // já está na lista

  plSelectedVideos.push(name);
  plSelectedDurations[name] = IMAGE_EXT_REGEX.test(name) ? IMAGE_DURATION_DEFAULT : 0;
  document.getElementById('plVideosError').textContent = '';
  // A grade de "disponíveis" se redesenha sozinha quando o loadVideos() do
  // upload retornar; aqui atualizamos a ordem de reprodução na hora.
  renderPlOrderList();
}

function togglePlVideo(v) {
  const idx = plSelectedVideos.indexOf(v);
  if (idx === -1) {
    plSelectedVideos.push(v);
    // Inicializar duração padrão
    const isImg = IMAGE_EXT_REGEX.test(v);
    plSelectedDurations[v] = isImg ? IMAGE_DURATION_DEFAULT : 0;
  } else {
    plSelectedVideos.splice(idx, 1);
    delete plSelectedDurations[v];
  }
  document.getElementById('plVideosError').textContent = '';
  renderPlVideoGrid();
  renderPlOrderList();
}

// Recebe o ÍNDICE do item, não o nome do arquivo. Antes o nome era interpolado
// direto no atributo onchange do HTML, o que além de frágil (nome com aspas
// quebrava o atributo) foi exatamente o que causou o bug do tempo travado em
// 10s. Índice é sempre um número, então não há nada para escapar.
function updatePlItemDuration(index, raw) {
  const v = plSelectedVideos[index];
  if (v === undefined) return;
  const n = parseInt(raw, 10);
  // Enquanto o campo está sendo digitado ele pode ficar vazio por um instante;
  // nesse caso mantemos o valor anterior em vez de forçar o padrão.
  if (!Number.isFinite(n)) return;
  plSelectedDurations[v] = Math.min(IMAGE_DURATION_MAX, Math.max(IMAGE_DURATION_MIN, n));
}

function renderPlOrderList() {
  const ol = document.getElementById('plOrderList');
  const empty = document.getElementById('plOrderEmpty');
  const count = plSelectedVideos.length;
  document.getElementById('plOrderCount').textContent = count + ' item(ns)';
  if (!count) {
    ol.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  ol.innerHTML = plSelectedVideos.map((v, i) => {
    const isImg = IMAGE_EXT_REGEX.test(v);
    const duration = plSelectedDurations[v] || (isImg ? IMAGE_DURATION_DEFAULT : 0);
    const icon = isImg ? '🖼' : '🎬';
    return `
    <div class="pl-order-item">
      <div class="pl-order-num">${i + 1}</div>
      <div>${icon}</div>
      <div class="pl-order-name">${v}</div>
      ${isImg ? `<div style="display:flex; align-items:center; gap:6px; font-size:12px;">
        <label style="color:var(--muted);">Tempo:</label>
        <input type="number" min="${IMAGE_DURATION_MIN}" max="${IMAGE_DURATION_MAX}" value="${duration}" oninput="updatePlItemDuration(${i}, this.value)" style="width:50px; padding:4px 6px; background:var(--surface2); border:1px solid var(--border); border-radius:4px; color:var(--text); font-size:12px;" title="Tempo em segundos">
        <span style="color:var(--muted);">s</span>
      </div>` : ''}
      <div class="pl-order-btns">
        <button class="pl-order-btn" onclick="movePlVideo(${i}, -1)" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="pl-order-btn" onclick="movePlVideo(${i}, 1)" ${i === count - 1 ? 'disabled' : ''}>▼</button>
      </div>
      <button class="pl-order-del" onclick="removePlVideo(${i})" title="Remover">×</button>
    </div>
  `}).join('');
}

function movePlVideo(idx, dir) {
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= plSelectedVideos.length) return;
  const tmp = plSelectedVideos[idx];
  plSelectedVideos[idx] = plSelectedVideos[newIdx];
  plSelectedVideos[newIdx] = tmp;
  renderPlOrderList();
}

function removePlVideo(idx) {
  const v = plSelectedVideos[idx];
  delete plSelectedDurations[v];
  plSelectedVideos.splice(idx, 1);
  renderPlVideoGrid();
  renderPlOrderList();
}

function savePlaylist() {
  const name = document.getElementById('plNameInput').value.trim();
  let valid = true;

  if (!name) {
    document.getElementById('plNameError').textContent = 'O nome da playlist é obrigatório.';
    document.getElementById('plNameInput').classList.add('error');
    valid = false;
  } else {
    document.getElementById('plNameError').textContent = '';
    document.getElementById('plNameInput').classList.remove('error');
  }

  if (plSelectedVideos.length === 0) {
    document.getElementById('plVideosError').textContent = 'Adicione ao menos 1 item à playlist.';
    valid = false;
  } else {
    document.getElementById('plVideosError').textContent = '';
  }

  if (!valid) return;

  const videos = plSelectedVideos.map(v => {
    const isImage = IMAGE_EXT_REGEX.test(v);
    return {
      name: v,
      // Imagem sempre vai com um tempo válido (nunca 0, que a TV
      // interpretaria como "usar o padrão"). Vídeo vai com 0: toca até o fim.
      duration: isImage ? (plSelectedDurations[v] || IMAGE_DURATION_DEFAULT) : 0,
      isImage,
    };
  });

  const payload = {
    id: editingPlaylistId || undefined,
    name,
    videos: videos,
  };

  fetch('/playlists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(r => r.json())
    .then(saved => {
      if (saved.error) { alert(saved.error); return; }
      playlists[saved.id] = saved;
      selectedPlaylistId = saved.id;
      editingPlaylistId = null;
      plSelectedVideos = [];
      renderPlList();
      showPlView(saved);
    })
    .catch(err => alert("Erro ao salvar playlist: " + err));
}

// ==================== INIT ====================
loadVersion();
connect();
setupDropzone('dropzone-broadcast', 'fileInput-broadcast', 'uploadList-broadcast');
setupDropzone('dropzone-panel', 'fileInput-panel', 'uploadList-panel');
// Zona de envio de dentro do formulário de playlist: o que sobe por aqui já
// entra na ordem de reprodução da playlist que está sendo montada.
setupDropzone('dropzone-playlist', 'fileInput-playlist', 'uploadList-playlist', addUploadedToPlaylist);

// ==================== TEMA CLARO/ESCURO ====================
// Mesma chave de localStorage usada no index.html e no tv.html, entao a
// escolha de tema fica sincronizada entre as tres paginas (mesma origem).
// Claro é o padrao aqui tambem agora — alternamos a classe "dark" (nao mais
// "light"), igual ja funciona no tv.js e no index.html.
function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('vl_theme', isDark ? 'dark' : 'light');
}

(function restoreTheme() {
  if (localStorage.getItem('vl_theme') === 'dark') {
    document.body.classList.add('dark');
  }
})();

// ==================== PAINEL DE TVs (dropdown) ====================
// A lista de TVs deixou de ser uma barra lateral fixa e virou um painel
// recolhivel no topo (igual ao design novo). Estas tres funcoes so abrem/
// fecham esse painel; quem preenche a lista continua sendo renderTvList(),
// sem nenhuma mudanca nela.
function toggleTvPanel() {
  const dropdown = document.getElementById('tvPanelDropdown');
  const bar = document.getElementById('tvPanelBar');
  const isOpen = dropdown.classList.toggle('open');
  bar.classList.toggle('open', isOpen);
}

function closeTvPanel() {
  document.getElementById('tvPanelDropdown').classList.remove('open');
  document.getElementById('tvPanelBar').classList.remove('open');
}

// ==================== BOTAO VOLTAR ====================
// Normalmente esta pagina roda dentro do iframe do index.html (o launcher),
// entao "Voltar" so precisa chamar a funcao closeApp() que ja existe la.
// Se alguem abrir o controller.html direto (fora do launcher), manda pra raiz.
function goBack() {
  if (window.parent && window.parent !== window && typeof window.parent.closeApp === 'function') {
    window.parent.closeApp();
  } else {
    window.location.href = '/';
  }
}
