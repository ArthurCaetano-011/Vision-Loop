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
let pausado = false;      // pausado pelo controlador (não reprogramar tempo)
const preloadedImageUrls = new Set(); // evita rebaixar a mesma imagem repetidamente
// true assim que o primeiro item de currentPlaylist realmente começou a
// aparecer na tela (ver playCurrentInPlaylist). Enquanto for false, a TV
// ainda está na tela de carregamento baixando os arquivos — ver startPlaylist
// e aplicarPlaylistAtualizada logo abaixo.
let playlistPlaybackStarted = false;

// ---------- Pré-carregamento da playlist inteira antes de começar a tocar ----------
// A pedido do usuário: antes de tocar o primeiro item de uma playlist nova, a
// TV baixa o ARQUIVO de todos os itens (só os bytes — nenhum vídeo é
// decodificado ainda, isso continua acontecendo um de cada vez, na hora certa,
// ver o double buffer mais abaixo e o comentário sobre decodificador único).
// Cada arquivo baixado vira um Blob local (URL.createObjectURL) guardado aqui;
// a partir daí, tocar ou pré-carregar aquele item nunca depende de rede de
// novo, mesmo com Wi-Fi ruim no meio da playlist.
const mediaBlobUrls = new Map(); // nome do arquivo -> URL local (blob:...)
let preloadGeneration = 0; // invalida um pré-carregamento em andamento se uma playlist nova chegar no meio
// Não trava a TV pra sempre esperando um arquivo que não baixa: depois desse
// tempo, toca com o que já tiver pronto (o resto cai no carregamento normal,
// sob demanda, igual sempre foi).
const PRELOAD_ALL_TIMEOUT_MS = 90000;

function mediaUrl(filename) {
  return mediaBlobUrls.get(filename) || `/videos/${encodeURIComponent(filename)}`;
}

function releasePreloadedBlobs() {
  mediaBlobUrls.forEach((url) => { try { URL.revokeObjectURL(url); } catch {} });
  mediaBlobUrls.clear();
}

function showLoadingScreen(total) {
  const el = document.getElementById('loadingScreen');
  if (!el) return;
  el.style.display = 'flex';
  updateLoadingProgress(0, total);
}
function updateLoadingProgress(done, total) {
  const text = document.getElementById('loadingText');
  const bar = document.getElementById('loadingProgressBar');
  if (text) text.textContent = total ? `Carregando mídia... ${done}/${total}` : 'Carregando mídia...';
  if (bar) bar.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
}
function hideLoadingScreen() {
  const el = document.getElementById('loadingScreen');
  if (el) el.style.display = 'none';
}

// Baixa (só os bytes, sem decodificar) o arquivo de cada item da playlist
// antes de chamar `callback`. Se uma playlist NOVA chegar enquanto essa
// ainda está baixando, `myGen` deixa de bater com `preloadGeneration` e essa
// rodada é descartada silenciosamente — quem manda é sempre o pedido mais
// recente do controlador.
function preloadAllPlaylistFiles(items, myGen, callback) {
  releasePreloadedBlobs();
  const total = items.length;
  showLoadingScreen(total);

  if (!total) { hideLoadingScreen(); callback(); return; }

  let done = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(safetyTimer);
    if (myGen === preloadGeneration) hideLoadingScreen();
    callback();
  };
  const safetyTimer = setTimeout(finish, PRELOAD_ALL_TIMEOUT_MS);

  items.forEach((item) => {
    const filename = itemName(item);
    const url = `/videos/${encodeURIComponent(filename)}`;
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then((blob) => {
        if (myGen !== preloadGeneration) return; // playlist já mudou, descarta
        mediaBlobUrls.set(filename, URL.createObjectURL(blob));
      })
      .catch((err) => {
        console.warn('Pré-carregamento falhou — esse item vai carregar sob demanda na hora de tocar:', filename, err);
      })
      .finally(() => {
        done++;
        if (myGen === preloadGeneration) updateLoadingProgress(done, total);
        if (done === total) finish();
      });
  });
}

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

// sessionStorage é POR ABA/JANELA (e sobrevive a um recarregamento dela),
// enquanto o localStorage é compartilhado por todas as abas do mesmo
// navegador. É essa diferença que separa duas telas abertas no mesmo
// aparelho — ver tvTabId() e tvIdentidade() abaixo.
function ssGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }

// ---------- Identidade do aparelho (pareamento por conta, Fase 3) ----------
// Diferente do código de sessão (que muda a cada reconexão), este ID é
// gerado UMA VEZ e persiste no localStorage — é o que permite ao servidor
// reconhecer "essa é a mesma TV de sempre" entre uma queda de rede e outra,
// e por isso é o que faz o pareamento com uma conta "grudar" na TV certa.
// Se o localStorage desta TV for limpo (ou ela trocar de navegador/app), o
// pareamento se perde e ela pede um código novo — isso é esperado, é a
// mesma lógica de "TV zerada" que já vale pro resto do estado local.
// Identidade com que esta ABA se conecta. Normalmente é o deviceId do
// aparelho (localStorage). Só quando o servidor precisa separar duas telas do
// mesmo navegador é que ele devolve uma identidade derivada — e aí ela fica
// guardada no sessionStorage desta aba, para as reconexões seguintes usarem a
// mesma e o pareamento não se perder.
function tvIdentidade() {
  return ssGet('vl_tvIdSessao') || tvDeviceId();
}

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

// Identificador da ABA/JANELA. O deviceId acima vem do localStorage, que é
// compartilhado por todas as abas do mesmo navegador — então duas telas
// abertas no mesmo aparelho mandavam o MESMO deviceId e o servidor as tratava
// como uma TV só (desparear uma derrubava as duas). Este id, guardado no
// sessionStorage, é único por aba e sobrevive ao recarregamento dela; o
// servidor o usa para separar as duas telas sem perder o pareamento da TV de
// verdade, que continua ancorado no deviceId.
function tvTabId() {
  let id = ssGet('vl_tvTab');
  if (!id) {
    id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'aba-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    ssSet('vl_tvTab', id);
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
    ws.send(JSON.stringify({ type: 'tv_connect', name: tvName(), deviceId: tvIdentidade(), tabId: tvTabId() }));
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
    if (msg.type === 'your_code') {
      // Guarda a identidade derivada, se o servidor tiver precisado criar uma
      // para separar esta tela de outra aberta no mesmo navegador.
      if (msg.deviceIdUsado && msg.deviceIdUsado !== tvDeviceId()) ssSet('vl_tvIdSessao', msg.deviceIdUsado);
      setPairingDisplay(msg);
    }
    if (msg.type === 'controller_status') setControllerStatus(!!msg.online);
    if (msg.type === 'play') {
      preloadGeneration++; // invalida qualquer pré-carregamento de playlist em andamento
      hideLoadingScreen();
      playlistMode = false; currentPlaylist = null; playlistPlaybackStarted = false;
      playMedia(msg.video); hidePlBadge();
    }
    if (msg.type === 'play_playlist') {
      startPlaylist(msg.playlist);
    }
    // Playlist editada no controlador enquanto esta TV a exibe: aplica a
    // versão nova sem recomeçar do primeiro item (ver aplicarPlaylistAtualizada).
    if (msg.type === 'update_playlist') {
      aplicarPlaylistAtualizada(msg.playlist);
    }
    if (msg.type === 'pause') { pausado = true; pauseMedia(); showOverlay('⏸', 'Pausado'); }
    if (msg.type === 'resume') { pausado = false; resumeMedia(); hideOverlay(); }
    if (msg.type === 'stop') {
      preloadGeneration++; // invalida qualquer pré-carregamento de playlist em andamento
      hideLoadingScreen();
      pausado = false; stopMedia(); hidePlBadge(); playlistMode = false; currentPlaylist = null; playlistPlaybackStarted = false;
      releasePreloadedBlobs();
    }
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
    preloadGeneration++; // invalida qualquer pré-carregamento de playlist em andamento
    hideLoadingScreen();
    playlistMode = false;
    currentPlaylist = null;
    playlistPlaybackStarted = false;
    hidePlBadge();
    hideOverlay();
    stopMedia();
    releasePreloadedBlobs();
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

  const url = mediaUrl(filename);
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
      el.src = mediaUrl(filename);
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
  const url = mediaUrl(filename);
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
  idle.onerror = null; idle.oncanplay = null; idle.onended = null; idle.ontimeupdate = null;
  clearWatchdog(idle);
  idle.src = mediaUrl(filename);
  idle.load();
  idle._loadedName = filename;
}

function startPlaylist(playlist) {
  const myGen = ++preloadGeneration;
  currentPlaylist = playlist;
  playlistIndex = 0;
  playlistMode = true;
  pausado = false;
  playlistPlaybackStarted = false;
  preloadedImageUrls.clear();

  // Esconde o que estiver tocando agora (se houver) e libera os dois
  // decodificadores enquanto a nova playlist inteira é baixada.
  clearTimeout(imageTimer);
  clearTimeout(preloadTimer);
  preloadArmed = false;
  players.forEach(p => { releasePlayer(p); p.style.display = 'none'; p._loadedName = null; });
  const imgDisplay = document.getElementById('imageDisplay');
  imgDisplay.style.backgroundImage = 'none';
  imgDisplay.classList.remove('visible');
  imgDisplay.style.display = 'none';
  hideOverlay();
  document.getElementById('standby').style.display = 'none';
  document.getElementById('videoContainer').style.display = 'none';

  preloadAllPlaylistFiles(playlist.videos, myGen, () => {
    // Se outra playlist (ou um play/stop avulso) chegou enquanto baixávamos
    // esta, não toca mais — o pedido mais novo já assumiu o controle.
    if (myGen !== preloadGeneration) return;
    playCurrentInPlaylist();
  });
}

// Troca a playlist em execução pela versão recém-editada, SEM voltar ao
// primeiro item: o que está na tela continua onde estava, e o que muda é o
// resto da fila. É o que evita ter que parar e mandar reproduzir de novo só
// pra ver uma alteração de tempo ou de ordem.
function aplicarPlaylistAtualizada(playlist) {
  const itens = (playlist && Array.isArray(playlist.videos)) ? playlist.videos : [];

  // Não estava em modo playlist (ou a TV está parada), ou a playlist atual
  // ainda nem começou a tocar de verdade (a TV ainda está baixando os
  // arquivos na tela de carregamento, ver startPlaylist): nesses casos não
  // existe "o que está na tela" pra manter, então é mais simples e seguro
  // recomeçar do zero com a versão mais nova.
  if (!playlistMode || !currentPlaylist || !playlistPlaybackStarted) {
    if (itens.length) startPlaylist(playlist);
    return;
  }

  // A edição esvaziou a playlist — não sobrou nada pra exibir.
  if (!itens.length) {
    stopMedia(); hidePlBadge();
    playlistMode = false; currentPlaylist = null; pausado = false; playlistPlaybackStarted = false;
    return;
  }

  const itemAntigo = currentPlaylist.videos[playlistIndex];
  const nomeAtual = itemAntigo ? itemName(itemAntigo) : null;
  currentPlaylist = playlist;

  // O que já tinha sido pré-carregado pode ser o "próximo" errado agora.
  clearTimeout(preloadTimer);
  preloadArmed = false;
  preloadedImageUrls.clear();
  releasePlayer(idlePlayer());   // o "próximo" pré-carregado pode não ser mais o próximo

  // O arquivo que está na tela pode ter mudado de posição — seguimos ele.
  // Se ele saiu da playlist, aí sim não há o que continuar: recomeça do 1º.
  let novoIndice = -1;
  for (let i = 0; i < itens.length; i++) {
    if (itemName(itens[i]) === nomeAtual) { novoIndice = i; break; }
  }
  if (novoIndice === -1) {
    playlistIndex = 0;
    players.forEach(p => { p._loadedName = null; });
    playCurrentInPlaylist();
    return;
  }
  playlistIndex = novoIndice;

  // Vídeo em exibição: nada a reprogramar, ele toca até o fim e o próximo já
  // sai da lista nova. Se estiver pausado, também não mexemos em tempo nenhum
  // — o que valer entra quando o controlador mandar continuar.
  if (pausado || !isImage(nomeAtual)) return;

  // Imagem em exibição: se o tempo dela mudou, o novo passa a valer agora,
  // sem esperar a próxima volta do loop. A imagem em si não pisca — só a
  // contagem é reiniciada com o valor novo.
  const antes = itemDuration(itemAntigo);
  const agora = itemDuration(itens[novoIndice]);
  if (antes === agora) {
    reagendarPreloadDaImagem(agora);
    return;
  }
  clearTimeout(imageTimer);
  const displayDuration = agora > 0 ? agora * 1000 : IMAGE_DURATION;
  imageTimer = setTimeout(() => nextPlaylistItem(), displayDuration);
  reagendarPreloadDaImagem(agora);
}

// Reagenda só o preload do próximo item, mantendo a mesma janela usada em
// playImageItem. Chamado quando a fila muda no meio de uma imagem.
function reagendarPreloadDaImagem(duracaoSegundos) {
  clearTimeout(preloadTimer);
  const displayDuration = duracaoSegundos > 0 ? duracaoSegundos * 1000 : IMAGE_DURATION;
  const preloadAt = Math.max(0, displayDuration - PRELOAD_LEAD_MS);
  preloadTimer = setTimeout(() => { preloadArmed = true; preloadNextInPlaylist(); }, preloadAt);
}

function playCurrentInPlaylist() {
  if (!currentPlaylist || !currentPlaylist.videos.length) return;
  playlistPlaybackStarted = true;
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
