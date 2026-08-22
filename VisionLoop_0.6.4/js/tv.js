let ws;
let reconnectTimer;
let imageTimer = null;
let preloadTimer = null;
const IMAGE_DURATION = 10000; // 10 segundos para cada imagem na playlist

// Quanto tempo ANTES do fim do item atual o próximo começa a ser preparado.
// Ver comentário do double buffer abaixo para o porquê de não ser no início.
const PRELOAD_LEAD_MS = 8000;

// Playlist state
let currentPlaylist = null;
let playlistIndex = 0;
let playlistMode = false;
let preloadArmed = false; // garante um preload por item
const preloadedImageUrls = new Set(); // evita rebaixar a mesma imagem repetidamente

// ---------- Persistência local ----------
// Só guardamos configurações do aparelho (nome e modo compatibilidade) —
// NÃO guardamos mais o que estava tocando. Toda vez que a aba é fechada e
// reaberta (ou a página recarrega sozinha após uma falha), a TV volta a um
// estado "zerado": conecta direto, sem código, e fica em espera até o
// controlador mandar algo. Isso evita que a TV fique presa tentando repetir
// um vídeo antigo que não existe mais (ex: apagado ou trocado de armazenamento).
const LS = {
  name: 'vl_tvName',
  compat: 'vl_compatMode',
  deviceId: 'vl_tvId',
};
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch {} }

// ---------- Identidade do aparelho (pareamento por conta, Fase 3) ----------
// Diferente do código de sessão (que muda a cada reconexão), este ID é
// gerado UMA VEZ e persiste no localStorage — é o que permite ao servidor
// reconhecer "essa é a mesma TV de sempre" entre uma queda de rede e outra,
// e por isso é o que faz o pareamento com uma conta "grudar" na TV certa.
// Se o localStorage desta TV for limpo (ou ela trocar de navegador/app), o
// pareamento se perde e ela pede um código novo — isso é esperado, é a
// mesma lógica de "TV zerada" que já vale pro resto do estado local.
function tvDeviceId() {
  let id = lsGet(LS.deviceId);
  if (!id) {
    id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'tv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    lsSet(LS.deviceId, id);
  }
  return id;
}

// ---------- Double buffer de vídeo ----------
// Dois elementos <video> se revezam entre "ativo" (visível, tocando) e "em
// espera" (fora de tela, recebendo o PRÓXIMO vídeo da playlist com
// antecedência). Isso é um preload de verdade: o navegador baixa E decodifica
// os primeiros frames antes da hora de tocar, então a troca no fim de um
// vídeo é instantânea, sem tela preta / re-buffering.
//
// PORÉM: muitas Smart TVs de entrada têm UM ÚNICO decodificador H.264 por
// hardware. Dois <video> com src carregado ao mesmo tempo podem disputar esse
// recurso — e o resultado é justamente o congelamento que o preload queria
// evitar. Por isso duas salvaguardas:
//   1) O preload é TARDIO: o próximo item só é carregado ~8s antes do fim do
//      atual (PRELOAD_LEAD_MS), e não no início dele. Assim a janela em que
//      dois decodificadores são disputados é de segundos, não do vídeo todo.
//   2) O player que sai de cena é LIBERADO na hora (releasePlayer), devolvendo
//      decodificador e memória em vez de segurá-los até a próxima troca.
// Para TVs que ainda assim engasguem, existe o "modo compatibilidade", que
// desliga o double buffer e usa um único elemento de vídeo.
let players = null; // preenchido no fim do arquivo, quando o DOM já existe
let activeIdx = 0;
function activePlayer() { return players[activeIdx]; }
function idlePlayer() { return players[1 - activeIdx]; }
function clearWatchdog(el) {
  if (el._watchdog) { clearInterval(el._watchdog); el._watchdog = null; }
}

// A caixinha do modo compatibilidade aparece nas duas telas (pareamento e
// espera), para ser alcançável tanto numa TV nova quanto numa já configurada.
// O estado real fica nesta variável; as caixinhas são só o reflexo dela.
let compatMode = false;

function doubleBufferEnabled() {
  return !compatMode;
}

function setCompatMode(on) {
  compatMode = !!on;
  lsSet(LS.compat, compatMode ? '1' : '0');
  const b = document.getElementById('compatMode');
  const l = document.getElementById('compatLabel');
  if (b) b.checked = compatMode;
  if (l) l.classList.toggle('on', compatMode);
  if (compatMode && players) {
    // Devolve imediatamente o decodificador do player que estava só em espera.
    const idle = idlePlayer();
    if (idle && idle !== activePlayer()) releasePlayer(idle);
  }
}

