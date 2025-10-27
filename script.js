// script.js - Dogzilla multiplayer (full working version)

// ===== CONFIG - replace with your own if needed (using your earlier config) =====
const firebaseConfig = {
  apiKey: "AIzaSyBlY2aNjSA7jbptYS3E3rGIzw2BgrUjO-Q",
  authDomain: "thunk-6d619.firebaseapp.com",
  databaseURL: "https://thunk-6d619-default-rtdb.firebaseio.com",
  projectId: "thunk-6d619",
  storageBucket: "thunk-6d619.firebasestorage.app",
  messagingSenderId: "1097168625990",
  appId: "1:1097168625990:web:1f4c57b67186a308590547"
};

const COMBO_NAMES = ['dogzilla','barknado','pupcake','chewbacca','pupsassion'];
const ACTION_NAMES = ['nope','skip','attack','favour','future','shuffle'];
const COUNT_EACH_COMBO = 4;
const COUNT_EACH_ACTION = 4;
const NUM_BOMBS = 4;
const NUM_DEFUSALS = 6;
const NOPE_WINDOW = 3000;

// ===== FIREBASE INIT (safe) =====
// Initialize Firebase if the SDK loaded; otherwise keep `db` null and fail gracefully.
let db = null;
try{
  if(typeof firebase !== 'undefined' && firebase && firebase.initializeApp){
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    console.log('Firebase initialized');
  } else {
    console.error('Firebase SDK not found. Make sure the firebase scripts are included before script.js');
  }
}catch(err){
  console.error('Firebase initialization error', err);
}

// ===== GLOBALS =====
let roomRef = null;
let roomCode = null;
let localPlayerId = null; // 'p1' or 'p2'
let localName = null;
let localState = null;
let unsub = null;

// ===== UI REFS (IDs must match your index.html) =====
let createRoomBtn, joinRoomBtn, roomCodeInput, roomCodeDisplay, nameInput;
let playerIdDisplay, gameArea, roomInfo, yourHandDiv, opponentHandDiv;
let deckDiv, deckCountSpan, discardTop, statusDiv, drawBtn, opponentNameH2, yourNameH2;
let leaveBtn, restartBtn, nopeIndicator, futureCardsDiv;
let _nopeInterval = null;

