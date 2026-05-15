const socket = io();

const joinCard = document.getElementById('join-card');
const roomCard = document.getElementById('room-card');
const joinForm = document.getElementById('join-form');
const modeToggle = document.getElementById('mode-toggle');
const roomField = document.getElementById('room-field');
const roomInput = document.getElementById('room-input');
const nameInput = document.getElementById('name-input');
const joinModeBtn = document.getElementById('join-mode-btn');
const createModeBtn = document.getElementById('create-mode-btn');
const joinSubmitBtn = document.getElementById('join-submit-btn');
const joinError = document.getElementById('join-error');

const roomTitle = document.getElementById('room-title');
const roomLink = document.getElementById('room-link');
const roomQr = document.getElementById('room-qr');
const currentSpeakerEl = document.getElementById('current-speaker');
const joinQueueBtn = document.getElementById('join-queue-btn');
const respondBtn = document.getElementById('respond-btn');
const yieldBtn = document.getElementById('yield-btn');
const mainQueueEl = document.getElementById('main-queue');
const participantsEl = document.getElementById('participants');

let me = null;
let roomId = '';
let roomState = null;
let isCreateMode = false;
let forcedRoomId = '';

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function renderList(container, items) {
  container.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.textContent = 'None';
    container.appendChild(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    container.appendChild(li);
  }
}

function syncJoinMode() {
  const hasForcedRoom = Boolean(forcedRoomId);

  modeToggle.classList.toggle('hidden', hasForcedRoom);
  roomField.classList.toggle('hidden', isCreateMode || hasForcedRoom);
  roomInput.required = !isCreateMode && !hasForcedRoom;
  joinModeBtn.classList.toggle('active', !isCreateMode);
  createModeBtn.classList.toggle('active', isCreateMode);
  joinModeBtn.setAttribute('aria-pressed', String(!isCreateMode));
  createModeBtn.setAttribute('aria-pressed', String(isCreateMode));
  joinSubmitBtn.textContent = hasForcedRoom ? 'Join Room' : isCreateMode ? 'Create Room' : 'Join Room';
}

function renderTalkingQueue() {
  mainQueueEl.innerHTML = '';

  const hasCurrent = Boolean(roomState.currentSpeaker);
  const hasQueued = roomState.mainQueue.length > 0;
  if (!hasCurrent && !hasQueued) {
    const li = document.createElement('li');
    li.textContent = 'None';
    mainQueueEl.appendChild(li);
    return;
  }

  if (hasCurrent) {
    const current = roomState.currentSpeaker;
    const currentLi = document.createElement('li');
    const currentName = current.userId === me.id ? `${current.name} (you)` : current.name;
    currentLi.textContent =
      current.type === 'response'
        ? `${currentName} (current response)`
        : `${currentName} (current speaker)`;
    mainQueueEl.appendChild(currentLi);

    if (roomState.responseQueue.length > 0) {
      const nested = document.createElement('ol');
      for (const responder of roomState.responseQueue) {
        const nestedLi = document.createElement('li');
        const responderName = responder.id === me.id ? `${responder.name} (you)` : responder.name;
        nestedLi.textContent = `${responderName} (response)`;
        nested.appendChild(nestedLi);
      }
      currentLi.appendChild(nested);
    }
  }

  for (const queued of roomState.mainQueue) {
    const li = document.createElement('li');
    li.textContent = queued.id === me.id ? `${queued.name} (you)` : queued.name;
    mainQueueEl.appendChild(li);
  }
}

function updateButtons() {
  if (!roomState || !me) {
    joinQueueBtn.disabled = true;
    respondBtn.disabled = true;
    yieldBtn.disabled = true;
    return;
  }

  const current = roomState.currentSpeaker;
  const iAmCurrent = current?.userId === me.id;

  const inMainQueue = roomState.mainQueue.some((p) => p.id === me.id);
  const inResponseQueue = roomState.responseQueue.some((p) => p.id === me.id);

  joinQueueBtn.disabled = iAmCurrent || inMainQueue || inResponseQueue;
  respondBtn.disabled = !current || iAmCurrent || inMainQueue || inResponseQueue;
  yieldBtn.disabled = !iAmCurrent;
}

function renderState() {
  if (!roomState || !me) return;

  if (!roomState.currentSpeaker) {
    currentSpeakerEl.textContent = 'Nobody speaking yet.';
  } else {
    const who = roomState.currentSpeaker.name;
    if (roomState.currentSpeaker.type === 'response') {
      currentSpeakerEl.textContent = `${who} (response subturn)`;
    } else {
      currentSpeakerEl.textContent = who;
    }
  }

  const participantLabels = roomState.participants.map((p) => p.id === me.id ? `${p.name} (you)` : p.name);

  renderTalkingQueue();
  renderList(participantsEl, participantLabels);

  updateButtons();
}

function enterRoomUI() {
  joinCard.classList.add('hidden');
  roomCard.classList.remove('hidden');
  roomTitle.textContent = `Room ${roomId}`;
  const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
  roomLink.innerHTML = `Share link: <a href="${url}">${url}</a>`;
  roomQr.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(url)}`;
  roomQr.classList.remove('hidden');
}

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  joinError.textContent = '';

  if (!name) {
    joinError.textContent = isCreateMode
      ? 'Enter your name before creating a room.'
      : 'Please enter both room and name.';
    return;
  }

  const rid = forcedRoomId || (isCreateMode ? makeRoomId() : roomInput.value.trim().toUpperCase());
  if (!rid) {
    joinError.textContent = 'Please enter both room and name.';
    roomInput.focus();
    return;
  }

  if (isCreateMode) {
    roomInput.value = rid;
  }

  roomId = rid;
  socket.emit('room:join', { roomId, name });
});

joinModeBtn.addEventListener('click', () => {
  isCreateMode = false;
  joinError.textContent = '';
  syncJoinMode();
});

createModeBtn.addEventListener('click', () => {
  isCreateMode = true;
  joinError.textContent = '';
  syncJoinMode();
});

joinQueueBtn.addEventListener('click', () => {
  socket.emit('queue:join');
});

respondBtn.addEventListener('click', () => {
  socket.emit('queue:respond');
});

yieldBtn.addEventListener('click', () => {
  socket.emit('turn:yield');
});

socket.on('room:error', ({ message }) => {
  joinError.textContent = message || 'Unable to join room.';
});

socket.on('room:joined', (payload) => {
  me = payload.me;
  roomId = payload.roomId;
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId);
  window.history.replaceState({}, '', url);
  enterRoomUI();
  updateButtons();
});

socket.on('room:state', (state) => {
  roomState = state;
  renderState();
});

(function init() {
  const url = new URL(window.location.href);
  const rid = url.searchParams.get('room');
  if (rid) {
    forcedRoomId = rid.toUpperCase();
    roomInput.value = forcedRoomId;
    isCreateMode = false;
  }
  syncJoinMode();
})();
