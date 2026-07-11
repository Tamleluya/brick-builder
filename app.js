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
var sel = null;          // part מסומן
var armed = '3001';      // סוג חלק חמוש להנחה (null = כבוי)
var curColor = COLORS[0];
var undoStack = [];

/* ---------- סצנה ---------- */
var canvas = document.getElementById('c');
var renderer = new THREE.WebGLRenderer({canvas:canvas, antialias:true});
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

/* ---------- כיוון מלא בתלת־ממד: 6 היפוכים × 4 סיבובים ---------- */
var FLIP_EULERS = [
  [0,0,0],              // רגיל
  [Math.PI/2,0,0],      // הטיה קדימה
  [Math.PI,0,0],        // הפוך
  [-Math.PI/2,0,0],     // הטיה אחורה
  [0,0,Math.PI/2],      // גלגול ימינה
  [0,0,-Math.PI/2]      // גלגול שמאלה
];
var quatCache = {};
function quatFor(r, o){
  var k = (r||0) + '_' + (o||0);
  if (quatCache[k]) return quatCache[k];
  var e = FLIP_EULERS[o||0];
  var qf = new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2]));
  var qy = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, (r||0)*Math.PI/2, 0));
  quatCache[k] = qy.multiply(qf);
  return quatCache[k];
}
/* קופסה נומינלית (גוף החלק ללא בליטות) מסובבת — נותנת טביעת רגל, גובה ויישור */
var _rv = null;
function rotDims(p){
  if (!_rv) _rv = new THREE.Vector3();
  var t = TYPES[p.t];
  var q = quatFor(p.r, p.o);
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
  mesh.quaternion.copy(quatFor(p.r, p.o));
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
function anchorFor(t, r, o, px, pz){
  var d = rotDims({t:t, r:r, o:o});
  var ax = Math.round(px - OFF - d.fw/2);
  var az = Math.round(pz - OFF - d.fd/2);
  ax = Math.max(0, Math.min(BOARD - d.fw, ax));
  az = Math.max(0, Math.min(BOARD - d.fd, az));
  return {x:ax, z:az};
}

function selectPart(p){
  if (sel){
    var m0 = meshes.get(sel.id);
    if (m0) m0.material = matFor(sel.c);
  }
  sel = p;
  if (p){
    armed = null; syncPalette();
    var m = meshes.get(p.id);
    var hm = matFor(p.c).clone();
    hm.emissive = new THREE.Color(0x2a4a66);
    hm.emissiveIntensity = 0.9;
    m.material = hm;
  }
  document.getElementById('actions').classList.toggle('on', !!p);
}

/* ---------- undo / שמירה ---------- */
function snapshot(){ return JSON.stringify(parts); }
function pushUndo(snap){
  undoStack.push(snap);
  if (undoStack.length > 60) undoStack.shift();
  syncTop();
}
function undo(){
  if (!undoStack.length) return;
  selectPart(null);
  parts = JSON.parse(undoStack.pop());
  nextId = parts.reduce(function(m,p){ return Math.max(m, p.id); }, 0) + 1;
  rebuildAll(); save(); syncTop();
}
function save(){
  try { localStorage.setItem('brick-proto-v3', snapshot()); } catch(e){}
  syncTop();
  refreshSnapViz();
  if (spinOn) buildSpin();
}
function load(){
  try {
    var s = localStorage.getItem('brick-proto-v3');
    if (s){
      var list = JSON.parse(s);
      nextId = list.reduce(function(m,p){ return Math.max(m, p.id); }, 0) + 1;
      // חלקי קטלוג שהורדו בעבר צריכים טעינה מחדש מהרשת
      parts = list.filter(function(p){ return TYPES[p.t]; });
      var missing = list.filter(function(p){ return !TYPES[p.t]; });
      rebuildAll();
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
      return list.length > 0;
    }
  } catch(e){}
  return false;
}

/* ---------- דגם פתיחה ---------- */
function demo(){
  function put(t,x,z,l,r,c,o){ addPart({id:nextId++, t:t, x:x, z:z, l:l, r:r, o:o||0, c:c}); }
  // הערה: 3001 האמיתי הוא 4×2 (רוחב 4), לכן r=0 הוא הכיוון הרחב. שכבות בחצאי-פלטות.
  var wallC = ['#c91a09','#f2cd37','#0055bf'];
  for (var lv=0; lv<3; lv++){
    var c = wallC[lv], l = lv*6;
    put('3001', 8, 8, l, 0, c);  put('3001', 12, 8, l, 0, c);
    put('3001', 8, 14, l, 0, c); put('3001', 12, 14, l, 0, c);
    put('3001', 8, 10, l, 1, c); put('3001', 14, 10, l, 1, c);
  }
  put('3031', 8, 8, 18, 0, '#237841');  put('3031', 12, 8, 18, 0, '#237841');
  put('3031', 8, 12, 18, 0, '#237841'); put('3031', 12, 12, 18, 0, '#237841');
  for (var k=0;k<4;k++) put('3003', 8, 8, 20 + k*6, 0, k%2 ? '#c91a09' : '#f2f3f2');
  put('3941', 8, 8, 44, 0, '#f2cd37');
  put('3039', 12, 14, 20, 0, '#c91a09');
  put('3062b', 14, 10, 20, 0, '#fe8a18');
  // רכבת גלגלי שיניים 24→8→24→40 — לחצו ▶ להנעה
  put('3648', 1, 17, 0, 0, '#a0a5a9');
  put('3647', 4, 18, 0, 0, '#c91a09');
  put('3648', 5, 17, 0, 0, '#f2cd37');
  put('3649', 8, 16, 0, 0, '#a0a5a9');
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
var downX=0, downY=0, hitPart=null, dragSnap=null, dragOrig=null;
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
      if (hitPart){
        mode = 'drag';
        dragSnap = snapshot();
        dragOrig = {x:hitPart.x, z:hitPart.z, l:hitPart.l};
        selectPart(hitPart);
        remOcc(hitPart);
      } else {
        mode = 'orbit';
      }
    } else return;
  }

  if (mode === 'orbit'){
    camTheta -= dx * 0.0062;
    camPhi -= dy * 0.0062;
    updateCamera();
  } else if (mode === 'drag' && hitPart){
    var hit = castAt(e.clientX, e.clientY, hitPart.id);
    if (hit){
      var p = hitPart;
      var an = anchorFor(p.t, p.r, p.o, hit.point.x, hit.point.z);
      p.x = an.x; p.z = an.z;
      p.l = Math.min(MAXH, heightAt(cellsOf(p), p.id));
      placeMesh(p);
    }
  }
});

