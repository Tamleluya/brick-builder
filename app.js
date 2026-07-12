/* בונה הקוביות — אב־טיפוס | Three.js r147 */
(function(){
'use strict';

/* ---------- קבועים ---------- */
var LU = 0.2;            // יחידת גובה = חצי פלטה (מאפשר חלקים על הצד: לבנה שוכבת = 5 יחידות)
var SR = 0.3, SH = 0.21; // רדיוס/גובה בליטה (stud)
var BOARD = 24;          // לוח 24×24 בליטות
var OFF = -BOARD / 2;    // מרכוז הלוח סביב ראשית הצירים
var MAXH = 120;          // תקרת גובה בחצאי-פלטות

/* חלקים אמיתיים מספריית LDraw (ראו parts-data.js; CC BY 4.0, ldraw.org)
   כולל נקודות חיבור אמיתיות מ-LDCad Shadow Library (CC BY-SA 4.0) */
var PD = window.PARTS_DATA;
var TYPES = {};
PD.order.forEach(function(id){
  var p = PD.parts[id];
  TYPES[id] = {n:p.n, w:p.w, d:p.d, h:p.h, flat:p.h === 1};
});
var TYPE_ORDER = PD.order.slice();

var COLORS = ['#c91a09','#fe8a18','#f2cd37','#237841','#0055bf','#f2f3f2','#1b2a34','#a0a5a9'];

/* ---------- מצב ---------- */
var parts = [];          // {id,t,x,z,l,r,c}
var nextId = 1;
var occ = new Map();     // "x,z" -> [{s,e,id}]
var meshes = new Map();  // id -> mesh
var sel = null;          // החלק הראשי המסומן (הראשון בבחירה)
var selIds = [];         // בחירה מרובה — מזהי כל החלקים המסומנים
var multiMode = false;   // מצב "בחר עוד" — הקשה מוסיפה/מסירה מהבחירה
var armed = '3001';      // סוג חלק חמוש להנחה (null = כבוי)
var curColor = COLORS[0];
var undoStack = [];

/* ---------- סצנה ---------- */
var canvas = document.getElementById('c');
var renderer = new THREE.WebGLRenderer({canvas:canvas, antialias:true, preserveDrawingBuffer:true});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;

var scene = new THREE.Scene();
scene.background = new THREE.Color('#dbe7f0');
scene.fog = new THREE.Fog(0xdbe7f0, 70, 150);

var camera = new THREE.PerspectiveCamera(45, 1, 0.1, 300);
var camTarget = new THREE.Vector3(0, 1.5, 0);
var camR = 30, camTheta = 0.65, camPhi = 1.02;

function updateCamera(){
  camPhi = Math.max(0.18, Math.min(1.45, camPhi));
  camR = Math.max(8, Math.min(70, camR));
  camera.position.set(
    camTarget.x + camR * Math.sin(camPhi) * Math.sin(camTheta),
    camTarget.y + camR * Math.cos(camPhi),
    camTarget.z + camR * Math.sin(camPhi) * Math.cos(camTheta)
  );
  camera.lookAt(camTarget);
}

scene.add(new THREE.HemisphereLight(0xffffff, 0x8fa38a, 0.85));
var sun = new THREE.DirectionalLight(0xfff4e0, 0.85);
sun.position.set(14, 26, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -20; sun.shadow.camera.right = 20;
sun.shadow.camera.top = 20; sun.shadow.camera.bottom = -20;
sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0004;
scene.add(sun);

/* רצפה ולוח בסיס */
var ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({color:0xc7d6e2, roughness:1})
);
ground.rotation.x = -Math.PI/2;
ground.position.y = -0.22;
ground.receiveShadow = true;
scene.add(ground);

var BP_H = 0.2;
var baseMat = new THREE.MeshStandardMaterial({color:0x00852b, roughness:0.6});
var basePlate = new THREE.Mesh(new THREE.BoxGeometry(BOARD, BP_H, BOARD), baseMat);
basePlate.position.y = -BP_H/2;
basePlate.receiveShadow = true;
scene.add(basePlate);

var studGeo = new THREE.CylinderGeometry(SR, SR, SH, 14);
var baseStuds = new THREE.InstancedMesh(studGeo, baseMat, BOARD*BOARD);
(function(){
  var m = new THREE.Matrix4(), k = 0;
  for (var i=0;i<BOARD;i++) for (var j=0;j<BOARD;j++){
    m.setPosition(i + 0.5 + OFF, SH/2, j + 0.5 + OFF);
    baseStuds.setMatrixAt(k++, m);
  }
})();
baseStuds.receiveShadow = true;
scene.add(baseStuds);

var partsGroup = new THREE.Group();
scene.add(partsGroup);

/* ---------- גאומטריה של חלקים ---------- */
function mergeGeoms(list){
  var pos = [], norm = [];
  list.forEach(function(g){
    var ng = g.index ? g.toNonIndexed() : g;
    var p = ng.attributes.position.array, n = ng.attributes.normal.array;
    for (var i=0;i<p.length;i++){ pos.push(p[i]); norm.push(n[i]); }
  });
  var out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  return out;
}

var geoCache = {}, edgeCache = {};
function geomFor(t){
  if (geoCache[t]) return geoCache[t];
  var p = PD.parts[t];
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(shrinkXZ(p.v), 3));
  g.setIndex(p.f);
  g = g.toNonIndexed();           // הצללה שטוחה — מראה CAD חד
  g.computeVertexNormals();
  geoCache[t] = g;
  return g;
}
// כיווץ קל בציר האופקי — מונע z-fighting בין דפנות צמודות של חלקים שכנים
function shrinkXZ(v){
  var out = new Float32Array(v.length);
  for (var i = 0; i < v.length; i += 3){
    out[i] = v[i] * 0.992;
    out[i+1] = v[i+1];
    out[i+2] = v[i+2] * 0.992;
  }
  return out;
}
function edgesFor(t){
  if (edgeCache[t]) return edgeCache[t];
  var p = PD.parts[t];
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(shrinkXZ(p.v), 3));
  g.setIndex(p.e);
  edgeCache[t] = g;
  return g;
}
var edgeMat = new THREE.LineBasicMaterial({color:0x22313d, transparent:true, opacity:0.4});

var matCache = {};
function matFor(c){
  if (!matCache[c]) matCache[c] = new THREE.MeshStandardMaterial({color:c, roughness:0.35, side:THREE.DoubleSide});
  return matCache[c];
}

/* ---------- כיוון מלא בתלת־ממד: קווטרניון חופשי בצעדי 90° (24 מצבים) ---------- */
var QID = [0,0,0,1];
function quatOf(p){
  var a = p.q || QID;
  return new THREE.Quaternion(a[0], a[1], a[2], a[3]);
}
var AXES = {x: new THREE.Vector3(1,0,0), y: new THREE.Vector3(0,1,0), z: new THREE.Vector3(0,0,1)};
/* סיבוב 90° סביב ציר עולם + הצמדה מדויקת לקבוצת הסיבובים (מונע סחף float) */
function rotatedQuat(p, axis, dir){
  var q = new THREE.Quaternion().setFromAxisAngle(AXES[axis], (dir || 1) * Math.PI/2).multiply(quatOf(p));
  var m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  for (var i = 0; i < 16; i++) m.elements[i] = Math.round(m.elements[i]);
  var out = new THREE.Quaternion().setFromRotationMatrix(m);
  return [out.x, out.y, out.z, out.w];
}
function upOf(p){ return new THREE.Vector3(0,1,0).applyQuaternion(quatOf(p)); }
function yawOf(p){
  var d = new THREE.Vector3(0,0,1).applyQuaternion(quatOf(p));
  return Math.atan2(d.x, d.z);
}
/* קופסה נומינלית (גוף החלק ללא בליטות) מסובבת — נותנת טביעת רגל, גובה ויישור */
var _rv = null;
function rotDims(p){
  if (!_rv) _rv = new THREE.Vector3();
  var t = TYPES[p.t];
  var q = quatOf(p);
  var mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
  for (var i=0;i<8;i++){
    _rv.set(i&1 ? t.w/2 : -t.w/2, i&2 ? t.h*0.4 : 0, i&4 ? t.d/2 : -t.d/2).applyQuaternion(q);
    var c = [_rv.x, _rv.y, _rv.z];
    for (var j=0;j<3;j++){
      if (c[j] < mn[j]) mn[j] = c[j];
      if (c[j] > mx[j]) mx[j] = c[j];
    }
  }
  var sx = mx[0]-mn[0], sy = mx[1]-mn[1], sz = mx[2]-mn[2];
  return {
    fw: Math.max(1, Math.ceil(sx - 0.02)),
    fd: Math.max(1, Math.ceil(sz - 0.02)),
    ly: Math.max(1, Math.round(sy / LU)),
    mn: mn, sx: sx, sz: sz
  };
}