// ===== UTILITIES =====
function randId(len=5){return Math.random().toString(36).slice(2,2+len).toUpperCase();}
function shuffle(arr){ const a = arr.slice(); for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function popAt(arr,index){ if(index<0||index>=arr.length) return null; return arr.splice(index,1)[0]; }
function otherPlayerId(id){ return id==='p1'?'p2':'p1'; }
function isComboName(n){ return COMBO_NAMES.includes(n); }
function isActionName(n){ return ACTION_NAMES.includes(n); }

// small helper to set discard top
function setTopDiscard(state, cardObj, meta={}) {
  state.discard = state.discard || [];
  state.discard.push(cardObj);
  state.discardTop = Object.assign({}, cardObj, { by: meta.by || null, ts: Date.now() });
}

// ===== BUILD DECK =====
function buildDeck(){
  const deck=[];
  COMBO_NAMES.forEach(name => { for(let i=0;i<COUNT_EACH_COMBO;i++) deck.push({type:'combo',name}); });
  ACTION_NAMES.forEach(name => { for(let i=0;i<COUNT_EACH_ACTION;i++) deck.push({type:'action',name}); });
  for(let i=0;i<NUM_BOMBS;i++) deck.push({type:'bomb',name:'bomb'});
  for(let i=0;i<NUM_DEFUSALS;i++) deck.push({type:'defusal',name:'defusal'});
  return shuffle(deck);
}

// ===== INIT DOM =====
document.addEventListener('DOMContentLoaded', ()=>{
  createRoomBtn = document.getElementById('createRoomBtn');
  joinRoomBtn = document.getElementById('joinRoomBtn');
  roomCodeInput = document.getElementById('roomCodeInput');
  roomCodeDisplay = document.getElementById('roomCodeDisplay');
  nameInput = document.getElementById('nameInput');
  playerIdDisplay = document.getElementById('playerIdDisplay');
  gameArea = document.getElementById('gameArea');
  roomInfo = document.getElementById('roomInfo');
  yourHandDiv = document.getElementById('yourHand');
  opponentHandDiv = document.getElementById('opponentHand');
  deckDiv = document.getElementById('deck');
  deckCountSpan = document.getElementById('deckCount');
  discardTop = document.getElementById('discardTop');
  statusDiv = document.getElementById('status');
  drawBtn = document.getElementById('drawBtn');
  opponentNameH2 = document.getElementById('opponentName');
  yourNameH2 = document.getElementById('yourName');
  leaveBtn = document.getElementById('leaveBtn');
  restartBtn = document.getElementById('restartBtn');
  nopeIndicator = document.getElementById('nopeIndicator');
  futureCardsDiv = document.getElementById('futureCards');

  // wire buttons
  // Bind button handlers defensively — if Firebase didn't load, show a message and disable actions
  if(createRoomBtn) createRoomBtn.addEventListener('click', ()=>{ if(db) createRoom(); else alert('Firebase not loaded — check console.'); });
  if(joinRoomBtn) joinRoomBtn.addEventListener('click', ()=>{ if(db) joinRoom(roomCodeInput.value.trim().toUpperCase(), false); else alert('Firebase not loaded — check console.'); });
  if(leaveBtn) leaveBtn.addEventListener('click', ()=>{ if(db) leaveRoom(); else location.reload(); });
  if(restartBtn) restartBtn.addEventListener('click', ()=>{ if(db) restartGame(); else alert('Not connected to Firebase'); });
  if(drawBtn) drawBtn.addEventListener('click', ()=>{ if(db) drawCard(); else flashInvalid(); });

  // click-on-hand (used for favour giving)
  yourHandDiv.addEventListener('click', async ev=>{
    const cardEl = ev.target.closest('.card');
    if(!cardEl) return;
    const idx = Array.from(yourHandDiv.children).indexOf(cardEl);
    // Get the clicked card from our local snapshot (may be slightly stale but fine for UI)
    const clickedCard = (localState && localState.players && localState.players[localPlayerId] && localState.players[localPlayerId].hand[idx]);
    if(localState && localState.pendingAction && localState.pendingAction.type==='favour' && localState.pendingAction.by!==localPlayerId){
      // opponent requested a favour; allow playing a NOPE to cancel instead of giving it away
      if(clickedCard && clickedCard.name === 'nope'){
        // play a NOPE to cancel the favour
        await pushNope();
      } else {
        // give selected card at idx to the favouring player
        await giveCardToPlayer(localState.pendingAction.by, idx);
      }
    } else {
      // normal click should call onCardClicked (we use data-index)
      const card = clickedCard;
      if(card) onCardClicked(card, idx);
    }
  });

  statusDiv.textContent = 'Enter name → create room → share code with friend.';
  if(!db){
    statusDiv.textContent = 'Firebase SDK not loaded or failed to initialize — game features disabled. Check console for errors.';
    if(createRoomBtn) createRoomBtn.disabled = true;
    if(joinRoomBtn) joinRoomBtn.disabled = true;
    if(drawBtn) drawBtn.disabled = true;
  }

  // Start in menu mode (centered main menu). When a room is joined we remove this class.
  try{ document.body.classList.add('menu-mode'); }catch(e){}
  // trigger visible state for fade-in
  try{ setTimeout(()=>document.body.classList.add('menu-visible'), 20); }catch(e){}
  // orientation handling: prompt portrait phone users to rotate to landscape
  try{ updateOrientationUI(); }catch(e){}
});

// Show a blocking rotate overlay on small portrait devices — user should rotate to landscape
function updateOrientationUI(){
  try{
    const notice = document.getElementById('rotateNotice');
    const isSmallPortrait = window.matchMedia && window.matchMedia('(orientation: portrait) and (max-width: 900px)').matches;
    if(notice){
      if(isSmallPortrait){
        notice.classList.remove('hidden');
        // disable interaction with the app behind the overlay to avoid accidental taps
        document.getElementById('app')?.setAttribute('aria-hidden','true');
      } else {
        notice.classList.add('hidden');
        document.getElementById('app')?.removeAttribute('aria-hidden');
      }
    }
  }catch(err){ /* noop */ }
}

window.addEventListener('resize', ()=>{ try{ updateOrientationUI(); }catch(e){} });
window.addEventListener('orientationchange', ()=>{ try{ setTimeout(updateOrientationUI,150); }catch(e){} });

// ===== ROOM FUNCTIONS =====
async function createRoom(){
  localName = nameInput.value.trim()||'Player';
  roomCode = randId();
  roomRef = db.ref('rooms/'+roomCode);

  // Build deck and deal
  const deck = buildDeck();

  // helper to pop first matching type
  const takeCard = pred => {
    const idx = deck.findIndex(pred);
    if(idx===-1) return null;
    return popAt(deck, idx);
  };

  // Players
  const p1 = {name: localName, hand: [], lost:false};
  const p2 = {name: 'Waiting...', hand: [], lost:false};

  // Give each player 1 defusal (take from deck if available)
  let def = takeCard(c=>c.type==='defusal'); if(def) p1.hand.push(def);
  def = takeCard(c=>c.type==='defusal'); if(def) p2.hand.push(def);

  // Deal 6 non-bomb, non-defusal to both
  for(let i=0;i<6;i++){
    let c = takeCard(c=>c.type!=='bomb'&&c.type!=='defusal'); if(c) p1.hand.push(c);
    c = takeCard(c=>c.type!=='bomb'&&c.type!=='defusal'); if(c) p2.hand.push(c);
  }

  // Ensure at least one bomb remains in deck (if all removed accidentally)
  if(!deck.some(c=>c.type==='bomb')) deck.push({type:'bomb',name:'bomb'});

  const initial = {
    createdAt: Date.now(),
    players: { p1, p2 },
    deck,
    discard: [],
    discardTop: null,
    turn: 'p1',
    nextDrawExtra: 0,
    pendingAction: null,
    peek: null,
    waitingForJoin: true,
    started: true
  };

  await roomRef.set(initial);
  await joinRoom(roomCode, true);
}

async function joinRoom(code, isCreator){
  if(!code) return alert('Enter room code');
  roomCode = code;
  roomRef = db.ref('rooms/'+roomCode);
  localName = nameInput.value.trim()||'Player';
  localPlayerId = isCreator ? 'p1' : 'p2';

  if(!isCreator){
    // set p2 name if joining
    const snap = await roomRef.once('value');
    if(!snap.exists()) return alert('Room not found');
    const data = snap.val();
    if(data.players.p2 && data.players.p2.name && data.players.p2.name !== 'Waiting...') {
      // room full
      return alert('Room full');
    }
    await roomRef.child('players').child('p2').child('name').set(localName);
    await roomRef.update({ waitingForJoin: false });
  } else {
    // creator sets their own name in db
    await roomRef.child('players').child('p1').child('name').set(localName);
  }

  if(unsub) unsub();
  unsub = roomRef.on('value', snapshot => {
    localState = snapshot.val();
    if(!localState) return;
    renderStateToUI(localState);
  });

  // Fade out the menu then show the game area
  try{ document.body.classList.remove('menu-visible'); }catch(e){}
  setTimeout(()=>{
    try{ document.body.classList.remove('menu-mode'); }catch(e){}
    roomInfo.classList.remove('hidden');
    gameArea.classList.remove('hidden');
    document.getElementById('room-controls')?.classList?.add('hidden');
    roomCodeDisplay.textContent = roomCode;
    playerIdDisplay.textContent = localPlayerId;
    drawBtn.disabled = false;
  }, 320);
}

// leave room
async function leaveRoom(){
  if(!roomRef) return location.reload();
  const snap = await roomRef.once('value');
  const state = snap.val();
  if(!state) return location.reload();

  if(localPlayerId === 'p1'){
    await roomRef.remove();
  } else {
    await roomRef.child('players').child('p2').set({name:'Waiting...', hand: [], lost:false});
    await roomRef.update({ waitingForJoin: true });
  }
  location.reload();
}

// Restart the game in the current room (host only / p1)
async function restartGame(){
  if(!roomRef || !roomCode) return;
  if(localPlayerId !== 'p1') return alert('Only the room creator can restart the game.');

  await transactRoom(state=>{
    // rebuild deck and redeal while preserving player names
    const deck = buildDeck();
    const takeCard = pred => {
      const idx = deck.findIndex(pred);
      if(idx===-1) return null;
      return popAt(deck, idx);
    };

    const p1 = state.players.p1 || {name:'Player1', hand:[], lost:false};
    const p2 = state.players.p2 || {name:'Waiting...', hand:[], lost:false};

    p1.hand = [];
    p2.hand = [];
    p1.lost = false; p2.lost = false;

    // give defusals
    let def = takeCard(c=>c.type==='defusal'); if(def) p1.hand.push(def);
    def = takeCard(c=>c.type==='defusal'); if(def) p2.hand.push(def);

    // deal 6 non-bomb/non-defusal
    for(let i=0;i<6;i++){
      let c = takeCard(c=>c.type!=='bomb'&&c.type!=='defusal'); if(c) p1.hand.push(c);
      c = takeCard(c=>c.type!=='bomb'&&c.type!=='defusal'); if(c) p2.hand.push(c);
    }

    if(!deck.some(c=>c.type==='bomb')) deck.push({type:'bomb',name:'bomb'});

    state.deck = deck;
    state.discard = [];
    state.discardTop = null;
    state.turn = 'p1';
    state.nextDrawExtra = 0;
    state.pendingAction = null;
    state.peek = null;
    state.players.p1 = p1;
    state.players.p2 = p2;
    state.waitingForJoin = false;
    state.started = true;
    return state;
  });
}

// ===== RENDER =====
function renderStateToUI(state){
  if(!state || !localPlayerId) return;

  const me = state.players[localPlayerId] || {hand:[]};
  const other = state.players[otherPlayerId(localPlayerId)] || {hand:[]};

  yourNameH2.textContent = (me.name || 'You') + ` (${localPlayerId})`;
  opponentNameH2.textContent = (other.name || 'Opponent') + ` (${otherPlayerId(localPlayerId)})`;

  // opponent hand (masked) — ensure the hand container is visible and render masked cards using the card back art
  if(opponentHandDiv) opponentHandDiv.classList.remove('hidden');
  opponentHandDiv.innerHTML = '';
  const oppHandCount = (other.hand||[]).length;
  for(let i=0;i<oppHandCount;i++){
    const c = document.createElement('div');
    c.className = 'card small';
    // set the back-of-card image (preserve inner children like deck count elsewhere)
    setBackgroundImageIfExists(c, 'BackofCard');
    opponentHandDiv.appendChild(c);
  }

  // deck visual: show back-of-card art on the deck element (preserve the count span)
  if(deckDiv){
    if((state.deck||[]).length > 0){
      setBackgroundImageIfExists(deckDiv, 'BackofCard');
    } else {
      deckDiv.style.backgroundImage = 'none';
    }
  }

  // your hand
  yourHandDiv.innerHTML = '';
  (me.hand||[]).forEach((card, idx)=>{
    const el = makeCardElement(card, idx);
    yourHandDiv.appendChild(el);
  });

  // deck count
  deckCountSpan.textContent = (state.deck||[]).length;

  // discard top: prefer discardTop key if present
  if(state.discardTop){
    const top = state.discardTop;
    // try to set an image; if not found, fall back to text
    setCardImage(discardTop, (top.name||top.type), top.name||top.type);
  } else if(state.discard && state.discard.length){
    const last = state.discard[state.discard.length-1];
    setCardImage(discardTop, (last.name||last.type), last.name||last.type);
  } else {
    discardTop.textContent = '—';
    discardTop.style.backgroundImage = 'none';
  }

  // toast / transient lastEvent display (show for 5s)
  const toast = document.getElementById('toast');
  if(state.lastEvent && (Date.now() - (state.lastEvent.ts || 0) < 5000)){
    if(toast){ toast.classList.remove('hidden'); toast.textContent = state.lastEvent.msg || ''; }
  } else {
    if(toast){ toast.classList.add('hidden'); toast.textContent = ''; }
  }

  // status / turn
  if(state.turn === localPlayerId) statusDiv.textContent = 'Your turn';
  else statusDiv.textContent = `Waiting for opponent (${state.turn})`;

  // nope indicator - renderStateToUI leaves content management to waitForNopeWindow
  if(!state.pendingAction){
    // clear any running interval
    if(_nopeInterval){ clearInterval(_nopeInterval); _nopeInterval = null; }
    nopeIndicator.style.display = 'none';
    nopeIndicator.innerHTML = '';
  } else {
    // show progress bar derived from pendingAction.ts so all clients see the same timer
    const startTs = state.pendingAction.ts || 0;
    const elapsed = Date.now() - startTs;
    const remaining = Math.max(0, NOPE_WINDOW - elapsed);
    const pct = Math.min(100, Math.round((elapsed/NOPE_WINDOW)*100));
    nopeIndicator.style.display = 'block';
    nopeIndicator.innerHTML = '<div class="nope-progress"><div class="bar"></div></div>';
    const bar = nopeIndicator.querySelector('.bar');
    if(bar) bar.style.width = pct+'%';
    if(_nopeInterval) clearInterval(_nopeInterval);
    // update smoothly until the remaining time elapses
    const step = 50;
    _nopeInterval = setInterval(()=>{
      const e = Date.now() - startTs;
      const p = Math.min(100, Math.round((e/NOPE_WINDOW)*100));
      if(bar) bar.style.width = p+'%';
      if(e >= NOPE_WINDOW){ clearInterval(_nopeInterval); _nopeInterval = null; }
    }, step);
  }

  // future peek
  futureCardsDiv.innerHTML = '';
  if(state.peek && state.peek.by === localPlayerId){
    (state.peek.cards||[]).forEach(c=>{
      const div=document.createElement('div'); div.className='card small'; div.textContent=c.name; futureCardsDiv.appendChild(div);
    });
  }
}

function makeCardElement(card, idx){
  const d = document.createElement('div'); d.className='card'; d.dataset.index = idx;
  const displayName = (card.name || card.type || 'card');
  // use the card image as the background (file should be assets/<cardName>.png)
  // remove visible text (art contains the label). Try to set an image and fall back to text if not found.
  d.textContent = '';
  setCardImage(d, (card.name||card.type), displayName);
  d.title = `${displayName} (${card.type})`;
  // show small type label
  const sub = document.createElement('div'); sub.className='sub'; sub.textContent = card.type;
  d.appendChild(sub);
  // set data attributes for optional CSS hooks
  if(card.name) d.dataset.card = card.name;
  if(card.type) d.dataset.type = card.type;
  // enable drag/drop reordering of your hand
  // enable drag/drop reordering of your hand (desktop drag) and touch/long-press reordering on mobile
  d.draggable = true;
  d.addEventListener('dragstart', e=>{ try{ e.dataTransfer.setData('text/plain', idx); }catch(err){} });
  d.addEventListener('dragover', e=>{ e.preventDefault(); });
  d.addEventListener('drop', async e=>{
    e.preventDefault();
    const from = parseInt(e.dataTransfer.getData('text/plain'),10);
    const to = Array.from(yourHandDiv.children).indexOf(d);
    if(!isNaN(from) && to!==from){
      await reorderHand(from, to);
    }
  });

  // Touch / long-press drag support for mobile: long-press to start drag and then move to reorder
  // We use touch events and a short long-press so normal taps and scrolling still work.
  d.addEventListener('touchstart', onTouchStart, { passive: true });
  d.addEventListener('touchmove', onTouchMove, { passive: false });
  d.addEventListener('touchend', onTouchEnd, { passive: true });
  d.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return d;

  function onTouchStart(ev){
    if(!ev.touches || ev.touches.length===0) return;
    const t = ev.touches[0];
    startLongPress(t.clientX, t.clientY, d, idx);
  }
  function onTouchMove(ev){
    if(!ev.touches || ev.touches.length===0) return;
    const t = ev.touches[0];
    if(!_dragState || !_dragState.active){
      // if movement exceeds threshold, cancel long-press and allow scrolling
      const s = _dragState && _dragState.startPoint;
      if(s && Math.hypot(t.clientX - s.x, t.clientY - s.y) > 10){
        cancelLongPress();
      }
      return;
    }
    // when dragging, prevent scroll and move the clone
    ev.preventDefault();
    moveDrag(t.clientX, t.clientY);
  }
  function onTouchEnd(ev){
    cancelLongPress();
    if(_dragState && _dragState.active){
      const last = (ev.changedTouches && ev.changedTouches[0]) || {};
      endDrag(last.clientX || _dragState.clientX, last.clientY || _dragState.clientY);
    }
  }
}

// Reorder the current player's hand (transactional)
async function reorderHand(fromIdx, toIdx){
  if(!roomCode) return;
  await transactRoom(state=>{
    const p = state.players && state.players[localPlayerId];
    if(!p || !Array.isArray(p.hand)) return state;
    if(fromIdx<0||fromIdx>=p.hand.length||toIdx<0||toIdx>p.hand.length) return state;
    const item = p.hand.splice(fromIdx,1)[0];
    p.hand.splice(toIdx,0,item);
    return state;
  });
}

// --- Drag state and helpers (for touch reordering) ---
let _dragState = null; // { active, fromIdx, placeholder, clone, startPoint, clientX, clientY, cardEl }
function startLongPress(clientX, clientY, cardEl, idx){
  cancelLongPress();
  _dragState = { active: false, longPressTimer: null, startPoint: { x: clientX, y: clientY }, cardEl, fromIdx: idx };
  _dragState.longPressTimer = setTimeout(()=>{ beginDrag(clientX, clientY); }, 220);
}
function cancelLongPress(){
  if(!_dragState) return;
  if(_dragState.longPressTimer){ clearTimeout(_dragState.longPressTimer); _dragState.longPressTimer = null; }
  if(_dragState && !_dragState.active){ _dragState = null; }
}
function beginDrag(clientX, clientY){
  if(!_dragState) return;
  const { cardEl, fromIdx } = _dragState;
  const rect = cardEl.getBoundingClientRect();
  const clone = cardEl.cloneNode(true);
  clone.classList.add('drag-clone');
  clone.style.width = rect.width + 'px';
  clone.style.height = rect.height + 'px';
  clone.style.left = clientX + 'px';
  clone.style.top = clientY + 'px';
  document.body.appendChild(clone);
  const placeholder = document.createElement('div'); placeholder.className = 'card placeholder';
  placeholder.style.width = rect.width + 'px'; placeholder.style.height = rect.height + 'px';
  const hand = yourHandDiv;
  const children = Array.from(hand.children);
  const anchor = children[fromIdx] || null;
  if(anchor) hand.insertBefore(placeholder, anchor.nextSibling);
  else hand.appendChild(placeholder);
  cardEl.style.visibility = 'hidden';
  _dragState.active = true;
  _dragState.clone = clone;
  _dragState.placeholder = placeholder;
  _dragState.clientX = clientX;
  _dragState.clientY = clientY;
  moveDrag(clientX, clientY);
  document.body.style.userSelect = 'none';
}
function moveDrag(clientX, clientY){
  if(!_dragState || !_dragState.active) return;
  _dragState.clientX = clientX; _dragState.clientY = clientY;
  const c = _dragState.clone;
  if(c){ c.style.left = clientX + 'px'; c.style.top = clientY + 'px'; }
  const hand = yourHandDiv;
  const kids = Array.from(hand.children).filter(n=>!n.classList.contains('drag-clone'));
  let toIdx = kids.length - 1;
  for(let i=0;i<kids.length;i++){
    const r = kids[i].getBoundingClientRect();
    const midx = r.left + r.width/2;
    if(clientX < midx){ toIdx = i; break; }
  }
  const placeholder = _dragState.placeholder;
  if(placeholder && placeholder.parentNode){
    const target = kids[toIdx];
    if(target && target !== placeholder){ placeholder.parentNode.insertBefore(placeholder, target); }
    else if(!target){ placeholder.parentNode.appendChild(placeholder); }
  }
}
async function endDrag(clientX, clientY){
  if(!_dragState) return;
  const fromIdx = _dragState.fromIdx;
  const hand = yourHandDiv;
  const kids = Array.from(hand.children).filter(n=>!n.classList.contains('drag-clone'));
  const toIdx = kids.indexOf(_dragState.placeholder);
  if(_dragState.clone && _dragState.clone.parentNode) _dragState.clone.parentNode.removeChild(_dragState.clone);
  if(_dragState.placeholder && _dragState.placeholder.parentNode) _dragState.placeholder.parentNode.removeChild(_dragState.placeholder);
  if(_dragState.cardEl) _dragState.cardEl.style.visibility = '';
  document.body.style.userSelect = '';
  const old = _dragState;
  _dragState = null;
  if(!isNaN(fromIdx) && toIdx !== -1 && toIdx !== fromIdx){
    await reorderHand(fromIdx, toIdx);
  }
}

// Try to set a card image on element by probing common filename casings
function setCardImage(el, name, fallbackText){
  if(!el) return;
  el.style.backgroundImage = '';
  el.textContent = '';
  const candidates = [];
  if(!name) name = '';
  candidates.push(name);
  // capitalize first letter (Defusal.png)
  if(name.length) candidates.push(name.charAt(0).toUpperCase()+name.slice(1));
  // lower-case
  candidates.push(name.toLowerCase());
  // upper-case first + lower rest
  if(name.length) candidates.push(name.charAt(0).toUpperCase()+name.slice(1).toLowerCase());

  // remove duplicates
  const uniq = [...new Set(candidates.filter(Boolean))];

  // try each candidate by creating an Image object
  let found = false;
  uniq.forEach(cand=>{
    const img = new Image();
    img.onload = ()=>{
      if(found) return;
      found = true;
      el.style.backgroundImage = `url('assets/${cand}.png')`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.textContent = '';
    };
    img.onerror = ()=>{
      // not found: if last candidate and none found, show fallback text
      // we'll check after a small delay via microtask — but simpler: if this is last candidate and not found, set text
      const last = uniq[uniq.length-1] === cand;
      if(last && !found){
        el.style.backgroundImage = 'none';
        el.textContent = fallbackText || '';
      }
    };
    img.src = `assets/${cand}.png`;
  });
}

// Like setCardImage but only sets the element's background image (preserves children/text)
function setBackgroundImageIfExists(el, name){
  if(!el) return;
  const candidates = [];
  if(!name) name = '';
  candidates.push(name);
  if(name.length) candidates.push(name.charAt(0).toUpperCase()+name.slice(1));
  candidates.push(name.toLowerCase());
  if(name.length) candidates.push(name.charAt(0).toUpperCase()+name.slice(1).toLowerCase());
  const uniq = [...new Set(candidates.filter(Boolean))];
  let found = false;
  uniq.forEach(cand=>{
    const img = new Image();
    img.onload = ()=>{
      if(found) return;
      found = true;
      el.style.backgroundImage = `url('assets/${cand}.png')`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    };
    img.onerror = ()=>{
      // if last and none found, clear background
      const last = uniq[uniq.length-1] === cand;
      if(last && !found){ el.style.backgroundImage = 'none'; }
    };
    img.src = `assets/${cand}.png`;
  });
}

// ===== FLASH INVALID
function flashInvalid(){
  yourHandDiv.classList.add('invalid');
  setTimeout(()=>yourHandDiv.classList.remove('invalid'), 350);
}

// ===== CARD CLICK HANDLER =====
// Handle clicks on card elements. Routes to the appropriate action/play function.
async function onCardClicked(card, idx){
  console.log('card clicked', card, idx);
  if(!card) return;
  // If it's a combo card, attempt combo play
  if(card.type === 'combo'){
    // playCombo will validate two-of-a-kind etc.
    await playCombo(card.name);
    return;
  }

  // Action cards
  if(card.type === 'action' || isActionName(card.name)){
    switch(card.name){
      case 'nope':
        // Trying to play a nope directly — call pushNope (it will validate availability)
        await pushNope();
        break;
      case 'skip':
        await playSkip();
        break;
      case 'attack':
        await playAttack();
        break;
      case 'shuffle':
        await playShuffle();
        break;
      case 'future':
        await playFuture();
        break;
      case 'favour':
        await playFavour();
        break;
      default:
        console.warn('Unhandled action card', card.name);
        flashInvalid();
    }
    return;
  }

  // defusal and bombs are not playable as actions
  flashInvalid();
}

// ===== TRANSACTION WRAPPER =====
async function transactRoom(mutator){
  if(!roomCode) { console.error('no roomCode in transactRoom'); return; }
  const ref = db.ref('rooms/'+roomCode);
  await ref.transaction(current => {
    if(!current) return current;
    // mutate the state directly (Firebase wants returned value)
    const next = mutator(current);
    return next;
  });
}

// ===== NOPE HANDLING =====
function waitForNopeWindow(){
  // This function only waits the server-side window; UI progress is rendered by renderStateToUI
  return new Promise(resolve=>{
    setTimeout(async ()=>{
      const snap = await db.ref('rooms/'+roomCode).once('value');
      const s = snap.val();
      resolve(!s.pendingAction);
    }, NOPE_WINDOW);
  });
}

async function pushNope(){
  await transactRoom(state=>{
    if(!state.pendingAction) return state;
    if(state.pendingAction.by === localPlayerId) return state; // can't nope your own action
    const p = state.players[localPlayerId];
    const idx = p.hand.findIndex(c=>c.name==='nope');
    if(idx===-1) return state; // no nope to play

    // Do NOT restore previously played cards — they were played and remain on the discard.
    // Just remove the NOPE from the current player's hand and push it to discard so it ends up on top.
    const playedNope = p.hand.splice(idx,1)[0];
    setTopDiscard(state, playedNope, { by: localPlayerId });

    // cancel pending action (action remains resolved as noped)
    state.pendingAction = null;
    return state;
  });
}

// ===== ACTIONS =====

// Combo: spend two identical combo cards -> steals blind from opponent (choose position)
async function playCombo(name){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const p = state.players[localPlayerId];
    const idx1 = p.hand.findIndex(c=>c.name===name);
    const idx2 = p.hand.findIndex((c,i)=>c.name===name && i!==idx1);
    if(idx1===-1 || idx2===-1) return state;

    // remove both cards and push to discard
    const firstIdx = Math.min(idx1, idx2);
    const secondIdx = Math.max(idx1, idx2);
    const c2 = p.hand.splice(secondIdx,1)[0];
    const c1 = p.hand.splice(firstIdx,1)[0];
    setTopDiscard(state, c1, { by: localPlayerId });
    setTopDiscard(state, c2, { by: localPlayerId });
    
    // record what was played so we can restore if NOPE cancels it
    state.pendingAction = { type:'combo', by: localPlayerId, payload: { name }, played: [c1, c2], discardCount: 2, ts: Date.now() };
    return state;
  });

  const wasNooped = await waitForNopeWindow();
  if(wasNooped){
    alert('Your combo was noped!');
    await transactRoom(s=>{ s.pendingAction = null; return s; });
    return;
  }

  // blind pick by position (no peeking)
  const other = otherPlayerId(localPlayerId);
  const oppHand = (localState.players && localState.players[other] && localState.players[other].hand) || [];
  if(oppHand.length === 0){
    await transactRoom(s=>{ s.pendingAction = null; return s; });
    return;
  }

  const choice = prompt(`Choose a position (1-${oppHand.length}) to take from opponent (blind).`);
  const pos = parseInt(choice,10)-1;
  if(isNaN(pos) || pos<0 || pos>=oppHand.length){
    await transactRoom(s=>{ s.pendingAction = null; return s; });
    return;
  }

  await transactRoom(state=>{
    const opp = state.players[other];
    const taken = opp.hand.splice(pos,1)[0];
    state.players[localPlayerId].hand.push(taken);
  // record discard as resolved: show the combo card image (the one played) rather than the taken card
  setTopDiscard(state, { type: 'combo', name }, { by: localPlayerId });
    state.pendingAction = null;
    return state;
  });

  alert('Combo resolved (card taken).');
}