function pointerEnd(e){
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);

  if (mode === 'pinch'){
    if (ptrs.size < 2){ mode = 'idle'; pinch = null; }
    return;
  }

  if (mode === 'maybe'){
    // הקשה
    if (armed){
      var hit = castAt(e.clientX, e.clientY);
      if (hit){
        var an = anchorFor(armed, 0, 0, hit.point.x, hit.point.z);
        var np = {id:nextId++, t:armed, x:an.x, z:an.z, l:0, r:0, o:0, c:curColor};
        np.l = heightAt(cellsOf(np));
        if (np.l <= MAXH){
          pushUndo(snapshot());
          addPart(np); save(); vibrate(9);
        }
      }
    } else if (hitPart){
      selectPart(hitPart); vibrate(6);
    } else {
      selectPart(null);
    }
  } else if (mode === 'drag' && hitPart){
    addOcc(hitPart); placeMesh(hitPart);
    if (dragOrig && (dragOrig.x !== hitPart.x || dragOrig.z !== hitPart.z || dragOrig.l !== hitPart.l)){
      pushUndo(dragSnap); save(); vibrate(9);
    }
    dragSnap = null; dragOrig = null;
  }
  mode = 'idle';
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', function(e){
  if (mode === 'drag' && hitPart && dragOrig){
    hitPart.x=dragOrig.x; hitPart.z=dragOrig.z; hitPart.l=dragOrig.l;
    addOcc(hitPart); placeMesh(hitPart);
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
document.getElementById('btnClear').addEventListener('click', function(){
  if (!parts.length) return;
  if (confirm('למחוק את כל הדגם?')){
    pushUndo(snapshot());
    selectPart(null);
    parts = []; rebuildAll(); save();
  }
});
document.getElementById('btnDel').addEventListener('click', function(){
  if (!sel) return;
  pushUndo(snapshot());
  var p = sel; selectPart(null);
  removePart(p); save(); vibrate(9);
});
function reorient(p, mut){
  pushUndo(snapshot());
  var f0 = fp(p);
  var cx = p.x + f0.w/2, cz = p.z + f0.d/2;
  remOcc(p);
  mut(p);
  var an = anchorFor(p.t, p.r, p.o, cx + OFF, cz + OFF);
  p.x = an.x; p.z = an.z;
  p.l = Math.min(MAXH, heightAt(cellsOf(p), p.id));
  addOcc(p); placeMesh(p); save(); vibrate(6);
}
document.getElementById('btnRot').addEventListener('click', function(){
  if (!sel) return;
  reorient(sel, function(p){ p.r = (p.r + 1) % 4; });
});
document.getElementById('btnFlip').addEventListener('click', function(){
  if (!sel) return;
  reorient(sel, function(p){ p.o = ((p.o||0) + 1) % 6; });
});
document.getElementById('btnDup').addEventListener('click', function(){
  if (!sel) return;
  pushUndo(snapshot());
  var np = {id:nextId++, t:sel.t, x:sel.x, z:sel.z, l:0, r:sel.r, o:sel.o||0, c:sel.c};
  np.l = heightAt(cellsOf(np));
  if (np.l <= MAXH){ addPart(np); selectPart(np); save(); vibrate(9); }
});
document.getElementById('btnPaint').addEventListener('click', function(){
  if (!sel) return;
  pushUndo(snapshot());
  sel.c = curColor;
  var p = sel; selectPart(null); selectPart(p); // רענון חומר
  save();
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
    if (sel){
      pushUndo(snapshot());
      sel.c = c; var p = sel; selectPart(null); selectPart(p); save();
    }
  });
  colorsEl.appendChild(b);
});