/* ---------- תפוסה (occupancy) ---------- */
function fp(p){ var d = rotDims(p); return {w:d.fw, d:d.fd}; }
function cellsOf(p){
  var f = fp(p), cs = [];
  for (var i=0;i<f.w;i++) for (var j=0;j<f.d;j++) cs.push((p.x+i) + ',' + (p.z+j));
  return cs;
}
function addOcc(p){
  var e = p.l + rotDims(p).ly;
  cellsOf(p).forEach(function(c){
    if (!occ.has(c)) occ.set(c, []);
    occ.get(c).push({s:p.l, e:e, id:p.id});
  });
}
function remOcc(p){
  cellsOf(p).forEach(function(c){
    var a = occ.get(c);
    if (!a) return;
    occ.set(c, a.filter(function(v){ return v.id !== p.id; }));
  });
}
function heightAt(cells, exceptId){
  var h = 0;
  cells.forEach(function(c){
    (occ.get(c) || []).forEach(function(v){
      if (v.id !== exceptId && v.e > h) h = v.e;
    });
  });
  return h;
}

/* ---------- ניהול חלקים ---------- */
function placeMesh(p){
  var mesh = meshes.get(p.id);
  var rd = rotDims(p);
  mesh.quaternion.copy(quatOf(p));
  // העוגן הוא פינת הרשת; ממקמים כך שהקופסה המסובבת ממורכזת בטביעת הרגל ותחתיתה בשכבה
  var padX = (rd.fw - rd.sx) / 2, padZ = (rd.fd - rd.sz) / 2;
  mesh.position.set(
    p.x + OFF + padX - rd.mn[0],
    p.l * LU - rd.mn[1],
    p.z + OFF + padZ - rd.mn[2]
  );
}
function addPart(p){
  parts.push(p);
  var mesh = new THREE.Mesh(geomFor(p.t), matFor(p.c));
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData.pid = p.id;
  mesh.add(new THREE.LineSegments(edgesFor(p.t), edgeMat));
  meshes.set(p.id, mesh);
  partsGroup.add(mesh);
  placeMesh(p);
  addOcc(p);
}
function removePart(p){
  remOcc(p);
  var mesh = meshes.get(p.id);
  if (mesh) partsGroup.remove(mesh);
  meshes.delete(p.id);
  parts = parts.filter(function(q){ return q.id !== p.id; });
}
function rebuildAll(){
  parts.slice().forEach(function(p){
    var mesh = meshes.get(p.id);
    if (mesh) partsGroup.remove(mesh);
  });
  meshes.clear(); occ.clear();
  var list = parts; parts = [];
  list.forEach(function(p){ addPart(p); });
}

/* אנכון מיקום: מרכז החלק בנק' המגע, מוצמד לרשת ולגבולות */
function anchorFor(t, q, px, pz){
  var d = rotDims({t:t, q:q});
  var ax = Math.round(px - OFF - d.fw/2);
  var az = Math.round(pz - OFF - d.fd/2);
  ax = Math.max(0, Math.min(BOARD - d.fw, ax));
  az = Math.max(0, Math.min(BOARD - d.fd, az));
  return {x:ax, z:az};
}

function partById(id){ for (var i=0;i<parts.length;i++) if (parts[i].id === id) return parts[i]; return null; }
function selParts(){ return selIds.map(partById).filter(Boolean); }
function applySelVisual(){
  parts.forEach(function(p){
    var m = meshes.get(p.id); if (!m) return;
    if (selIds.indexOf(p.id) >= 0){
      var hm = matFor(p.c).clone();
      hm.emissive = new THREE.Color(0x2a4a66);
      hm.emissiveIntensity = 0.9;
      m.material = hm;
    } else if (m.material.emissive){
      m.material = matFor(p.c);
    }
  });
}
function afterSel(){
  sel = selIds.length ? partById(selIds[0]) : null;
  if (selIds.length) armed = null;
  applySelVisual();
  syncPalette();
  var has = selIds.length > 0, multi = selIds.length > 1;
  document.getElementById('actions').classList.toggle('on', has);
  document.body.classList.toggle('hasSel', has);
  document.body.classList.toggle('multiSel', multi);
  var sc = document.getElementById('selCount');
  if (sc){ sc.textContent = multi ? selIds.length + ' חלקים נבחרו' : ''; sc.style.display = multi ? '' : 'none'; }
  var mb = document.getElementById('btnMulti');
  if (mb) mb.classList.toggle('active', multiMode);
}
function selectPart(p){ selIds = p ? [p.id] : []; if (!p) multiMode = false; afterSel(); }
function toggleSelect(p){
  var i = selIds.indexOf(p.id);
  if (i >= 0) selIds.splice(i, 1); else selIds.push(p.id);
  afterSel();
}

/* ---------- undo/redo / שמירה לפי משתמש ---------- */
function snapshot(){ return JSON.stringify(parts); }
var redoStack = [];
function pushUndo(snap){
  undoStack.push(snap);
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  syncTop();
}
function undo(){
  if (!undoStack.length) return;
  selectPart(null);
  redoStack.push(snapshot());
  applySnap(undoStack.pop());
}
function redo(){
  if (!redoStack.length) return;
  selectPart(null);
  undoStack.push(snapshot());
  applySnap(redoStack.pop());
}
function applySnap(s){
  parts = JSON.parse(s);
  nextId = parts.reduce(function(m,p){ return Math.max(m, p.id); }, 0) + 1;
  rebuildAll(); save(); syncTop();
}
var curUser = null;
function userModelKey(n){ return 'bb-m4-' + n; }
function save(){
  try { if (curUser) localStorage.setItem(userModelKey(curUser), snapshot()); } catch(e){}
  syncTop();
  refreshSnapViz();
  if (spinOn) buildSpin();
}
/* טעינת רשימת חלקים לסצנה, כולל הורדה מהרשת של חלקי קטלוג חסרים */
function setModel(list){
  selectPart(null);
  nextId = list.reduce(function(m,p){ return Math.max(m, p.id); }, 0) + 1;
  parts = list.filter(function(p){ return TYPES[p.t]; });
  var missing = list.filter(function(p){ return !TYPES[p.t]; });
  rebuildAll();
  syncTop(); refreshSnapViz();
  if (missing.length){
    var ids = {};
    missing.forEach(function(p){ ids[p.t] = true; });
    Promise.all(Object.keys(ids).map(function(id){
      return buildRemotePart(id, catalogName(id)).catch(function(){ return null; });
    })).then(function(){
      missing.forEach(function(p){ if (TYPES[p.t]) addPart(p); });
      syncTop(); refreshSnapViz();
    });
  }
}
function load(){
  try {
    var s = curUser && localStorage.getItem(userModelKey(curUser));
    if (s){
      var list = JSON.parse(s);
      setModel(list);
      return list.length > 0;
    }
  } catch(e){}
  return false;
}

/* ---------- דגם פתיחה ---------- */
function demo(){
  var S2 = Math.SQRT1_2;
  var QY1 = [0, S2, 0, S2]; // סיבוב 90° סביב Y
  function put(t,x,z,l,c,q){ addPart({id:nextId++, t:t, x:x, z:z, l:l, q:q||null, c:c}); }
  // הערה: 3001 האמיתי הוא 4×2 (רוחב 4). שכבות בחצאי-פלטות.
  var wallC = ['#c91a09','#f2cd37','#0055bf'];
  for (var lv=0; lv<3; lv++){
    var c = wallC[lv], l = lv*6;
    put('3001', 8, 8, l, c);  put('3001', 12, 8, l, c);
    put('3001', 8, 14, l, c); put('3001', 12, 14, l, c);
    put('3001', 8, 10, l, c, QY1); put('3001', 14, 10, l, c, QY1);
  }
  put('3031', 8, 8, 18, '#237841');  put('3031', 12, 8, 18, '#237841');
  put('3031', 8, 12, 18, '#237841'); put('3031', 12, 12, 18, '#237841');
  for (var k=0;k<4;k++) put('3003', 8, 8, 20 + k*6, k%2 ? '#c91a09' : '#f2f3f2');
  put('3941', 8, 8, 44, '#f2cd37');
  put('3039', 12, 14, 20, '#c91a09');
  put('3062b', 14, 10, 20, '#fe8a18');
  // רכבת גלגלי שיניים 24→8→24→40 — לחצו ▶ להנעה
  put('3648', 1, 17, 0, '#a0a5a9');
  put('3647', 4, 18, 0, '#c91a09');
  put('3648', 5, 17, 0, '#f2cd37');
  put('3649', 8, 16, 0, '#a0a5a9');
  save();
}

/* ---------- Raycast ---------- */
var raycaster = new THREE.Raycaster();
var ndc = new THREE.Vector2();
function castAt(cx, cy, excludeId){
  var r = canvas.getBoundingClientRect();
  ndc.set(((cx - r.left)/r.width)*2 - 1, -((cy - r.top)/r.height)*2 + 1);
  raycaster.setFromCamera(ndc, camera);
  var targets = [basePlate, baseStuds, ground];
  parts.forEach(function(p){
    if (p.id !== excludeId) targets.push(meshes.get(p.id));
  });
  var hits = raycaster.intersectObjects(targets, false);
  if (!hits.length) return null;
  var h = hits[0];
  var pid = h.object.userData.pid || null;
  return {point:h.point, part:pid ? parts.find(function(p){ return p.id===pid; }) : null};
}