// Skip: play skip -> subject to nope -> pass turn without drawing
async function playSkip(){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const p = state.players[localPlayerId];
    const idx = p.hand.findIndex(c=>c.name==='skip');
    if(idx===-1) return state;
    const played = p.hand.splice(idx,1)[0];
    setTopDiscard(state, played, { by: localPlayerId });
    // store played card so it can be returned if noped
    state.pendingAction = { type:'skip', by: localPlayerId, played, discardCount: 1, ts: Date.now() };
    return state;
  });

  const wasNooped = await waitForNopeWindow();
  await transactRoom(state=>{
    if(wasNooped){
      state.pendingAction = null;
      alert('Skip was noped. Your turn continues.');
      return state;
    }
    state.pendingAction = null;
    state.turn = otherPlayerId(localPlayerId);
    return state;
  });
}

// Attack: play attack -> subject to nope -> pass turn and give opponent +2 draws (nextDrawExtra)
async function playAttack(){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const p = state.players[localPlayerId];
    const idx = p.hand.findIndex(c=>c.name==='attack');
    if(idx===-1) return state;
    const played = p.hand.splice(idx,1)[0];
    setTopDiscard(state, played, { by: localPlayerId });
    state.pendingAction = { type:'attack', by: localPlayerId, played, discardCount: 1, ts: Date.now() };
    return state;
  });

  const wasNooped = await waitForNopeWindow();
  await transactRoom(state=>{
    if(wasNooped){
      state.pendingAction = null;
      alert('Attack was noped. Your turn continues.');
      return state;
    }
    state.nextDrawExtra = (state.nextDrawExtra||0) + 2; // will apply to the next player when they draw
    state.pendingAction = null;
    state.turn = otherPlayerId(localPlayerId);
    return state;
  });
}

