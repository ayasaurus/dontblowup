

// Full gameplay with Firebase Realtime Database room-code multiplayer.
// IMPORTANT: Replace firebaseConfig with your project's config object.

// ===== CONFIG =====
const firebaseConfig = {
  apiKey: "AIzaSyBlY2aNjSA7jbptYS3E3rGIzw2BgrUjO-Q",
  authDomain: "thunk-6d619.firebaseapp.com",
  databaseURL: "https://thunk-6d619-default-rtdb.firebaseio.com",
  projectId: "thunk-6d619",
  storageBucket: "thunk-6d619.firebasestorage.app",
  messagingSenderId: "1097168625990",
  appId: "1:1097168625990:web:1f4c57b67186a308590547"
};

// Deck constants (tweak if you want different counts)
const COMBO_NAMES = ['dogzilla','barknado','pupcake','chewbacca','pawsassiom'];
const ACTION_NAMES = ['nope','skip','attack','favour','future','shuffle'];
const COUNT_EACH_COMBO = 4;
const COUNT_EACH_ACTION = 4;
const NUM_BOMBS = 4;      // bombs placed into deck
const NUM_DEFUSALS = 6;   // total defusals in deck (two will be dealt at start if you want)

// Nope window time
const NOPE_WINDOW = 1500;

// ===== Firebase init =====
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ===== UI refs =====
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const roomCodeInput = document.getElementById('roomCodeInput');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const nameInput = document.getElementById('nameInput');
const playerIdDisplay = document.getElementById('playerIdDisplay');
const gameArea = document.getElementById('gameArea');
const roomInfo = document.getElementById('roomInfo');
const yourHandDiv = document.getElementById('yourHand');
const opponentHandDiv = document.getElementById('opponentHand');
const deckCountSpan = document.getElementById('deckCount');
const discardTop = document.getElementById('discardTop');
const statusDiv = document.getElementById('status');
const drawBtn = document.getElementById('drawBtn');
const opponentNameH2 = document.getElementById('opponentName');
const yourNameH2 = document.getElementById('yourName');
const leaveBtn = document.getElementById('leaveBtn');

// ===== Local state =====
let roomRef = null;
let roomCode = null;
let localPlayerId = null; // 'p1' or 'p2'
let localName = null;
let unsub = null; // firebase listener
let localState = null; // mirror of remote state
let nopeTimer = null;

// ===== Utilities =====
function randId(len=6){return Math.random().toString(36).slice(2,2+len).toUpperCase()}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}

// Build a full deck array of card objects
function buildDeck(){
  const deck=[];
  COMBO_NAMES.forEach(name=>{for(let i=0;i<COUNT_EACH_COMBO;i++)deck.push({type:'combo',name})});
  ACTION_NAMES.forEach(name=>{for(let i=0;i<COUNT_EACH_ACTION;i++)deck.push({type:'action',name})});
  for(let i=0;i<NUM_BOMBS;i++)deck.push({type:'bomb',name:'bomb'});
  for(let i=0;i<NUM_DEFUSALS;i++)deck.push({type:'defusal',name:'defusal'});
  return shuffle(deck);
}

// Remove a specific card instance from an array (by index) and return it
function popAt(arr, index){if(index<0||index>=arr.length) return null; return arr.splice(index,1)[0]}

// ===== Firebase room lifecycle =====
createRoomBtn.onclick = async () => {
  localName = nameInput.value.trim() || 'Player';
  const code = randId(5);
  roomCode = code;

  let deck = buildDeck();

  // === Remove bombs from initial dealing ===
  const bombs = deck.filter(c => c.type === 'bomb');
  deck = deck.filter(c => c.type !== 'bomb');

  // === Initial hands ===
  const p1 = { name: localName, hand: [], defusals: 0 };
  const p2 = { name: 'Waiting...', hand: [], defusals: 0 };

  function takeAndRemoveCard(deck, predicate) {
    const idx = deck.findIndex(predicate);
    if (idx === -1) return null;
    return popAt(deck, idx);
  }

  // Give each player 1 defusal
  let defusalCard = takeAndRemoveCard(deck, c => c.type === 'defusal');
  if (defusalCard) p1.defusals++;
  defusalCard = takeAndRemoveCard(deck, c => c.type === 'defusal');
  // We'll give this to p2 when they join

  // Deal 6 random non-bomb cards to p1
  for (let i = 0; i < 6; i++) {
    p1.hand.push(popAt(deck, 0));
  }

  // Restore bombs to deck and shuffle
  deck = shuffle(deck.concat(bombs));

  const initialState = {
    createdAt: Date.now(),
    players: { p1, p2 },
    deck,
    discard: [],
    turn: 'p1',
    started: false,
    waitingForJoin: true,
    pendingAction: null
  };

  await db.ref('rooms/' + code).set(initialState);

  // Now join the room as creator
  joinRoom(code, true);
};