/* ---------- אינטראקציה ---------- */
var ptrs = new Map();
var mode = 'idle';       // idle | maybe | orbit | drag | pinch
var downX=0, downY=0, hitPart=null, dragSnap=null, dragOrig=null, dragGroup=null;
var pinch = null;

function vibrate(ms){ if (navigator.vibrate) navigator.vibrate(ms); }

canvas.addEventListener('pointerdown', function(e){
  try { canvas.setPointerCapture(e.pointerId); } catch(err){}
  ptrs.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if (ptrs.size === 2){
    if (mode === 'drag' && dragOrig){ // ביטול גרירה
      var p = hitPart;
      remOcc(p); p.x=dragOrig.x; p.z=dragOrig.z; p.l=dragOrig.l; addOcc(p); placeMesh(p);
    }
    var a = Array.from(ptrs.values());
    pinch = {d:Math.hypot(a[0].x-a[1].x, a[0].y-a[1].y),
             mx:(a[0].x+a[1].x)/2, my:(a[0].y+a[1].y)/2};
    mode = 'pinch';
    return;
  }
  downX = e.clientX; downY = e.clientY;
  var hit = castAt(e.clientX, e.clientY);
  hitPart = hit && hit.part ? hit.part : null;
  mode = 'maybe';
  // לחיצה ארוכה על חלק = בחירה, גם כשמצב הנחה פעיל
  lpDone = false;
  clearTimeout(lpTimer);
  if (hitPart){
    var lpTarget = hitPart;
    lpTimer = setTimeout(function(){
      if (mode === 'maybe' && hitPart === lpTarget){
        if (multiMode) toggleSelect(lpTarget); else selectPart(lpTarget);
        lpDone = true;
        mode = 'idle';
        vibrate(18);
        toast(multiMode ? 'בבחירה: ' + selIds.length + ' חלקים' : 'נבחר: ' + TYPES[lpTarget.t].n);
      }
    }, 420);
  }
});
var lpTimer = null, lpDone = false;
var camLock = false, lockHinted = false;
document.getElementById('btnCam').addEventListener('click', function(){
  camLock = !camLock;
  this.classList.toggle('active', camLock);
  toast(camLock ? 'המצלמה ננעלה 🔒 — גרירת רקע לא תזיז את המבט' : 'המצלמה שוחררה — גרירת רקע מסובבת את המבט');
});

canvas.addEventListener('pointermove', function(e){
  if (!ptrs.has(e.pointerId)) return;
  var prev = ptrs.get(e.pointerId);
  var dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  ptrs.set(e.pointerId, {x:e.clientX, y:e.clientY});

  if (mode === 'pinch' && ptrs.size === 2){
    var a = Array.from(ptrs.values());
    var d = Math.hypot(a[0].x-a[1].x, a[0].y-a[1].y);
    var mx = (a[0].x+a[1].x)/2, my = (a[0].y+a[1].y)/2;
    if (pinch.d > 0) camR *= pinch.d / d;
    var pr = camR * 0.0014;
    var right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    var up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    camTarget.addScaledVector(right, -(mx - pinch.mx) * pr * -1);
    camTarget.addScaledVector(up, (my - pinch.my) * pr);
    camTarget.x = Math.max(-16, Math.min(16, camTarget.x));
    camTarget.z = Math.max(-16, Math.min(16, camTarget.z));
    camTarget.y = Math.max(0, Math.min(14, camTarget.y));
    pinch = {d:d, mx:mx, my:my};
    updateCamera();
    return;
  }

  if (mode === 'maybe'){
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 9){
      clearTimeout(lpTimer);
      if (hitPart){
        mode = 'drag';
        dragSnap = snapshot();
        // גרירת חלק שהוא חלק מבחירה מרובה = הזזת כל הקבוצה יחד
        if (selIds.indexOf(hitPart.id) >= 0 && selIds.length > 1){
          dragGroup = selParts();
        } else {
          selectPart(hitPart);
          dragGroup = [hitPart];
        }
        dragOrig = dragGroup.map(function(p){ return {p:p, x:p.x, z:p.z, l:p.l}; });
        dragGroup.forEach(remOcc);
      } else if (!camLock){
        mode = 'orbit';
      } else {
        // מצלמה נעולה — לעבודה עדינה בלי הזזות מבט בטעות
        mode = 'idle';
        if (!lockHinted){
          lockHinted = true;
          toast('המצלמה נעולה 🔒 — שחררו בכפתור למעלה');
        }
      }
    } else return;
  }

  if (mode === 'orbit'){
    camTheta -= dx * 0.0062;
    camPhi -= dy * 0.0062;
    updateCamera();
  } else if (mode === 'drag' && dragGroup){
    var hit = castAt(e.clientX, e.clientY, dragGroup.length === 1 ? dragGroup[0].id : -1);
    if (hit){
      var an = anchorFor(hitPart.t, hitPart.q, hit.point.x, hit.point.z);
      var ddx = an.x - hitPart.x, ddz = an.z - hitPart.z;
      // הגבלת התזוזה כך שכל הקבוצה נשארת בתוך הלוח
      dragGroup.forEach(function(p){
        var f = fp(p);
        if (p.x + ddx < 0) ddx = -p.x;
        if (p.x + ddx > BOARD - f.w) ddx = BOARD - f.w - p.x;
        if (p.z + ddz < 0) ddz = -p.z;
        if (p.z + ddz > BOARD - f.d) ddz = BOARD - f.d - p.z;
      });
      dragGroup.forEach(function(p){ p.x += ddx; p.z += ddz; });
      if (dragGroup.length === 1){
        // חלק בודד: מנוע חיבור בוחר את הגובה (הצמדה לבליטות/ישיבה על חלק אחר)
        dragGroup[0].l = connectLayer(dragGroup[0]);
      }
      dragGroup.forEach(placeMesh);
      showMateViz(dragGroup);
    }
  }
});

function pointerEnd(e){
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  clearTimeout(lpTimer);
  if (lpDone){ lpDone = false; mode = 'idle'; return; }

  if (mode === 'pinch'){
    if (ptrs.size < 2){ mode = 'idle'; pinch = null; }
    return;
  }

  if (mode === 'maybe'){
    // הקשה
    if (armed && armed.indexOf('sub:') === 0){
      var hitS = castAt(e.clientX, e.clientY);
      var sub = getSubs()[+armed.slice(4)];
      if (hitS && sub) placeSub(sub, hitS.point.x, hitS.point.z);
    } else if (armed){
      var hit = castAt(e.clientX, e.clientY);
      if (hit){
        var an = anchorFor(armed, null, hit.point.x, hit.point.z);
        var np = {id:nextId++, t:armed, x:an.x, z:an.z, l:0, q:null, c:curColor};
        np.l = connectLayer(np);
        if (np.l <= MAXH){
          pushUndo(snapshot());
          addPart(np); save(); vibrate(9);
        }
      }
    } else if (hitPart){
      if (multiMode) toggleSelect(hitPart); else selectPart(hitPart);
      vibrate(6);
    } else if (!multiMode){
      selectPart(null);
    }
  } else if (mode === 'drag' && dragGroup){
    dragGroup.forEach(addOcc);
    dragGroup.forEach(placeMesh);
    var moved = dragOrig && dragOrig.some(function(o){ return o.x !== o.p.x || o.z !== o.p.z || o.l !== o.p.l; });
    if (moved){
      pushUndo(dragSnap); save(); vibrate(9);
      var mates = countMates(dragGroup);
      if (mates) toast('🔗 התחבר · ' + mates + ' נקודות חיבור');
    }
    clearMateViz();
    dragSnap = null; dragOrig = null; dragGroup = null;
  }
  mode = 'idle';
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', function(e){
  if (mode === 'drag' && dragGroup && dragOrig){
    dragOrig.forEach(function(o){ o.p.x=o.x; o.p.z=o.z; o.p.l=o.l; addOcc(o.p); placeMesh(o.p); });
    clearMateViz();
    dragGroup = null;
  }
  ptrs.delete(e.pointerId);
  mode = 'idle';
});

canvas.addEventListener('wheel', function(e){
  e.preventDefault();
  camR *= 1 + e.deltaY * 0.0012;
  updateCamera();
}, {passive:false});