// Devolve decodificador de vídeo e memória de buffer ao sistema. Só remover a
// classe de visibilidade não basta: enquanto o elemento tiver um src carregado,
// a TV continua com o decodificador preso a ele.
function releasePlayer(el) {
  if (!el) return;
  clearWatchdog(el);
  el.onended = null; el.onerror = null; el.oncanplay = null; el.ontimeupdate = null;
  try { el.pause(); } catch {}
  el.removeAttribute('src');
  try { el.load(); } catch {}
  el._loadedName = null;
  el.classList.remove('visible');
}

// ---------- Recuperação de emergência ----------
// Última linha de defesa: se a TV travar repetidamente em pouco tempo, é
// porque o estado do player/navegador ficou inconsistente e nenhuma tentativa
// pontual vai resolver. Recarregar a página inteira devolve tudo ao zero — e,
// como o código de pareamento e o que estava tocando ficam salvos localmente,
// a TV volta ao ar sozinha em poucos segundos, sem ninguém ir até ela.
const MAX_RECOVERIES = 3;
const RECOVERY_WINDOW_MS = 120000;
let recoveryCount = 0;
let lastRecoveryAt = 0;
let healthyTimer = null;

function registerRecovery() {
  const now = Date.now();
  if (now - lastRecoveryAt > RECOVERY_WINDOW_MS) recoveryCount = 0;
  lastRecoveryAt = now;
  recoveryCount++;
  if (recoveryCount >= MAX_RECOVERIES) {
    console.warn('Falhas repetidas — recarregando a página para recuperar.');
    showOverlay('🔄', 'Reiniciando player…');
    setTimeout(() => location.reload(), 1500);
    return true;
  }
  return false;
}

// ---------- Versão ----------
function loadVersion() {
  fetch('/version')
    .then(r => r.json())
    .then(d => { if (d.version) document.getElementById('tvVersion').textContent = 'v' + d.version; })
    .catch(() => {});
}

// ---------- WebSocket ----------
function connect() {
  // Conecta sempre ao mesmo host que serviu esta página — a TV não precisa
  // saber nenhum IP, basta abrir a URL do site.
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    setConn(true);
    ws.send(JSON.stringify({ type: 'tv_connect', name: tvName(), deviceId: tvDeviceId() }));
  };

  ws.onclose = () => {
    setConn(false);
    document.getElementById('codeDisplay').innerHTML =
      '<span class="pulse" style="font-size:24px;letter-spacing:2px;color:#444;">reconectando...</span>';
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = (err) => console.error('WebSocket Error:', err);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'your_code') setPairingDisplay(msg);
    if (msg.type === 'controller_status') setControllerStatus(!!msg.online);
    if (msg.type === 'play') {
      playlistMode = false; currentPlaylist = null;
      playMedia(msg.video); hidePlBadge();
    }
    if (msg.type === 'play_playlist') {
      startPlaylist(msg.playlist);
    }
    if (msg.type === 'pause') { pauseMedia(); showOverlay('⏸', 'Pausado'); }
    if (msg.type === 'resume') { resumeMedia(); hideOverlay(); }
    if (msg.type === 'stop') { stopMedia(); hidePlBadge(); playlistMode = false; currentPlaylist = null; }
    if (msg.type === 'enter_fullscreen') enterFullscreen();
    if (msg.type === 'exit_fullscreen') exitFullscreen();
  };
}

function tvName() { return document.getElementById('tvNameInput').value.trim() || 'TV'; }

function setName() {
  if (ws && ws.readyState === 1) {
    lsSet(LS.name, tvName());
    ws.send(JSON.stringify({ type: 'tv_set_name', name: tvName() }));
    showOverlay('✅', tvName());
    setTimeout(hideOverlay, 1500);
  }
}

function setControllerStatus(online) {
  const el = document.getElementById('ctrlStatus');
  if (!el) return;
  el.className = 'pair-status ' + (online ? 'on' : 'off');
  el.textContent = online
    ? 'Controlador conectado'
    : 'Nenhum controlador no ar no momento.';
}