joinRoomBtn.onclick = ()=>{const code = (roomCodeInput.value||'').trim().toUpperCase(); if(!code)return alert('Enter room code'); joinRoom(code,false)}

async function joinRoom(code, isCreator){
  localName = nameInput.value.trim() || 'Player';
  roomCode = code;
  roomRef = db.ref('rooms/'+code);

  // set local player id
  if(isCreator){localPlayerId = 'p1'; localPlayerIdDisplay(localPlayerId);}
  else{
    // try to claim p2 if available
    const snap = await roomRef.once('value');
    if(!snap.exists()) return alert('Room not found');
    const data = snap.val();
    if(data.players && data.players.p2 && data.players.p2.name !== 'Waiting...'){
      return alert('Room already full');
    }
    localPlayerId = 'p2'; localPlayerIdDisplay(localPlayerId);
  }

  // write our name into the player slot (p1 already had name)
  await roomRef.child('players').child(localPlayerId).child('name').set(localName);

  // if joining as p2 and game hasn't started, finalize dealing p2's defusal & 6 cards
  if (!isCreator) {
  const snap = await roomRef.once('value');
  const state = snap.val();
  let deck = state.deck || [];

  // Give 1 defusal if available
  const idxDef = deck.findIndex(c => c.type === 'defusal');
  if (idxDef !== -1) popAt(deck, idxDef);

  const p2hand = [];
  for (let i = 0; i < 6; i++) {
    // Skip bombs during initial deal
    let idxCard = deck.findIndex(c => c.type !== 'bomb');
    if (idxCard === -1) idxCard = 0; // fallback
    p2hand.push(popAt(deck, idxCard));
  }

  await roomRef.update({
    'players/p2/hand': p2hand,
    'deck': deck,
    'waitingForJoin': false,
    'started': true
  });
}


  // attach listener to room
  if(unsub) unsub();
  unsub = roomRef.on('value', snapshot=>{
    localState = snapshot.val();
    if(!localState) return; // room deleted
    renderStateToUI(localState);
  });

  // show UI
  roomInfo.classList.remove('hidden');
  gameArea.classList.remove('hidden');
  document.getElementById('roomControls')?.classList?.add('hidden');
  roomCodeDisplay.textContent = roomCode;
}

function localPlayerIdDisplay(id){playerIdDisplay.textContent = id}

leaveBtn.onclick = async ()=>{
  if(roomRef){
    // simple: remove the room if you're creator, else clear p2
    const snap = await roomRef.once('value');
    const state = snap.val();
    if(!state) return location.reload();
    if(localPlayerId==='p1'){
      await roomRef.remove();
    }else{
      await roomRef.child('players/p2').set({name:'Waiting...',hand:[],defusals:0});
      await roomRef.update({waitingForJoin:true,started:false});
    }
    location.reload();
  }
}

// ===== Rendering =====
function renderStateToUI(state){
  // show names
  const players = state.players || {};
  const me = players[localPlayerId] || {name:localName,hand:[]};
  const otherId = localPlayerId==='p1'?'p2':'p1';
  const other = players[otherId] || {name:'Waiting...',hand:[]};

  yourNameH2.textContent = me.name + (localPlayerId?` (${localPlayerId})`: '');
  opponentNameH2.textContent = other.name + ` (${otherId})`;

  // show hands (opponent hidden count, you see full hand)
  opponentHandDiv.innerHTML = '';
  for(let i=0;i<(other.hand?other.hand.length:0);i++){
    const c = document.createElement('div'); c.className='card small'; c.textContent='?'; opponentHandDiv.appendChild(c);
  }

  yourHandDiv.innerHTML = '';
  (me.hand||[]).forEach((card, idx)=>{
    const el = makeCardElement(card, idx);
    yourHandDiv.appendChild(el);
  });

  deckCountSpan.textContent = (state.deck?state.deck.length:0);
  discardTop.textContent = (state.discard&&state.discard.length?state.discard[state.discard.length-1].name:'—');

  // status
  if(state.turn === localPlayerId) statusDiv.textContent = `Your turn`;
  else statusDiv.textContent = `Waiting for opponent (${state.turn})`;

  // store latest localState
}