/* ---------- כפתורים ---------- */
document.getElementById('btnUndo').addEventListener('click', undo);
document.getElementById('btnRedo').addEventListener('click', redo);
/* אישור בהקשה כפולה — confirm() חסום בחלק מהסביבות */
var clearArmedAt = 0;
document.getElementById('btnClear').addEventListener('click', function(){
  if (!parts.length) return;
  var now = performance.now();
  if (now - clearArmedAt > 2600){
    clearArmedAt = now;
    toast('בטוחים? הקשה נוספת על 🗑 תמחק את כל הדגם');
    return;
  }
  clearArmedAt = 0;
  pushUndo(snapshot());
  selectPart(null);
  parts = []; rebuildAll(); save();
  toast('הדגם נמחק — אפשר להתחרט עם ↩');
});
document.getElementById('btnDel').addEventListener('click', function(){
  if (!selIds.length) return;
  pushUndo(snapshot());
  var ps = selParts(); selectPart(null);
  ps.forEach(removePart); save(); vibrate(9);
});
function reorient(p, mut){
  pushUndo(snapshot());
  var f0 = fp(p);
  var cx = p.x + f0.w/2, cz = p.z + f0.d/2;
  remOcc(p);
  mut(p);
  var an = anchorFor(p.t, p.q, cx + OFF, cz + OFF);
  p.x = an.x; p.z = an.z;
  p.l = Math.min(MAXH, heightAt(cellsOf(p), p.id));
  addOcc(p); placeMesh(p); save(); vibrate(6);
}
/* הזזה אנכית חופשית — משחררת את הנעילה על "תמיד על הכי גבוה" */
function collides(p){
  var ly = rotDims(p).ly;
  var cs = cellsOf(p);
  for (var i=0;i<cs.length;i++){
    var arr = occ.get(cs[i]) || [];
    for (var j=0;j<arr.length;j++){
      var v = arr[j];
      if (v.id !== p.id && v.s < p.l + ly && p.l < v.e) return true;
    }
  }
  return false;
}
function nudgeY(dir){
  if (!selIds.length) return;
  var ps = selParts();
  var snap = snapshot();
  ps.forEach(remOcc);
  var l0 = ps.map(function(p){ return p.l; });
  // מזיזים את כל הקבוצה יחד עד שאף חלק לא מתנגש
  var step = 0, ok = true;
  do {
    step += dir;
    ok = true;
    for (var i=0;i<ps.length;i++){
      var nl = l0[i] + step;
      if (nl < 0 || nl > MAXH){ ok = false; break; }
      ps[i].l = nl;
    }
    if (!ok) break;
    var clash = ps.some(function(p){ return collides(p); });
    if (!clash) break;
  } while (Math.abs(step) < MAXH);
  if (!ok){ ps.forEach(function(p,i){ p.l = l0[i]; }); ps.forEach(addOcc); return; }
  ps.forEach(addOcc); ps.forEach(placeMesh);
  pushUndo(snap); save(); vibrate(6);
}
document.getElementById('btnUp').addEventListener('click', function(){ nudgeY(1); });
document.getElementById('btnDown').addEventListener('click', function(){ nudgeY(-1); });

/* סיבוב קבוצה סביב מרכזה (yaw בלבד — שומר יישור רשת) */
function groupYaw(){
  var ps = selParts(); if (ps.length < 2) return;
  pushUndo(snapshot());
  ps.forEach(remOcc);
  var cx = 0, cz = 0;
  ps.forEach(function(p){ var f = fp(p); cx += p.x + f.w/2; cz += p.z + f.d/2; });
  cx /= ps.length; cz /= ps.length;
  ps.forEach(function(p){
    var f = fp(p), pcx = p.x + f.w/2, pcz = p.z + f.d/2;
    var dx = pcx - cx, dz = pcz - cz;
    p.q = rotatedQuat(p, 'y', 1);
    var nf = fp(p);
    p.x = Math.round(cx - dz - nf.w/2);
    p.z = Math.round(cz + dx - nf.d/2);
  });
  ps.forEach(function(p){
    var f = fp(p);
    p.x = Math.max(0, Math.min(BOARD - f.w, p.x));
    p.z = Math.max(0, Math.min(BOARD - f.d, p.z));
  });
  ps.forEach(addOcc); ps.forEach(placeMesh); save(); vibrate(6);
}
/* שלושה צירי סיבוב עולמיים — כל 24 הכיוונים נגישים בהרכבה (חלק בודד) */
document.getElementById('btnRot').addEventListener('click', function(){
  if (selIds.length > 1) groupYaw();
  else if (sel) reorient(sel, function(p){ p.q = rotatedQuat(p, 'y', 1); });
});
document.getElementById('btnPitch').addEventListener('click', function(){
  if (selIds.length > 1){ toast('הטיה וגלגול פועלים על חלק בודד — בחרו חלק אחד'); return; }
  if (sel) reorient(sel, function(p){ p.q = rotatedQuat(p, 'x', 1); });
});
document.getElementById('btnRoll').addEventListener('click', function(){
  if (selIds.length > 1){ toast('הטיה וגלגול פועלים על חלק בודד — בחרו חלק אחד'); return; }
  if (sel) reorient(sel, function(p){ p.q = rotatedQuat(p, 'z', 1); });
});
document.getElementById('btnDup').addEventListener('click', function(){
  if (!selIds.length) return;
  pushUndo(snapshot());
  var ps = selParts();
  var minl = Math.min.apply(null, ps.map(function(p){ return p.l; }));
  // מרימים את העותקים מעל הגובה הקיים כדי שלא ייכנסו זה בזה
  var lift = 0;
  ps.forEach(function(p){ lift = Math.max(lift, heightAt(cellsOf(p), p.id) - minl); });
  var copies = [];
  ps.forEach(function(p){
    var np = {id:nextId++, t:p.t, x:p.x, z:p.z, l:p.l + lift, q:p.q ? p.q.slice() : null, c:p.c};
    if (np.l <= MAXH){ addPart(np); copies.push(np.id); }
  });
  selIds = copies; afterSel(); save(); vibrate(9);
});
document.getElementById('btnPaint').addEventListener('click', function(){
  if (!selIds.length) return;
  pushUndo(snapshot());
  selParts().forEach(function(p){ p.c = curColor; });
  applySelVisual(); save();
});
document.getElementById('btnMulti').addEventListener('click', function(){
  multiMode = !multiMode;
  this.classList.toggle('active', multiMode);
  toast(multiMode ? 'בחירה מרובה — הקישו על חלקים להוסיף/להסיר' : 'בחירה מרובה כבויה');
});
document.getElementById('btnSaveSub').addEventListener('click', function(){
  if (selIds.length < 1){ toast('בחרו חלקים (בחר עוד ➕) ואז שמרו כמודול'); return; }
  var panel = document.getElementById('subPanel');
  panel.hidden = false;
  var inp = document.getElementById('subName');
  inp.value = ''; inp.focus();
});

/* ---------- פלטות UI ---------- */
var colorsEl = document.getElementById('colors');
COLORS.forEach(function(c){
  var b = document.createElement('button');
  b.className = 'sw' + (c === curColor ? ' on' : '');
  b.style.background = c;
  b.setAttribute('aria-label', c);
  b.addEventListener('click', function(){
    curColor = c;
    Array.from(colorsEl.children).forEach(function(el){ el.classList.remove('on'); });
    b.classList.add('on');
    if (selIds.length){
      pushUndo(snapshot());
      selParts().forEach(function(p){ p.c = c; });
      applySelVisual(); save();
    }
  });
  colorsEl.appendChild(b);
});

var partsEl = document.getElementById('parts');
var catsEl = document.getElementById('cats');
var CATS = [['b','לבנים'],['p','פלטות'],['s','מיוחדים'],['t','טכני'],['g','גלגלי שיניים'],['m','מודולים 🧩'],['c','קטלוג ⬇']];
var curCat = 'b';
function armedLabel(){
  if (!armed) return '';
  if (armed.indexOf('sub:') === 0){ var s = getSubs()[+armed.slice(4)]; return s ? 'מניח מודול: ' + s.name : ''; }
  return TYPES[armed] ? 'מניח: ' + TYPES[armed].n + ' · לחיצה ארוכה בוחרת חלק' : '';
}
function syncPalette(){
  Array.from(partsEl.children).forEach(function(el){
    if (el.dataset.sub !== undefined){
      el.classList.toggle('on', armed === 'sub:' + el.dataset.sub);
      el.style.display = (curCat === 'm') ? '' : 'none';
    } else {
      el.classList.toggle('on', el.dataset.t === armed);
      el.style.display = (PD.parts[el.dataset.t].cat === curCat) ? '' : 'none';
    }
  });
  Array.from(catsEl.children).forEach(function(el){
    el.classList.toggle('on', el.dataset.c === curCat);
  });
  var bar = document.getElementById('armedBar');
  var lbl = armedLabel();
  if (lbl){ document.getElementById('armedName').textContent = lbl; bar.classList.add('on'); }
  else bar.classList.remove('on');
}
document.getElementById('btnDockMin').addEventListener('click', function(){
  var dock = document.getElementById('dock');
  dock.classList.toggle('min');
  this.textContent = dock.classList.contains('min') ? '▴ פלטת חלקים' : '▾ הסתר';
});
document.getElementById('btnDisarm').addEventListener('click', function(){
  armed = null;
  syncPalette();
  toast('מצב בחירה — הקישו על חלק כדי לערוך אותו');
});
CATS.forEach(function(c){
  var b = document.createElement('button');
  b.className = 'cat';
  b.dataset.c = c[0];
  b.textContent = c[1];
  b.addEventListener('click', function(){
    curCat = c[0];
    syncPalette();
    // טאב הקטלוג ריק עד שמורידים חלקים — פותחים ישר את החיפוש
    if (c[0] === 'c' && !TYPE_ORDER.some(function(t){ return PD.parts[t].cat === 'c'; })){
      openSearch();
    }
  });
  catsEl.appendChild(b);
});
function makeChip(t){
  var def = TYPES[t];
  var chip = document.createElement('div');
  chip.className = 'chip' + (def.flat ? ' flat' : '');
  chip.dataset.t = t;
  if (PD.parts[t].teeth){
    var ic = document.createElement('div');
    ic.className = 'gearIcon';
    ic.textContent = '⚙';
    chip.appendChild(ic);
  } else {
    var dots = document.createElement('div');
    dots.className = 'dots';
    dots.style.gridTemplateColumns = 'repeat(' + Math.min(def.d, 8) + ',6px)';
    for (var i=0;i<Math.min(def.w*def.d, 32);i++){
      var d = document.createElement('div');
      d.className = 'dot';
      dots.appendChild(d);
    }
    chip.appendChild(dots);
  }
  var lbl = document.createElement('small');
  lbl.textContent = def.n;
  lbl.dir = 'auto';
  chip.appendChild(lbl);
  chip.addEventListener('click', function(){
    armed = (armed === t) ? null : t;
    if (armed) selectPart(null);
    syncPalette();
  });
  partsEl.appendChild(chip);
}
TYPE_ORDER.forEach(makeChip);
/* צ'יפים של תת־מודלים שמורים */
function buildSubChips(){
  Array.from(partsEl.querySelectorAll('.chip[data-sub]')).forEach(function(el){ el.remove(); });
  getSubs().forEach(function(sub, idx){
    var chip = document.createElement('div');
    chip.className = 'chip subchip';
    chip.dataset.sub = idx;
    var ic = document.createElement('div');
    ic.className = 'gearIcon'; ic.textContent = '🧩';
    var lbl = document.createElement('small');
    lbl.textContent = sub.name + ' (' + sub.parts.length + ')';
    lbl.dir = 'auto';
    var del = document.createElement('button');
    del.className = 'subDel'; del.textContent = '✕'; del.title = 'מחק מודול';
    del.addEventListener('click', function(ev){
      ev.stopPropagation();
      var subs = getSubs(); subs.splice(idx, 1); setSubs(subs); buildSubChips();
      if (armed === 'sub:' + idx) armed = null;
      syncPalette();
    });
    chip.appendChild(ic); chip.appendChild(lbl); chip.appendChild(del);
    chip.addEventListener('click', function(){
      var key = 'sub:' + idx;
      armed = (armed === key) ? null : key;
      if (armed) selectPart(null);
      syncPalette();
    });
    partsEl.appendChild(chip);
  });
}
buildSubChips();
syncPalette();