// Shuffle: shuffle deck
async function playShuffle(){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const p = state.players[localPlayerId];
    const idx = p.hand.findIndex(c=>c.name==='shuffle');
    if(idx===-1) return state;
    const played = p.hand.splice(idx,1)[0];
    setTopDiscard(state, played, { by: localPlayerId });
    state.pendingAction = { type:'shuffle', by: localPlayerId, played, discardCount: 1, ts: Date.now() };
    return state;
  });

  const wasNooped = await waitForNopeWindow();
  await transactRoom(state=>{
    if(wasNooped){ state.pendingAction = null; alert('Shuffle was noped.'); return state; }
    state.deck = shuffle(state.deck || []);
    state.pendingAction = null;
    return state;
  });
}

// Future: peek top 3 cards (stored in state.peek with short timestamp)
async function playFuture(){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const p = state.players[localPlayerId];
    const idx = p.hand.findIndex(c=>c.name==='future');
    if(idx===-1) return state;
    const played = p.hand.splice(idx,1)[0];
    setTopDiscard(state, played, { by: localPlayerId });
    state.pendingAction = { type:'future', by: localPlayerId, played, discardCount: 1, ts: Date.now() };
    return state;
  });

  const wasNooped = await waitForNopeWindow();
  await transactRoom(state=>{
    if(wasNooped){ state.pendingAction = null; alert('Future was noped.'); return state; }
    state.peek = { by: localPlayerId, cards: (state.deck||[]).slice(0,3), ts: Date.now() };
    state.pendingAction = null;
    return state;
  });
}

