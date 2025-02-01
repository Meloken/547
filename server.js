/**************************************
 * server.js
 **************************************/
require('dotenv').config();
const http = require("http");
const express = require("express");
const socketIO = require("socket.io");
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid'); // UUID

const User = require('./models/User');
const Group = require('./models/Group');
const Channel = require('./models/Channel');
const Message = require('./models/Message'); // <-- YENİ: Mesaj modelini ekledik

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// MongoDB bağlantısı ve hata yönetimi (geliştirilmiş versiyon)
const connectWithRetry = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      retryWrites: true,
      w: 'majority'
    });
    console.log('MongoDB bağlantısı başarılı');
  } catch (err) {
    console.error('MongoDB bağlantı hatası:', err);
    console.log('5 saniye sonra yeniden denenecek...');
    setTimeout(connectWithRetry, 5000);
  }
};

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB bağlantısı kesildi. Yeniden bağlanılıyor...');
  connectWithRetry();
});

connectWithRetry();

// Bellek içi tablolar (Anlık takip için)
const users = {};   // socket.id -> { username, currentGroup, currentRoom, micEnabled, selfDeafened }
const groups = {};  // groupId -> { owner: <username>, name, users:[], rooms:{} }

// Çevrimiçi (online) olan kullanıcı adlarını tutuyoruz
const onlineUsernames = new Set();

app.use(express.static("public"));

/* 1) DB'den Grupları belleğe yükleme */
async function loadGroupsFromDB() {
  try {
    const allGroups = await Group.find({});
    allGroups.forEach(gDoc => {
      if (!groups[gDoc.groupId]) {
        groups[gDoc.groupId] = {
          owner: null, 
          name: gDoc.name,
          users: [],
          rooms: {}
        };
      }
    });
    console.log("loadGroupsFromDB tamam, groups:", Object.keys(groups));
  } catch (err) {
    console.error("loadGroupsFromDB hatası:", err);
  }
}

/* 2) DB'den Kanal bilgilerini belleğe yükleme */
async function loadChannelsFromDB() {
  try {
    const allChannels = await Channel.find({}).populate('group');
    allChannels.forEach(ch => {
      if (!ch.group) return;
      const gId = ch.group.groupId;
      if (!groups[gId]) return;
      if (!groups[gId].rooms[ch.channelId]) {
        groups[gId].rooms[ch.channelId] = {
          name: ch.name,
          users: [],
          // YENİ: Kanalın tipini bellekte de saklayalım
          type: ch.type || 'voice'
        };
      }
    });
    console.log("loadChannelsFromDB tamam.");
  } catch (err) {
    console.error("loadChannelsFromDB hatası:", err);
  }
}

// Uygulama başlarken DB'den verileri yükle
loadGroupsFromDB().then(() => loadChannelsFromDB());

/* groupId'deki Tüm Oda + Kullanıcı datasını döndürür => UI'ya "allChannelsData" için */
function getAllChannelsData(groupId) {
  if (!groups[groupId]) return {};
  const channelsObj = {};
  Object.keys(groups[groupId].rooms).forEach(roomId => {
    const rm = groups[groupId].rooms[roomId];
    // rm.users => { id, username }
    // Her user => micEnabled / selfDeafened de eklenecek
    const userListWithAudio = rm.users.map(u => ({
      id: u.id,
      username: u.username,
      micEnabled: (users[u.id] && users[u.id].micEnabled !== undefined)
        ? users[u.id].micEnabled 
        : true,
      selfDeafened: (users[u.id] && users[u.id].selfDeafened !== undefined)
        ? users[u.id].selfDeafened 
        : false
    }));
    channelsObj[roomId] = {
      name: rm.name,
      users: userListWithAudio
    };
  });
  return channelsObj;
}

/* Tüm kanallardaki kullanıcı listesini tekrar yayınlar (roomUsers) */
function broadcastAllRoomsUsers(groupId) {
  if (!groups[groupId]) return;
  Object.keys(groups[groupId].rooms).forEach(roomId => {
    io.to(`${groupId}::${roomId}`).emit('roomUsers', groups[groupId].rooms[roomId].users);
  });
}