/* ---------- קטלוג מלא: חיפוש וטעינה מהרשת ----------
   גאומטריה: ספריית LDraw (raw.githubusercontent.com, CC BY 4.0)
   נקודות חיבור: LDCad Shadow Library (CC BY-SA 4.0) */
var RAW_LD = 'https://raw.githubusercontent.com/gkjohnson/ldraw-parts-library/master/complete/ldraw/';
var RAW_SH = 'https://raw.githubusercontent.com/RolandMelkert/LDCadShadowLibrary/main/';
var catalog = [];
(window.PARTS_CATALOG || '').split('\n').forEach(function(line){
  var i = line.indexOf('\t');
  if (i > 0) catalog.push({id: line.slice(0, i), n: line.slice(i + 1)});
});
function catalogName(id){
  for (var i=0;i<catalog.length;i++) if (catalog[i].id === id) return catalog[i].n;
  return id;
}

var IDENT_M = {r:[1,0,0, 0,1,0, 0,0,1], t:[0,0,0]};
function mXform(m, v){
  return [
    m.r[0]*v[0] + m.r[1]*v[1] + m.r[2]*v[2] + m.t[0],
    m.r[3]*v[0] + m.r[4]*v[1] + m.r[5]*v[2] + m.t[1],
    m.r[6]*v[0] + m.r[7]*v[1] + m.r[8]*v[2] + m.t[2]
  ];
}
function mMul(a, b){
  var r = new Array(9), t = new Array(3);
  for (var i=0;i<3;i++){
    for (var j=0;j<3;j++){
      r[i*3+j] = a.r[i*3]*b.r[j] + a.r[i*3+1]*b.r[3+j] + a.r[i*3+2]*b.r[6+j];
    }
    t[i] = a.r[i*3]*b.t[0] + a.r[i*3+1]*b.t[1] + a.r[i*3+2]*b.t[2] + a.t[i];
  }
  return {r:r, t:t};
}

var ldCache = {}, shCache = {};
function fetchText(url){
  return fetch(url).then(function(res){ if (!res.ok) throw new Error(res.status); return res.text(); });
}
function fetchLD(name){
  name = name.trim().toLowerCase().replace(/\\/g, '/');
  if (!(name in ldCache)){
    ldCache[name] = fetchText(RAW_LD + 'parts/' + name).then(function(t){ return {t:t, rel:'parts/' + name}; })
      .catch(function(){ return fetchText(RAW_LD + 'p/' + name).then(function(t){ return {t:t, rel:'p/' + name}; }); })
      .catch(function(){ return null; });
  }
  return ldCache[name];
}
function fetchShadow(rel){
  if (!(rel in shCache)) shCache[rel] = fetchText(RAW_SH + rel).catch(function(){ return null; });
  return shCache[rel];
}

function metaArgs(line){
  var args = {}, re = /\[(\w+)=([^\]]*)\]/g, m;
  while ((m = re.exec(line))) args[m[1].toLowerCase()] = m[2].trim();
  return args;
}
function gridOffsets(spec){
  var tok = spec.split(/\s+/), cx = false, cz = false, nums = [];
  tok.forEach(function(t){
    if (t.toUpperCase() === 'C'){ if (!nums.length) cx = true; else cz = true; }
    else nums.push(parseFloat(t));
  });
  if (nums.length < 4) return [[0,0,0]];
  var ox0 = cx ? -((nums[0]-1)*nums[2])/2 : 0;
  var oz0 = cz ? -((nums[1]-1)*nums[3])/2 : 0;
  var offs = [];
  for (var i=0;i<nums[0];i++) for (var j=0;j<nums[1];j++) offs.push([ox0+i*nums[2], 0, oz0+j*nums[3]]);
  return offs;
}
function secR(secs){
  var m = /^[RS]\s+([\d.]+)/.exec(secs || '');
  return m ? parseFloat(m[1]) : 0;
}
async function collectSnaps(text, baseM, out, depth){
  if (depth > 4) return;
  var lines = text.split(/\r?\n/);
  for (var li=0; li<lines.length; li++){
    var line = lines[li].trim();
    if (!/^0\s+!LDCAD\s+SNAP_/i.test(line)) continue;
    var kind = /SNAP_(\w+)/i.exec(line)[1].toUpperCase();
    var a = metaArgs(line);
    var pos = a.pos ? a.pos.split(/\s+/).map(Number) : [0,0,0];
    var ori = a.ori ? a.ori.split(/\s+/).map(Number) : [1,0,0, 0,1,0, 0,0,1];
    var combo = mMul(baseM, {r: ori, t: pos});
    if (kind === 'INCL'){
      var ref = (a.ref || '').trim().toLowerCase().replace(/\\/g, '/');
      var inc = await fetchShadow('p/' + ref);
      if (!inc) inc = await fetchShadow('parts/' + ref);
      if (inc) await collectSnaps(inc, combo, out, depth + 1);
      continue;
    }
    if (kind !== 'CYL' && kind !== 'GEN' && kind !== 'SPH') continue;
    var g = (a.gender || 'M').toUpperCase() === 'F' ? 'F' : 'M';
    var r = secR(a.secs);
    gridOffsets(a.grid || '').forEach(function(o){
      out.push({g:g, r:r, p:mXform(combo, o)});
    });
  }
}
async function walkLD(name, M, acc, depth){
  if (depth > 40) return;
  var f = await fetchLD(name);
  if (!f) return;
  var sh = await fetchShadow(f.rel);
  if (sh) await collectSnaps(sh, M, acc.snaps, 0);
  var subs = [];
  f.t.split(/\r?\n/).forEach(function(raw){
    var line = raw.trim();
    if (!line) return;
    var t0 = line[0];
    if (t0 === '1'){
      var tok = line.split(/\s+/);
      if (tok.length < 15) return;
      var nm = tok.slice(2, 14).map(Number);
      subs.push(walkLD(tok.slice(14).join(' '), mMul(M, {t:[nm[0],nm[1],nm[2]], r:nm.slice(3)}), acc, depth + 1));
    } else if (t0 === '3' || t0 === '4'){
      var tk = line.split(/\s+/).map(Number);
      var n = t0 === '3' ? 3 : 4;
      var vv = [];
      for (var i=0;i<n;i++) vv.push(mXform(M, [tk[2+i*3], tk[3+i*3], tk[4+i*3]]));
      acc.tris.push([vv[0], vv[1], vv[2]]);
      if (n === 4) acc.tris.push([vv[0], vv[2], vv[3]]);
    } else if (t0 === '2'){
      var tk2 = line.split(/\s+/).map(Number);
      acc.edges.push([mXform(M, [tk2[2],tk2[3],tk2[4]]), mXform(M, [tk2[5],tk2[6],tk2[7]])]);
    }
  });
  await Promise.all(subs);
}
async function buildRemotePart(id, name){
  var acc = {tris:[], edges:[], snaps:[]};
  await walkLD(id + '.dat', IDENT_M, acc, 0);
  if (!acc.tris.length) throw new Error('empty geometry');
  var mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
  acc.tris.forEach(function(tri){ tri.forEach(function(v){
    for (var i=0;i<3;i++){ if (v[i]<mn[i]) mn[i]=v[i]; if (v[i]>mx[i]) mx[i]=v[i]; }
  }); });
  var w = Math.max(1, Math.round((mx[0]-mn[0])/20));
  var d = Math.max(1, Math.round((mx[2]-mn[2])/20));
  var hP = Math.max(1, Math.round((mx[1]-mn[1]-4)/8));
  var cx = (mn[0]+mx[0])/2, cz = (mn[2]+mx[2])/2, bottom = mx[1], S = 0.05;
  function cv(v){
    return [Math.round((v[0]-cx)*S*1000)/1000, Math.round((bottom-v[1])*S*1000)/1000, Math.round((v[2]-cz)*S*1000)/1000];
  }
  var vmap = new Map(), verts = [], faces = [], eidx = [];
  function vid(v){
    var c = cv(v), k = c.join(',');
    var i = vmap.get(k);
    if (i === undefined){ i = verts.length/3; verts.push(c[0],c[1],c[2]); vmap.set(k, i); }
    return i;
  }
  acc.tris.forEach(function(tri){ faces.push(vid(tri[0]), vid(tri[1]), vid(tri[2])); });
  var eset = new Set();
  acc.edges.forEach(function(e){
    var a = vid(e[0]), b = vid(e[1]);
    var k = a < b ? a+'_'+b : b+'_'+a;
    if (!eset.has(k)){ eset.add(k); eidx.push(a, b); }
  });
  var sset = new Set(), snaps = [];
  acc.snaps.forEach(function(s){
    var c = cv(s.p);
    var k = s.g + '|' + c.map(function(x){ return Math.round(x*10)/10; }).join(',');
    if (!sset.has(k)){ sset.add(k); snaps.push({g:s.g, r:s.r, p:c}); }
  });
  PD.parts[id] = {n:name, cat:'c', teeth:0, w:w, d:d, h:hP, v:verts, f:faces, e:eidx, s:snaps};
  TYPES[id] = {n:name, w:w, d:d, h:hP, flat:hP === 1};
  if (TYPE_ORDER.indexOf(id) < 0){ TYPE_ORDER.push(id); makeChip(id); }
}