// Favour: opponent must give one card of their choice
async function playFavour(){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const p = state.players[localPlayerId];
    const idx = p.hand.findIndex(c=>c.name==='favour');
    if(idx===-1) return state;
    const played = p.hand.splice(idx,1)[0];
    setTopDiscard(state, played, { by: localPlayerId });
    state.pendingAction = { type:'favour', by: localPlayerId, played, discardCount: 1, ts: Date.now() };
    return state;
  });

  const wasNooped = await waitForNopeWindow();
  await transactRoom(state=>{
    if(wasNooped){ state.pendingAction = null; alert('Favour was noped.'); return state; }
    // leave pendingAction so opponent can give card
    return state;
  });

  statusDiv.textContent = 'Waiting for opponent to give a card';
}

// give card for favour (opponent calls this by clicking a card in their hand)
async function giveCardToPlayer(targetPlayerId, cardIdx){
  await transactRoom(state=>{
    if(!state.pendingAction || state.pendingAction.type!=='favour') return state;
    if(state.pendingAction.by === localPlayerId) return state; // actor can't give
    const me = state.players[localPlayerId];
    if(cardIdx<0 || cardIdx>=me.hand.length) return state;
    const moved = me.hand.splice(cardIdx,1)[0];
    state.players[state.pendingAction.by].hand.push(moved);
    state.pendingAction = null;
    return state;
  });
}