var partsEl = document.getElementById('parts');
var catsEl = document.getElementById('cats');
var CATS = [['b','לבנים'],['p','פלטות'],['s','מיוחדים'],['t','טכני'],['g','גלגלי שיניים'],['c','קטלוג ⬇']];
var curCat = 'b';
function syncPalette(){
  Array.from(partsEl.children).forEach(function(el){
    el.classList.toggle('on', el.dataset.t === armed);
    el.style.display = (PD.parts[el.dataset.t].cat === curCat) ? '' : 'none';
  });
  Array.from(catsEl.children).forEach(function(el){
    el.classList.toggle('on', el.dataset.c === curCat);
  });
}
CATS.forEach(function(c){
  var b = document.createElement('button');
  b.className = 'cat';
  b.dataset.c = c[0];
  b.textContent = c[1];
  b.addEventListener('click', function(){ curCat = c[0]; syncPalette(); });
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

/* ---------- קינמטיקה: הנעת גלגלי שיניים ----------
   גלגלים משתלבים כשהמרחק בין הצירים שווה לסכום רדיוסי הפיץ' (שיניים/16 ביחידות בליטה).
   BFS על גרף ההשתלבות מפיץ יחס תמסורת (-Na/Nb) ופאזה שמשלבת שן-מול-מרווח. */
var spinOn = false, spinNodes = null, spinA = 0;
function gearCenter(p){ var f = fp(p); return {x: p.x + f.w/2, z: p.z + f.d/2}; }
function buildSpin(){
  var nodes = parts.filter(function(p){ return PD.parts[p.t].teeth && !(p.o||0); }).map(function(p){
    var n = PD.parts[p.t].teeth;
    return {p: p, c: gearCenter(p), n: n, r: n/16, ratio: 0, phase: 0, seen: false};
  });
  for (var i = 0; i < nodes.length; i++){
    if (nodes[i].seen) continue;
    nodes[i].seen = true;
    nodes[i].ratio = 1;
    nodes[i].phase = nodes[i].p.r * Math.PI/2;
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

/* ---------- HUD ---------- */
var stN = document.getElementById('stN'), stF = document.getElementById('stF');
function syncTop(){
  stN.textContent = parts.length;
  document.getElementById('btnUndo').disabled = !undoStack.length;
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
if (!load()) demo();
syncTop();
requestAnimationFrame(tick);
window.__ready = true;
window.__partCount = function(){ return parts.length; };
window.__gearRots = function(){
  return (spinNodes || []).map(function(n){
    var m = meshes.get(n.p.id);
    return m ? Math.round(m.rotation.y * 1000) / 1000 : null;
  });
};
})();
