const socket = io();

const joinCard = document.getElementById('join-card');
const joinKicker = document.getElementById('join-kicker');
const joinTitle = document.getElementById('join-title');
const joinLede = document.getElementById('join-lede');
const roomCard = document.getElementById('room-card');
const joinForm = document.getElementById('join-form');
const modeToggle = document.getElementById('mode-toggle');
const roomField = document.getElementById('room-field');
const roomInput = document.getElementById('room-input');
const nameInput = document.getElementById('name-input');
const joinModeBtn = document.getElementById('join-mode-btn');
const createModeBtn = document.getElementById('create-mode-btn');
const joinSubmitBtn = document.getElementById('join-submit-btn');
const otherRoomLink = document.getElementById('other-room-link');
const joinError = document.getElementById('join-error');

const speakerCard = document.getElementById('speaker-card');
const controlsCard = document.getElementById('controls-card');
const ownerShareCard = document.getElementById('owner-share-card');
const moderatorCard = document.getElementById('moderator-card');
const roomTitle = document.getElementById('room-title');
const roomLink = document.getElementById('room-link');
const roomQrWrap = document.getElementById('room-qr-wrap');
const roomQr = document.getElementById('room-qr');
const queueBadge = document.getElementById('queue-badge');
const queueTitle = document.getElementById('queue-title');
const currentSpeakerEl = document.getElementById('current-speaker');
const joinQueueBtn = document.getElementById('join-queue-btn');
const respondBtn = document.getElementById('respond-btn');
const yieldBtn = document.getElementById('yield-btn');
const forceYieldBtn = document.getElementById('force-yield-btn');
const pauseRoomBtn = document.getElementById('pause-room-btn');
const moderatorReplyOrder = document.getElementById('moderator-reply-order');
const moderatorMainOrder = document.getElementById('moderator-main-order');
const mainQueueEl = document.getElementById('main-queue');
const pauseOverlay = document.getElementById('pause-overlay');

let me = null;
let roomId = '';
let roomState = null;
let isCreateMode = false;
let forcedRoomId = '';
let draggedModeratorId = null;
let draggedModeratorKind = null;

const isModeratorPath = window.location.pathname.replace(/\/+$/, '') === '/mod';

function isCreator() {
  return me?.role === 'creator';
}

function isModerator() {
  return me?.role === 'moderator';
}

function canParticipate() {
  return me?.role === 'user' || me?.role === 'moderator';
}

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
  const lockedJoinMode = hasForcedRoom || isModeratorPath;

  joinCard.classList.toggle('compact-join-card', hasForcedRoom);
  joinKicker.classList.toggle('hidden', hasForcedRoom);
  joinTitle.textContent = hasForcedRoom
    ? 'You are now joining a room.'
    : isModeratorPath
      ? 'Join a room as moderator.'
      : 'Keep speaking turns structured without killing the flow.';
  joinTitle.classList.remove('hidden');
  joinLede.classList.toggle('hidden', hasForcedRoom || isModeratorPath);
  otherRoomLink.classList.toggle('hidden', !hasForcedRoom);
  modeToggle.classList.toggle('hidden', lockedJoinMode);
  roomField.classList.toggle('hidden', isCreateMode || hasForcedRoom);
  roomInput.required = !isCreateMode && !hasForcedRoom;
  joinModeBtn.classList.toggle('active', !isCreateMode);
  createModeBtn.classList.toggle('active', isCreateMode);
  joinModeBtn.setAttribute('aria-pressed', String(!isCreateMode));
  createModeBtn.setAttribute('aria-pressed', String(isCreateMode));
  joinSubmitBtn.textContent = isModeratorPath
    ? 'Join As Moderator'
    : hasForcedRoom
      ? 'Join Room'
      : isCreateMode
        ? 'Create Room'
        : 'Join Room';
}