/* Bir kullanıcı hangi gruplarda/odalarda varsa hepsinden çıkarır (socket.leave vb.) */
function removeUserFromAllGroupsAndRooms(socket) {
  const socketId = socket.id;
  const userData = users[socketId];
  if (!userData) return;

  Object.keys(groups).forEach(gId => {
    const grpObj = groups[gId];
    if (grpObj.users.some(u => u.id === socketId)) {
      grpObj.users = grpObj.users.filter(u => u.id !== socketId);

      Object.keys(grpObj.rooms).forEach(rId => {
        grpObj.rooms[rId].users = grpObj.rooms[rId].users.filter(u => u.id !== socketId);
        io.to(`${gId}::${rId}`).emit('roomUsers', grpObj.rooms[rId].users);
      });
      io.to(gId).emit('allChannelsData', getAllChannelsData(gId));
    }
    Object.keys(grpObj.rooms).forEach(rId => {
      socket.leave(`${gId}::${rId}`);
    });
    socket.leave(gId);
  });

  users[socketId].currentGroup = null;
  users[socketId].currentRoom = null;
}

/* DB'den gruba ait kullanıcıları alıp => online/offline listesi */
async function getOnlineOfflineDataForGroup(groupId) {
  const groupDoc = await Group.findOne({ groupId }).populate('users');
  if (!groupDoc) return { online: [], offline: [] };

  const online = [];
  const offline = [];

  groupDoc.users.forEach(u => {
    if (onlineUsernames.has(u.username)) {
      online.push({ username: u.username });
    } else {
      offline.push({ username: u.username });
    }
  });
  return { online, offline };
}

async function broadcastGroupUsers(groupId) {
  if (!groupId) return;
  try {
    const { online, offline } = await getOnlineOfflineDataForGroup(groupId);
    io.to(groupId).emit('groupUsers', { online, offline });
  } catch (err) {
    console.error("broadcastGroupUsers hata:", err);
  }
}

async function sendGroupUsersToOneUser(socketId, groupId) {
  try {
    const { online, offline } = await getOnlineOfflineDataForGroup(groupId);
    io.to(socketId).emit('groupUsers', { online, offline });
  } catch (err) {
    console.error("sendGroupUsersToOneUser hata:", err);
  }
}

/* Tüm group'a => allChannelsData */
function broadcastAllChannelsData(groupId) {
  if (!groups[groupId]) return;
  const channelsObj = getAllChannelsData(groupId);
  io.to(groupId).emit('allChannelsData', channelsObj);
}

/* Tek user'a => allChannelsData */
function sendAllChannelsDataToOneUser(socketId, groupId) {
  if (!groups[groupId]) return;
  const channelsObj = getAllChannelsData(groupId);
  io.to(socketId).emit('allChannelsData', channelsObj);
}

/* Tek user'a => roomsList
   YENİ: channel tipini de ekledik => {id, name, type} */
function sendRoomsListToUser(socketId, groupId) {
  if (!groups[groupId]) return;
  const groupObj = groups[groupId];
  const roomArray = Object.keys(groupObj.rooms).map(rId => ({
    id: rId,
    name: groupObj.rooms[rId].name,
    type: groupObj.rooms[rId].type || 'voice'
  }));
  io.to(socketId).emit('roomsList', roomArray);
}

/* Tüm kullanıcıya => roomsList */
function broadcastRoomsListToGroup(groupId) {
  if (!groups[groupId]) return;
  groups[groupId].users.forEach(u => {
    sendRoomsListToUser(u.id, groupId);
  });
}

/* Tek user'a => groupsList => (owner, id, name) */
async function sendGroupsListToUser(socketId) {
  const userData = users[socketId];
  if (!userData) return;
  const userDoc = await User.findOne({ username: userData.username }).populate('groups');
  if (!userDoc) return;

  const userGroups = [];
  for (const g of userDoc.groups) {
    let ownerUsername = null;
    const ownerUser = await User.findById(g.owner);
    if (ownerUser) {
      ownerUsername = ownerUser.username;
    }
    userGroups.push({
      id: g.groupId,
      name: g.name,
      owner: ownerUsername
    });
  }
  io.to(socketId).emit('groupsList', userGroups);
}

/* ========== YENİ FONKSİYON: Kanal Mesaj Geçmişi Gönderme ========== */
async function sendChannelHistory(socket, channelId) {
  try {
    // DB'den channel bul
    const chDoc = await Channel.findOne({ channelId });
    if (!chDoc) return;

    // Mesajları çek, user populate
    const messages = await Message.find({ channel: chDoc._id })
      .populate('user')
      .sort({ timestamp: 1 })
      .limit(50); // İsterseniz arttırabilirsiniz

    // Sadece bu kullanıcıya gönder
    socket.emit('channelHistory', {
      channelId,
      messages: messages.map(m => ({
        content: m.content,
        username: m.user.username,
        timestamp: m.timestamp
      }))
    });
  } catch (err) {
    console.error("sendChannelHistory hata:", err);
  }
}

