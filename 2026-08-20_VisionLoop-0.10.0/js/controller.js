// ==================== FORMATOS ACEITOS ====================
// Apenas formatos de uso comum. Vídeo: .mp4 (universal), .mov (padrão do
// iPhone) e .webm. Imagem: .jpg/.jpeg, .png e .webp.
// Declarados aqui no topo porque são usados por funções de todo o arquivo.
const UPLOAD_EXT_REGEX = /\.(mp4|jpg|jpeg|png|webp)$/i;
const IMAGE_EXT_REGEX = /\.(jpg|jpeg|png|webp)$/i;

// Precificador automático (0.10.0): um .txt solto ou selecionado aqui não é
// mídia — é a exportação da balança. Em vez de virar um item da playlist, ele
// aciona o precificador (server.js, /upload-tabela-precos), que gera as 7
// tabelas de preço, salva como mídia normal com nome fixo, e já coloca a
// playlist "Tabela de Preços" pra tocar nas TVs desta conta. Ver handleFiles.
const TXT_BALANCA_EXT_REGEX = /\.txt$/i;

// Tempo de exibição das imagens na playlist (vídeos tocam até o fim).
const IMAGE_DURATION_DEFAULT = 10; // segundos
const IMAGE_DURATION_MIN = 1;
const IMAGE_DURATION_MAX = 300;

// ==================== STATE ====================
let ws;
let tvs = [];
// Identidade da TV selecionada no painel. Usa tvRowId (o id dela no banco),
// não o "code" de sessão — code é efêmero (muda a cada reconexão e não
// existe pra uma TV offline), tvRowId é estável mesmo com a TV desligada.
// Guardado sempre como string pra evitar bug de comparação number/string
// (já aconteceu antes com id de playlist — ver CHANGELOG da 0.6).
let selectedTvId = null;
let selectedVideo = null;
let broadcastVideo = null;
let playlists = {};
let selectedPlaylistId = null;
let editingPlaylistId = null;    // null = nova playlist
let plSelectedVideos = [];       // vídeos escolhidos no form (em ordem)
let plSelectedDurations = {};    // duração (em segundos) para cada item da playlist
let r2Enabled = false;           // define se o upload vai direto pro R2 (sem passar pelo servidor)
// Falso quando o banco ainda não tem a coluna de validade (migração 0.6.9
// pendente). Nesse caso o prazo não é oferecido, em vez de aceitar uma data
// que nunca ia valer. O padrão é "true" pra não travar nada se o /version
// vier de uma versão antiga do servidor, sem esse campo.
let validadeDisponivel = true;
let currentAccountId = null;     // id da própria conta logada (vem de /me)
let currentRole = null;          // 'adm' ou 'cliente' (vem de /me)
// (a antiga grade "Vídeos disponíveis" e sua lista `videos`/`mediaMeta` foram
// removidas na 0.7.1 — a playlist agora só recebe conteúdo pelo envio direto)
let contas = [];                 // lista de contas (só carregada/usada por ADM)
let editingContaId = null;       // null = nova conta; senão, id da conta em edição

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
    loadPlaylists();
    loadStorageUsage();
  };
  ws.onclose = () => { setStatus(false); setTimeout(connect, 2000); };
  ws.onerror = (err) => console.error("WebSocket Error:", err);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'tv_list') {
      // `fullscreen` vem confirmado pelo servidor (a própria TV avisa quando
      // entra/sai de verdade — ver js/tv.js) — nada a preservar aqui, é só
      // usar o que chegou.
      tvs = msg.tvs;
      renderTvList();
      renderPlTvSelect();
    }
    if (msg.type === 'media_changed') {
      // Um arquivo venceu e saiu sozinho (varredura de validade no servidor,
      // a cada 60s) — o servidor já tira ele de toda playlist que o usava
      // (ver removerArquivoDeTodas), então recarrega playlists e uso de
      // armazenamento pra refletir isso na hora, sem precisar de F5.
      loadStorageUsage();
      loadPlaylists();
    }
    if (msg.type === 'auth_error') {
      // Sessão caiu (licença venceu, conta foi suspensa, ou logou em outro
      // lugar) enquanto este controlador estava aberto — o servidor já
      // fechou a conexão do WebSocket; só falta mandar pra tela de login.
      window.location.href = '/login.html';
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
      if (d.validadeDisponivel !== undefined) validadeDisponivel = !!d.validadeDisponivel;
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

// ==================== TABS ====================
function switchTab(tab) {
  document.getElementById('panel-playlists').style.display = tab === 'playlists' ? 'flex' : 'none';
  const contasPanel = document.getElementById('panel-contas');
  if (contasPanel) contasPanel.style.display = tab === 'contas' ? 'flex' : 'none';

  document.getElementById('tab-playlists').classList.toggle('active', tab === 'playlists');
  const contasTabBtn = document.getElementById('tab-contas');
  if (contasTabBtn) contasTabBtn.classList.toggle('active', tab === 'contas');

  if (tab === 'contas') loadContas();
}

// Escapa texto antes de jogar em innerHTML — usado nos campos digitados
// pelo próprio ADM (nome da empresa) que aparecem na lista de contas, vista
// por qualquer outro ADM. Nada no resto do app escapa texto assim (nome de
// vídeo, de playlist) porque só o próprio dono via aquele texto; aqui outros
// ADMs veem o nome de contas que não são a deles, então vale a defesa extra.
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// ==================== VIDEOS ====================
// NOTE: sem UI que chame esta função no momento — a grade "Vídeos
// disponíveis" (único botão que a acionava) foi removida na 0.7.1. Mantida
// aqui, funcional, caso volte um jeito de excluir um arquivo já enviado.
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
      loadPlaylists();
      loadStorageUsage();
    })
    .catch(err => alert('Erro ao excluir: ' + err.message));
}