/* חיפוש UI */
var searchPanel = document.getElementById('searchPanel');
var searchInput = document.getElementById('searchInput');
var searchResults = document.getElementById('searchResults');
var searchMeta = document.getElementById('searchMeta');
function openSearch(){
  searchPanel.hidden = false;
  searchMeta.textContent = catalog.length.toLocaleString() + ' חלקים בקטלוג המלא · הקלידו שם באנגלית או מספר חלק';
  searchResults.innerHTML = '';
  searchInput.value = '';
  searchInput.focus();
}
function closeSearch(){ searchPanel.hidden = true; }
document.getElementById('btnSearch').addEventListener('click', openSearch);
document.getElementById('btnCloseSearch').addEventListener('click', closeSearch);
searchPanel.addEventListener('click', function(e){ if (e.target === searchPanel) closeSearch(); });
searchInput.addEventListener('input', function(){
  var q = searchInput.value.trim().toLowerCase();
  searchResults.innerHTML = '';
  if (q.length < 2){
    searchMeta.textContent = catalog.length.toLocaleString() + ' חלקים בקטלוג המלא · הקלידו לפחות 2 תווים';
    return;
  }
  var hits = [];
  for (var i=0;i<catalog.length && hits.length<50;i++){
    var c = catalog[i];
    if (c.id.indexOf(q) === 0 || c.n.toLowerCase().indexOf(q) >= 0) hits.push(c);
  }
  searchMeta.textContent = hits.length ? hits.length + (hits.length === 50 ? '+ תוצאות' : ' תוצאות') : 'אין תוצאות';
  hits.forEach(function(c){
    var row = document.createElement('button');
    row.className = 'sr';
    var pid = document.createElement('span'); pid.className = 'pid'; pid.textContent = c.id;
    var pn = document.createElement('span'); pn.className = 'pname'; pn.textContent = c.n;
    row.appendChild(pid); row.appendChild(pn);
    row.addEventListener('click', function(){
      if (TYPES[c.id]){ armed = c.id; curCat = PD.parts[c.id].cat; syncPalette(); closeSearch(); return; }
      row.classList.add('loading');
      pn.textContent = 'מוריד את החלק… ' + c.n;
      buildRemotePart(c.id, c.n).then(function(){
        armed = c.id; curCat = 'c'; selectPart(null); syncPalette(); closeSearch(); vibrate(9);
      }).catch(function(){
        row.classList.remove('loading');
        pn.textContent = c.n;
        searchMeta.textContent = 'ההורדה נכשלה — בסביבה זו אין גישה לרשת (נסו בגרסת האתר או בקובץ המקומי)';
      });
    });
    searchResults.appendChild(row);
  });
});

/* ---------- תצוגת נקודות חיבור (מנתוני ה-shadow האמיתיים) ---------- */
var snapViz = false;
var snapGroup = new THREE.Group();
scene.add(snapGroup);
var snapGeo = new THREE.SphereGeometry(0.14, 10, 8);
var snapMatM = new THREE.MeshBasicMaterial({color:0x38bdf8, depthTest:false, transparent:true, opacity:0.95});
var snapMatF = new THREE.MeshBasicMaterial({color:0xff7043, depthTest:false, transparent:true, opacity:0.95});
function refreshSnapViz(){
  snapGroup.clear();
  if (!snapViz) return;
  parts.forEach(function(p){
    var mesh = meshes.get(p.id);
    if (!mesh) return;
    mesh.updateMatrixWorld(true);
    (PD.parts[p.t].s || []).forEach(function(s){
      var v = new THREE.Vector3(s.p[0], s.p[1], s.p[2]);
      mesh.localToWorld(v);
      var mk = new THREE.Mesh(snapGeo, s.g === 'M' ? snapMatM : snapMatF);
      if (s.r !== 6) mk.scale.setScalar(0.5); // חיבורי משנה (צינורות/פינים)
      mk.renderOrder = 999;
      mk.position.copy(v);
      snapGroup.add(mk);
    });
  });
}
window.__snapCount = function(){ return snapGroup.children.length; };

/* ---------- מנוע חיבור מבוסס נקודות (shadow data) ---------- */
/* מיקום וכיוון החלק ללא צורך ב-mesh — משכפל את חישוב placeMesh */
function partPose(p){
  var rd = rotDims(p);
  var padX = (rd.fw - rd.sx) / 2, padZ = (rd.fd - rd.sz) / 2;
  return {
    pos: new THREE.Vector3(p.x + OFF + padX - rd.mn[0], p.l * LU - rd.mn[1], p.z + OFF + padZ - rd.mn[2]),
    q: quatOf(p)
  };
}
function worldSnaps(p){
  var pose = partPose(p);
  return (PD.parts[p.t].s || []).map(function(s){
    return {g:s.g, r:s.r, v:new THREE.Vector3(s.p[0], s.p[1], s.p[2]).applyQuaternion(pose.q).add(pose.pos)};
  });
}
/* נקודות בהן חיבור זכר של חלק אחד פוגש נקבה של חלק אחר (או להפך) */
function findMates(movingParts){
  var movingIds = {};
  movingParts.forEach(function(p){ movingIds[p.id] = true; });
  var moving = [];
  movingParts.forEach(function(p){ worldSnaps(p).forEach(function(s){ moving.push(s); }); });
  var statics = [];
  parts.forEach(function(p){
    if (movingIds[p.id]) return;
    worldSnaps(p).forEach(function(s){ statics.push(s); });
  });
  var mates = [];
  moving.forEach(function(a){
    statics.forEach(function(b){
      if (a.g === b.g) return;                       // זכר מתחבר לנקבה בלבד
      if (Math.abs(a.r - b.r) > 1.5) return;          // קטרים תואמים
      if (a.v.distanceTo(b.v) < 0.22){
        mates.push(a.v.clone().lerp(b.v, 0.5));
      }
    });
  });
  return mates;
}
function countMates(movingParts){ return findMates(movingParts).length; }

/* גובה החיבור: בוחר את השכבה שבה נוצרים הכי הרבה חיבורים סביב גובה הישיבה הטבעי */
function connectLayer(p){
  var base = Math.min(MAXH, heightAt(cellsOf(p), p.id));
  var best = base, bestScore = -1;
  for (var d = -2; d <= 2; d++){
    var l = base + d;
    if (l < 0 || l > MAXH) continue;
    p.l = l;
    if (collides(p)) continue;
    var m = countMates([p]);
    var score = m * 10 - Math.abs(d);   // מעדיף חיבור, בתיקו — קרוב לגובה הטבעי
    if (score > bestScore){ bestScore = score; best = l; }
  }
  p.l = best;
  return best;
}