// Updated makeCardElement to use /assets PNGs and overlay text
function makeCardElement(card, idx){
  const d = document.createElement('div');
  d.className='card';
  d.dataset.card = card.name;
  d.dataset.type = card.type;

  // set background image from /assets folder (capitalize first letter)
  const fileName = card.name.charAt(0).toUpperCase() + card.name.slice(1) + '.png';
  d.style.backgroundImage = `url('assets/${fileName}')`;
  d.style.backgroundSize = 'cover';
  d.style.backgroundPosition = 'center';
  d.style.color = 'white';
  d.style.textShadow = '0 0 4px rgba(0,0,0,0.8)';

  // overlay text
  const titleDiv = document.createElement('div');
  titleDiv.className='title';
  titleDiv.textContent = card.name;
  d.appendChild(titleDiv);

  const subDiv = document.createElement('div');
  subDiv.className='sub';
  subDiv.textContent = card.type;
  d.appendChild(subDiv);

  d.onclick = ()=>onCardClicked(card, idx);
  return d;
}

// ===== Gameplay interactions =====
async function onCardClicked(card, idx){
  if(!localState) return;
  if(localState.turn !== localPlayerId){
    // can play only certain interrupt cards (nope) while not your turn
    if(card.name === 'nope'){
      // send nope action
      await pushNope();
    } else {
      // invalid click
      flashInvalid();
    }
    return;
  }

  // When it's your turn, clicking a card attempts to play it.
  if(card.type === 'combo'){
    // check if player has another of same name
    const myHand = localState.players[localPlayerId].hand || [];
    const matches = myHand.filter(c=>c && c.name === card.name);
    if(matches.length < 2){ flashInvalid(); return; }
    await playCombo(card.name);
  } else if(card.type === 'action'){
    if(card.name === 'nope') { flashInvalid(); return; } // nope can't be played on your own turn
    if(card.name === 'skip'){
      await playSkip();
    } else if(card.name === 'attack'){
      await playAttack();
    } else if(card.name === 'favour'){
      await playFavour();
    } else if(card.name === 'future'){
      await playFuture();
    } else if(card.name === 'shuffle'){
      await playShuffle();
    }
  } else {
    flashInvalid();
  }
}

function flashInvalid(){ yourHandDiv.classList.add('invalid'); setTimeout(()=>yourHandDiv.classList.remove('invalid'),350)}

// Core: atomic update helper to avoid race conditions
async function transactRoom(fn){
  const roomPath = 'rooms/'+roomCode;
  const ref = db.ref(roomPath);
  await ref.transaction(current => { if(!current) return current; return fn(current); });
}

// Implement playCombo: remove two cards from player's hand and perform request
async function playCombo(name){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const player = state.players[localPlayerId];
    const otherId = localPlayerId==='p1'?'p2':'p1';
    const myHand = player.hand || [];
    const idx1 = myHand.findIndex(c=>c && c.name===name);
    const idx2 = myHand.findIndex((c,i)=>c && c.name===name && i!==idx1);
    if(idx1===-1||idx2===-1) return state; // invalid
    // remove higher index first
    const card1 = myHand.splice(Math.max(idx1,idx2),1)[0];
    const card2 = myHand.splice(Math.min(idx1,idx2),1)[0];

    // set pending action so opponent can 'nope'
    state.pendingAction = {type:'combo',by:localPlayerId,cardName:name,ts:Date.now()};
    // write back
    state.players[localPlayerId].hand = myHand;
    return state;
  });

  // wait for nope window
  const wasNooped = await waitForNopeWindow();
  if(wasNooped){
    // if nooped, cancel pendingAction and refund cards (we'll give them back to player)
    await transactRoom(state=>{ if(state.pendingAction && state.pendingAction.type==='combo'){
      // refund: push two cards back to player's hand
      state.players[localPlayerId].hand.push({type:'combo',name});
      state.players[localPlayerId].hand.push({type:'combo',name});
      state.pendingAction = null;
    } return state;});
    statusDiv.textContent = 'Your combo was noped.';
    return;
  }

  // not nooped: execute effect — request card from opponent
  await transactRoom(state=>{
    if(!state.pendingAction || state.pendingAction.type!=='combo') return state;
    const otherId = localPlayerId==='p1'?'p2':'p1';
    const otherHand = state.players[otherId].hand || [];
    const idx = otherHand.findIndex(c=>c && c.name===name);
    if(idx!==-1){
      // opponent has the card: transfer first matching card
      const card = otherHand.splice(idx,1)[0];
      state.players[localPlayerId].hand.push(card);
      state.discard = state.discard || [];
      state.discard.push({system:'transfer',name});
    } else {
      // opponent does not have card: combo ends (no transfer). Player can continue until draw.
      state.discard = state.discard || [];
      state.discard.push({system:'combo_miss',name});
    }
    state.pendingAction = null;
    return state;
  });

  statusDiv.textContent = 'Combo resolved.';
}