// Mostra o código de pareamento (TV ainda sem dono) ou a confirmação de que
// já está pareada (Fase 3). O código que existia antes disso (msg.code) é
// só um identificador interno de sessão — nunca mais o que aparece nesta
// caixa, pra não confundir com o código de pareamento de verdade.
function setPairingDisplay(msg) {
  const box = document.getElementById('codeDisplay');
  const label = document.getElementById('codeLabel');
  const hint = document.getElementById('pairingHint');

  // Ficar sem par significa que esta TV não pertence mais a conta nenhuma —
  // então ela NÃO pode continuar exibindo o conteúdo daquela conta. O
  // servidor manda um "stop" junto, mas paramos aqui também: a TV nunca deve
  // depender de uma segunda mensagem para largar um conteúdo que já não tem
  // dono. Sem isso, uma TV despareada seguia reproduzindo em loop para
  // sempre, sem ninguém conseguindo mais comandá-la.
  if (msg.paired === false) {
    playlistMode = false;
    currentPlaylist = null;
    hidePlBadge();
    hideOverlay();
    stopMedia();
  }

  if (!box) return;
  if (msg.paired) {
    if (label) label.textContent = 'Situação';
    if (hint) hint.style.display = 'none';
    box.innerHTML = '<span style="font-size:18px; color:#1a9c5c;">✅ TV pareada</span>';
  } else {
    if (label) label.textContent = 'Código de pareamento';
    if (hint) hint.style.display = 'block';
    if (msg.pairingCode) {
      box.textContent = msg.pairingCode;
    } else {
      // TV rodando sem deviceId (versão antiga em cache) — segue
      // funcionando, mas sem pareamento possível nesta conexão.
      box.innerHTML = '<span style="font-size:16px; color:#888;">Pareamento indisponível — recarregue a página</span>';
    }
  }
}

// ---------- Playback ----------
function isImage(filename) {
  return /\.(jpg|jpeg|png|webp)$/i.test(filename);
}
function itemName(item) { return typeof item === 'string' ? item : item.name; }
function itemDuration(item) { return typeof item === 'object' ? (item.duration || 0) : 0; }

// Observa se o vídeo realmente está avançando. Em algumas Smart TVs o
// decodificador pode travar (buffer/hardware) sem nunca disparar um evento
// "error" — o currentTime simplesmente para de avançar para sempre e a tela
// fica congelada. Esse watchdog detecta isso e força uma recuperação.
function armWatchdog(el, onStuck) {
  clearWatchdog(el);
  let lastTime = -1;
  let stuckChecks = 0;
  el._watchdog = setInterval(() => {
    if (el.paused || el.ended || el !== activePlayer()) return;
    if (el.currentTime === lastTime) {
      stuckChecks++;
      if (stuckChecks === 1) {
        // primeira detecção: tenta retomar sozinho (comum após um stall de rede)
        el.play().catch(() => {});
      } else if (stuckChecks >= 3) { // ~6s parado mesmo após tentar retomar
        stuckChecks = 0;
        onStuck();
      }
    } else {
      stuckChecks = 0;
      lastTime = el.currentTime;
    }
  }, 2000);
}

function handleStuckPlayback() {
  console.warn('Vídeo travado detectado pelo watchdog — recuperando.');
  if (registerRecovery()) return; // travou demais: a página vai recarregar
  showOverlay('⚠️', 'Recuperando reprodução…');
  if (playlistMode) {
    setTimeout(() => { hideOverlay(); nextPlaylistItem(); }, 800);
  } else {
    const el = activePlayer();
    setTimeout(() => {
      hideOverlay();
      el.load();
      el.play().catch(() => {});
    }, 800);
  }
}

function playMedia(item, duration) {
  clearTimeout(imageTimer);
  clearTimeout(preloadTimer);
  preloadArmed = false;
  const filename = itemName(item);
  const dur = duration || itemDuration(item);

  document.getElementById('standby').style.display = 'none';
  document.getElementById('videoContainer').style.display = 'block';
  hideOverlay();

  if (isImage(filename)) {
    playImageItem(filename, dur);
  } else {
    playVideoItem(filename);
  }
  // O preload do próximo item NÃO acontece aqui. Ele é agendado para perto do
  // fim deste item (ver playImageItem e o ontimeupdate em playVideoItem), para
  // não manter dois vídeos carregados durante toda a reprodução.
}

