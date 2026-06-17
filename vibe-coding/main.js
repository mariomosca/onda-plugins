/**
 * VibeCoding — play arcade games while your AI agents work.
 *
 * An interactive-panel plugin. The panel is a sandboxed <iframe> (capability
 * `panel:interactive`) whose srcDoc is a full self-contained HTML document with
 * three canvas games: Snake, Tetris, Pong. The plugin Worker subscribes to the
 * `aiStatus` capability and drives a pause/recall protocol over the postMessage
 * bridge:
 *
 *   Worker -> iframe : api.panel.postMessage('game', {type, ...})
 *                      (relayed verbatim; iframe gets it as window 'message' e.data)
 *   iframe -> Worker : window.parent.postMessage({type, ...}, '*')
 *                      (relayed verbatim; Worker gets it via api.panel.onMessage(data))
 *
 * Pause rule (the core):
 *   - >=1 session WAITING  -> {type:'recall', ...}  iframe pauses + recall overlay
 *   - 0 waiting & >=1 busy  -> {type:'resume'}       game resumes
 *   - all idle (no busy/wait)-> {type:'idle'}         free play, no forced pause
 *
 * High scores persist per game via api.storage.
 *
 * No npm deps — classic Worker, matches the style of team-panel / variable-replacer.
 */