// ==================== TV LIST ====================
function renderTvList() {
  const list = document.getElementById('tvList');
  document.getElementById('tvCount').textContent = tvs.length;
  if (!tvs.length) {
    list.innerHTML = `<div class="empty-tvs"><img src="/assets/empty-tv.png" class="empty-tvs-img" alt=""><p>Nenhuma TV pareada ainda.<br>Abra o site na TV, escolha <strong>TV</strong>, e digite o código que aparecer lá no campo acima.</p></div>`;
    return;
  }
  list.innerHTML = tvs.map(tv => {
    const rowId = String(tv.tvRowId);
    const offline = tv.connected === false;
    const statusClass = offline ? 'offline' : (!tv.video ? '' : tv.paused ? 'paused' : 'playing');
    let statusLabel = offline ? 'Offline' : (!tv.video ? 'Aguardando' : tv.paused ? 'Pausado' : 'Reproduzindo');
    let extra = '';
    if (!offline && tv.playlist) extra = ' · 📋 ' + tv.playlist.name;
    else if (!offline && tv.video) extra = ' · ' + tv.video;
    const codeBadge = offline
      ? `<div class="tv-code-badge tv-offline-badge">sem conexão</div>`
      : `<div class="tv-code-badge">${tv.code}</div>`;
    // De quem é essa TV. Pra um cliente comum é sempre a própria conta dele
    // — óbvio, não precisa repetir. Só importa pro ADM, que vê TVs de várias
    // contas juntas na mesma lista e precisa saber de quem é cada uma.
    const contaBadge = (currentRole === 'adm' && tv.contaNome)
      ? `<div class="tv-conta-badge">🏢 ${tv.contaNome}</div>`
      : '';
    return `
    <div class="tv-card ${offline ? 'offline' : ''} ${selectedTvId === rowId ? 'selected' : ''}" onclick="selectTv('${rowId}')">
      <button class="tv-unpair-btn" onclick="despairTv('${rowId}', event)" title="Desparear esta TV desta conta">Desparear</button>
      <div class="tv-card-top">
        <div class="tv-icon">📺</div>
        <div>
          <div class="tv-name">${tv.name}</div>
          ${contaBadge}
          ${codeBadge}
        </div>
      </div>
      <div class="tv-status">
        <div class="dot ${statusClass}"></div>
        ${statusLabel}${extra}
      </div>
      ${selectedTvId === rowId ? controlesDaTvHtml(tv) : ''}
    </div>`;
  }).join('');
}

// Controles da TV clicada. Cada botão de comando de reprodução carrega o
// CÓDIGO DE SESSÃO da própria TV e manda o comando só para ela — o servidor
// entrega a mensagem exclusivamente para aquele aparelho (tvs.get(code)),
// então pausar/parar/retomar/tela cheia numa TV nunca alcança as outras,
// mesmo com várias pareadas na mesma conta. Uma TV offline não tem code (não
// há pra onde mandar nada agora), então os botões ficam desabilitados.
function controlesDaTvHtml(tv) {
  const online = tv.connected !== false;
  const temConteudo = !!(tv.video || tv.playlist);
  const c = tv.code;
  const r = tv.tvRowId;
  return `
      <div class="tv-controls" onclick="event.stopPropagation()">
        <button class="btn btn-green btn-sm" onclick="tvResume('${c}', event)" ${online && temConteudo && tv.paused ? '' : 'disabled'}>▶ Retomar</button>
        <button class="btn btn-ghost btn-sm" onclick="tvPause('${c}', event)" ${online && temConteudo && !tv.paused ? '' : 'disabled'}>⏸ Pausar</button>
        <button class="btn btn-red btn-sm" onclick="tvStop('${c}', event)" ${online && temConteudo ? '' : 'disabled'}>⏹ Parar</button>
        <button class="btn btn-ghost btn-sm" onclick="tvToggleFullscreen('${r}', '${c}', event)" ${online ? '' : 'disabled'} title="${tv.fullscreen ? 'Manda a TV sair da tela cheia' : 'Mostra na TV o botão de confirmar tela cheia — precisa de alguém apertar OK no controle remoto dela'}">${tv.fullscreen ? '⛶ Sair da tela cheia' : '⛶ Tela cheia'}</button>
      </div>${!online ? '<div class="tv-offline-hint">Offline — os controles voltam quando ela reconectar.</div>' : ''}`;
}

// Um único caminho para os comandos de reprodução, sempre com o código
// explícito da TV — nada aqui depende de "qual TV está selecionada" na hora
// do envio, que é o que poderia fazer um clique afetar a TV errada.
function enviarComandoTv(tipo, code, event) {
  if (event) event.stopPropagation();
  if (!code) return;
  if (!ws || ws.readyState !== 1) { alert('Sem conexão com o servidor. Tente de novo em instantes.'); return; }
  ws.send(JSON.stringify({ type: tipo, code }));
  // A lista se redesenha sozinha quando o servidor confirmar o novo estado
  // (mensagem tv_list), então nada é assumido como certo aqui.
}

function tvResume(code, event) { enviarComandoTv('resume', code, event); }
function tvPause(code, event)  { enviarComandoTv('pause',  code, event); }
function tvStop(code, event)   { enviarComandoTv('stop',   code, event); }