// ===== DRAW =====
async function drawCard(){
  await transactRoom(state=>{
    if(state.turn !== localPlayerId) return state;
    const p = state.players[localPlayerId];
    const deck = state.deck || [];
    let draws = 1 + (state.nextDrawExtra || 0);
    state.nextDrawExtra = 0;

    for(let i=0;i<draws;i++){
      if(deck.length === 0) continue;
      const top = deck.shift();
      if(top.type === 'bomb'){
        // check for defusal in hand
        const defIdx = p.hand.findIndex(c=>c.type==='defusal' || c.name==='defusal');
        if(defIdx !== -1){
          // use defusal: remove from hand and shuffle bomb back
          p.hand.splice(defIdx,1);
          const pos = Math.floor(Math.random()*(deck.length+1));
          deck.splice(pos,0, top);
          // show the defusal art when a bomb is defused
          setTopDiscard(state, { type:'defusal', name:'defusal' }, { by: localPlayerId });
            state.lastEvent = { type: 'defused', by: localPlayerId, msg: `${(state.players && state.players[localPlayerId] && state.players[localPlayerId].name) || localPlayerId} drew a bomb but used a defusal!`, ts: Date.now() };
          // optional: give notification on client
          // alert('Bomb drawn! Defusal used and bomb reinserted.');
        }else{
          // exploded
          p.lost = true;
          // show the actual bomb card in the discard so Bomb.png is displayed
          setTopDiscard(state, top, { by: localPlayerId });
          // add a transient lastEvent so UI can show a message
          state.lastEvent = { type: 'bomb', by: localPlayerId, msg: `${(state.players && state.players[localPlayerId] && state.players[localPlayerId].name) || localPlayerId} drew a bomb!`, ts: Date.now() };
          // do NOT remove other player's cards here; remote clients can detect lost flag
        }
      } else {
        p.hand.push(top);
      }
    }

    if(!p.lost){
      state.turn = otherPlayerId(localPlayerId);
    }
    if(state.peek && Date.now() - (state.peek.ts||0) > 5000) delete state.peek;
    // ensure deck saved
    state.deck = deck;
    return state;
  });
}

// ===== UI - initial listener example (auto sync) =====
// When you join a room, the joinRoom function sets up the on('value') listener to call renderStateToUI.
// If you want extra behavior on update, you can add it in renderStateToUI or here.

// End of script.js
