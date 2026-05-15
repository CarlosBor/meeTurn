const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const socketMeta = new Map();

function createRoomState() {
  return {
    participants: new Map(),
    mainQueue: [],
    responseQueues: new Map(),
    currentTurn: null,
    turnSeq: 0,
  };
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoomState());
  }
  return rooms.get(roomId);
}

function makeMainTurn(room, userId) {
  room.turnSeq += 1;
  return {
    turnId: `${room.turnSeq}`,
    type: 'main',
    userId,
    parentTurnId: null,
  };
}

function makeResponseTurn(room, userId, parentTurnId) {
  room.turnSeq += 1;
  return {
    turnId: `${room.turnSeq}`,
    type: 'response',
    userId,
    parentTurnId,
  };
}

function isQueued(room, userId) {
  if (room.mainQueue.includes(userId)) return true;
  for (const queue of room.responseQueues.values()) {
    if (queue.includes(userId)) return true;
  }
  return false;
}

function removeFromQueues(room, userId) {
  room.mainQueue = room.mainQueue.filter((id) => id !== userId);
  for (const [turnId, queue] of room.responseQueues.entries()) {
    const filtered = queue.filter((id) => id !== userId);
    if (filtered.length === 0) {
      room.responseQueues.delete(turnId);
    } else {
      room.responseQueues.set(turnId, filtered);
    }
  }
}

function advanceToNextMain(room) {
  while (room.mainQueue.length > 0) {
    const nextUser = room.mainQueue.shift();
    if (room.participants.has(nextUser)) {
      room.currentTurn = makeMainTurn(room, nextUser);
      return;
    }
  }
  room.currentTurn = null;
}

function applyYield(room) {
  if (!room.currentTurn) {
    return;
  }

  if (room.currentTurn.type === 'main') {
    const responseQueue = room.responseQueues.get(room.currentTurn.turnId) || [];
    while (responseQueue.length > 0) {
      const nextResponder = responseQueue.shift();
      if (room.participants.has(nextResponder)) {
        room.currentTurn = makeResponseTurn(room, nextResponder, room.currentTurn.turnId);
        if (responseQueue.length === 0) {
          room.responseQueues.delete(room.currentTurn.parentTurnId);
        } else {
          room.responseQueues.set(room.currentTurn.parentTurnId, responseQueue);
        }
        return;
      }
    }
    room.responseQueues.delete(room.currentTurn.turnId);
    advanceToNextMain(room);
    return;
  }

  const parentTurnId = room.currentTurn.parentTurnId;
  const responseQueue = room.responseQueues.get(parentTurnId) || [];
  while (responseQueue.length > 0) {
    const nextResponder = responseQueue.shift();
    if (room.participants.has(nextResponder)) {
      room.currentTurn = makeResponseTurn(room, nextResponder, parentTurnId);
      if (responseQueue.length === 0) {
        room.responseQueues.delete(parentTurnId);
      } else {
        room.responseQueues.set(parentTurnId, responseQueue);
      }
      return;
    }
  }
  room.responseQueues.delete(parentTurnId);
  advanceToNextMain(room);
}

function serializeRoom(room) {
  const participants = [];
  for (const [id, data] of room.participants.entries()) {
    participants.push({ id, name: data.name });
  }

  const currentSpeaker = room.currentTurn
    ? {
        ...room.currentTurn,
        name: room.participants.get(room.currentTurn.userId)?.name || 'Unknown',
      }
    : null;

  const mainQueue = room.mainQueue
    .filter((id) => room.participants.has(id))
    .map((id) => ({ id, name: room.participants.get(id).name }));

  let responseAnchor = null;
  let responseQueue = [];

  if (room.currentTurn) {
    const anchorTurnId = room.currentTurn.type === 'main' ? room.currentTurn.turnId : room.currentTurn.parentTurnId;
    responseAnchor = anchorTurnId;
    responseQueue = (room.responseQueues.get(anchorTurnId) || [])
      .filter((id) => room.participants.has(id))
      .map((id) => ({ id, name: room.participants.get(id).name }));
  }

  return {
    participants,
    currentSpeaker,
    mainQueue,
    responseQueue,
    responseAnchor,
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
  socket.on('room:join', ({ roomId, name }) => {
    const safeRoomId = String(roomId || '').trim();
    const safeName = String(name || '').trim().slice(0, 40);

    if (!safeRoomId || !safeName) {
      socket.emit('room:error', { message: 'Room and name are required.' });
      return;
    }

    const room = ensureRoom(safeRoomId);
    socket.join(safeRoomId);

    room.participants.set(socket.id, { name: safeName });
    socketMeta.set(socket.id, { roomId: safeRoomId });

    socket.emit('room:joined', { roomId: safeRoomId, me: { id: socket.id, name: safeName } });
    emitRoomState(safeRoomId);
  });

  socket.on('queue:join', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    if (!room || !room.participants.has(socket.id)) return;

    const isCurrent = room.currentTurn?.userId === socket.id;
    if (isCurrent || isQueued(room, socket.id)) return;

    if (!room.currentTurn) {
      room.currentTurn = makeMainTurn(room, socket.id);
    } else {
      room.mainQueue.push(socket.id);
    }

    emitRoomState(meta.roomId);
  });

  socket.on('queue:respond', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    if (!room || !room.currentTurn || !room.participants.has(socket.id)) return;

    if (room.currentTurn.userId === socket.id) return;
    if (isQueued(room, socket.id)) return;

    const anchorTurnId = room.currentTurn.type === 'main' ? room.currentTurn.turnId : room.currentTurn.parentTurnId;
    const existing = room.responseQueues.get(anchorTurnId) || [];
    existing.push(socket.id);
    room.responseQueues.set(anchorTurnId, existing);

    emitRoomState(meta.roomId);
  });

  socket.on('turn:yield', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    if (!room || !room.currentTurn) return;
    if (room.currentTurn.userId !== socket.id) return;

    applyYield(room);
    emitRoomState(meta.roomId);
  });

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const room = rooms.get(meta.roomId);
    socketMeta.delete(socket.id);

    if (!room) return;

    room.participants.delete(socket.id);
    removeFromQueues(room, socket.id);

    if (room.currentTurn?.userId === socket.id) {
      applyYield(room);
    }

    emitRoomState(meta.roomId);
    cleanupRoomIfEmpty(meta.roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