// Mesaj hız sınırlama için basit bir çözüm
const messageRateLimits = new Map();

// Socket.IO
io.on("connection", (socket) => {
  console.log("Kullanıcı bağlandı:", socket.id);

  // Kullanıcı datası => default micEnabled = true, selfDeafened = false
  users[socket.id] = {
    username: null,
    currentGroup: null,
    currentRoom: null,
    micEnabled: true,
    selfDeafened: false
  };

  // LOGIN
  socket.on('login', async ({ username, password }) => {
    try {
      if (!username || !password) {
        socket.emit('loginResult', { success: false, message: 'Geçersiz kimlik bilgileri' });
        return;
      }
      const user = await User.findOne({ username }).select('+passwordHash');
      if (!user) {
        // Güvenlik için genel hata mesajı
        socket.emit('loginResult', { success: false, message: 'Geçersiz kimlik bilgileri' });
        return;
      }
      const pwMatch = await bcrypt.compare(password, user.passwordHash);
      if (!pwMatch) {
        socket.emit('loginResult', { success: false, message: 'Yanlış parola.' });
        return;
      }
      socket.emit('loginResult', { success: true, username: user.username });
    } catch (err) {
      console.error(err);
      socket.emit('loginResult', { success: false, message: 'Giriş hatası.' });
    }
  });

  // REGISTER
  socket.on('register', async (userData) => {
    const { username, name, surname, birthdate, email, phone, password, passwordConfirm } = userData;
    if (!username || !name || !surname || !birthdate || !email || !phone ||
        !password || !passwordConfirm) {
      socket.emit('registerResult', { success: false, message: 'Tüm alanları doldurunuz.' });
      return;
    }
    if (username !== username.toLowerCase()) {
      socket.emit('registerResult', { success: false, message: 'Kullanıcı adı küçük harf olmalı.' });
      return;
    }
    if (password !== passwordConfirm) {
      socket.emit('registerResult', { success: false, message: 'Parolalar eşleşmiyor.' });
      return;
    }
    try {
      const existingUser = await User.findOne({ $or: [ { username }, { email } ] });
      if (existingUser) {
        socket.emit('registerResult', { success: false, message: 'Kullanıcı adı veya e-posta zaten alınmış.' });
        return;
      }
      const passwordHash = await bcrypt.hash(password, 10);
      const newUser = new User({
        username,
        passwordHash,
        name,
        surname,
        birthdate: new Date(birthdate),
        email,
        phone,
        groups: []
      });
      await newUser.save();
      socket.emit('registerResult', { success: true });
    } catch (err) {
      console.error(err);
      socket.emit('registerResult', { success: false, message: 'Kayıt hatası.' });
    }
  });

  // set-username
  socket.on('set-username', async (usernameVal) => {
    try {
      const trimmedName = usernameVal.trim();
      if (!trimmedName) {
        socket.emit('errorMessage', 'Geçersiz kullanıcı adı');
        return;
      }

      // Kullanıcı adı benzersizlik kontrolü
      const existingUser = await User.findOne({ username: trimmedName });
      if (existingUser) {
        socket.emit('errorMessage', 'Bu kullanıcı adı zaten alınmış');
        return;
      }

      users[socket.id].username = trimmedName;
      onlineUsernames.add(trimmedName);

      try {
        await sendGroupsListToUser(socket.id);
      } catch (err) {
        console.error("sendGroupsListToUser hata:", err);
      }

      // DB => hangi gruplara üye => broadcastGroupUsers
      try {
        const userDoc = await User.findOne({ username: trimmedName }).populate('groups');
        if (userDoc && userDoc.groups.length > 0) {
          for (const gDoc of userDoc.groups) {
            broadcastGroupUsers(gDoc.groupId);
          }
        }
      } catch (err) {
        console.error("userDoc groups fetch hata:", err);
      }
    } catch (err) {
      console.error('Kullanıcı adı kontrol hatası:', err);
      socket.emit('errorMessage', 'Sunucu hatası');
    }
  });

  // audioStateChanged => client => sunucu => kaydet => broadcast
  socket.on('audioStateChanged', ({ micEnabled, selfDeafened }) => {
    if (!users[socket.id]) return;
    users[socket.id].micEnabled = micEnabled;
    users[socket.id].selfDeafened = selfDeafened;
    const gId = users[socket.id].currentGroup;
    if (gId) {
      broadcastAllChannelsData(gId);
    }
  });

  // createGroup
  socket.on('createGroup', async (groupName) => {
    if (!groupName) return;
    const trimmed = groupName.trim();
    if (!trimmed) return;

    const userName = users[socket.id].username || null;
    if (!userName) {
      socket.emit('errorMessage', "Kullanıcı adınız tanımlı değil.");
      return;
    }
    const userDoc = await User.findOne({ username: userName });
    if (!userDoc) return;

    const groupId = uuidv4();
    const newGroup = new Group({
      groupId,
      name: trimmed,
      owner: userDoc._id,
      users: [ userDoc._id ]
    });
    await newGroup.save();

    userDoc.groups.push(newGroup._id);
    await userDoc.save();

    groups[groupId] = {
      owner: userName, 
      name: trimmed,
      users: [ { id: socket.id, username: userName } ],
      rooms: {}
    };
    console.log(`Yeni grup: ${trimmed} (ID=${groupId}), owner=${userName}`);

    await sendGroupsListToUser(socket.id);
    broadcastGroupUsers(groupId);
  });

  // joinGroupByID
  socket.on('joinGroupByID', async (groupId) => {
    try {
      if (users[socket.id].currentGroup === groupId) {
        return;
      }
      const userName = users[socket.id].username || null;
      if (!userName) {
        socket.emit('errorMessage', "Kullanıcı adınız tanımlı değil.");
        return;
      }
      const userDoc = await User.findOne({ username: userName });
      if (!userDoc) {
        socket.emit('errorMessage', "Kullanıcı yok (DB).");
        return;
      }
      const groupDoc = await Group.findOne({ groupId });
      if (!groupDoc) {
        socket.emit('errorMessage', "Böyle bir grup yok (DB).");
        return;
      }

      if (!groupDoc.users.includes(userDoc._id)) {
        groupDoc.users.push(userDoc._id);
        await groupDoc.save();
      }
      if (!userDoc.groups.includes(groupDoc._id)) {
        userDoc.groups.push(groupDoc._id);
        await userDoc.save();
      }

      if (!groups[groupId]) {
        const ownerUser = await User.findById(groupDoc.owner);
        let ownerUsername = ownerUser ? ownerUser.username : null;
        groups[groupId] = {
          owner: ownerUsername,
          name: groupDoc.name,
          users: [],
          rooms: {}
        };
      }

      removeUserFromAllGroupsAndRooms(socket);

      const userData = users[socket.id];
      if (!userData.username) {
        socket.emit('errorMessage', "Kullanıcı adınız yok, kanala eklenemiyorsunuz.");
        return;
      }
      if (!groups[groupId].users.some(u => u.id === socket.id)) {
        groups[groupId].users.push({ id: socket.id, username: userData.username });
      }
      userData.currentGroup = groupId;
      userData.currentRoom = null;
      socket.join(groupId);

      console.log(`User ${socket.id} => joinGroupByID => ${groupId}`);

      await sendGroupsListToUser(socket.id);

      sendRoomsListToUser(socket.id, groupId);
      broadcastAllChannelsData(groupId);
      await broadcastGroupUsers(groupId);

    } catch (err) {
      console.error("joinGroupByID hata:", err);
    }
  });

  // browseGroup
  socket.on('browseGroup', async (groupId) => {
    if (!groups[groupId]) return;
    sendRoomsListToUser(socket.id, groupId);
    sendAllChannelsDataToOneUser(socket.id, groupId);
    await sendGroupUsersToOneUser(socket.id, groupId);
  });

  // joinGroup
  socket.on('joinGroup', async (groupId) => {
    if (!groups[groupId]) return;
    if (users[socket.id].currentGroup === groupId) {
      return;
    }

    removeUserFromAllGroupsAndRooms(socket);

    const userData = users[socket.id];
    const userName = userData.username;
    if (!userName) {
      socket.emit('errorMessage', "Kullanıcı adınız yok.");
      return;
    }
    if (!groups[groupId].users.some(u => u.id === socket.id)) {
      groups[groupId].users.push({ id: socket.id, username: userName });
    }
    userData.currentGroup = groupId;
    userData.currentRoom = null;
    socket.join(groupId);

    sendRoomsListToUser(socket.id, groupId);
    broadcastAllChannelsData(groupId);
    await broadcastGroupUsers(groupId);
  });

  // createRoom
  socket.on('createRoom', async ({ groupId, roomName, channelType }) => {
    try {
      const allowedTypes = ['voice', 'text'];
      if (!allowedTypes.includes(channelType)) {
        socket.emit('errorMessage', 'Geçersiz kanal tipi');
        return;
      }
      if (!groups[groupId]) return;
      if (!roomName) return;
      const trimmed = roomName.trim();
      if (!trimmed) return;

      const groupDoc = await Group.findOne({ groupId });
      if (!groupDoc) return;

      const roomId = uuidv4();
      const newChannel = new Channel({
        channelId: roomId,
        name: trimmed,
        group: groupDoc._id,
        type: channelType || 'voice',
        users: []
      });
      await newChannel.save();

      // Kanal tipine göre varsayılan ayarlar
      const roomConfig = {
        name: trimmed,
        users: [],
        type: channelType || 'voice',
        // Ses kanalları için özel ayarlar
        voiceSettings: channelType === 'voice' ? {
          maxUsers: 50,
          requireMic: true
        } : null,
        // Metin kanalları için özel ayarlar
        textSettings: channelType === 'text' ? {
          historySize: 100,
          slowMode: false
        } : null
      };

      groups[groupId].rooms[roomId] = roomConfig;
      console.log(`Yeni oda: type=${channelType}, config=`, roomConfig);

      broadcastRoomsListToGroup(groupId);
      broadcastAllChannelsData(groupId);
    } catch (err) {
      console.error("createRoom hata:", err);
      socket.emit('errorMessage', "İşlem sırasında bir hata oluştu");
    }
  });

  // joinRoom
  socket.on('joinRoom', ({ groupId, roomId }) => {
    if (!groups[groupId]) return;
    if (!groups[groupId].rooms[roomId]) return;

    const userData = users[socket.id];
    if (!userData.username) {
      socket.emit('errorMessage', "Kullanıcı adınız tanımsız => Kanala eklenemiyor.");
      return;
    }
    if (userData.currentGroup === groupId && userData.currentRoom === roomId) {
      return; 
    }
    if (userData.currentGroup === groupId && userData.currentRoom && groups[groupId].rooms[userData.currentRoom]) {
      groups[groupId].rooms[userData.currentRoom].users =
        groups[groupId].rooms[userData.currentRoom].users.filter(u => u.id !== socket.id);
      io.to(`${groupId}::${userData.currentRoom}`).emit('roomUsers', groups[groupId].rooms[userData.currentRoom].users);
      socket.leave(`${groupId}::${userData.currentRoom}`);
    } else {
      removeUserFromAllGroupsAndRooms(socket);
    }

    const userName = userData.username;
    if (!groups[groupId].users.some(u => u.id === socket.id)) {
      groups[groupId].users.push({ id: socket.id, username: userName });
    }
    groups[groupId].rooms[roomId].users.push({ id: socket.id, username: userName });
    userData.currentGroup = groupId;
    userData.currentRoom = roomId;

    socket.join(groupId);
    socket.join(`${groupId}::${roomId}`);

    io.to(`${groupId}::${roomId}`).emit('roomUsers', groups[groupId].rooms[roomId].users);

    broadcastAllChannelsData(groupId);

    // "joinRoomAck" => girdiğini onaylayalım (yeni user'daysak)
    socket.emit('joinRoomAck', { groupId, roomId });

    // YENİ: Kanal geçmişini sadece bu kullanıcıya gönder
    sendChannelHistory(socket, roomId);
  });

  // leaveRoom
  socket.on('leaveRoom', ({ groupId, roomId }) => {
    if (!groups[groupId]) return;
    if (!groups[groupId].rooms[roomId]) return;

    groups[groupId].rooms[roomId].users =
      groups[groupId].rooms[roomId].users.filter(u => u.id !== socket.id);
    io.to(`${groupId}::${roomId}`).emit('roomUsers', groups[groupId].rooms[roomId].users);
    socket.leave(`${groupId}::${roomId}`);

    users[socket.id].currentRoom = null;
    broadcastAllChannelsData(groupId);
  });

  // renameGroup
  socket.on('renameGroup', async (data) => {
    const { groupId, newName } = data;
    const userName = users[socket.id].username;
    if (!groups[groupId]) return;

    if (groups[groupId].owner !== userName) {
      socket.emit('errorMessage', "Bu grubu değiştirme yetkiniz yok.");
      return;
    }

    try {
      const groupDoc = await Group.findOne({ groupId });
      if (!groupDoc) {
        socket.emit('errorMessage', "Grup DB'de yok.");
        return;
      }
      groupDoc.name = newName;
      await groupDoc.save();

      groups[groupId].name = newName;
      io.to(groupId).emit('groupRenamed', { groupId, newName });
      console.log(`Grup rename => ${groupId}, yeni isim=${newName}`);
    } catch (err) {
      console.error("renameGroup hata:", err);
      socket.emit('errorMessage', "İşlem sırasında bir hata oluştu");
    }
  });

  // deleteGroup
  socket.on('deleteGroup', async (grpId) => {
    const userName = users[socket.id].username;
    if (!groups[grpId]) {
      socket.emit('errorMessage', "Grup bellekte yok.");
      return;
    }
    if (groups[grpId].owner !== userName) {
      socket.emit('errorMessage', "Bu grubu silmeye yetkiniz yok.");
      return;
    }

    try {
      const groupDoc = await Group.findOne({ groupId: grpId }).populate('users');
      if (!groupDoc) {
        socket.emit('errorMessage', "Grup DB'de bulunamadı.");
        return;
      }
      if (groupDoc.users && groupDoc.users.length > 0) {
        for (const userId of groupDoc.users) {
          const usr = await User.findById(userId);
          if (usr && usr.groups.includes(groupDoc._id)) {
            usr.groups = usr.groups.filter(gRef => gRef.toString() !== groupDoc._id.toString());
            await usr.save();
          }
        }
      }
      await Group.deleteOne({ _id: groupDoc._id });
      await Channel.deleteMany({ group: groupDoc._id });
      // Kanallara ait mesajlar da silinsin mi? (İsterseniz)
      // await Message.deleteMany({ channel: ??? })

      delete groups[grpId];
      console.log(`Grup silindi => ${grpId}`);

      io.emit('groupDeleted', { groupId: grpId });
    } catch (err) {
      console.error("deleteGroup hata:", err);
      socket.emit('errorMessage', "İşlem sırasında bir hata oluştu");
    }
  });

  // renameChannel
  socket.on('renameChannel', async (payload) => {
    try {
      const { channelId, newName } = payload;
      if (!channelId || !newName) return;

      const chDoc = await Channel.findOne({ channelId });
      if (!chDoc) {
        socket.emit('errorMessage', "Kanal DB'de bulunamadı.");
        return;
      }
      chDoc.name = newName;
      await chDoc.save();

      const groupDoc = await Group.findById(chDoc.group);
      if (!groupDoc) return;
      const gId = groupDoc.groupId;
      if (!groups[gId] || !groups[gId].rooms[channelId]) return;

      groups[gId].rooms[channelId].name = newName;

      broadcastRoomsListToGroup(gId);
      broadcastAllRoomsUsers(gId);
      broadcastAllChannelsData(gId);
      console.log(`Kanal rename => ${channelId} => ${newName}`);
    } catch (err) {
      console.error("renameChannel hata:", err);
      socket.emit('errorMessage', "İşlem sırasında bir hata oluştu");
    }
  });

  // deleteChannel
  socket.on('deleteChannel', async (channelId) => {
    try {
      if (!channelId) return;
      const chDoc = await Channel.findOne({ channelId });
      if (!chDoc) {
        socket.emit('errorMessage', "Kanal DB'de bulunamadı.");
        return;
      }
      // Kanalı sil
      await Channel.deleteOne({ _id: chDoc._id });
      // YENİ: O kanala ait mesajlar da silinsin
      await Message.deleteMany({ channel: chDoc._id });

      const groupDoc = await Group.findById(chDoc.group);
      if (!groupDoc) return;
      const gId = groupDoc.groupId;

      if (groups[gId] && groups[gId].rooms[channelId]) {
        delete groups[gId].rooms[channelId];
      }
      broadcastRoomsListToGroup(gId);
      broadcastAllRoomsUsers(gId);
      broadcastAllChannelsData(gId);

      console.log(`Kanal silindi => ${channelId} (mesajlar da temizlendi)`);
    } catch (err) {
      console.error("deleteChannel hata:", err);
      socket.emit('errorMessage', "İşlem sırasında bir hata oluştu");
    }
  });

  // ========== YENİ: Text Message Event ==========
  socket.on('textMessage', async ({ channelId, content }) => {
    try {
      const channel = await Channel.findOne({ channelId }).populate('group');
      if (!channel || channel.type !== 'text') {
        socket.emit('errorMessage', 'Sadece metin kanallarında mesaj gönderebilirsiniz!');
        return;
      }
      
      // Kullanıcı adını socket üzerinden al
      const username = socket.username || 'Anonim';
      
      const newMessage = new Message({
        channel: channel._id,
        user: username,
        content
      });
      
      await newMessage.save();

      io.to(channelId).emit('textMessage', {
        channelId,
        content,
        username, // Kaydedilen kullanıcı adını gönder
        timestamp: newMessage.timestamp
      });

    } catch (err) {
      console.error('Mesaj işleme hatası:', err);
      socket.emit('errorMessage', 'Mesaj gönderilemedi: ' + err.message);
    }
  });

  // Kanal geçmişi gönderirken tarih filtresi ekleme
  socket.on('getChannelHistory', async (channelId) => {
    try {
      const channel = await Channel.findOne({ channelId });
      if (!channel) {
        return socket.emit('errorMessage', 'Kanal bulunamadı');
      }
      
      const messages = await Message.find({ channel: channel._id })
        .sort({ timestamp: -1 })
        .limit(100)
        .lean(); // Daha hızlı işlem için

      socket.emit('channelHistory', {
        channelId,
        messages: messages.map(m => ({
          ...m,
          timestamp: new Date(m.timestamp).getTime() // Tarih formatını düzelt
        }))
      });

    } catch (err) {
      console.error('Geçmiş yükleme hatası:', err);
      socket.emit('errorMessage', 'Geçmiş yüklenemedi');
    }
  });

  // WebRTC (signal) => RACE CONDITION DÜZELTMESİ
  socket.on("signal", (data) => {
    const targetId = data.to;
    if (socket.id === targetId) return;
    if (!users[targetId]) return;

    const sG = users[socket.id].currentGroup;
    const tG = users[targetId].currentGroup;
    const sR = users[socket.id].currentRoom;
    const tR = users[targetId].currentRoom;

    if (sG && sG === tG && sR && sR === tR) {
      io.to(targetId).emit("signal", {
        from: socket.id,
        signal: data.signal
      });
    } else if (sG && tG && sG === tG) {
      setTimeout(() => {
        const sG2 = users[socket.id]?.currentGroup;
        const tG2 = users[targetId]?.currentGroup;
        const sR2 = users[socket.id]?.currentRoom;
        const tR2 = users[targetId]?.currentRoom;

        if (sG2 && tG2 && sG2 === tG2 && sR2 && sR2 === tR2) {
          io.to(targetId).emit("signal", {
            from: socket.id,
            signal: data.signal
          });
        }
      }, 200);
    }
  });

  // Disconnect
  socket.on("disconnect", async () => {
    console.log("disconnect:", socket.id);
    const userData = users[socket.id];
    if (userData) {
      const { username } = userData;
      if (username) {
        onlineUsernames.delete(username);
        removeUserFromAllGroupsAndRooms(socket);

        try {
          const userDoc = await User.findOne({ username }).populate('groups');
          if (userDoc && userDoc.groups.length > 0) {
            for (const gDoc of userDoc.groups) {
              broadcastAllChannelsData(gDoc.groupId);
              await broadcastGroupUsers(gDoc.groupId);
            }
          }
        } catch (err) {
          console.error("disconnect => userDoc fetch hata:", err);
        }
      }
    }
    delete users[socket.id];
  });
});

// Sunucuyu başlat
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});

// Her 5 dakikada bir bellek verisini DB'ye senkronize et
setInterval(async () => {
  try {
    await Promise.all([
      syncGroupsToDB(),
      syncChannelsToDB()
    ]);
    console.log('Veritabanı senkronizasyonu tamamlandı');
  } catch (err) {
    console.error('Senkronizasyon hatası:', err);
  }
}, 300000); // 5 dakika

async function syncGroupsToDB() {
  // Grup verilerini DB'ye yazma mantığı
}

async function syncChannelsToDB() {
  // Kanal verilerini DB'ye yazma mantığı
}
