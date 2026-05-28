const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');

app.use(express.static(publicDir));
app.get('/room/:roomId/creator', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.get('/room/:roomId/admin', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.get('/room/:roomId', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.get('/mod', (_req, res) => {
  res.redirect('/admin');
});

const rooms = new Map();
const socketMeta = new Map();

function createRoomState() {
  return {
    participants: new Map(),
    mainQueue: [],
    currentBlock: null,
    turnSeq: 0,
    ownerId: null,
    creatorToken: null,
    paused: false,
  };
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function createRoom(roomId) {
  const room = createRoomState();
  rooms.set(roomId, room);
  return room;
}

function makeBlockId(room) {
  room.turnSeq += 1;
  return `${room.turnSeq}`;
}

function makeSpeakerEntry(id, name, role, status) {
  return {
    id,
    name,
    role,
    status,
  };
}

function getParticipant(room, userId) {
  return room.participants.get(userId) || null;
}

function isModerator(room, userId) {
  return getParticipant(room, userId)?.role === 'moderator';
}

function canUseParticipationTools(room, userId) {
  const role = getParticipant(room, userId)?.role;
  return role === 'user' || role === 'moderator';
}

function interactionBlocked(room, userId) {
  return room.paused && !isModerator(room, userId);
}

function isQueued(room, userId) {
  if (room.mainQueue.some((entry) => entry.id === userId)) return true;
  if (!room.currentBlock) return false;
  if (room.currentBlock.mainSpeaker.id === userId) return true;
  for (const reply of room.currentBlock.replies) {
    if (reply.id === userId) {
      return true;
    }
  }
  return false;
}

function removeFromQueues(room, userId) {
  room.mainQueue = room.mainQueue.filter((entry) => entry.id !== userId);
  if (!room.currentBlock) {
    return;
  }

  if (room.currentBlock.mainSpeaker.id === userId) {
    room.currentBlock.mainSpeaker.status = 'completed';
  }

  room.currentBlock.replies = room.currentBlock.replies.filter((reply) => {
    if (reply.id !== userId) return true;
    return reply.status === 'completed';
  });
}

function findCurrentEntry(room) {
  if (!room.currentBlock) return null;
  if (room.currentBlock.mainSpeaker.status === 'current') {
    return room.currentBlock.mainSpeaker;
  }
  return room.currentBlock.replies.find((reply) => reply.status === 'current') || null;
}

function startNextMainBlock(room) {
  while (room.mainQueue.length > 0) {
    const nextSpeaker = room.mainQueue.shift();
    if (room.participants.has(nextSpeaker.id)) {
      room.currentBlock = {
        blockId: makeBlockId(room),
        mainSpeaker: makeSpeakerEntry(nextSpeaker.id, nextSpeaker.name, 'main', 'current'),
        replies: [],
      };
      return;
    }
  }
  room.currentBlock = null;
}

function advanceCurrentBlock(room) {
  if (!room.currentBlock) {
    return;
  }

  for (const reply of room.currentBlock.replies) {
    if (reply.status === 'queued' && room.participants.has(reply.id)) {
      reply.status = 'current';
      return;
    }
  }

  room.currentBlock = null;
  startNextMainBlock(room);
}

function applyYield(room) {
  const currentEntry = findCurrentEntry(room);
  if (!currentEntry) {
    return;
  }

  currentEntry.status = 'completed';
  advanceCurrentBlock(room);
}

function serializeRoom(room) {
  const participants = [];
  for (const [id, data] of room.participants.entries()) {
    participants.push({ id, name: data.name });
  }

  const currentEntry = findCurrentEntry(room);
  const currentSpeaker = currentEntry
    ? {
        id: currentEntry.id,
        name: currentEntry.name,
        role: currentEntry.role,
        status: currentEntry.status,
      }
    : null;

  const mainQueue = room.mainQueue
    .filter((entry) => room.participants.has(entry.id))
    .map((entry) => ({ id: entry.id, name: entry.name }));

  return {
    ownerId: room.ownerId,
    paused: room.paused,
    participants,
    currentSpeaker,
    mainQueue,
    activeBlock: room.currentBlock
      ? {
          blockId: room.currentBlock.blockId,
          mainSpeaker: { ...room.currentBlock.mainSpeaker },
          replies: room.currentBlock.replies.map((reply) => ({ ...reply })),
        }
      : null,
  };
}

function emitRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('room:state', serializeRoom(room));
}

function cleanupRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.participants.size === 0) {
    rooms.delete(roomId);
  }
}

io.on('connection', (socket) => {
  socket.on('room:join', ({ roomId, name, createRoom: wantsCreateRaw, role: requestedRoleRaw, creatorToken: creatorTokenRaw }) => {
    const safeRoomId = String(roomId || '').trim();
    const safeName = String(name || '').trim().slice(0, 40);
    const wantsCreate = Boolean(wantsCreateRaw);
    const requestedRole =
      requestedRoleRaw === 'creator'
        ? 'creator'
        : requestedRoleRaw === 'moderator'
          ? 'moderator'
          : 'user';
    const creatorToken = String(creatorTokenRaw || '').trim();

    if (!safeRoomId || !safeName) {
      socket.emit('room:error', { message: 'Room and name are required.' });
      return;
    }

    let room = getRoom(safeRoomId);
    if (wantsCreate) {
      if (room) {
        socket.emit('room:error', { message: 'That room already exists. Create another one.' });
        return;
      }
      room = createRoom(safeRoomId);
      room.ownerId = socket.id;
      room.creatorToken = crypto.randomBytes(16).toString('hex');
    } else if (!room) {
      socket.emit('room:error', { message: 'That room does not exist yet.' });
      return;
    }

    let participantRole = requestedRole;
    if (wantsCreate) {
      participantRole = 'creator';
    } else if (requestedRole === 'creator') {
      if (!room.creatorToken || creatorToken !== room.creatorToken) {
        socket.emit('room:error', { message: 'Creator access requires the private creator link.' });
        return;
      }
      participantRole = 'creator';
    }

    socket.join(safeRoomId);
    room.participants.set(socket.id, { name: safeName, role: participantRole });
    socketMeta.set(socket.id, { roomId: safeRoomId });

    socket.emit('room:joined', {
      roomId: safeRoomId,
      me: { id: socket.id, name: safeName, role: participantRole },
      creatorToken: participantRole === 'creator' ? room.creatorToken : null,
    });
    emitRoomState(safeRoomId);
  });

  socket.on('queue:join', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    if (!room || !room.participants.has(socket.id)) return;
    if (!canUseParticipationTools(room, socket.id)) return;
    if (interactionBlocked(room, socket.id)) return;

    const isCurrent = findCurrentEntry(room)?.id === socket.id;
    if (isCurrent || isQueued(room, socket.id)) return;

    if (!room.currentBlock) {
      room.currentBlock = {
        blockId: makeBlockId(room),
        mainSpeaker: makeSpeakerEntry(socket.id, room.participants.get(socket.id).name, 'main', 'current'),
        replies: [],
      };
    } else {
      room.mainQueue.push({
        id: socket.id,
        name: room.participants.get(socket.id).name,
      });
    }

    emitRoomState(meta.roomId);
  });

  socket.on('queue:respond', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    const currentEntry = findCurrentEntry(room);
    if (!room || !room.currentBlock || !currentEntry || !room.participants.has(socket.id)) return;
    if (!canUseParticipationTools(room, socket.id)) return;
    if (interactionBlocked(room, socket.id)) return;

    if (currentEntry.id === socket.id) return;
    if (isQueued(room, socket.id)) return;

    room.currentBlock.replies.push(
      makeSpeakerEntry(socket.id, room.participants.get(socket.id).name, 'reply', 'queued'),
    );

    emitRoomState(meta.roomId);
  });

  socket.on('turn:yield', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    const currentEntry = findCurrentEntry(room);
    if (!room || !currentEntry) return;
    if (!canUseParticipationTools(room, socket.id)) return;
    if (interactionBlocked(room, socket.id)) return;
    if (currentEntry.id !== socket.id) return;

    applyYield(room);
    emitRoomState(meta.roomId);
  });

  socket.on('turn:force-yield', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    if (!room || !isModerator(room, socket.id)) return;

    applyYield(room);
    emitRoomState(meta.roomId);
  });

  socket.on('room:pause', ({ paused }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    if (!room || !isModerator(room, socket.id)) return;

    room.paused = Boolean(paused);
    emitRoomState(meta.roomId);
  });

  socket.on('queue:reorder', ({ kind, orderedIds }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    if (!room || !isModerator(room, socket.id) || !Array.isArray(orderedIds)) return;

    if (kind === 'main') {
      const mainMap = new Map(room.mainQueue.map((entry) => [entry.id, entry]));
      if (mainMap.size !== orderedIds.length) return;
      if (orderedIds.some((id) => !mainMap.has(id))) return;
      room.mainQueue = orderedIds.map((id) => mainMap.get(id));
      emitRoomState(meta.roomId);
      return;
    }

    if (kind === 'replies' && room.currentBlock) {
      const fixedReplies = room.currentBlock.replies.filter((reply) => reply.status !== 'queued');
      const queuedReplies = room.currentBlock.replies.filter((reply) => reply.status === 'queued');
      const replyMap = new Map(queuedReplies.map((reply) => [reply.id, reply]));
      if (replyMap.size !== orderedIds.length) return;
      if (orderedIds.some((id) => !replyMap.has(id))) return;
      room.currentBlock.replies = [...fixedReplies, ...orderedIds.map((id) => replyMap.get(id))];
      emitRoomState(meta.roomId);
    }
  });

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    socketMeta.delete(socket.id);

    if (!room) return;

    room.participants.delete(socket.id);
    removeFromQueues(room, socket.id);

    if (room.ownerId === socket.id) {
      room.ownerId = null;
    }

    if (room.paused && !Array.from(room.participants.keys()).some((id) => isModerator(room, id))) {
      room.paused = false;
    }

    if (findCurrentEntry(room)?.id === socket.id) {
      applyYield(room);
    } else if (room.currentBlock) {
      advanceCurrentBlock(room);
    }

    emitRoomState(meta.roomId);
    cleanupRoomIfEmpty(meta.roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