// Waits NOPE_WINDOW ms to see if someone plays nope. Returns true if noped.
function waitForNopeWindow(){
  return new Promise((resolve)=>{
    let resolved=false;
    const path = 'rooms/'+roomCode+'/pendingAction';
    const ref = db.ref(path);
    const onChange = snap=>{
      const val = snap.val();
      if(!val){ if(!resolved){resolved=true; ref.off('value', onChange); resolve(false);} }
    };
    ref.on('value', onChange);

    // after timeout, check if a 'nope' marker exists in last actions
    setTimeout(async ()=>{
      ref.off('value', onChange);
      // check server state for a flag that indicates 'noped'
      const snap = await db.ref('rooms/'+roomCode).once('value');
      const state = snap.val();
      if(state && state.lastNope && state.lastNope.ts && state.lastNope.target && state.lastNope.target === state.pendingAction?.by){
        resolve(true);
      } else resolve(false);
    }, NOPE_WINDOW);
  });
}

// Opponent can call this to play a nope while it's NOT their turn
async function pushNope(){
  // write lastNope marker into DB so waiting party can detect
  await db.ref('rooms/'+roomCode).update({lastNope:{by:localPlayerId,ts:Date.now(),target:null}});
  // also clear pendingAction (server-side reaction will handle refund)
  await transactRoom(state=>{ state.pendingAction = null; return state; });
}

// Play Skip: skip drawing and pass turn
async function playSkip(){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    // move card from player's hand to discard (we need to remove one skip card instance)
    const p = state.players[localPlayerId];
    const idx = (p.hand||[]).findIndex(c=>c && c.type==='action' && c.name==='skip');
    if(idx===-1) return state;
    p.hand.splice(idx,1);
    state.discard = state.discard||[]; state.discard.push({system:'played',name:'skip'});
    // pass turn to other without forcing a draw
    state.turn = (localPlayerId==='p1'?'p2':'p1');
    return state;
  });
}

// Play Attack: end your turn but force next player to draw twice (we'll set a flag)
async function playAttack(){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const p = state.players[localPlayerId];
    const idx = (p.hand||[]).findIndex(c=>c && c.type==='action' && c.name==='attack');
    if(idx===-1) return state;
    p.hand.splice(idx,1);
    state.discard = state.discard||[]; state.discard.push({system:'played',name:'attack'});
    // set a flag so next player must draw twice on their draw
    state.nextDrawExtra = (state.nextDrawExtra||0) + 2;
    state.turn = (localPlayerId==='p1'?'p2':'p1');
    return state;
  });
}

// Play Favour: opponent must give a card of their choice
async function playFavour(){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const p = state.players[localPlayerId];
    const idx = (p.hand||[]).findIndex(c=>c && c.type==='action' && c.name==='favour');
    if(idx===-1) return state;
    p.hand.splice(idx,1);
    state.discard = state.discard||[]; state.discard.push({system:'played',name:'favour'});
    // mark pending favour; other player must pick a card to transfer
    state.pendingAction = {type:'favour',by:localPlayerId,ts:Date.now()};
    return state;
  });

  // wait for opponent to react by selecting a card when it's their turn (we'll rely on the UI to allow selecting card while not your turn for favour)
  statusDiv.textContent = 'Waiting for opponent to give a card (favour)';
}