function renderTalkingQueue() {
  mainQueueEl.innerHTML = '';

  const block = roomState.activeBlock;
  const hasCurrent = Boolean(block);
  const hasQueued = roomState.mainQueue.length > 0;
  if (!hasCurrent && !hasQueued) {
    const li = document.createElement('li');
    li.textContent = 'None';
    mainQueueEl.appendChild(li);
    return;
  }

  if (hasCurrent) {
    const currentLi = document.createElement('li');
    const currentName =
      block.mainSpeaker.id === me.id ? `${block.mainSpeaker.name} (you)` : block.mainSpeaker.name;
    currentLi.textContent = `${currentName} (current speaker)`;
    if (block.mainSpeaker.status === 'completed') {
      currentLi.classList.add('completed-speaker');
    }
    mainQueueEl.appendChild(currentLi);

    if (block.replies.length > 0) {
      const nested = document.createElement('ol');
      for (const responder of block.replies) {
        const nestedLi = document.createElement('li');
        const responderName = responder.id === me.id ? `${responder.name} (you)` : responder.name;
        if (responder.status === 'current') {
          nestedLi.textContent = `${responderName} (current response)`;
        } else if (responder.status === 'completed') {
          nestedLi.textContent = `${responderName} (response completed)`;
          nestedLi.classList.add('completed-speaker');
        } else {
          nestedLi.textContent = `${responderName} (response)`;
        }
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

function makeModeratorItem(entry, kind) {
  const li = document.createElement('li');
  li.textContent = entry.id === me.id ? `${entry.name} (you)` : entry.name;
  li.dataset.id = entry.id;
  li.dataset.kind = kind;
  li.draggable = true;
  li.classList.add('draggable-item');
  li.addEventListener('dragstart', () => {
    draggedModeratorId = entry.id;
    draggedModeratorKind = kind;
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    draggedModeratorId = null;
    draggedModeratorKind = null;
    li.classList.remove('dragging');
  });
  li.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  li.addEventListener('drop', (event) => {
    event.preventDefault();
    if (!draggedModeratorId || draggedModeratorKind !== kind || draggedModeratorId === entry.id) return;
    const container = kind === 'replies' ? moderatorReplyOrder : moderatorMainOrder;
    const ids = Array.from(container.children).map((child) => child.dataset.id);
    const from = ids.indexOf(draggedModeratorId);
    const to = ids.indexOf(entry.id);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    socket.emit('queue:reorder', { kind, orderedIds: ids });
  });
  return li;
}

function renderModeratorQueues() {
  moderatorReplyOrder.innerHTML = '';
  moderatorMainOrder.innerHTML = '';

  const queuedReplies = roomState.activeBlock?.replies.filter((reply) => reply.status === 'queued') || [];
  const hasReplies = queuedReplies.length > 0;
  const hasMain = roomState.mainQueue.length > 0;

  if (!hasReplies) {
    const li = document.createElement('li');
    li.textContent = 'No pending replies';
    moderatorReplyOrder.appendChild(li);
  } else {
    for (const reply of queuedReplies) {
      moderatorReplyOrder.appendChild(makeModeratorItem(reply, 'replies'));
    }
  }

  if (!hasMain) {
    const li = document.createElement('li');
    li.textContent = 'No queued speakers';
    moderatorMainOrder.appendChild(li);
  } else {
    for (const speaker of roomState.mainQueue) {
      moderatorMainOrder.appendChild(makeModeratorItem(speaker, 'main'));
    }
  }
}

function updateButtons() {
  if (!roomState || !me) {
    joinQueueBtn.disabled = true;
    respondBtn.disabled = true;
    yieldBtn.disabled = true;
    return;
  }

  if (!canParticipate()) {
    joinQueueBtn.disabled = true;
    respondBtn.disabled = true;
    yieldBtn.disabled = true;
    return;
  }

  if (roomState.paused && !isModerator()) {
    joinQueueBtn.disabled = true;
    respondBtn.disabled = true;
    yieldBtn.disabled = true;
    return;
  }

  const current = roomState.currentSpeaker;
  const iAmCurrent = current?.id === me.id;

  const inMainQueue = roomState.mainQueue.some((p) => p.id === me.id);
  const inResponseQueue = roomState.activeBlock?.replies.some(
    (reply) => reply.id === me.id && reply.status !== 'completed',
  ) || false;

  joinQueueBtn.disabled = iAmCurrent || inMainQueue || inResponseQueue;
  respondBtn.disabled = !current || iAmCurrent || inMainQueue || inResponseQueue;
  yieldBtn.disabled = !iAmCurrent;
}

function renderState() {
  if (!roomState || !me) return;
  const creatorView = isCreator();
  const moderatorView = isModerator();

  if (!roomState.currentSpeaker) {
    currentSpeakerEl.textContent = 'Nobody speaking yet.';
  } else {
    const who = roomState.currentSpeaker.name;
    if (roomState.currentSpeaker.role === 'reply') {
      currentSpeakerEl.textContent = `${who} (replying to current speaker)`;
    } else {
      currentSpeakerEl.textContent = who;
    }
  }

  ownerShareCard.classList.toggle('hidden', !creatorView);
  speakerCard.classList.remove('hidden');
  controlsCard.classList.toggle('hidden', !canParticipate());
  moderatorCard.classList.toggle('hidden', !moderatorView);
  pauseOverlay.classList.toggle('hidden', !roomState.paused || moderatorView);
  queueBadge.textContent = creatorView ? 'Order' : moderatorView ? 'Queue' : 'Live';
  queueTitle.textContent = creatorView ? 'Speaking Queue' : 'Talking Queue';
  pauseRoomBtn.textContent = roomState.paused ? 'Unpause Room' : 'Pause Room';
  renderTalkingQueue();
  if (moderatorView) {
    renderModeratorQueues();
  }
  updateButtons();
}

function enterRoomUI() {
  document.body.classList.add('room-active');
  joinCard.classList.add('hidden');
  roomCard.classList.remove('hidden');
  ownerShareCard.classList.add('hidden');
  roomTitle.textContent = `Room ${roomId}`;
  const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
  roomLink.innerHTML = `Share link: <a href="${url}">${url}</a>`;
  roomQr.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(url)}`;
  roomQrWrap.classList.remove('hidden');
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
  socket.emit('room:join', {
    roomId,
    name,
    createRoom: !isModeratorPath && isCreateMode,
    role: isModeratorPath ? 'moderator' : 'user',
  });
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

forceYieldBtn.addEventListener('click', () => {
  socket.emit('turn:force-yield');
});

pauseRoomBtn.addEventListener('click', () => {
  if (!roomState) return;
  socket.emit('room:pause', { paused: !roomState.paused });
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
  otherRoomLink.querySelector('a').href = `${window.location.origin}${isModeratorPath ? '/mod' : '/'}`;
  if (rid) {
    forcedRoomId = rid.toUpperCase();
    roomInput.value = forcedRoomId;
    isCreateMode = false;
  }
  syncJoinMode();
})();
