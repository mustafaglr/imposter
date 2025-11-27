// imposter_game_server.js

// --- SUNUCU TARAFI (NODE.JS) KISMI ---
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const games = {};
let wordsData = null;

try {
    // words.json dosyasını yükle
    const wordsPath = path.join(__dirname, 'words.json');
    wordsData = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
    console.log('Kelimeler yüklendi:', wordsData.categories.length, 'kategori');
} catch (error) {
    console.error('HATA: words.json dosyası yüklenemedi. Lütfen dosyanın mevcut ve geçerli JSON formatında olduğundan emin olun.', error);
}


// HTML Sayfasını Sunma
app.get('/', (req, res) => {
    // Aşağıdaki HTML içeriğini gönderiyoruz
    res.send(HTML_CONTENT);
});

// Yardımcı fonksiyonlar
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Socket Bağlantı Olayları
io.on('connection', (socket) => {
    console.log(`Yeni oyuncu bağlandı: ${socket.id}`);

    // --- 1. Yeni Oyun Oluşturma ---
    socket.on('createGame', ({ hostName, playerCount }) => {
        if (!wordsData) {
            return socket.emit('gameError', 'Sunucu: Kelime listesi yüklenemedi.');
        }
        
        const roomCode = generateRoomCode();
        
        const newGame = {
            roomCode: roomCode,
            totalPlayers: playerCount,
            players: [{ name: hostName, role: null, word: null, isHost: true, socketId: socket.id }],
            started: false,
            finished: false,
            actualWord: null,
            imposterHint: null,
            category: null,
            startingPlayer: null,
            hostSocketId: socket.id
        };

        games[roomCode] = newGame;
        socket.join(roomCode);
        
        socket.emit('gameCreated', { roomCode, gameData: newGame });
    });

    // --- 2. Oyuna Katılma ---
    socket.on('joinGame', ({ roomCode, playerName }) => {
        const game = games[roomCode];

        if (!game) {
            return socket.emit('joinError', 'Oda bulunamadı! Kod doğru mu kontrol edin.');
        }
        if (game.players.length >= game.totalPlayers) {
            return socket.emit('joinError', 'Oda dolu!');
        }
        if (game.started) {
            return socket.emit('joinError', 'Oyun zaten başlamış!');
        }
        if (game.players.some(p => p.name === playerName)) {
            return socket.emit('joinError', 'Bu isimde bir oyuncu zaten var!');
        }

        const newPlayer = { name: playerName, role: null, word: null, isHost: false, socketId: socket.id };
        game.players.push(newPlayer);
        socket.join(roomCode);
        
        socket.emit('joinedGame', { roomCode, gameData: game });
        
        // Odadaki herkese oyuncu listesi güncel bilgisini gönder
        io.to(roomCode).emit('playerListUpdated', game.players);
    });

    // --- 3. Oyunu Başlatma ---
    socket.on('startGame', (roomCode) => {
        const game = games[roomCode];
        if (!game || socket.id !== game.hostSocketId || game.started || !wordsData) return;

        if (game.players.length !== game.totalPlayers) {
            return socket.emit('gameError', 'Oyunu başlatmak için yeterli oyuncu yok!');
        }
        
        // Kelime ve Rol Atama Mantığı
        const randomCategory = wordsData.categories[Math.floor(Math.random() * wordsData.categories.length)];
        const randomItem = randomCategory.items[Math.floor(Math.random() * randomCategory.items.length)];

        game.actualWord = randomItem.word;
        game.imposterHint = randomItem.imposterHint;
        game.category = randomCategory.name;

        const imposterIndex = Math.floor(Math.random() * game.players.length);
        
        const imposterChance = 0.3 / game.players.length;
        const citizenChance = (1 - 0.3) / (game.players.length - 1);
        let cumulativeChance = 0;
        let startingIndex = 0;
        const rand = Math.random();

        game.players.forEach((player, index) => {
            if (index === imposterIndex) {
                player.role = 'imposter';
                player.word = game.imposterHint;
            } else {
                player.role = 'citizen';
                player.word = game.actualWord;
            }

            const chance = player.role === 'imposter' ? imposterChance : citizenChance;
            cumulativeChance += chance;
            if (rand < cumulativeChance && startingIndex === 0) { 
                startingIndex = index;
            }
            
            // Her oyuncuya özel rolünü ve kelimesini gönder
            io.to(player.socketId).emit('roleAssigned', { 
                role: player.role, 
                word: player.word, 
                actualWord: game.actualWord,
                imposterHint: game.imposterHint
            });
        });
        
        game.startingPlayer = game.players[startingIndex].name;
        game.started = true;
        
        io.to(roomCode).emit('gameStarted', { startingPlayer: game.startingPlayer });
    });

    // --- 4. Oyunu Bitirme ---
    socket.on('endGame', (roomCode) => {
        const game = games[roomCode];
        if (!game || socket.id !== game.hostSocketId || !game.started || game.finished) return;

        game.finished = true;
        io.to(roomCode).emit('gameFinished', game);
    });
    
    // --- 5. Yeni Oyun (Aynı Oda) ---
    socket.on('newGameSameRoom', (roomCode) => {
        const game = games[roomCode];
        if (!game || socket.id !== game.hostSocketId) return;

        game.started = false;
        game.finished = false;
        game.actualWord = null;
        game.imposterHint = null;
        game.category = null;
        game.startingPlayer = null;
        game.players.forEach(p => {
            p.role = null;
            p.word = null;
        });

        io.to(roomCode).emit('roomReset', game);
    });

    // --- 6. Odayı İptal Etme / Bağlantı Kesilmesi ---
    socket.on('disconnect', () => {
        for (const code in games) {
            const game = games[code];
            const playerIndex = game.players.findIndex(p => p.socketId === socket.id);
            
            if (playerIndex > -1) {
                const disconnectedPlayer = game.players[playerIndex];
                game.players.splice(playerIndex, 1);
                
                if (game.players.length === 0 || disconnectedPlayer.isHost) {
                    delete games[code];
                    io.to(code).emit('roomClosed', 'Host ayrıldığı için oda kapatıldı.');
                } else {
                    io.to(code).emit('playerListUpdated', game.players);
                }
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Socket.IO sunucusu çalışıyor: http://localhost:${PORT}`);
    console.log(`Lütfen bu adresi tarayıcınızda açın.`);
});


// --- İSTEMCİ TARAFI (HTML + JS) KISMI ---

const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>İmposter Kelime Oyunu</title>
    <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
        .container { background: white; border-radius: 20px; padding: 40px; max-width: 600px; width: 100%; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); }
        h1 { color: #667eea; text-align: center; margin-bottom: 30px; font-size: 2.5em; }
        .screen { display: none; }
        .screen.active { display: block; }
        .input-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 8px; color: #333; font-weight: 600; }
        input, select { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; transition: border-color 0.3s; }
        input:focus, select:focus { outline: none; border-color: #667eea; }
        button { width: 100%; padding: 15px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; font-size: 18px; font-weight: 600; cursor: pointer; transition: transform 0.2s, box-shadow 0.2s; margin-top: 10px; }
        button:hover { transform: translateY(-2px); box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3); }
        button:active { transform: translateY(0); }
        button.secondary { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
        button.success { background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); }
        .player-list { background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .player-item { padding: 10px; background: white; margin-bottom: 10px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; }
        .room-code { background: #fff3cd; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; border: 2px dashed #ffc107; }
        .room-code h3 { color: #856404; margin-bottom: 10px; }
        .room-code .code { font-size: 32px; font-weight: bold; color: #856404; letter-spacing: 3px; }
        .role-display { text-align: center; padding: 40px; border-radius: 12px; margin: 20px 0; }
        .role-display.citizen { background: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%); }
        .role-display.imposter { background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%); color: white; }
        .role-display h2 { font-size: 2em; margin-bottom: 20px; }
        .word-display { font-size: 3em; font-weight: bold; margin: 20px 0; padding: 30px; background: rgba(255, 255, 255, 0.3); border-radius: 12px; }
        .starting-player { background: #d4edda; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; border: 2px solid #28a745; }
        .starting-player h3 { color: #155724; font-size: 1.5em; }
        .results-table { width: 100%; margin: 20px 0; border-collapse: collapse;}
        .results-table th, .results-table td { padding: 12px; text-align: left; border-bottom: 1px solid #e0e0e0; }
        .results-table th { background: #f8f9fa; font-weight: 600; }
        .imposter-tag { background: #ff6b6b; color: white; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: bold; }
        .info-text { color: #666; font-size: 14px; text-align: center; margin: 10px 0; }
        .error { background: #f8d7da; color: #721c24; padding: 12px; border-radius: 8px; margin: 10px 0; border: 1px solid #f5c6cb; }
        @media (max-width: 600px) { .container { padding: 20px; } h1 { font-size: 1.8em; } .word-display { font-size: 2em; } }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎭 İmposter Kelime Oyunu</h1>

        <div id="mainMenu" class="screen active">
            <div class="input-group">
                <label>Ne yapmak istersiniz?</label>
                <button onclick="showCreateGame()">Yeni Oyun Oluştur</button>
                <button class="secondary" onclick="showJoinGame()">Oyuna Katıl</button>
            </div>
        </div>

        <div id="createGame" class="screen">
            <div class="input-group">
                <label>Oyuncu Sayısı (4-10)</label>
                <input type="number" id="playerCount" min="4" max="10" value="5">
            </div>
            <div class="input-group">
                <label>Host Adınız</label>
                <input type="text" id="hostName" placeholder="Adınızı girin">
            </div>
            <button onclick="createGame()">Oyunu Oluştur</button>
            <button class="secondary" onclick="showMainMenu()">Geri</button>
        </div>

        <div id="hostLobby" class="screen">
            <div class="room-code">
                <h3>Oda Kodu</h3>
                <div class="code" id="roomCodeDisplay"></div>
                <p class="info-text">Bu kodu oyunculara gönderin</p>
            </div>
            <div class="player-list">
                <h3>Katılan Oyuncular (<span id="joinedCount">0</span>/<span id="totalCount">0</span>)</h3>
                <div id="playerListHost"></div>
            </div>
            <button onclick="startGame()" id="startGameBtn" disabled>Oyunu Başlat</button>
            <button class="secondary" onclick="cancelRoom()">Odayı İptal Et</button>
        </div>

        <div id="joinGame" class="screen">
            <div class="input-group">
                <label>Oda Kodu</label>
                <input type="text" id="roomCodeInput" placeholder="Oda kodunu girin" maxlength="6">
            </div>
            <div class="input-group">
                <label>Adınız</label>
                <input type="text" id="playerNameInput" placeholder="Adınızı girin">
            </div>
            <button onclick="joinGame()">Katıl</button>
            <button class="secondary" onclick="showMainMenu()">Geri</button>
        </div>

        <div id="waitingRoom" class="screen">
            <div class="room-code">
                <h3>Oyuna Katıldınız!</h3>
                <p class="info-text">Host oyunu başlatmasını bekleyin...</p>
            </div>
            <div class="player-list">
                <h3>Katılan Oyuncular</h3>
                <div id="playerListWaiting"></div>
            </div>
        </div>

        <div id="roleReveal" class="screen">
            <div id="roleDisplay"></div>
            <button class="success" onclick="showInGame()">Anladım, Oyuna Başla</button>
        </div>

        <div id="inGameHost" class="screen">
            <div class="starting-player">
                <h3>🎯 Oyuna Başlayan</h3>
                <p style="font-size: 1.5em; margin-top: 10px; color: #155724;" id="startingPlayerName"></p>
            </div>
            <div class="info-text">
                <p>Oyun devam ediyor...</p>
            </div>
            <button class="secondary" onclick="endGame()">Oyunu Bitir / Sonucu Göster</button>
            <button class="secondary" onclick="cancelRoom()" style="background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%); margin-top: 10px;">Odayı İptal Et</button>
        </div>

        <div id="inGamePlayer" class="screen">
            <div class="starting-player">
                <h3>🎯 Oyuna Başlayan</h3>
                <p style="font-size: 1.5em; margin-top: 10px; color: #155724;" id="startingPlayerNamePlayer"></p>
            </div>
            <div class="info-text">
                <p>Oyun devam ediyor...</p>
                <p>Host oyunu bitirene kadar bekleyin.</p>
            </div>
        </div>

        <div id="results" class="screen">
            <h2 style="text-align: center; margin-bottom: 20px;">📊 Oyun Sonucu</h2>
            <div class="room-code">
                <h3>Asıl Kelime</h3>
                <div class="code" id="actualWord"></div>
            </div>
            <table class="results-table">
                <thead>
                    <tr>
                        <th>Oyuncu</th>
                        <th>Rol</th>
                    </tr>
                </thead>
                <tbody id="resultsTableBody"></tbody>
            </table>
            <div id="hostResultsActions">
                <button onclick="newGameSameRoom()">Aynı Oyuncularla Yeni Oyun</button>
                <button class="secondary" onclick="showMainMenu()">Ana Menüye Dön</button>
            </div>
            <div id="playerResultsActions" style="display: none;">
                <p class="info-text">Host yeni oyun başlatmasını bekleyin...</p>
                <button class="secondary" onclick="showMainMenu()">Ana Menüye Dön</button>
            </div>
        </div>
    </div>

    <script>
        // --- İSTEMCİ JAVASCRIPT KISMI ---
        const SERVER_URL = window.location.origin; // Sunucu adresi olarak mevcut URL'yi kullan
        let socket = null; 
        let gameData = null;
        let currentUser = null;

        // Sayfa yüklendiğinde Socket bağlantısını kur
        document.addEventListener('DOMContentLoaded', () => {
            socket = io(SERVER_URL);
            setupSocketListeners();
            
            socket.on('connect_error', () => {
                alert('Sunucuya bağlanılamadı. Lütfen Node.js sunucusunun çalışır durumda olduğundan emin olun.');
            });
        });

        function showScreen(screenId) {
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            document.getElementById(screenId).classList.add('active');
        }

        function showMainMenu() {
            if (socket) {
                // Eğer oyundayken ana menüye dönülüyorsa, sunucuya ayrıldığını bildir
                if (gameData) {
                     // Host veya oyuncu olmasından bağımsız olarak socket bağlantısını kesmek, sunucudaki disconnect olayını tetikleyecektir.
                     socket.disconnect();
                     socket = io(SERVER_URL);
                     setupSocketListeners();
                }
            }
            gameData = null;
            currentUser = null;
            showScreen('mainMenu');
        }

        function showCreateGame() {
            showScreen('createGame');
        }

        function showJoinGame() {
            showScreen('joinGame');
        }

        function setupSocketListeners() {
            // --- 1. Oda Güncellemeleri ---
            socket.on('playerListUpdated', (players) => {
                if (gameData) {
                    gameData.players = players;
                    if (document.getElementById('hostLobby').classList.contains('active')) {
                        updatePlayerListHost();
                    } else if (document.getElementById('waitingRoom').classList.contains('active')) {
                        updatePlayerListWaiting();
                    }
                }
            });
            
            socket.on('roomClosed', (message) => {
                alert(message);
                showMainMenu();
            });
            
            socket.on('gameError', (message) => {
                alert("Hata: " + message);
            });


            // --- 2. Oyun Oluşturma (Host) ---
            socket.on('gameCreated', ({ roomCode, gameData: initialGameData }) => {
                gameData = initialGameData;
                currentUser = { name: initialGameData.players[0].name, isHost: true };
                
                document.getElementById('roomCodeDisplay').textContent = roomCode;
                document.getElementById('totalCount').textContent = gameData.totalPlayers;
                updatePlayerListHost();
                showScreen('hostLobby');
            });

            // --- 3. Oyuna Katılma (Oyuncu) ---
            socket.on('joinedGame', ({ roomCode, gameData: initialGameData }) => {
                gameData = initialGameData;
                const player = initialGameData.players.find(p => p.socketId === socket.id);
                currentUser = { name: player.name, isHost: player.isHost };
                
                updatePlayerListWaiting();
                showScreen('waitingRoom');
            });

            socket.on('joinError', (message) => {
                alert(message);
            });

            // --- 4. Rol Atama (Hem Host hem Oyuncu) ---
            socket.on('roleAssigned', ({ role, word, actualWord, imposterHint }) => {
                currentUser.role = role;
                currentUser.word = word;
                gameData.actualWord = actualWord; 
                gameData.imposterHint = imposterHint;
                showRoleReveal();
            });

            // --- 5. Oyun Başladı (Hem Host hem Oyuncu) ---
            socket.on('gameStarted', ({ startingPlayer }) => {
                gameData.started = true;
                gameData.startingPlayer = startingPlayer;
                // Rol ekranı kapandıysa direkt oyuna geç
                if (!document.getElementById('roleReveal').classList.contains('active')) {
                    showInGame(); 
                }
            });

            // --- 6. Oyun Bitti (Hem Host hem Oyuncu) ---
            socket.on('gameFinished', (finalGameData) => {
                gameData = finalGameData;
                showResults();
            });
            
            // --- 7. Oda Sıfırlandı (Hem Host hem Oyuncu) ---
            socket.on('roomReset', (resetGameData) => {
                gameData = resetGameData;
                // Kendi rol bilgimizi koru
                const currentPlayer = resetGameData.players.find(p => p.socketId === socket.id);
                if (currentPlayer) {
                    currentUser = { name: currentPlayer.name, isHost: currentPlayer.isHost, role: null, word: null };
                }

                if (currentUser.isHost) {
                    updatePlayerListHost();
                    showScreen('hostLobby');
                } else {
                    updatePlayerListWaiting();
                    showScreen('waitingRoom');
                }
            });
        }
        
        // --- CLIENT FUNCTIONS ---
        
        function createGame() {
            const playerCount = parseInt(document.getElementById('playerCount').value);
            const hostName = document.getElementById('hostName').value.trim();

            if (!hostName) {
                alert('Lütfen adınızı girin!');
                return;
            }

            if (playerCount < 4 || playerCount > 10) {
                alert('Oyuncu sayısı 4-10 arasında olmalıdır!');
                return;
            }
            
            socket.emit('createGame', { hostName, playerCount });
        }

        function joinGame() {
            const roomCode = document.getElementById('roomCodeInput').value.trim().toUpperCase();
            const playerName = document.getElementById('playerNameInput').value.trim();

            if (!roomCode || !playerName) {
                alert('Lütfen oda kodu ve adınızı girin!');
                return;
            }

            socket.emit('joinGame', { roomCode, playerName });
        }

        function updatePlayerListHost() {
            const list = document.getElementById('playerListHost');
            list.innerHTML = '';
            
            gameData.players.forEach(player => {
                const div = document.createElement('div');
                div.className = 'player-item';
                div.innerHTML = \`
                    <span>\${player.name} \${player.isHost ? '(Host)' : ''}</span>
                \`;
                list.appendChild(div);
            });

            document.getElementById('joinedCount').textContent = gameData.players.length;
            document.getElementById('startGameBtn').disabled = gameData.players.length !== gameData.totalPlayers;
        }

        function updatePlayerListWaiting() {
            const list = document.getElementById('playerListWaiting');
            list.innerHTML = '';
            
            gameData.players.forEach(player => {
                const div = document.createElement('div');
                div.className = 'player-item';
                div.innerHTML = \`
                    <span>\${player.name} \${player.isHost ? '(Host)' : ''}</span>
                \`;
                list.appendChild(div);
            });
        }

        function startGame() {
            if (gameData && currentUser.isHost) {
                socket.emit('startGame', gameData.roomCode);
            }
        }

        function showRoleReveal() {
            const display = document.getElementById('roleDisplay');
            
            if (currentUser.role === 'imposter') {
                display.innerHTML = \`
                    <div class="role-display imposter">
                        <h2>🎭 SEN IMPOSTER'SIN!</h2>
                        <div class="word-display">\${currentUser.word}</div>
                        <p style="font-size: 1.2em; margin-top: 20px;">Bu bir ipucu! Diğerleri asıl kelimeyi biliyor.</p>
                    </div>
                \`;
            } else {
                display.innerHTML = \`
                    <div class="role-display citizen">
                        <h2>✅ Sen Normal Oyuncusun</h2>
                        <div class="word-display">\${currentUser.word}</div>
                        <p style="font-size: 1.2em; margin-top: 20px; color: #333;">Bu kelimeyi bil ama imposter'a belli etme!</p>
                    </div>
                \`;
            }
            
            showScreen('roleReveal');
        }

        function showInGame() {
            document.getElementById('startingPlayerName').textContent = gameData.startingPlayer;
            document.getElementById('startingPlayerNamePlayer').textContent = gameData.startingPlayer;
            
            if (currentUser.isHost) {
                showScreen('inGameHost');
            } else {
                showScreen('inGamePlayer');
            }
        }

        function endGame() {
            if (gameData && currentUser.isHost) {
                socket.emit('endGame', gameData.roomCode);
            }
        }

        function showResults() {
            document.getElementById('actualWord').textContent = gameData.actualWord;
            
            const tbody = document.getElementById('resultsTableBody');
            tbody.innerHTML = '';
            
            // Sonuçları gösterirken, kendi bilgilerimizi değil, sunucudan gelen tam gameData'yı kullanmalıyız.
            gameData.players.forEach(player => {
                const tr = document.createElement('tr');
                tr.innerHTML = \`
                    <td>\${player.name}</td>
                    <td>
                        \${player.role === 'imposter' 
                            ? \`<span class="imposter-tag">IMPOSTER</span> <span style="color: #666; font-size: 0.9em;">(İpucu: \${gameData.imposterHint})</span>\` 
                            : 'Normal Oyuncu'}
                    </td>
                \`;
                tbody.appendChild(tr);
            });
            
            if (currentUser.isHost) {
                document.getElementById('hostResultsActions').style.display = 'block';
                document.getElementById('playerResultsActions').style.display = 'none';
            } else {
                document.getElementById('hostResultsActions').style.display = 'none';
                document.getElementById('playerResultsActions').style.display = 'block';
            }
            
            showScreen('results');
        }

        function newGameSameRoom() {
            if (gameData && currentUser.isHost) {
                socket.emit('newGameSameRoom', gameData.roomCode);
            }
        }

        function cancelRoom() {
            if (confirm('Odayı iptal edip ana menüye dönmek istediğinizden emin misiniz?')) {
                // Host veya oyuncu fark etmez, bağlantı kesilerek sunucunun temizlik yapması sağlanır
                showMainMenu();
            }
        }

        // URL'den oda kodu algılama (Artık sadece joinGame'i gösterir)
        window.addEventListener('load', () => {
            const urlParams = new URLSearchParams(window.location.search);
            const roomCode = urlParams.get('room');
            
            if (roomCode) {
                document.getElementById('roomCodeInput').value = roomCode;
                showJoinGame();
            }
        });

    </script>
</body>
</html>
`;