// Tela cheia é um comando meio diferente dos outros três: "ligar" só mostra
// na TV um prompt pra confirmar (precisa de alguém com o controle remoto
// dela pra apertar OK — navegador nenhum deixa um comando remoto forçar tela
// cheia sem interação de verdade), então nada é assumido aqui na hora do
// clique. O botão só muda de verdade quando o próximo `tv_list` chegar com o
// `fullscreen` que a própria TV confirmou (ver avisarStatusFullscreen() em
// js/tv.js) — o que também cobre alguém saindo da tela cheia direto pelo
// controle remoto, sem passar pelo painel.
function tvToggleFullscreen(tvRowId, code, event) {
  if (event) event.stopPropagation();
  if (!code) return;
  if (!ws || ws.readyState !== 1) { alert('Sem conexão com o servidor. Tente de novo em instantes.'); return; }
  const tv = tvs.find(t => String(t.tvRowId) === String(tvRowId));
  if (!tv) return;
  ws.send(JSON.stringify({ type: tv.fullscreen ? 'exit_fullscreen' : 'enter_fullscreen', code }));
}

// Sem o painel de vídeos, clicar numa TV apenas a destaca na lista do topo
// (o alvo de uma playlist continua sendo escolhido no seletor "Enviar para TV").
function selectTv(tvRowId) {
  selectedTvId = selectedTvId === tvRowId ? null : tvRowId;
  renderTvList();
}

// ==================== PAREAMENTO DE TV (Fase 3) ====================
// A TV nova mostra um código de 6 caracteres na própria tela (não aparece
// em lista nenhuma até ser pareada — só existe o código). Digitar esse
// código aqui vincula a TV à conta logada agora; o servidor confirma pelo
// WebSocket (broadcastTvList()/tv_list) e a TV passa a aparecer na lista
// normalmente, sem precisar recarregar nada.
function parearTv() {
  const input = document.getElementById('pairCodeInput');
  const errorEl = document.getElementById('pairTvError');
  const btn = document.getElementById('pairTvBtn');
  const codigo = input.value.trim();
  if (!codigo) {
    errorEl.textContent = 'Digite o código mostrado na tela da TV.';
    return;
  }
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Pareando...';

  fetch('/parear-tv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo }),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) { errorEl.textContent = data.error || 'Não foi possível parear essa TV.'; return; }
      input.value = '';
      // A lista de TVs é atualizada automaticamente pelo servidor via
      // WebSocket (tv_list) assim que o pareamento é confirmado — não
      // precisa recarregar nada aqui.
    })
    .catch(() => { errorEl.textContent = 'Erro de conexão ao parear a TV.'; })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Parear TV';
    });
}

// Libera a TV selecionada de volta pro estado "sem dono" — ela ganha um
// código de pareamento novo e some da lista até alguém parear de novo
// (com essa conta ou outra). Funciona com a TV online ou offline — a rota
// mexe só no banco, então nem precisa da TV estar conectada agora (se
// estiver, o servidor manda ela parar e voltar pro código na hora; se não
// estiver, o "stop" e o código novo aparecem sozinhos na próxima vez que
// ela ligar).
// `tvRowId` vem do botão no card da TV. Sem argumento, cai no comportamento
// anterior (a TV atualmente selecionada) — a lógica de desemparelhamento em
// si segue exatamente a mesma.
function despairTv(tvRowId, event) {
  if (event) event.stopPropagation(); // não deixa o clique selecionar o card
  const alvo = tvRowId || selectedTvId;
  if (!alvo) return;
  const tv = tvs.find((t) => String(t.tvRowId) === String(alvo));
  if (!tv) return;
  if (!confirm(`Desparear "${tv.name}"?\n\nEla vai parar de aparecer na sua lista e vai pedir um novo código de pareamento na própria tela — qualquer conta (inclusive esta) pode parear ela de novo depois.`)) return;

  fetch('/tvs/' + tv.tvRowId, { method: 'DELETE' })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) { alert(data.error || 'Não foi possível desparear essa TV.'); return; }
      // A lista de TVs é atualizada automaticamente pelo servidor via
      // WebSocket (tv_list) assim que o desemparelhamento é confirmado.
    })
    .catch(() => { alert('Erro de conexão ao desparear a TV.'); });
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

// onUploaded (opcional): recebe o NOME FINAL de cada arquivo que subiu com
// sucesso. Usado pela zona de envio do formulário de playlist, para o arquivo
// recém-enviado já entrar na ordem de reprodução. O nome final pode diferir do
// nome no computador (o servidor acrescenta " (1)" quando já existe outro com
// aquele nome), por isso quem manda é a resposta do servidor.
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

// ==================== VALIDADE DA MÍDIA (0.6.9) ====================
// (o selo visual de prazo — expiryBadgeHtml/mediaMeta/loadMediaMeta — vivia
// só na grade "Vídeos disponíveis", removida na 0.7.1. O que resta aqui é o
// modal de escolha de prazo no momento do envio, que é independente disso.)