/* תצוגה חיה של נקודות החיבור בזמן גרירה */
var mateGroup = new THREE.Group();
scene.add(mateGroup);
var mateGeo = new THREE.SphereGeometry(0.2, 12, 10);
var mateMat = new THREE.MeshBasicMaterial({color:0x22e06a, depthTest:false, transparent:true, opacity:0.95});
function clearMateViz(){ mateGroup.clear(); }
function showMateViz(movingParts){
  mateGroup.clear();
  findMates(movingParts).forEach(function(v){
    var mk = new THREE.Mesh(mateGeo, mateMat);
    mk.position.copy(v); mk.renderOrder = 1000;
    mateGroup.add(mk);
  });
}
window.__mateCount = function(){ return mateGroup.children.length; };
window.__mateTest = function(){
  // בדיקה: שתי לבנים 2×4, אחת על השנייה
  var a = {id:90001, t:'3001', x:5, z:5, l:0, q:null, c:'#c91a09'};
  var b = {id:90002, t:'3001', x:5, z:5, l:6, q:null, c:'#0055bf'};
  addPart(a); addPart(b);
  var sa = worldSnaps(a).map(function(s){ return s.g + '@' + s.v.x.toFixed(2) + ',' + s.v.y.toFixed(2) + ',' + s.v.z.toFixed(2); });
  var sb = worldSnaps(b).map(function(s){ return s.g + '@' + s.v.x.toFixed(2) + ',' + s.v.y.toFixed(2) + ',' + s.v.z.toFixed(2); });
  var m = countMates([b]);
  var res = 'mates=' + m + ' | A: ' + sa.slice(0,3).join(' ') + ' | B: ' + sb.slice(0,3).join(' ');
  removePart(a); removePart(b);
  return res;
};

/* ---------- תת־מודלים (מודולים) ---------- */
function subKey(){ return 'bb-sub-' + (curUser || 'אורח'); }
function getSubs(){ try { return JSON.parse(localStorage.getItem(subKey()) || '[]'); } catch(e){ return []; } }
function setSubs(a){ try { localStorage.setItem(subKey(), JSON.stringify(a)); } catch(e){} }
function saveSubModel(name){
  var ps = selParts(); if (!ps.length) return;
  var minx = Math.min.apply(null, ps.map(function(p){ return p.x; }));
  var minz = Math.min.apply(null, ps.map(function(p){ return p.z; }));
  var minl = Math.min.apply(null, ps.map(function(p){ return p.l; }));
  var data = ps.map(function(p){
    return {t:p.t, dx:p.x - minx, dz:p.z - minz, dl:p.l - minl, q:p.q ? p.q.slice() : null, c:p.c};
  });
  var subs = getSubs();
  subs.push({name:name, parts:data});
  setSubs(subs);
  buildSubChips();
  toast('נשמר מודול "' + name + '" · זמין בטאב מודולים 🧩');
}
function subFootprint(sub){
  var w = 1, d = 1;
  sub.parts.forEach(function(sp){
    var f = fp({t:sp.t, q:sp.q});
    w = Math.max(w, sp.dx + f.w);
    d = Math.max(d, sp.dz + f.d);
  });
  return {w:w, d:d};
}
function placeSub(sub, px, pz){
  var fpr = subFootprint(sub);
  var ax = Math.max(0, Math.min(BOARD - fpr.w, Math.round(px - OFF - fpr.w/2)));
  var az = Math.max(0, Math.min(BOARD - fpr.d, Math.round(pz - OFF - fpr.d/2)));
  // גובה בסיס: מעל הגבוה ביותר בטביעת הרגל של כל המודול
  var baseCells = [];
  for (var i=0;i<fpr.w;i++) for (var j=0;j<fpr.d;j++) baseCells.push((ax+i) + ',' + (az+j));
  var base = heightAt(baseCells);
  pushUndo(snapshot());
  var newIds = [];
  sub.parts.forEach(function(sp){
    var np = {id:nextId++, t:sp.t, x:ax + sp.dx, z:az + sp.dz, l:base + sp.dl, q:sp.q ? sp.q.slice() : null, c:sp.c};
    if (TYPES[np.t] && np.l <= MAXH){ addPart(np); newIds.push(np.id); }
  });
  selIds = newIds; afterSel(); save(); vibrate(12);
  toast('הונח המודול "' + sub.name + '"');
}
document.getElementById('btnSubSave').addEventListener('click', function(){
  var n = document.getElementById('subName').value.trim();
  if (!n) return;
  document.getElementById('subPanel').hidden = true;
  saveSubModel(n);
});
document.getElementById('btnSubClose').addEventListener('click', function(){
  document.getElementById('subPanel').hidden = true;
});

/* ---------- קינמטיקה: הנעת גלגלי שיניים ----------
   גלגלים משתלבים כשהמרחק בין הצירים שווה לסכום רדיוסי הפיץ' (שיניים/16 ביחידות בליטה).
   BFS על גרף ההשתלבות מפיץ יחס תמסורת (-Na/Nb) ופאזה שמשלבת שן-מול-מרווח. */
var spinOn = false, spinNodes = null, spinA = 0;
function gearCenter(p){ var f = fp(p); return {x: p.x + f.w/2, z: p.z + f.d/2}; }
function buildSpin(){
  var nodes = parts.filter(function(p){ return PD.parts[p.t].teeth && upOf(p).y > 0.99; }).map(function(p){
    var n = PD.parts[p.t].teeth;
    return {p: p, c: gearCenter(p), n: n, r: n/16, ratio: 0, phase: 0, seen: false};
  });
  for (var i = 0; i < nodes.length; i++){
    if (nodes[i].seen) continue;
    nodes[i].seen = true;
    nodes[i].ratio = 1;
    nodes[i].phase = yawOf(nodes[i].p);
    var q = [nodes[i]];
    while (q.length){
      var a = q.shift();
      nodes.forEach(function(b){
        if (b.seen || b.p.l !== a.p.l) return;
        var dx = b.c.x - a.c.x, dz = b.c.z - a.c.z;
        if (Math.abs(Math.hypot(dx, dz) - (a.r + b.r)) > 0.1) return;
        var phi = Math.atan2(dx, dz);
        var k = a.n / b.n;
        b.ratio = -k * a.ratio;
        b.phase = -k * a.phase + (1 + k) * phi + Math.PI / b.n;
        b.seen = true;
        q.push(b);
      });
    }
  }
  spinNodes = nodes;
}
document.getElementById('btnPlay').addEventListener('click', function(){
  spinOn = !spinOn;
  this.classList.toggle('active', spinOn);
  this.textContent = spinOn ? '⏸' : '▶';
  if (spinOn){ buildSpin(); spinA = 0; }
  else {
    spinNodes = null;
    parts.forEach(function(p){ placeMesh(p); });
  }
});
document.getElementById('btnSnap').addEventListener('click', function(){
  snapViz = !snapViz;
  this.classList.toggle('active', snapViz);
  refreshSnapViz();
});

/* ---------- משתמשים ושיתוף ---------- */
function getUsers(){ try { return JSON.parse(localStorage.getItem('bb-users') || '[]'); } catch(e){ return []; } }
function setUsers(u){ try { localStorage.setItem('bb-users', JSON.stringify(u)); } catch(e){} }
function syncUserBtn(){ document.getElementById('btnUser').textContent = '👤 ' + (curUser || ''); }
function switchUser(name){
  if (getUsers().indexOf(name) < 0) setUsers(getUsers().concat([name]));
  curUser = name;
  try { localStorage.setItem('bb-user', name); } catch(e){}
  syncUserBtn();
  undoStack = []; redoStack = [];
  currentGalId = null;
  buildSubChips();
  if (!load()) setModel([]); // משתמש חדש מתחיל בלוח נקי
}
var toastTimer = null;
function toast(msg){
  var h = document.getElementById('hint');
  h.textContent = msg;
  h.classList.remove('gone');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ h.classList.add('gone'); }, 3500);
}
var usersPanel = document.getElementById('usersPanel');
function renderUsers(){
  var listEl = document.getElementById('usersList');
  listEl.innerHTML = '';
  getUsers().forEach(function(n){
    var row = document.createElement('button');
    row.className = 'sr';
    var nm = document.createElement('span');
    nm.className = 'pname';
    nm.style.direction = 'rtl'; nm.style.textAlign = 'right';
    nm.textContent = (n === curUser ? '✓ ' : '') + n;
    row.appendChild(nm);
    row.addEventListener('click', function(){
      switchUser(n);
      usersPanel.hidden = true;
      toast('עברת למשתמש ' + n + ' — הדגם שלו נטען');
    });
    listEl.appendChild(row);
  });
}
document.getElementById('btnUser').addEventListener('click', function(){
  usersPanel.hidden = false;
  renderUsers();
});
document.getElementById('btnCloseUsers').addEventListener('click', function(){ usersPanel.hidden = true; });
usersPanel.addEventListener('click', function(e){ if (e.target === usersPanel) usersPanel.hidden = true; });
document.getElementById('btnAddUser').addEventListener('click', function(){
  var inp = document.getElementById('newUserName');
  var n = inp.value.trim();
  if (!n) return;
  inp.value = '';
  switchUser(n);
  usersPanel.hidden = true;
  toast('נוצר משתמש חדש: ' + n);
});
document.getElementById('btnDemo').addEventListener('click', function(){
  pushUndo(snapshot());
  selectPart(null);
  parts = []; rebuildAll();
  demo();
  usersPanel.hidden = true;
  toast('נטען דגם לדוגמה — עם רכבת גלגלי שיניים, לחצו ▶');
});
document.getElementById('btnShare').addEventListener('click', function(){
  var data = btoa(unescape(encodeURIComponent(snapshot())));
  var url = location.origin + location.pathname + '#m=' + data;
  var cp = (navigator.clipboard && navigator.clipboard.writeText) ? navigator.clipboard.writeText(url) : Promise.reject();
  cp.then(function(){ toast('קישור לדגם הועתק — שלחו לחברים 🎉'); })
    .catch(function(){
      var panel = document.getElementById('linkPanel');
      var out = document.getElementById('linkOut');
      panel.hidden = false;
      out.value = url;
      out.focus(); out.select();
    });
});
document.getElementById('btnCloseLink').addEventListener('click', function(){
  document.getElementById('linkPanel').hidden = true;
});
document.getElementById('linkPanel').addEventListener('click', function(e){
  if (e.target === document.getElementById('linkPanel')) document.getElementById('linkPanel').hidden = true;
});
function readHashModel(){
  if (location.hash.indexOf('#m=') !== 0) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(3))))); } catch(e){ return null; }
}