function playImageItem(filename, duration) {
  const imgDisplay = document.getElementById('imageDisplay');
  // Enquanto uma imagem está na tela nenhum vídeo precisa de decodificador:
  // liberamos os dois players e devolvemos esse recurso à TV.
  players.forEach(releasePlayer);
  imgDisplay.classList.remove('visible');

  const url = `/videos/${encodeURIComponent(filename)}`;
  setTimeout(() => {
    players.forEach(p => p.style.display = 'none');
    imgDisplay.style.display = 'block';
    imgDisplay.style.backgroundImage = `url('${url}')`;
    // Força um reflow para a transição de opacidade funcionar
    imgDisplay.offsetHeight;
    imgDisplay.classList.add('visible');
  }, 100);

  if (playlistMode) {
    const displayDuration = duration > 0 ? duration * 1000 : IMAGE_DURATION;
    imageTimer = setTimeout(() => nextPlaylistItem(), displayDuration);
    // Prepara o próximo item só no finalzinho do tempo da imagem.
    const preloadAt = Math.max(0, displayDuration - PRELOAD_LEAD_MS);
    preloadTimer = setTimeout(() => { preloadArmed = true; preloadNextInPlaylist(); }, preloadAt);
  }
}

// Toca um vídeo. Se ele já tiver sido pré-carregado no elemento "em espera"
// (ver preloadNextInPlaylist), a troca é instantânea — só alternamos qual
// elemento é o "ativo", sem precisar baixar/decodificar nada na hora.
function playVideoItem(filename) {
  const imgDisplay = document.getElementById('imageDisplay');
  imgDisplay.classList.remove('visible');
  imgDisplay.style.display = 'none';

  players.forEach(clearWatchdog);

  let el;
  const idle = idlePlayer();
  if (doubleBufferEnabled() && idle._loadedName === filename) {
    // O próximo já estava pré-carregado: só troca quem é o ativo.
    el = idle;
    activeIdx = 1 - activeIdx;
  } else {
    el = activePlayer();
    if (el._loadedName !== filename) {
      const url = `/videos/${encodeURIComponent(filename)}`;
      el.src = url;
      el.load();
      el._loadedName = filename;
    }
  }

  // Libera o outro elemento imediatamente. A partir daqui só UM vídeo segura
  // decodificador — o segundo volta a existir apenas na janela de preload,
  // pouco antes da próxima troca.
  players.forEach(p => { if (p !== el) releasePlayer(p); });

  players.forEach(p => {
    p.style.display = 'block';
    if (p !== el) p.classList.remove('visible');
  });
  el.loop = !playlistMode;

  // Se o vídeo já estava pré-carregado, o evento "canplay" já disparou no
  // passado e não vai disparar de novo — nesse caso mostramos direto.
  if (el.readyState >= 3) {
    el.classList.add('visible');
    el.oncanplay = null;
  } else {
    el.oncanplay = () => { el.classList.add('visible'); el.oncanplay = null; };
  }

  // Tratamento de erro de codec/rede/decodificação.
  el.onerror = () => {
    const err = el.error;
    console.error('Erro no player de vídeo:', err, filename);
    let label = 'Erro ao reproduzir vídeo';
    if (err) {
      if (err.code === 4) label = 'Formato incompatível';
      else if (err.code === 3) label = 'Falha ao decodificar vídeo';
      else if (err.code === 2) label = 'Falha de rede';
      else label = 'Reprodução abortada';
    }
    // Erro de formato (código 4) é problema DO ARQUIVO: recarregar a página
    // não resolveria e ainda criaria um ciclo de reloads. Só falhas de
    // decodificação/rede contam para a recuperação de emergência.
    if (err && err.code !== 4) {
      if (registerRecovery()) return;
    }
    showOverlay('⚠️', label);
    // Em qualquer erro, se estiver em playlist, pula para o próximo após um
    // instante em vez de travar o loop para sempre.
    if (playlistMode) {
      setTimeout(() => { if (el.error) nextPlaylistItem(); }, 2500);
    }
  };

  el.onended = () => {
    if (!playlistMode || !currentPlaylist) return;
    nextPlaylistItem();
  };

  // Prepara o PRÓXIMO item só quando faltar PRELOAD_LEAD_MS para o fim deste.
  // Se a duração for desconhecida, nada é pré-carregado e o próximo item é
  // carregado na hora — mais lento, porém sempre seguro.
  el.ontimeupdate = () => {
    if (!playlistMode || preloadArmed) return;
    const d = el.duration;
    if (!isFinite(d) || d <= 0) return;
    if ((d - el.currentTime) * 1000 <= PRELOAD_LEAD_MS) {
      preloadArmed = true;
      preloadNextInPlaylist();
    }
  };

  // Reproduziu bem por um tempo? Então o problema anterior foi pontual —
  // zera o contador para que um único arquivo ruim no meio de uma playlist
  // saudável nunca acumule até disparar o reload de emergência.
  el.onplaying = () => {
    clearTimeout(healthyTimer);
    healthyTimer = setTimeout(() => { recoveryCount = 0; }, 10000);
  };

  armWatchdog(el, handleStuckPlayback);

  el.play().catch(e => {
    // Detecção de Autoplay Bloqueado: navegadores modernos exigem interação
    // do usuário antes de permitir som/vídeo automático.
    console.warn('Play failed:', e);
    if (e.name === 'NotAllowedError') {
      console.warn('Autoplay bloqueado pelo navegador. Mostrando prompt de interação.');
      showOverlay('▶️', 'Clique para Iniciar');
      const startOnInteraction = () => {
        el.play().then(() => {
          hideOverlay();
          window.removeEventListener('click', startOnInteraction);
          window.removeEventListener('keydown', startOnInteraction);
        }).catch(err => console.error('Ainda não pôde reproduzir:', err));
      };
      window.addEventListener('click', startOnInteraction);
      window.addEventListener('keydown', startOnInteraction);
    } else if (e.name === 'NotSupportedError') {
      showOverlay('⚠️', 'Codec não suportado');
    }
  });
}