self.__ondaPlugin = {
  async onActivate(api) {
    const PANEL_ID = 'game';
    const STORAGE_KEY = 'vibe-coding.highscores';

    // ──────────────────────────────────────────────────────────────
    // The game document (srcDoc for the sandboxed iframe).
    // Built as an array joined with '\n' so we never embed a raw backtick
    // inside a Worker-level template literal (keeps `node --check` happy and
    // avoids ${} interpolation surprises). The document itself is plain HTML
    // + inline <script>; it uses no external resources.
    // ──────────────────────────────────────────────────────────────
    function gameDocument(highscores) {
      const HS = JSON.stringify(highscores || {});
      const lines = [
        '<!doctype html>',
        '<html><head><meta charset="utf-8">',
        '<style>',
        '  * { box-sizing: border-box; }',
        '  html, body { margin:0; padding:0; height:100%; }',
        '  body {',
        '    background:#0a0a0b; color:#e4e4e7;',
        '    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
        '    overflow:hidden; user-select:none;',
        '  }',
        '  #root { display:flex; flex-direction:column; height:100vh; }',
        '  .hud {',
        '    display:flex; align-items:center; gap:12px;',
        '    padding:8px 12px; font-size:12px; color:#a1a1aa;',
        '    border-bottom:1px solid #1f1f23; flex-shrink:0;',
        '  }',
        '  .hud .title { color:#34d399; font-weight:600; letter-spacing:0.04em; }',
        '  .hud .score { color:#e4e4e7; }',
        '  .hud .hs { color:#fbbf24; }',
        '  .hud .spacer { flex:1; }',
        '  .hud .hint { color:#52525b; font-size:10px; }',
        '  #stage { position:relative; flex:1; min-height:0; display:flex; align-items:center; justify-content:center; }',
        '  canvas { display:block; background:#08080a; }',
        '  /* Hub */',
        '  #hub { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; height:100%; padding:20px; }',
        '  #hub h1 { margin:0; font-size:22px; color:#34d399; letter-spacing:0.06em; }',
        '  #hub .sub { color:#71717a; font-size:12px; margin-top:-8px; text-align:center; line-height:1.5; }',
        '  .games { display:flex; flex-direction:column; gap:10px; width:100%; max-width:280px; }',
        '  .game-btn {',
        '    display:flex; align-items:center; gap:12px;',
        '    background:#141417; border:1px solid #27272a; border-radius:10px;',
        '    padding:14px 16px; cursor:pointer; transition:all 120ms;',
        '    color:#e4e4e7; font-size:14px; font-family:inherit;',
        '  }',
        '  .game-btn:hover, .game-btn.sel { background:#1c1c20; border-color:#34d399; transform:translateX(2px); }',
        '  .game-btn .ico { font-size:20px; }',
        '  .game-btn .meta { flex:1; display:flex; flex-direction:column; gap:2px; text-align:left; }',
        '  .game-btn .meta .nm { font-weight:600; }',
        '  .game-btn .meta .ds { font-size:10px; color:#71717a; }',
        '  .game-btn .best { font-size:10px; color:#fbbf24; }',
        '  /* Overlay */',
        '  #overlay {',
        '    position:absolute; inset:0; display:none;',
        '    flex-direction:column; align-items:center; justify-content:center; gap:16px;',
        '    background:rgba(5,5,7,0.92); backdrop-filter:blur(2px); text-align:center; padding:24px;',
        '    z-index:10;',
        '  }',
        '  #overlay.show { display:flex; }',
        '  #overlay .big { font-size:18px; font-weight:700; }',
        '  #overlay .desc { font-size:12px; color:#a1a1aa; line-height:1.5; max-width:320px; }',
        '  #overlay .pulse { color:#34d399; }',
        '  #overlay .recall { color:#f59e0b; }',
        '  #overlay button {',
        '    font-family:inherit; font-size:13px; cursor:pointer;',
        '    background:#34d399; color:#062b20; border:0; border-radius:8px;',
        '    padding:10px 18px; font-weight:600;',
        '  }',
        '  #overlay button.ghost { background:transparent; color:#a1a1aa; border:1px solid #3f3f46; }',
        '  #overlay .btns { display:flex; gap:10px; flex-wrap:wrap; justify-content:center; }',
        '  .status-chip {',
        '    font-size:10px; padding:2px 8px; border-radius:9px; border:1px solid #27272a; color:#71717a;',
        '  }',
        '  .status-chip.busy { color:#60a5fa; border-color:#60a5fa55; }',
        '  .status-chip.wait { color:#f59e0b; border-color:#f59e0b55; }',
        '  .status-chip.idle { color:#52525b; }',
        '</style></head>',
        '<body>',
        '<div id="root">',
        '  <div class="hud">',
        '    <span class="title">VIBE</span>',
        '    <span id="hud-game"></span>',
        '    <span class="score" id="hud-score"></span>',
        '    <span class="hs" id="hud-hs"></span>',
        '    <span class="spacer"></span>',
        '    <span class="status-chip idle" id="hud-status">idle</span>',
        '    <span class="hint" id="hud-hint"></span>',
        '  </div>',
        '  <div id="stage">',
        '    <div id="hub">',
        '      <h1>VIBE CODING</h1>',
        '      <div class="sub">Kill time while the agents grind.<br>Pauses itself when a session needs you.</div>',
        '      <div class="games" id="games"></div>',
        '    </div>',
        '    <canvas id="cv" width="440" height="440" style="display:none"></canvas>',
        '    <div id="overlay">',
        '      <div class="big" id="ov-title"></div>',
        '      <div class="desc" id="ov-desc"></div>',
        '      <div class="btns" id="ov-btns"></div>',
        '    </div>',
        '  </div>',
        '</div>',
        '<script>',
        '(function(){',
        '  "use strict";',
        '  var HS = ' + HS + ';',
        '  var bridge = {',
        '    send: function(obj){ try { window.parent.postMessage(obj, "*"); } catch(e){} },',
        '    saveScore: function(game, score){ this.send({type:"score", game:game, score:score}); }',
        '  };',
        '',
        '  // DOM refs',
        '  var stage = document.getElementById("stage");',
        '  var hub = document.getElementById("hub");',
        '  var cv = document.getElementById("cv");',
        '  var ctx = cv.getContext("2d");',
        '  var overlay = document.getElementById("overlay");',
        '  var ovTitle = document.getElementById("ov-title");',
        '  var ovDesc = document.getElementById("ov-desc");',
        '  var ovBtns = document.getElementById("ov-btns");',
        '  var hudGame = document.getElementById("hud-game");',
        '  var hudScore = document.getElementById("hud-score");',
        '  var hudHs = document.getElementById("hud-hs");',
        '  var hudHint = document.getElementById("hud-hint");',
        '  var hudStatus = document.getElementById("hud-status");',
        '  var gamesEl = document.getElementById("games");',
        '',
        '  // ── External (AI) pause state, driven by parent via postMessage ──',
        '  var forcedPause = false;        // true when a session is waiting (recall)',
        '  var manualPause = false;        // P key',
        '  var aiState = "idle";           // idle | busy | waiting',
        '  var lastRecall = null;          // {tool, terminalId, waitingCount}',
        '',
        '  var GAMES = [',
        '    {id:"snake",  name:"Snake",  ico:"\\uD83D\\uDC0D", desc:"arrows / WASD"},',
        '    {id:"tetris", name:"Tetris", ico:"\\uD83E\\uDDF1", desc:"\\u2190\\u2192 move \\u2191 rotate \\u2193 drop"},',
        '    {id:"pong",   name:"Pong",   ico:"\\uD83C\\uDFD3", desc:"\\u2191\\u2193 / mouse vs CPU"}',
        '  ];',
        '',
        '  var current = null;   // active game controller or null (hub)',
        '  var rafId = null;',
        '',
        '  function hs(id){ return HS[id] || 0; }',
        '  function setHs(id, v){ if(v > hs(id)){ HS[id]=v; bridge.saveScore(id, v); } }',
        '',
        '  function updateStatusChip(){',
        '    hudStatus.className = "status-chip " + (aiState==="busy"?"busy":aiState==="waiting"?"wait":"idle");',
        '    hudStatus.textContent = aiState;',
        '  }',
        '',
        '  // ── Overlay helpers ──',
        '  function showOverlay(opts){',
        '    ovTitle.innerHTML = opts.title || "";',
        '    ovDesc.innerHTML = opts.desc || "";',
        '    ovBtns.innerHTML = "";',
        '    (opts.buttons || []).forEach(function(b){',
        '      var el = document.createElement("button");',
        '      el.textContent = b.label;',
        '      if(b.ghost) el.className = "ghost";',
        '      el.onclick = b.onClick;',
        '      ovBtns.appendChild(el);',
        '    });',
        '    overlay.classList.add("show");',
        '  }',
        '  function hideOverlay(){ overlay.classList.remove("show"); }',
        '',
        '  function isPaused(){ return forcedPause || manualPause; }',
        '',
        '  function refreshOverlay(){',
        '    if(!current){ hideOverlay(); return; }',
        '    if(forcedPause){',
        '      var who = lastRecall && lastRecall.tool ? lastRecall.tool : "A session";',
        '      var n = lastRecall && lastRecall.waitingCount ? lastRecall.waitingCount : 1;',
        '      showOverlay({',
        '        title: "<span class=\\"recall\\">\\u25B8 " + esc(who) + " is waiting for you</span>",',
        '        desc: (n>1 ? (n + " sessions are") : "A session is") + " waiting for input. Game paused.",',
        '        buttons: [',
        '          { label:"Back to terminal", onClick:function(){ bridge.send({type:"focusTerminal", terminalId: lastRecall?lastRecall.terminalId:null}); } }',
        '        ]',
        '      });',
        '    } else if(manualPause){',
        '      showOverlay({',
        '        title:"Paused",',
        '        desc:"Press P to resume \\u00B7 ESC for hub",',
        '        buttons:[{ label:"Resume", onClick:function(){ manualPause=false; refreshOverlay(); } }]',
        '      });',
        '    } else {',
        '      hideOverlay();',
        '    }',
        '  }',
        '',
        '  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;"); }',
        '',
        '  // ── Game loop scaffold ──',
        '  function startLoop(){',
        '    if(rafId) cancelAnimationFrame(rafId);',
        '    var last = performance.now();',
        '    function frame(now){',
        '      rafId = requestAnimationFrame(frame);',
        '      var dt = Math.min(100, now - last); last = now;',
        '      if(current){',
        '        if(!isPaused()){ current.update(dt); }',
        '        current.render();',
        '      }',
        '    }',
        '    rafId = requestAnimationFrame(frame);',
        '  }',
        '  function stopLoop(){ if(rafId){ cancelAnimationFrame(rafId); rafId=null; } }',
        '',
        '  function setHud(name, score){',
        '    hudGame.textContent = name || "";',
        '    hudScore.textContent = score!=null ? ("score " + score) : "";',
        '    hudHs.textContent = current ? ("best " + hs(current.id)) : "";',
        '    hudHint.textContent = current ? "P pause \\u00B7 ESC hub" : "";',
        '  }',
        '',
        '  // ── Hub ──',
        '  function renderHub(){',
        '    gamesEl.innerHTML = "";',
        '    GAMES.forEach(function(g){',
        '      var b = document.createElement("button");',
        '      b.className = "game-btn";',
        '      b.innerHTML = "<span class=\\"ico\\">"+g.ico+"</span>"',
        '        + "<span class=\\"meta\\"><span class=\\"nm\\">"+g.name+"</span><span class=\\"ds\\">"+g.desc+"</span></span>"',
        '        + "<span class=\\"best\\">best "+hs(g.id)+"</span>";',
        '      b.onclick = function(){ launch(g.id); };',
        '      gamesEl.appendChild(b);',
        '    });',
        '  }',
        '',
        '  function goHub(){',
        '    current = null;',
        '    stopLoop();',
        '    cv.style.display = "none";',
        '    hub.style.display = "flex";',
        '    hideOverlay();',
        '    setHud("", null);',
        '    renderHub();',
        '  }',
        '',
        '  function launch(id){',
        '    hub.style.display = "none";',
        '    cv.style.display = "block";',
        '    manualPause = false;',
        '    if(id==="snake") current = makeSnake();',
        '    else if(id==="tetris") current = makeTetris();',
        '    else if(id==="pong") current = makePong();',
        '    else { goHub(); return; }',
        '    current.id = id;',
        '    fitCanvas();',
        '    current.reset();',
        '    setHud(current.name, current.score);',
        '    refreshOverlay();',
        '    startLoop();',
        '  }',
        '',
        '  function fitCanvas(){',
        '    // Square play area that fits the stage, capped for crispness.',
        '    var w = stage.clientWidth, h = stage.clientHeight;',
        '    var size = Math.max(200, Math.min(w, h) - 8);',
        '    cv.width = size; cv.height = size;',
        '    if(current && current.onResize) current.onResize(size);',
        '  }',
        '  window.addEventListener("resize", function(){ if(current) fitCanvas(); });',
        '',
        '  // ── Input ──',
        '  var keys = {};',
        '  window.addEventListener("keydown", function(e){',
        '    var k = e.key;',
        '    if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].indexOf(k) >= 0) e.preventDefault();',
        '    if(!current) return;',
        '    if(k === "Escape"){ goHub(); return; }',
        '    if(k === "p" || k === "P"){ if(!forcedPause){ manualPause = !manualPause; refreshOverlay(); } return; }',
        '    keys[k] = true;',
        '    if(!isPaused() && current.onKey) current.onKey(k);',
        '  });',
        '  window.addEventListener("keyup", function(e){ keys[e.key] = false; });',
        '',
        '  // ════════════════════════════ SNAKE ════════════════════════════',
        '  function makeSnake(){',
        '    var GRID = 20, cell = 22, size = GRID*cell;',
        '    var snake, dir, nextDir, food, score, acc, step, dead;',
        '    function place(){',
        '      while(true){',
        '        var f = {x:(Math.random()*GRID)|0, y:(Math.random()*GRID)|0};',
        '        var hit = snake.some(function(s){ return s.x===f.x && s.y===f.y; });',
        '        if(!hit){ food = f; return; }',
        '      }',
        '    }',
        '    return {',
        '      name:"Snake", score:0, id:"snake",',
        '      onResize:function(s){ cell = Math.floor(s/GRID); size = cell*GRID; },',
        '      reset:function(){',
        '        snake = [{x:10,y:10},{x:9,y:10},{x:8,y:10}];',
        '        dir = {x:1,y:0}; nextDir = {x:1,y:0};',
        '        score = 0; this.score = 0; acc = 0; step = 130; dead = false;',
        '        place();',
        '      },',
        '      onKey:function(k){',
        '        if((k==="ArrowUp"||k==="w"||k==="W") && dir.y===0) nextDir={x:0,y:-1};',
        '        else if((k==="ArrowDown"||k==="s"||k==="S") && dir.y===0) nextDir={x:0,y:1};',
        '        else if((k==="ArrowLeft"||k==="a"||k==="A") && dir.x===0) nextDir={x:-1,y:0};',
        '        else if((k==="ArrowRight"||k==="d"||k==="D") && dir.x===0) nextDir={x:1,y:0};',
        '        else if(dead && (k===" "||k==="Enter")) this.reset();',
        '      },',
        '      update:function(dt){',
        '        if(dead) return;',
        '        acc += dt;',
        '        if(acc < step) return;',
        '        acc = 0; dir = nextDir;',
        '        var head = {x:snake[0].x+dir.x, y:snake[0].y+dir.y};',
        '        if(head.x<0||head.y<0||head.x>=GRID||head.y>=GRID || snake.some(function(s){return s.x===head.x&&s.y===head.y;})){',
        '          dead = true; setHs("snake", score); return;',
        '        }',
        '        snake.unshift(head);',
        '        if(head.x===food.x && head.y===food.y){ score += 10; this.score = score; setHud("Snake", score); if(step>60) step -= 3; place(); }',
        '        else snake.pop();',
        '      },',
        '      render:function(){',
        '        var ox = (cv.width-size)/2, oy = (cv.height-size)/2;',
        '        ctx.fillStyle = "#08080a"; ctx.fillRect(0,0,cv.width,cv.height);',
        '        ctx.strokeStyle = "#1a1a1e"; ctx.strokeRect(ox,oy,size,size);',
        '        ctx.fillStyle = "#ef4444";',
        '        ctx.fillRect(ox+food.x*cell+2, oy+food.y*cell+2, cell-4, cell-4);',
        '        for(var i=0;i<snake.length;i++){',
        '          ctx.fillStyle = i===0 ? "#34d399" : "#1f9d6f";',
        '          ctx.fillRect(ox+snake[i].x*cell+1, oy+snake[i].y*cell+1, cell-2, cell-2);',
        '        }',
        '        if(dead) banner("GAME OVER", "score " + score + " \\u00B7 SPACE to retry");',
        '      }',
        '    };',
        '  }',
        '',
        '  // ════════════════════════════ TETRIS ════════════════════════════',
        '  function makeTetris(){',
        '    var COLS = 10, ROWS = 20, cell = 20;',
        '    var SHAPES = {',
        '      I:[[1,1,1,1]], O:[[1,1],[1,1]], T:[[0,1,0],[1,1,1]],',
        '      S:[[0,1,1],[1,1,0]], Z:[[1,1,0],[0,1,1]], J:[[1,0,0],[1,1,1]], L:[[0,0,1],[1,1,1]]',
        '    };',
        '    var COLORS = {I:"#22d3ee",O:"#fbbf24",T:"#a78bfa",S:"#34d399",Z:"#ef4444",J:"#60a5fa",L:"#fb923c"};',
        '    var KEYS = Object.keys(SHAPES);',
        '    var board, cur, score, lines, acc, step, dead;',
        '    function emptyBoard(){ var b=[]; for(var y=0;y<ROWS;y++){ b.push(new Array(COLS).fill(null)); } return b; }',
        '    function spawn(){',
        '      var k = KEYS[(Math.random()*KEYS.length)|0];',
        '      var m = SHAPES[k].map(function(r){ return r.slice(); });',
        '      cur = { m:m, color:COLORS[k], x:((COLS - m[0].length)/2)|0, y:0 };',
        '      if(collide(cur.m, cur.x, cur.y)){ dead = true; setHs("tetris", score); }',
        '    }',
        '    function collide(m, px, py){',
        '      for(var y=0;y<m.length;y++) for(var x=0;x<m[y].length;x++){',
        '        if(!m[y][x]) continue;',
        '        var nx=px+x, ny=py+y;',
        '        if(nx<0||nx>=COLS||ny>=ROWS) return true;',
        '        if(ny>=0 && board[ny][nx]) return true;',
        '      }',
        '      return false;',
        '    }',
        '    function rotate(m){',
        '      var r=[]; for(var x=0;x<m[0].length;x++){ var row=[]; for(var y=m.length-1;y>=0;y--){ row.push(m[y][x]); } r.push(row); } return r;',
        '    }',
        '    function lockPiece(){',
        '      for(var y=0;y<cur.m.length;y++) for(var x=0;x<cur.m[y].length;x++){',
        '        if(cur.m[y][x] && cur.y+y>=0) board[cur.y+y][cur.x+x] = cur.color;',
        '      }',
        '      var cleared = 0;',
        '      for(var ry=ROWS-1; ry>=0; ry--){',
        '        if(board[ry].every(function(c){ return c; })){ board.splice(ry,1); board.unshift(new Array(COLS).fill(null)); cleared++; ry++; }',
        '      }',
        '      if(cleared){ lines += cleared; score += [0,100,300,500,800][cleared] || cleared*200; if(step>120) step -= cleared*8; }',
        '      spawn();',
        '    }',
        '    return {',
        '      name:"Tetris", score:0, id:"tetris",',
        '      onResize:function(s){ cell = Math.floor(Math.min(s/COLS, s/ROWS)); },',
        '      reset:function(){ board=emptyBoard(); score=0; this.score=0; lines=0; acc=0; step=600; dead=false; spawn(); },',
        '      onKey:function(k){',
        '        if(dead){ if(k===" "||k==="Enter") this.reset(); return; }',
        '        if(k==="ArrowLeft"||k==="a"||k==="A"){ if(!collide(cur.m, cur.x-1, cur.y)) cur.x--; }',
        '        else if(k==="ArrowRight"||k==="d"||k==="D"){ if(!collide(cur.m, cur.x+1, cur.y)) cur.x++; }',
        '        else if(k==="ArrowUp"||k==="w"||k==="W"){ var r=rotate(cur.m); if(!collide(r,cur.x,cur.y)) cur.m=r; else if(!collide(r,cur.x-1,cur.y)){cur.x--;cur.m=r;} else if(!collide(r,cur.x+1,cur.y)){cur.x++;cur.m=r;} }',
        '        else if(k==="ArrowDown"||k==="s"||k==="S"){ if(!collide(cur.m,cur.x,cur.y+1)){ cur.y++; acc=0; } }',
        '        else if(k===" "){ while(!collide(cur.m,cur.x,cur.y+1)) cur.y++; lockPiece(); this.score=score; setHud("Tetris", score); }',
        '      },',
        '      update:function(dt){',
        '        if(dead) return;',
        '        acc += dt;',
        '        if(acc < step) return;',
        '        acc = 0;',
        '        if(!collide(cur.m, cur.x, cur.y+1)) cur.y++;',
        '        else { lockPiece(); this.score=score; setHud("Tetris", score); }',
        '      },',
        '      render:function(){',
        '        var bw = COLS*cell, bh = ROWS*cell;',
        '        var ox = (cv.width-bw)/2, oy = (cv.height-bh)/2;',
        '        ctx.fillStyle = "#08080a"; ctx.fillRect(0,0,cv.width,cv.height);',
        '        ctx.strokeStyle = "#1a1a1e"; ctx.strokeRect(ox,oy,bw,bh);',
        '        for(var y=0;y<ROWS;y++) for(var x=0;x<COLS;x++){',
        '          if(board[y][x]){ ctx.fillStyle = board[y][x]; ctx.fillRect(ox+x*cell+1, oy+y*cell+1, cell-2, cell-2); }',
        '        }',
        '        if(!dead && cur){',
        '          ctx.fillStyle = cur.color;',
        '          for(var py=0;py<cur.m.length;py++) for(var px=0;px<cur.m[py].length;px++){',
        '            if(cur.m[py][px] && cur.y+py>=0) ctx.fillRect(ox+(cur.x+px)*cell+1, oy+(cur.y+py)*cell+1, cell-2, cell-2);',
        '          }',
        '        }',
        '        if(dead) banner("GAME OVER", "score " + score + " \\u00B7 SPACE to retry");',
        '      }',
        '    };',
        '  }',
        '',
        '  // ════════════════════════════ PONG ════════════════════════════',
        '  function makePong(){',
        '    var W=440, H=440, PW=10, PH=70, BALL=9;',
        '    var py, cy, bx, by, bvx, bvy, score, cpu, dead, win;',
        '    function resetBall(dir){',
        '      bx = W/2; by = H/2;',
        '      var sp = 4.2;',
        '      bvx = sp * (dir||1); bvy = (Math.random()*2-1)*3;',
        '    }',
        '    return {',
        '      name:"Pong", score:0, id:"pong",',
        '      onResize:function(s){ W=s; H=s; py=Math.min(py,H-PH); cy=Math.min(cy,H-PH); },',
        '      reset:function(){ py=(H-PH)/2; cy=(H-PH)/2; score=0; this.score=0; cpu=0; dead=false; win=false; resetBall(Math.random()<0.5?1:-1); },',
        '      onKey:function(k){ if(dead && (k===" "||k==="Enter")) this.reset(); },',
        '      update:function(dt){',
        '        if(dead) return;',
        '        var spd = 6 * (dt/16.6);',
        '        if(keys["ArrowUp"]||keys["w"]||keys["W"]) py -= spd;',
        '        if(keys["ArrowDown"]||keys["s"]||keys["S"]) py += spd;',
        '        py = Math.max(0, Math.min(H-PH, py));',
        '        // CPU tracks ball with a capped speed (beatable).',
        '        var target = by - PH/2;',
        '        var cspd = 3.6 * (dt/16.6);',
        '        if(cy + PH/2 < by - 6) cy += cspd; else if(cy + PH/2 > by + 6) cy -= cspd;',
        '        cy = Math.max(0, Math.min(H-PH, cy));',
        '        bx += bvx*(dt/16.6); by += bvy*(dt/16.6);',
        '        if(by<BALL){ by=BALL; bvy=Math.abs(bvy); } if(by>H-BALL){ by=H-BALL; bvy=-Math.abs(bvy); }',
        '        // Left paddle (player)',
        '        if(bx-BALL < PW && by>py && by<py+PH && bvx<0){',
        '          bvx = -bvx*1.06; bvy += ((by-(py+PH/2))/(PH/2))*3; score += 1; this.score=score; setHud("Pong", score);',
        '        }',
        '        // Right paddle (cpu)',
        '        if(bx+BALL > W-PW && by>cy && by<cy+PH && bvx>0){',
        '          bvx = -bvx*1.06; bvy += ((by-(cy+PH/2))/(PH/2))*3;',
        '        }',
        '        if(bx < -BALL){ cpu++; if(cpu>=5){ dead=true; setHs("pong", score); } else resetBall(1); }',
        '        if(bx > W+BALL){ resetBall(-1); }',
        '      },',
        '      render:function(){',
        '        var ox=(cv.width-W)/2, oy=(cv.height-H)/2;',
        '        ctx.fillStyle="#08080a"; ctx.fillRect(0,0,cv.width,cv.height);',
        '        ctx.save(); ctx.translate(ox,oy);',
        '        ctx.strokeStyle="#1a1a1e"; ctx.setLineDash([6,8]); ctx.beginPath(); ctx.moveTo(W/2,0); ctx.lineTo(W/2,H); ctx.stroke(); ctx.setLineDash([]);',
        '        ctx.fillStyle="#34d399"; ctx.fillRect(0, py, PW, PH);',
        '        ctx.fillStyle="#f59e0b"; ctx.fillRect(W-PW, cy, PW, PH);',
        '        ctx.fillStyle="#e4e4e7"; ctx.fillRect(bx-BALL/2, by-BALL/2, BALL, BALL);',
        '        ctx.fillStyle="#3f3f46"; ctx.font="14px ui-monospace, monospace"; ctx.textAlign="center";',
        '        ctx.fillText(score + "  :  " + cpu, W/2, 24);',
        '        ctx.restore();',
        '        if(dead) banner("YOU LOSE", "score " + score + " \\u00B7 SPACE to retry");',
        '      }',
        '    };',
        '  }',
        '',
        '  // Shared in-canvas banner (game-over etc.)',
        '  function banner(big, small){',
        '    ctx.fillStyle = "rgba(5,5,7,0.78)"; ctx.fillRect(0,0,cv.width,cv.height);',
        '    ctx.textAlign = "center";',
        '    ctx.fillStyle = "#ef4444"; ctx.font = "bold 26px ui-monospace, monospace";',
        '    ctx.fillText(big, cv.width/2, cv.height/2 - 8);',
        '    ctx.fillStyle = "#a1a1aa"; ctx.font = "13px ui-monospace, monospace";',
        '    ctx.fillText(small, cv.width/2, cv.height/2 + 20);',
        '  }',
        '',
        '  // ── Messages from the plugin Worker (relayed verbatim as e.data) ──',
        '  window.addEventListener("message", function(e){',
        '    var d = e.data; if(!d || typeof d !== "object") return;',
        '    if(d.type === "recall"){',
        '      aiState = "waiting"; updateStatusChip();',
        '      lastRecall = { tool:d.tool, terminalId:d.terminalId, waitingCount:d.waitingCount };',
        '      forcedPause = true; refreshOverlay();',
        '    } else if(d.type === "resume"){',
        '      aiState = "busy"; updateStatusChip();',
        '      forcedPause = false; lastRecall = null; refreshOverlay();',
        '    } else if(d.type === "idle"){',
        '      aiState = "idle"; updateStatusChip();',
        '      forcedPause = false; lastRecall = null; refreshOverlay();',
        '    } else if(d.type === "busy"){',
        '      aiState = "busy"; updateStatusChip();',
        '    } else if(d.type === "hello"){',
        '      bridge.send({type:"ready"});',
        '    }',
        '  });',
        '',
        '  // Boot',
        '  updateStatusChip();',
        '  goHub();',
        '  bridge.send({type:"ready"});',
        '})();',
        '</scr' + 'ipt>',
        '</body></html>'
      ];
      return lines.join('\n');
    }

    // ──────────────────────────────────────────────────────────────
    // Worker-side state + AI status protocol
    // ──────────────────────────────────────────────────────────────
    let highscores = {};
    try {
      const stored = await api.storage.get(STORAGE_KEY);
      if (stored) highscores = JSON.parse(stored);
    } catch (_) { highscores = {}; }

    const busy = new Set();
    const waiting = new Set();
    // Remember the most-recent tool/terminal that entered waiting, so the
    // recall overlay can name it.
    let lastWaitInfo = { tool: null, terminalId: null };

    // Debounce overlay pushes so a burst of transitions doesn't spam the iframe
    // or the notification system.
    let lastSent = null;

    function classify() {
      if (waiting.size > 0) return 'recall';
      if (busy.size > 0) return 'resume';
      return 'idle';
    }

    async function pushState(force) {
      const kind = classify();
      const sig =
        kind === 'recall'
          ? 'recall:' + waiting.size + ':' + (lastWaitInfo.terminalId || '')
          : kind;
      if (!force && sig === lastSent) return;
      const prev = lastSent;
      lastSent = sig;

      if (kind === 'recall') {
        await api.panel.postMessage(PANEL_ID, {
          type: 'recall',
          waitingCount: waiting.size,
          tool: lastWaitInfo.tool || 'A session',
          terminalId: lastWaitInfo.terminalId,
        });
        // Only fire a notification on the rising edge into recall.
        if (!prev || prev.indexOf('recall') !== 0) {
          try {
            await api.notifications.show({
              type: 'warning',
              title: 'VibeCoding paused',
              message:
                (lastWaitInfo.tool || 'A session') +
                ' is waiting for input' +
                (waiting.size > 1 ? ' (+' + (waiting.size - 1) + ' more)' : ''),
            });
          } catch (_) {}
        }
      } else if (kind === 'resume') {
        await api.panel.postMessage(PANEL_ID, { type: 'resume' });
      } else {
        await api.panel.postMessage(PANEL_ID, { type: 'idle' });
      }
    }

    function applyStatus(evt) {
      if (!evt || !evt.terminalId) return;
      const id = evt.terminalId;
      // Reset membership, then re-add based on the new status.
      busy.delete(id);
      waiting.delete(id);
      if (evt.status === 'busy') {
        busy.add(id);
      } else if (evt.status === 'waiting') {
        waiting.add(id);
        lastWaitInfo = { tool: evt.tool || null, terminalId: id };
      }
      // 'idle' | 'unknown' → membership already cleared.
    }

    // ──────────────────────────────────────────────────────────────
    // Register the interactive panel + entry points
    // ──────────────────────────────────────────────────────────────
    await api.panel.register({
      id: PANEL_ID,
      title: 'VibeCoding',
      icon: 'gamepad-2',
      position: 'floating',
      interactive: true,
      floating: {
        defaultSize: { width: 480, height: 600 },
        defaultPosition: 'bottom-right',
        minimizable: true,
      },
    });
    await api.panel.setContent(PANEL_ID, gameDocument(highscores));

    const STATUS_BAR_ID = 'vibe-coding.statusbar';
    try {
      await api.statusBar.addItem({
        id: STATUS_BAR_ID,
        text: 'Vibe',
        icon: 'gamepad-2',
        tooltip: 'Toggle VibeCoding (Cmd+Shift+G)',
        position: 'right',
        priority: 90,
        onClick: 'vibe-coding.toggle',
      });
    } catch (_) { /* statusbar capability missing — fine */ }

    // ──────────────────────────────────────────────────────────────
    // Bridge: messages FROM the iframe (panel.onMessage receives e.data)
    // ──────────────────────────────────────────────────────────────
    api.panel.onMessage(async (data) => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'ready') {
        // The game booted (or re-mounted) — replay current state so it's in sync.
        await pushState(true);
      } else if (data.type === 'score') {
        if (typeof data.game === 'string' && typeof data.score === 'number') {
          if (!(data.score > (highscores[data.game] || 0))) return;
          highscores[data.game] = data.score;
          try { await api.storage.set(STORAGE_KEY, JSON.stringify(highscores)); } catch (_) {}
        }
      } else if (data.type === 'focusTerminal') {
        // No plugin-facing "focus terminal" API exists in this Onda build, so
        // fall back to a notification + closing the panel to nudge the user
        // back to the terminal grid.
        try {
          await api.notifications.show({
            type: 'info',
            title: 'Back to the terminal',
            message: 'Your AI session is waiting for input.',
          });
        } catch (_) {}
        try { await api.panel.hide(PANEL_ID); } catch (_) {}
      }
    });

    // ──────────────────────────────────────────────────────────────
    // Subscribe to AI session status — the trigger for pause/recall.
    // ──────────────────────────────────────────────────────────────
    try {
      const res = await api.aiStatus.subscribe();
      const snapshot = (res && res.snapshot) || [];
      for (const s of snapshot) applyStatus(s);
      await pushState(true);
    } catch (err) {
      // aiStatus may be unavailable — the games still work, just no auto-pause.
      try {
        await api.notifications.show({
          type: 'warning',
          title: 'VibeCoding',
          message: 'AI status unavailable — auto-pause disabled, free play only.',
        });
      } catch (_) {}
    }

    api.on('aiStatus:changed', async (evt) => {
      applyStatus(evt);
      await pushState(false);
    });

    // ──────────────────────────────────────────────────────────────
    // Command + show on activate
    // ──────────────────────────────────────────────────────────────
    api.commands.register('vibe-coding.toggle', {
      title: 'Toggle VibeCoding',
      category: 'VibeCoding',
      handler: async () => { await api.panel.toggle(PANEL_ID); },
    });

    // Registered but NOT shown at startup — a game must open on demand
    // (Cmd+Shift+G or the status-bar item), never pop open by itself.

    // Cleanup on runtime deactivation.
    self.__ondaPluginDeactivate = async () => {
      try { await api.aiStatus.unsubscribe(); } catch (_) {}
      try { await api.statusBar.removeItem(STATUS_BAR_ID); } catch (_) {}
    };
  },
};