/* ---------- גלריית דגמים (שמירות מרובות לכל משתמש, מקומי) ---------- */
var currentGalId = null;
function galKey(){ return 'bb-gal-' + (curUser || 'אורח'); }
function getGal(){ try { return JSON.parse(localStorage.getItem(galKey()) || '[]'); } catch(e){ return []; } }
function setGal(a){ try { localStorage.setItem(galKey(), JSON.stringify(a)); } catch(e){} }
function galById(id){ return getGal().filter(function(g){ return g.id === id; })[0]; }
function uid(){ return 'g' + Math.floor(Math.random() * 1e9).toString(36) + selIds.length + parts.length; }
function captureThumb(){
  try {
    renderer.render(scene, camera);
    var tc = document.createElement('canvas'); tc.width = 240; tc.height = 150;
    tc.getContext('2d').drawImage(renderer.domElement, 0, 0, tc.width, tc.height);
    return tc.toDataURL('image/jpeg', 0.72);
  } catch(e){ return ''; }
}
function saveToGallery(){
  var gal = getGal();
  var typed = document.getElementById('galName').value.trim();
  var cur = currentGalId ? galById(currentGalId) : null;
  var name = typed || (cur && cur.name) || ('דגם ' + (gal.length + 1));
  var thumb = captureThumb();
  var snap = snapshot();
  if (cur){
    cur.name = name; cur.thumb = thumb; cur.parts = snap;
    gal = gal.map(function(g){ return g.id === cur.id ? cur : g; });
  } else {
    currentGalId = uid();
    gal.push({id:currentGalId, name:name, thumb:thumb, parts:snap});
  }
  setGal(gal); renderGal(); vibrate(9);
  toast('נשמר בגלריה: ' + name);
}
function saveCopy(){
  var gal = getGal();
  var typed = document.getElementById('galName').value.trim();
  var base = typed || (currentGalId && galById(currentGalId) ? galById(currentGalId).name : 'דגם');
  currentGalId = uid();
  gal.push({id:currentGalId, name:base + ' (עותק)', thumb:captureThumb(), parts:snapshot()});
  setGal(gal); renderGal(); toast('נשמר עותק חדש');
}
function loadGalItem(id){
  var e = galById(id); if (!e) return;
  setModel(JSON.parse(e.parts));
  currentGalId = id;
  document.getElementById('galName').value = e.name;
  save();
  document.getElementById('galleryPanel').hidden = true;
  toast('נטען: ' + e.name);
}
function deleteGalItem(id){
  setGal(getGal().filter(function(g){ return g.id !== id; }));
  if (currentGalId === id) currentGalId = null;
  renderGal();
}
function newModel(){
  pushUndo(snapshot());
  selectPart(null);
  parts = []; rebuildAll();
  currentGalId = null;
  document.getElementById('galName').value = '';
  save();
  document.getElementById('galleryPanel').hidden = true;
  toast('דגם חדש — לוח נקי');
}
function renderGal(){
  var grid = document.getElementById('galGrid');
  grid.innerHTML = '';
  var gal = getGal();
  if (!gal.length){
    grid.innerHTML = '<div class="galEmpty">אין עדיין דגמים שמורים. בנו משהו ולחצו "שמור דגם".</div>';
    return;
  }
  gal.slice().reverse().forEach(function(g){
    var card = document.createElement('div');
    card.className = 'galCard' + (g.id === currentGalId ? ' cur' : '');
    var img = document.createElement('img');
    img.className = 'galThumb'; img.src = g.thumb || ''; img.alt = g.name;
    img.addEventListener('click', function(){ loadGalItem(g.id); });
    var nm = document.createElement('div'); nm.className = 'galNm'; nm.textContent = g.name; nm.dir = 'auto';
    var del = document.createElement('button'); del.className = 'galDel'; del.textContent = '✕';
    del.addEventListener('click', function(ev){ ev.stopPropagation(); deleteGalItem(g.id); });
    card.appendChild(img); card.appendChild(nm); card.appendChild(del);
    grid.appendChild(card);
  });
}
document.getElementById('btnGallery').addEventListener('click', function(){
  document.getElementById('galleryPanel').hidden = false;
  var cur = currentGalId ? galById(currentGalId) : null;
  document.getElementById('galName').value = cur ? cur.name : '';
  renderGal();
});
document.getElementById('btnGalClose').addEventListener('click', function(){ document.getElementById('galleryPanel').hidden = true; });
document.getElementById('galleryPanel').addEventListener('click', function(e){ if (e.target === this) this.hidden = true; });
document.getElementById('btnGalSave').addEventListener('click', saveToGallery);
document.getElementById('btnGalCopy').addEventListener('click', saveCopy);
document.getElementById('btnGalNew').addEventListener('click', newModel);

/* ---------- HUD ---------- */
var stN = document.getElementById('stN'), stF = document.getElementById('stF');
function syncTop(){
  stN.textContent = parts.length;
  document.getElementById('btnUndo').disabled = !undoStack.length;
  document.getElementById('btnRedo').disabled = !redoStack.length;
}
var fpsAcc = 0, fpsCnt = 0, fpsLast = 0;

setTimeout(function(){ document.getElementById('hint').classList.add('gone'); }, 9000);

/* ---------- לולאה ---------- */
function resize(){
  var w = canvas.clientWidth || window.innerWidth;
  var h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function fitCamera(){
  // במסך צר (טלפון) מרחיקים את המצלמה כדי שכל הלוח ייכנס
  var aspect = (window.innerWidth || 1) / (window.innerHeight || 1);
  camR = aspect < 0.8 ? 42 : 30;
}

function tick(ts){
  requestAnimationFrame(tick);
  if (fpsLast){
    var dt = ts - fpsLast;
    fpsAcc += dt; fpsCnt++;
    if (fpsAcc >= 500){
      stF.textContent = Math.round(1000 / (fpsAcc / fpsCnt));
      fpsAcc = 0; fpsCnt = 0;
    }
    if (spinOn && spinNodes){
      spinA += dt * 0.0016;
      spinNodes.forEach(function(n){
        var mesh = meshes.get(n.p.id);
        if (mesh) mesh.rotation.y = n.ratio * spinA + n.phase;
      });
    }
  }
  fpsLast = ts;
  renderer.render(scene, camera);
}

/* ---------- אתחול ---------- */
resize();
fitCamera();
updateCamera();
curUser = localStorage.getItem('bb-user') || 'אורח';
try { localStorage.setItem('bb-user', curUser); } catch(e){}
if (getUsers().indexOf(curUser) < 0) setUsers(getUsers().concat([curUser]));
syncUserBtn();
var sharedModel = readHashModel();
if (sharedModel){
  // דגם משותף נטען למשתמש ייעודי כדי לא לדרוס דגמים של אף אחד
  curUser = 'דגם משותף';
  if (getUsers().indexOf(curUser) < 0) setUsers(getUsers().concat([curUser]));
  try { localStorage.setItem('bb-user', curUser); } catch(e){}
  syncUserBtn();
  setModel(sharedModel); save();
  toast('נטען דגם משותף 🎁 — הדגמים שלך שמורים תחת 👤');
  try { history.replaceState(null, '', location.pathname + location.search); } catch(e){}
} else if (!load()){
  setModel([]); // התחלה בלוח נקי; דגם לדוגמה זמין בתפריט 👤
  toast('לוח נקי ומוכן — בחרו חלק למטה והקישו על הלוח');
}
syncTop();
requestAnimationFrame(tick);
window.__ready = true;
window.__partCount = function(){ return parts.length; };
window.__selQ = function(){ return sel ? (sel.q || null) : null; };
window.__hitTest = function(x, y){
  var h = castAt(x, y);
  return h ? (h.part ? 'part:' + h.part.id : 'ground@' + Math.round(h.point.x) + ',' + Math.round(h.point.z)) : 'none';
};
window.__gearRots = function(){
  return (spinNodes || []).map(function(n){
    var m = meshes.get(n.p.id);
    return m ? Math.round(m.rotation.y * 1000) / 1000 : null;
  });
};
})();