// Play Future: let player peek next 3 cards
async function playFuture(){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const p = state.players[localPlayerId];
    const idx = (p.hand||[]).findIndex(c=>c && c.type==='action' && c.name==='future');
    if(idx===-1) return state;
    p.hand.splice(idx,1);
    state.discard = state.discard||[]; state.discard.push({system:'played',name:'future'});

    // attach peek info to state so client can show it briefly
    const peek = (state.deck||[]).slice(0,3);
    state.peek = {by:localPlayerId, cards: peek, ts: Date.now()};
    return state;
  });
}

// Play Shuffle: randomize deck
async function playShuffle(){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const p = state.players[localPlayerId];
    const idx = (p.hand||[]).findIndex(c=>c && c.type==='action' && c.name==='shuffle');
    if(idx===-1) return state;
    p.hand.splice(idx,1);
    state.discard = state.discard||[]; state.discard.push({system:'played',name:'shuffle'});
    state.deck = shuffle(state.deck || []);
    return state;
  });
}

// Opponent selecting a card to give for favour, or for other transfers while not your turn
async function giveCardToPlayer(targetPlayerId, cardIdx){
  await transactRoom(state=>{
    const otherId = localPlayerId==='p1'?'p2':'p1';
    // allow only if there's a pending favour
    if(!state.pendingAction || state.pendingAction.type!=='favour' || state.pendingAction.by===localPlayerId) return state;
    // remove cardIdx from current player's hand and give to requester
    const card = state.players[localPlayerId].hand.splice(cardIdx,1)[0];
    state.players[state.pendingAction.by].hand.push(card);
    state.discard = state.discard||[]; state.discard.push({system:'favour_give',name:card.name});
    state.pendingAction = null;
    return state;
  });
}

// Draw card (ends your turn). Handles bombs and defusals and nextDrawExtra
async function drawCard() {
  await transactRoom(state => {
    if (state.turn !== localPlayerId) return state;

    const deck = state.deck || [];
    const p = state.players[localPlayerId];
    let draws = 1 + (state.nextDrawExtra || 0);
    state.nextDrawExtra = 0;

    for (let d = 0; d < draws; d++) {
      if (deck.length === 0) continue;

      const card = deck.shift();

      if (card.type === 'bomb') {
        if (p.defusals && p.defusals > 0) {
          p.defusals--;
          const pos = Math.floor(Math.random() * (deck.length + 1));
          deck.splice(pos, 0, { type: 'bomb', name: 'bomb' });
          state.discard = state.discard || [];
          state.discard.push({ system: 'defused', by: localPlayerId, card: 'bomb' });
          // show popup for defusal
          statusDiv.textContent = 'You picked up a Bomb, but auto-used a Defusal!';
        } else {
          p.lost = true;
          state.discard = state.discard || [];
          state.discard.push({ system: 'exploded', by: localPlayerId, card: 'bomb' });
          // show popup for explosion
          statusDiv.textContent = 'You picked up a Bomb and exploded! 💥';
        }
      } else if (card.type === 'defusal') {
        p.defusals = (p.defusals || 0) + 1;
        state.discard = state.discard || [];
        state.discard.push({ system: 'draw', by: localPlayerId, card: 'defusal' });
        statusDiv.textContent = 'You picked up a Defusal card.';
      } else {
        p.hand.push(card);
        state.discard = state.discard || [];
        state.discard.push({ system: 'draw', by: localPlayerId, card: card.name });
        statusDiv.textContent = `You drew a ${card.name} card.`;
      }
    }

    if (!p.lost) state.turn = (localPlayerId === 'p1' ? 'p2' : 'p1');

    if (state.peek && Date.now() - state.peek.ts > 3000) delete state.peek;

    return state;
  });
}



// Draw button
drawBtn.onclick = async ()=>{
  await drawCard();
}

// Allow clicking on your own hand while not your turn to give a card for favour
yourHandDiv.addEventListener('click', async (ev)=>{
  const cardEl = ev.target.closest('.card');
  if(!cardEl) return;
  const idx = Array.from(yourHandDiv.children).indexOf(cardEl);
  if(localState && localState.pendingAction && localState.pendingAction.type==='favour' && localState.pendingAction.by !== localPlayerId){
    // give card idx
    await giveCardToPlayer(localState.pendingAction.by, idx);
  }
});

// ===== On-load: simple UI hints =====
statusDiv.textContent = 'Enter your name, create a room and share the code with a friend.';

// ===== END of script.js =====