// Preenche o "min" do campo de data com o minuto atual (formato que o
// datetime-local espera: AAAA-MM-DDTHH:MM, no horário LOCAL). É o que impede
// escolher uma data passada já no próprio calendário do navegador — a
// checagem em JS e a do servidor continuam existindo por baixo.
function agoraParaInputLocal() {
  const d = new Date();
  d.setSeconds(0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// O modal é resolvido por uma Promise: quem chama espera a decisão.
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
    // Se o banco ainda não tem a coluna de validade (migração 0.6.9 pendente),
    // escolher uma data seria mentira: o prazo nunca chegaria a valer. Nesse
    // caso o aviso aparece e só "sem prazo" fica disponível.
    const opcaoData = document.querySelector('input[name="expiryChoice"][value="date"]');
    const aviso = document.getElementById('expiryIndisponivel');
    if (opcaoData) opcaoData.disabled = !validadeDisponivel;
    if (aviso) aviso.style.display = validadeDisponivel ? 'none' : 'block';
    document.getElementById('expirySub').textContent = qtdArquivos > 1
      ? `Escolha até quando estes ${qtdArquivos} arquivos devem ficar no ar.`
      : 'Escolha até quando este conteúdo deve ficar no ar.';
    // Sempre reabre em "sem prazo" — a escolha não fica grudada de um envio
    // para o outro.
    document.querySelector('input[name="expiryChoice"][value="never"]').checked = true;
    const campo = document.getElementById('expiryInput');
    campo.value = '';
    campo.min = agoraParaInputLocal();
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
  if (!valor) { erro.textContent = 'Escolha a data e a hora em que o arquivo deve sair do ar.'; return; }
  // O campo devolve a hora LOCAL do navegador; convertemos pra UTC (ISO) pro
  // servidor comparar sem depender do fuso de quem enviou.
  const quando = new Date(valor);
  if (isNaN(quando)) { erro.textContent = 'Data inválida.'; return; }
  if (quando.getTime() <= Date.now()) { erro.textContent = 'A data precisa estar no futuro.'; return; }
  closeExpiryModal({ expiresAt: quando.toISOString() });
}

function handleFiles(fileList, listId, onUploaded) {
  // Só um arquivo por vez: o seletor nativo não deixa mais escolher vários
  // (input sem "multiple"), mas o drag-and-drop ainda permite soltar um
  // punhado de arquivos de uma vez — barrado aqui.
  const arquivos = Array.from(fileList || []);
  if (arquivos.length > 1) {
    alert('Envie um arquivo por vez — selecione ou arraste só um.');
    return;
  }

  // .txt da balança: não é vídeo/imagem pra playlist nenhuma — é o gatilho
  // do precificador automático. Segue um caminho totalmente à parte (nem
  // pede prazo de validade, nem entra na fila de upload comum) e o resultado
  // vale pra CONTA inteira, não só pra playlist que estava aberta na hora.
  if (arquivos.length === 1 && TXT_BALANCA_EXT_REGEX.test(arquivos[0].name)) {
    uploadTabelaPrecos(arquivos[0], listId, onUploaded);
    return;
  }

  const queue = [];
  arquivos.forEach(file => {
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

  // Cancelar aqui cancela o envio — nada sobe.
  askExpiry(queue.length).then((decisao) => {
    if (!decisao || decisao.cancelado) return;
    processUploadQueue(queue, listId, onUploaded, decisao.expiresAt);
  });
}

// Sobe o .txt da balança pro precificador automático (server.js,
// /upload-tabela-precos). Não é um upload de mídia comum — o servidor só
// gera e salva as 7 imagens, sem mexer em nenhuma playlist nem em nenhuma
// TV. Aqui, do lado do cliente, é que cada nome devolvido entra na ordem de
// reprodução da playlist que já estava aberta (`onUploaded`, o mesmo
// callback usado por qualquer upload comum — normalmente
// addUploadedToPlaylist) — ainda falta clicar em "Salvar" pra gravar, e
// escolher a playlist numa TV quando quiser exibir, exatamente como com
// qualquer outro vídeo/imagem.
function uploadTabelaPrecos(file, listId, onUploaded) {
  const list = document.getElementById(listId);
  let itemId = null;
  if (list) {
    itemId = 'up-' + Math.random().toString(36).slice(2);
    const item = document.createElement('div');
    item.className = 'upload-item'; item.id = itemId;
    item.innerHTML = `
      <span>🏷️</span>
      <div class="name">${file.name} — precificando tabelas…</div>
      <div class="upload-bar-track"><div class="upload-bar-fill" id="${itemId}-bar" style="width:100%"></div></div>
      <div class="upload-pct" id="${itemId}-pct">…</div>
    `;
    list.prepend(item);
  }

  const finalizar = (ok, msg) => {
    const el = itemId && document.getElementById(itemId);
    if (el) {
      el.classList.add(ok ? 'done' : 'error');
      const pct = document.getElementById(itemId + '-pct');
      if (pct) pct.textContent = ok ? '✓' : '✗';
      if (!ok && msg) el.title = msg;
      if (ok) setTimeout(() => el.remove(), 4000);
    }
  };

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload-tabela-precos?name=' + encodeURIComponent(file.name));
  xhr.onload = () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status === 200 && data.success) {
      finalizar(true);
      loadStorageUsage();
      const arquivos = Array.isArray(data.arquivos) ? data.arquivos : [];
      // Mesmo destino de qualquer upload comum: entra na ordem de reprodução
      // da playlist que estava aberta na tela (ainda não salva).
      if (onUploaded) arquivos.forEach((nome) => onUploaded(nome));
      let aviso = `${arquivos.length} tabela(s) de preço geradas a partir de "${file.name}" (${data.totalItensTxt} itens lidos do arquivo) e adicionadas a esta playlist. Clique em Salvar para gravar, e selecione a playlist numa TV quando quiser exibir.`;
      if (Array.isArray(data.itensNaoEncontrados) && data.itensNaoEncontrados.length) {
        aviso += `\n\nAtenção: ${data.itensNaoEncontrados.length} item(ns) da tabela não foram encontrados neste .txt (ficaram com a célula de preço em branco):\n- ` + data.itensNaoEncontrados.join('\n- ');
      }
      alert(aviso);
      return;
    }
    finalizar(false, data.error);
    alert('Falha ao precificar as tabelas: ' + (data.error || ('status ' + xhr.status)));
  };
  xhr.onerror = () => {
    finalizar(false, 'Erro de conexão');
    alert('Erro de conexão ao enviar o .txt para o precificador.');
  };
  xhr.send(file);
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
  return fetch('/playlists')
    .then(r => r.json())
    .then(data => {
      playlists = data;
      renderPlList();
      // Se a playlist aberta em MODO VISUALIZAÇÃO mudou de conteúdo por fora
      // (ex: um item dela venceu e a varredura de validade a tirou sozinha —
      // ver `media_changed`), redesenha ela também, sem esperar o usuário
      // trocar de playlist e voltar ou dar F5. O formulário de EDIÇÃO não é
      // mexido aqui de propósito: ele trabalha em cima de uma cópia local
      // (`plSelectedVideos`) que pode ter alterações ainda não salvas, e
      // sincronizar às cegas arriscaria apagar uma edição em andamento.
      const emVisualizacao = document.getElementById('plView').style.display !== 'none';
      if (emVisualizacao && selectedPlaylistId != null) {
        if (playlists[selectedPlaylistId]) {
          showPlView(playlists[selectedPlaylistId]);
        } else {
          // A playlist toda sumiu (não deveria acontecer só por expiração de
          // mídia, mas por segurança) — volta pro estado vazio em vez de
          // continuar mostrando dados de uma playlist que não existe mais.
          selectedPlaylistId = null;
          document.getElementById('plView').style.display = 'none';
          document.getElementById('plEmptyState').style.display = 'flex';
        }
      }
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
    <div class="pl-card ${String(selectedPlaylistId) === String(pl.id) ? 'selected' : ''}" onclick="selectPlaylist('${pl.id}')">
      <div class="pl-card-icon">📋</div>
      <div class="pl-card-info">
        <div class="pl-card-name">${pl.name}</div>
        <div class="pl-card-count">${pl.videos.length ? pl.videos.length + ' vídeo(s)' : 'vazia — sem conteúdo ainda'}</div>
      </div>
      <button class="pl-card-del" onclick="event.stopPropagation(); deletePlaylist('${pl.id}')" title="Excluir">×</button>
    </div>
  `).join('');
}

function selectPlaylist(id) {
  selectedPlaylistId = String(id);
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
  const vazia = itemCount === 0;
  document.getElementById('plViewCount').textContent = vazia
    ? 'Nenhum item ainda — clique em ➕ Adicionar vídeos'
    : itemCount + ' item(ns) · loop contínuo';

  const ol = document.getElementById('plViewOrderList');
  if (vazia) {
    ol.innerHTML = `<div style="color:var(--muted); font-size:13px; padding:12px 0;">
      Esta playlist ainda está vazia. Use <strong>➕ Adicionar vídeos</strong> para enviar arquivos ou escolher os que já estão na biblioteca.
    </div>`;
  } else {
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
  }

  // Sem conteúdo não há o que mandar pra TV: os dois botões de envio ficam
  // desabilitados até a playlist ter pelo menos um item.
  const btnEnviar = document.getElementById('plSendBtn');
  const btnTodas = document.getElementById('plBroadcastBtn');
  if (btnTodas) {
    btnTodas.disabled = vazia;
    btnTodas.title = vazia ? 'Adicione pelo menos um item à playlist antes de enviar.' : '';
  }
  if (btnEnviar) {
    btnEnviar.title = vazia ? 'Adicione pelo menos um item à playlist antes de enviar.' : '';
  }

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
  // Além de exigir uma TV escolhida, o botão só libera se a playlist tiver
  // conteúdo — mandar uma playlist vazia deixaria a TV parada sem nada.
  const pl = playlists[selectedPlaylistId];
  const semConteudo = !pl || !Array.isArray(pl.videos) || pl.videos.length === 0;
  const atualizarBotao = () => {
    document.getElementById('plSendBtn').disabled = !sel.value || semConteudo;
  };
  sel.onchange = atualizarBotao;
  atualizarBotao();
}

function sendPlaylistToTv() {
  const code = document.getElementById('plTvSelect').value;
  if (!code || !selectedPlaylistId) return;
  const pl = playlists[selectedPlaylistId];
  if (!pl || !pl.videos || !pl.videos.length) {
    alert('Esta playlist está vazia. Adicione pelo menos um item antes de enviar para a TV.');
    return;
  }
  ws.send(JSON.stringify({ type: 'play_playlist', code, playlist: pl }));
  // Feedback visual
  const btn = document.getElementById('plSendBtn');
  btn.textContent = '✓ Enviada!';
  setTimeout(() => { btn.textContent = '▶ Iniciar Playlist'; }, 2000);
}

function broadcastPlaylist() {
  if (!selectedPlaylistId) return;
  const pl = playlists[selectedPlaylistId];
  if (!pl || !pl.videos || !pl.videos.length) {
    alert('Esta playlist está vazia. Adicione pelo menos um item antes de enviar para as TVs.');
    return;
  }
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
      // Comparação por String(): selectedPlaylistId às vezes vem de um
      // clique (string, via atributo onclick) e às vezes vem direto da
      // resposta da API depois de salvar (number, id do Postgres) — usar
      // "===" direto deixava esse fechamento de painel dependendo de sorte
      // de tipo, e o painel ficava aberto "por engano" com uma playlist já
      // excluída.
      if (String(selectedPlaylistId) === String(id)) {
        selectedPlaylistId = null;
        editingPlaylistId = null;
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

  // Criar playlist pede SÓ o nome. Envio de arquivo e escolha de conteúdo
  // acontecem dentro de uma playlist que já existe — nunca soltos, fora dela.
  const existente = !!pl;
  const bloco = document.getElementById('plContentBlock');
  const aviso = document.getElementById('plNovaAviso');
  if (bloco) bloco.style.display = existente ? '' : 'none';
  if (aviso) aviso.style.display = existente ? 'none' : '';

  if (existente) {
    renderPlOrderList();
  }
}

// Botão "➕ Adicionar vídeos" do cabeçalho da playlist aberta: é o caminho
// para colocar conteúdo. Abre o formulário dela já rolado até a área de envio.
function addVideosToPlaylist() {
  if (!selectedPlaylistId) return;
  editPlaylist();
  const bloco = document.getElementById('plContentBlock');
  if (bloco && bloco.scrollIntoView) {
    bloco.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
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

// Chamada quando um arquivo termina de subir pela zona de envio de DENTRO do
// formulário de playlist: já é incluído direto na ordem de reprodução — que é
// o que se espera de "enviar para esta playlist" (não existe mais uma grade
// de "vídeos disponíveis" separada pra escolher depois).
function addUploadedToPlaylist(name) {
  if (!name) return;
  const form = document.getElementById('plForm');
  if (!form || getComputedStyle(form).display === 'none') return; // formulário fechado
  if (plSelectedVideos.includes(name)) return;                    // já está na lista

  plSelectedVideos.push(name);
  plSelectedDurations[name] = IMAGE_EXT_REGEX.test(name) ? IMAGE_DURATION_DEFAULT : 0;
  const erro = document.getElementById('plVideosError');
  if (erro) erro.textContent = '';
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

  // Playlist vazia pode ser salva: serve pra criar agora, com nome, e
  // preencher depois. O que impede de mandar pra TV é o botão de iniciar,
  // desabilitado enquanto não houver conteúdo.
  document.getElementById('plVideosError').textContent = '';

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
      // saved.id vem da API como number (id do Postgres); selectedPlaylistId
      // precisa ficar sempre como string, senão a comparação "===" em outros
      // pontos (ex.: exclusão) falha silenciosamente por tipo diferente.
      selectedPlaylistId = String(saved.id);
      editingPlaylistId = null;
      plSelectedVideos = [];
      renderPlList();
      showPlView(saved);
    })
    .catch(err => alert("Erro ao salvar playlist: " + err));
}

// ==================== CONTAS (painel ADM — Fase 2) ====================
// Só chamado quando currentRole === 'adm' (o botão da aba fica escondido
// pra quem não é ADM, e o servidor recusa as rotas /admin/contas/* de
// qualquer forma — ver requireAdmin() em server.js).

function loadContas(keepForm) {
  fetch('/admin/contas')
    .then((r) => { if (!r.ok) throw new Error('Erro ao carregar contas'); return r.json(); })
    .then((lista) => {
      contas = lista;
      renderContaList();
      // Depois de salvar uma conta, a gente recarrega a lista (pra pegar o
      // que o servidor normalizou) mas quer manter o formulário aberto
      // mostrando a mesma conta, em vez de fechar tudo.
      if (keepForm && editingContaId) {
        const conta = contas.find((c) => c.id === editingContaId);
        if (conta) showContaForm(conta);
      }
    })
    .catch(() => {
      document.getElementById('contaList').innerHTML =
        '<div class="empty-tvs" style="padding:30px 16px;"><p>Erro ao carregar contas.</p></div>';
    });
}

// Dias até a licença vencer (negativo se já venceu). null se não houver
// data definida. Usado tanto na lista de cartões quanto no formulário de
// edição, pra manter a mesma conta de dias nos dois lugares.
function diasParaVencer(licencaExpiraEm) {
  if (!licencaExpiraEm) return null;
  const ms = new Date(licencaExpiraEm).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

// Formata em UTC de propósito: a data vem de um <input type="date"> (só
// "AAAA-MM-DD", sem hora) e o servidor guarda isso como meia-noite UTC. Se
// formatássemos no fuso local (Brasil, UTC-3), a data apareceria um dia
// ANTES do que foi digitado — por isso força UTC aqui pra bater com o que
// a pessoa realmente escolheu no campo.
function formatarDataBr(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function renderContaList() {
  const list = document.getElementById('contaList');
  document.getElementById('contaCount').textContent = contas.length;
  if (!contas.length) {
    list.innerHTML = `<div class="empty-tvs" style="padding:30px 16px;"><div class="icon">👤</div><p>Nenhuma conta cadastrada.<br>Clique em <strong>+ Nova Conta</strong> para criar.</p></div>`;
    return;
  }
  list.innerHTML = contas.map((c) => {
    const roleTag = c.role === 'adm'
      ? '<span class="tag tag-accent">👑 ADM</span>'
      : '<span class="tag tag-muted">Cliente</span>';
    const statusTag = c.ativa
      ? '<span class="tag tag-green">Ativa</span>'
      : '<span class="tag tag-red">Suspensa</span>';

    let licencaTag = '';
    let licencaLinha = '';
    if (c.role !== 'adm') {
      if (c.licenca_permanente) {
        licencaTag = '<span class="tag tag-accent">♾️ Permanente</span>';
      } else if (!c.licenca_expira_em) {
        licencaTag = '<span class="tag tag-amber">Sem validade</span>';
      } else {
        const dias = diasParaVencer(c.licenca_expira_em);
        if (dias < 0) licencaTag = '<span class="tag tag-red">Licença vencida</span>';
        else if (dias <= 10) licencaTag = `<span class="tag tag-amber">Vence em ${dias}d</span>`;
        licencaLinha = `<div style="font-size:11px; color:var(--muted); margin-top:3px;">Válida até ${formatarDataBr(c.licenca_expira_em)}</div>`;
      }
    }

    const tvsLinha = `<div style="font-size:11px; color:var(--muted); margin-top:2px;">📺 ${c.tvs_pareadas || 0}/${c.limite_tvs} TV(s) pareada(s)</div>`;
    const isSelf = currentAccountId != null && c.id === currentAccountId;
    return `
    <div class="pl-card ${editingContaId === c.id ? 'selected' : ''}" onclick="selectConta(${c.id})">
      <div class="pl-card-icon">${c.role === 'adm' ? '👑' : '🏢'}</div>
      <div class="pl-card-info">
        <div class="pl-card-name">${escapeHtml(c.nome_negocio)}${isSelf ? ' <span style="color:var(--muted); font-weight:400;">(você)</span>' : ''}</div>
        <div class="pl-card-count" style="display:flex; gap:6px; flex-wrap:wrap; margin-top:4px;">${roleTag}${statusTag}${licencaTag}</div>
        ${licencaLinha}
        ${tvsLinha}
      </div>
    </div>`;
  }).join('');
}

function openNewConta() {
  editingContaId = null;
  renderContaList();
  showContaForm(null);
}

function selectConta(id) {
  editingContaId = id;
  renderContaList();
  const conta = contas.find((c) => c.id === id);
  if (conta) showContaForm(conta);
}

function showContaForm(conta) {
  document.getElementById('contaEmptyState').style.display = 'none';
  document.getElementById('contaForm').style.display = 'flex';
  document.getElementById('contaFormTitle').textContent = conta ? 'Editar Conta' : 'Nova Conta';

  document.getElementById('contaNomeInput').value = conta ? conta.nome_negocio : '';
  document.getElementById('contaNomeError').textContent = '';

  document.getElementById('contaRoleInput').value = conta ? conta.role : 'cliente';
  document.getElementById('contaSenhaInput').value = '';
  document.getElementById('contaSenhaError').textContent = '';
  document.getElementById('contaSenhaLabel').textContent = conta ? 'Nova senha' : 'Senha *';
  document.getElementById('contaSenhaInput').placeholder = conta ? 'Deixe em branco para não alterar' : 'Mínimo 6 caracteres';
  ocultarContaSenha(); // sempre reabre o formulário com a senha oculta, mesmo se a última edição tinha deixado visível

  document.getElementById('contaLimiteTvsInput').value = conta ? conta.limite_tvs : 1;
  document.getElementById('contaLimiteGbInput').value = conta ? conta.limite_armazenamento_gb : 5;
  document.getElementById('contaTvsPareadasHint').textContent = conta
    ? `${conta.tvs_pareadas || 0} TV(s) pareada(s) atualmente com esta conta.`
    : '';

  document.getElementById('contaLicencaInput').value = conta && conta.licenca_expira_em ? conta.licenca_expira_em.slice(0, 10) : '';
  document.getElementById('contaLicencaPermanenteInput').checked = conta ? !!conta.licenca_permanente : false;
  toggleLicencaPermanente(); // sincroniza o campo de data (desabilitado) com o checkbox que acabou de ser preenchido
  atualizarStatusLicenca(conta);

  document.getElementById('contaAtivaInput').checked = conta ? !!conta.ativa : true;

  // Guardas de segurança: o próprio ADM logado não pode se excluir nem
  // trocar o próprio papel por aqui (o servidor recusa de qualquer jeito —
  // isso só evita a tentativa frustrada e explica o motivo na tela).
  const isSelf = conta && currentAccountId != null && conta.id === currentAccountId;
  const deleteBtn = document.getElementById('contaDeleteBtn');
  deleteBtn.style.display = conta ? 'inline-flex' : 'none';
  deleteBtn.disabled = !!isSelf;
  deleteBtn.title = isSelf ? 'Você não pode excluir a própria conta logada aqui.' : '';

  const roleInput = document.getElementById('contaRoleInput');
  roleInput.disabled = !!isSelf;
  document.getElementById('contaRoleHint').textContent = isSelf
    ? 'Você não pode trocar o próprio papel de ADM por aqui.'
    : '';
}

// Alterna o campo de senha da conta (criar/editar no painel ADM) entre
// oculto/visível — mesma ideia do botão da tela de login, só que reaproveita
// o CSS do formulário de conta (.pw-toggle-wrap/.pw-toggle-btn).
function toggleContaSenhaVisivel() {
  const input = document.getElementById('contaSenhaInput');
  const mostrando = input.type === 'text';
  if (mostrando) ocultarContaSenha(); else mostrarContaSenha();
}

function mostrarContaSenha() {
  document.getElementById('contaSenhaInput').type = 'text';
  document.getElementById('contaSenhaToggleIconOpen').style.display = 'none';
  document.getElementById('contaSenhaToggleIconClosed').style.display = '';
  const btn = document.getElementById('contaSenhaToggleBtn');
  btn.setAttribute('aria-label', 'Ocultar senha');
  btn.title = 'Ocultar senha';
}

function ocultarContaSenha() {
  document.getElementById('contaSenhaInput').type = 'password';
  document.getElementById('contaSenhaToggleIconOpen').style.display = '';
  document.getElementById('contaSenhaToggleIconClosed').style.display = 'none';
  const btn = document.getElementById('contaSenhaToggleBtn');
  btn.setAttribute('aria-label', 'Mostrar senha');
  btn.title = 'Mostrar senha';
}

// Desabilita o campo de data quando "licença permanente" está marcado — o
// valor da data NÃO é apagado (só ignorado enquanto o checkbox estiver
// marcado), então desmarcar depois devolve a data anterior sem precisar
// digitar de novo.
function toggleLicencaPermanente() {
  const permanente = document.getElementById('contaLicencaPermanenteInput').checked;
  const dateInput = document.getElementById('contaLicencaInput');
  dateInput.disabled = permanente;
  dateInput.style.opacity = permanente ? '0.5' : '1';
}

// Linha de status abaixo do campo de licença — mesma lógica de "quantos
// dias faltam" usada nos cartões da lista, só que com texto mais explicado
// pra quem está editando uma conta específica.
function atualizarStatusLicenca(conta) {
  const el = document.getElementById('contaLicencaStatus');
  if (!conta || conta.role === 'adm') {
    el.textContent = '';
    return;
  }
  if (conta.licenca_permanente) {
    el.textContent = '♾️ Licença permanente — nunca bloqueia o login desta conta.';
    el.style.color = 'var(--accent)';
    return;
  }
  if (!conta.licenca_expira_em) {
    el.textContent = '⚠️ Sem data definida — o login desta conta está bloqueado até você definir uma validade (ou marcar "licença permanente").';
    el.style.color = 'var(--amber)';
    return;
  }
  const dias = diasParaVencer(conta.licenca_expira_em);
  if (dias < 0) {
    el.textContent = `❌ Licença vencida há ${Math.abs(dias)} dia(s) (${formatarDataBr(conta.licenca_expira_em)}) — o login está bloqueado.`;
    el.style.color = 'var(--red)';
  } else if (dias <= 10) {
    el.textContent = `⚠️ Vence em ${dias} dia(s) — ${formatarDataBr(conta.licenca_expira_em)}.`;
    el.style.color = 'var(--amber)';
  } else {
    el.textContent = `Válida até ${formatarDataBr(conta.licenca_expira_em)}.`;
    el.style.color = 'var(--muted)';
  }
}

function cancelContaEdit() {
  editingContaId = null;
  document.getElementById('contaForm').style.display = 'none';
  document.getElementById('contaEmptyState').style.display = 'flex';
  renderContaList();
}

function saveConta() {
  const nome = document.getElementById('contaNomeInput').value.trim();
  const role = document.getElementById('contaRoleInput').value;
  const senha = document.getElementById('contaSenhaInput').value;
  const limiteTvs = document.getElementById('contaLimiteTvsInput').value;
  const limiteGb = document.getElementById('contaLimiteGbInput').value;
  const licenca = document.getElementById('contaLicencaInput').value; // "" ou "AAAA-MM-DD"
  const licencaPermanente = document.getElementById('contaLicencaPermanenteInput').checked;
  const ativa = document.getElementById('contaAtivaInput').checked;

  let valid = true;
  if (!nome) {
    document.getElementById('contaNomeError').textContent = 'Informe o nome da empresa.';
    valid = false;
  } else {
    document.getElementById('contaNomeError').textContent = '';
  }

  const criandoNova = !editingContaId;
  if (criandoNova && (!senha || senha.length < 6)) {
    document.getElementById('contaSenhaError').textContent = 'A senha deve ter pelo menos 6 caracteres.';
    valid = false;
  } else if (!criandoNova && senha && senha.length < 6) {
    document.getElementById('contaSenhaError').textContent = 'A nova senha deve ter pelo menos 6 caracteres.';
    valid = false;
  } else {
    document.getElementById('contaSenhaError').textContent = '';
  }

  if (!valid) return;

  const payload = {
    nomeNegocio: nome,
    role,
    limiteTvs,
    limiteArmazenamentoGb: limiteGb,
    licencaExpiraEm: licenca || null,
    licencaPermanente,
    ativa,
  };
  if (senha) payload.senha = senha;

  const btn = document.getElementById('contaSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Salvando...';

  const request = editingContaId
    ? fetch('/admin/contas/' + editingContaId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    : fetch('/admin/contas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

  request
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) {
        document.getElementById('contaNomeError').textContent = data.error || 'Erro ao salvar a conta.';
        return;
      }
      editingContaId = data.id;
      loadContas(true);
    })
    .catch(() => {
      document.getElementById('contaNomeError').textContent = 'Erro de conexão ao salvar.';
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Salvar';
    });
}

function deleteConta() {
  if (!editingContaId) return;
  const conta = contas.find((c) => c.id === editingContaId);
  if (!conta) return;
  const digitado = prompt(
    `Para excluir a conta "${conta.nome_negocio}" definitivamente, digite o nome da empresa exatamente como está:`
  );
  if (digitado === null) return; // cancelou
  if (digitado.trim() !== conta.nome_negocio) {
    alert('O nome digitado não confere com o nome da conta. Nada foi excluído.');
    return;
  }
  fetch('/admin/contas/' + editingContaId, { method: 'DELETE' })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) { alert(data.error || 'Erro ao excluir a conta.'); return; }
      cancelContaEdit();
      loadContas();
    })
    .catch(() => alert('Erro de conexão ao excluir a conta.'));
}

// ==================== SESSÃO (login) ====================
// Confere se existe sessão válida ANTES de carregar qualquer coisa do
// controlador — sem isso, o resto do init() abaixo rodaria (e o WebSocket
// tentaria conectar) mesmo sem ninguém logado. A conexão do WebSocket é
// quem de fato barra o controle das TVs (valida o cookie no servidor); este
// redirecionamento aqui é só pra não mostrar a tela por trás.
function checkSessionAndInit() {
  fetch('/me')
    .then((r) => {
      if (!r.ok) throw new Error('not-authenticated');
      return r.json();
    })
    .then((conta) => {
      currentAccountId = conta.id;
      currentRole = conta.role;
      const chip = document.getElementById('accountChip');
      const nameEl = document.getElementById('accountChipName');
      if (chip && nameEl) {
        nameEl.textContent = conta.role === 'adm' ? '👑 ' + (conta.nomeNegocio || 'ADM') : conta.nomeNegocio || conta.email;
        chip.style.display = 'flex';
      }
      if (conta.role === 'adm') {
        const contasTabBtn = document.getElementById('tab-contas');
        if (contasTabBtn) contasTabBtn.style.display = 'flex';
      }
      initApp();
    })
    .catch(() => {
      window.location.href = '/login.html';
    });
}

function logout() {
  fetch('/logout', { method: 'POST' })
    .catch(() => {})
    .then(() => { window.location.href = '/login.html'; });
}

// ==================== INIT ====================
function initApp() {
  loadVersion();
  connect();
  // Única zona de envio do painel desde que a aba Vídeos saiu (0.6.1): o que
  // sobe aqui entra na biblioteca E na playlist que está sendo montada.
  setupDropzone('dropzone-playlist', 'fileInput-playlist', 'uploadList-playlist', addUploadedToPlaylist);
}

checkSessionAndInit();

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