function pauseMedia() {
  const el = activePlayer();
  if (el.style.display !== 'none') el.pause();
  clearTimeout(imageTimer);
}

function resumeMedia() {
  const el = activePlayer();
  if (el.style.display !== 'none' && el.getAttribute('src') !== null) {
    el.play().catch(() => {});
  } else if (playlistMode && currentPlaylist) {
    // Se for imagem na playlist, reinicia o timer com duração configurada
    const item = currentPlaylist.videos[playlistIndex];
    const duration = itemDuration(item) || 10;
    const displayDuration = duration > 0 ? duration * 1000 : IMAGE_DURATION;
    imageTimer = setTimeout(() => nextPlaylistItem(), displayDuration);
  }
}

function stopMedia() {
  clearTimeout(imageTimer);
  clearTimeout(preloadTimer);
  clearTimeout(healthyTimer);
  preloadArmed = false;
  players.forEach(p => {
    releasePlayer(p);
    p.onplaying = null;
    p.style.display = 'none';
  });
  const imgDisplay = document.getElementById('imageDisplay');
  imgDisplay.style.backgroundImage = 'none';
  imgDisplay.classList.remove('visible');
  document.getElementById('videoContainer').style.display = 'none';
  document.getElementById('standby').style.display = 'flex';
}

// ---------- Playlist loop ----------
function preloadImageUrl(filename) {
  const url = `/videos/${encodeURIComponent(filename)}`;
  if (preloadedImageUrls.has(url)) return;
  preloadedImageUrls.add(url);
  // Baixa a imagem em segundo plano; o Cache-Control do servidor faz o
  // navegador reaproveitar esses bytes na hora de exibir de verdade.
  const img = new Image();
  img.src = url;
}

// Prepara de verdade o PRÓXIMO vídeo da playlist: carrega no elemento
// <video> que está em segundo plano (fora de tela), para que ele já esteja
// baixado e decodificado quando chegar a vez dele. Isso é um preload real —
// diferente de <link rel="prefetch">, que várias TVs ignoram e que, mesmo
// quando funciona, só ajuda o cache HTTP, não o pipeline de vídeo em si.
function preloadNextInPlaylist() {
  if (!currentPlaylist || !currentPlaylist.videos.length) return;
  const nextIndex = (playlistIndex + 1) % currentPlaylist.videos.length;
  // Playlist de um item só: o "próximo" é o próprio atual, que já está
  // carregado. Pré-carregar de novo seria baixar e decodificar à toa.
  if (nextIndex === playlistIndex) return;

  const nextItem = currentPlaylist.videos[nextIndex];
  const filename = itemName(nextItem);

  if (isImage(filename)) {
    preloadImageUrl(filename);
    return;
  }

  // Modo compatibilidade: nunca deixa dois vídeos carregados ao mesmo tempo.
  if (!doubleBufferEnabled()) return;

  const idle = idlePlayer();
  if (idle._loadedName === filename) return; // já preparado
  const url = `/videos/${encodeURIComponent(filename)}`;
  idle.onerror = null; idle.oncanplay = null; idle.onended = null; idle.ontimeupdate = null;
  clearWatchdog(idle);
  idle.src = url;
  idle.load();
  idle._loadedName = filename;
}

function startPlaylist(playlist) {
  currentPlaylist = playlist;
  playlistIndex = 0;
  playlistMode = true;
  preloadedImageUrls.clear();
  players.forEach(p => { p._loadedName = null; });
  playCurrentInPlaylist();
}

function playCurrentInPlaylist() {
  if (!currentPlaylist || !currentPlaylist.videos.length) return;
  const item = currentPlaylist.videos[playlistIndex];
  playMedia(item);
}

function nextPlaylistItem() {
  if (!playlistMode || !currentPlaylist) return;
  playlistIndex = (playlistIndex + 1) % currentPlaylist.videos.length;
  playCurrentInPlaylist();
}

// ---------- UI Helpers ----------
function showPlBadge(name, current, total, videoName) {
  // Badge desativada a pedido do usuário
}

function hidePlBadge() {
  document.getElementById('plBadge').classList.remove('show');
}

function showOverlay(icon, text) {
  document.getElementById('overlayIcon').textContent = icon;
  document.getElementById('overlayText').textContent = text;
  document.getElementById('overlay').classList.add('show');
}
function hideOverlay() { document.getElementById('overlay').classList.remove('show'); }

function enterFullscreen() {
  const overlay = document.getElementById('fsOverlay');
  overlay.classList.add('show');
  document.getElementById('fsBtn').focus();
}
function confirmFullscreen() {
  document.getElementById('fsOverlay').classList.remove('show');
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen();
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}
function exitFullscreen() {
  document.getElementById('fsOverlay').classList.remove('show');
  if (document.exitFullscreen) document.exitFullscreen();
}

function setConn(ok) {
  document.getElementById('connDot').className = 'conn-dot' + (ok ? ' ok' : ' error');
  document.getElementById('connText').textContent = ok ? 'Conectado ao servidor' : 'Sem conexão — reconectando...';
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const el = activePlayer();
    if (el && el.style.display !== 'none' && el.getAttribute('src') && el.paused && !document.getElementById('overlay').classList.contains('show')) {
      el.play().catch(() => {});
    }
  }
});

// Inicializa o double buffer agora que os elementos <video> já existem no DOM.
players = [document.getElementById('playerA'), document.getElementById('playerB')];
players.forEach(p => { p._loadedName = null; p._watchdog = null; });

// ---------- Inicialização ao abrir a página ----------
// A cada abertura de aba (inclusive depois de fechar/reabrir, ou de um reload
// automático de emergência), a TV começa "zerada": reaplica só as
// configurações do aparelho (modo compatibilidade e nome salvo), conecta
// direto ao servidor sem nenhum código, e fica em espera até o controlador
// mandar algo. Nada do que estava tocando antes é retomado sozinho — isso
// evita a TV ficar presa tentando reproduzir um conteúdo que já não existe
// mais (apagado, ou de antes de uma troca de armazenamento).
(function init() {
  // Modo compatibilidade. O parâmetro ?compat=1 na URL força o modo mesmo
  // numa TV que nunca foi configurada — útil para deixar fixo no atalho.
  const forcedByUrl = /[?&]compat=1/.test(location.search);
  setCompatMode(forcedByUrl || lsGet(LS.compat) === '1');

  // Nome da TV
  const savedName = lsGet(LS.name);
  if (savedName) document.getElementById('tvNameInput').value = savedName;

  loadVersion();
  connect();
})();

// ==================== TEMA CLARO/ESCURO ====================
// Mesma chave de localStorage usada no index.html e no controller.html, entao
// a escolha de tema fica sincronizada entre as tres paginas (mesma origem).
// Aqui o padrao da TV ja é o degrade claro/colorido (do jeito que foi editado),
// entao o alternativo é a classe "dark" (nao "light" como no controller).
function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('vl_theme', isDark ? 'dark' : 'light');
}

(function restoreTheme() {
  if (localStorage.getItem('vl_theme') === 'dark') {
    document.body.classList.add('dark');
  }
})();

// ==================== BOTAO VOLTAR ====================
// Mesma logica do controller.js: se estiver dentro do iframe do index.html,
// chama a funcao closeApp() de la; se abriu a pagina sozinha, manda pra raiz.
function goBack() {
  if (window.parent && window.parent !== window && typeof window.parent.closeApp === 'function') {
    window.parent.closeApp();
  } else {
    window.location.href = '/';
  }
}
