// ============================================================
// CONFIG
// ============================================================
var SPREADSHEET_ID = "ID_DE_EJEMPLO";
var SHEET_GESTION_ID = 'id_prueba';
var SHEET_GESTION_NAME = 'Hoja 1';
var LOG_SHEET_NAME = 'LOG_REGISTRO';
var FILA_MINIMA = 500;

// Ajustes editables desde la app (se guardan en PropertiesService)
function getAjustes() {
  var props = PropertiesService.getScriptProperties();
  return {
    emailDestino: props.getProperty('EMAIL_DESTINO') || '',
    emailCC: props.getProperty('EMAIL_CC') || '',
    responsable: props.getProperty('RESPONSABLE') || 'Sistemas Compras',
    diasAlerta: parseInt(props.getProperty('DIAS_ALERTA') || '15'),
    filaMinima: parseInt(props.getProperty('FILA_MINIMA') || String(FILA_MINIMA)),
    apiKeyGroq: props.getProperty('GROQ_API_KEY') || '',
    apiKeyOpenRouter: props.getProperty('OPENROUTER_API_KEY') || '',
    iaProvider: props.getProperty('IA_PROVIDER') || 'groq'
  };
}
function guardarAjustes(jsonStr) {
  var a = JSON.parse(jsonStr);
  var props = PropertiesService.getScriptProperties();
  if (a.emailDestino !== undefined) props.setProperty('EMAIL_DESTINO', a.emailDestino);
  if (a.emailCC !== undefined) props.setProperty('EMAIL_CC', a.emailCC);
  if (a.responsable !== undefined) props.setProperty('RESPONSABLE', a.responsable);
  if (a.diasAlerta !== undefined) props.setProperty('DIAS_ALERTA', String(a.diasAlerta));
  if (a.filaMinima !== undefined) { props.setProperty('FILA_MINIMA', String(a.filaMinima)); FILA_MINIMA = parseInt(a.filaMinima); }
  if (a.apiKeyGroq !== undefined) props.setProperty('GROQ_API_KEY', a.apiKeyGroq);
  if (a.apiKeyOpenRouter !== undefined) props.setProperty('OPENROUTER_API_KEY', a.apiKeyOpenRouter);
  if (a.iaProvider !== undefined) props.setProperty('IA_PROVIDER', a.iaProvider);
  return JSON.stringify({ ok: true });
}

// ============================================================
// AUTENTICACIÓN — Usuarios y Sesiones en Gestión de Tareas
// ============================================================
var AUTH_SHEET_USERS = 'USUARIOS';
var AUTH_SHEET_SESSIONS = 'SESIONES';

function getAuthSheet(name) {
  var ss = SpreadsheetApp.openById(SHEET_GESTION_ID);
  var h = ss.getSheetByName(name);
  if (!h) {
    h = ss.insertSheet(name);
    if (name === AUTH_SHEET_USERS) {
      h.appendRow(['EMAIL','NOMBRE','PASSWORD_HASH','FECHA_REGISTRO','ACTIVO']);
      h.getRange(1,1,1,5).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#fff');
      h.setFrozenRows(1);
    } else if (name === AUTH_SHEET_SESSIONS) {
      h.appendRow(['TOKEN','EMAIL','FINGERPRINT','FECHA_CREACION','ULTIMO_ACCESO']);
      h.getRange(1,1,1,5).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#fff');
      h.setFrozenRows(1);
    }
  }
  return h;
}

function hashPassword(pwd) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pwd + 'TN_UIO_SALT_2025');
  return raw.map(function(b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function generarToken() {
  return Utilities.getUuid() + '-' + new Date().getTime();
}

function registrarUsuario(nombre, email, password) {
  if (!nombre || !email || !password) return JSON.stringify({ error: 'Todos los campos son requeridos' });
  if (password.length < 4) return JSON.stringify({ error: 'La contraseña debe tener al menos 4 caracteres' });
  email = email.trim().toLowerCase();
  var h = getAuthSheet(AUTH_SHEET_USERS);
  var d = h.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) {
    if (String(d[i][0]).trim().toLowerCase() === email) return JSON.stringify({ error: 'Este email ya está registrado' });
  }
  var hash = hashPassword(password);
  var fecha = Utilities.formatDate(new Date(), 'America/Guayaquil', 'yyyy-MM-dd HH:mm:ss');
  h.appendRow([email, nombre.trim(), hash, fecha, 'SI']);
  return JSON.stringify({ ok: true, msg: 'Registro exitoso. Ahora puedes iniciar sesión.' });
}

function loginUsuario(email, password, fingerprint) {
  if (!email || !password) return JSON.stringify({ error: 'Email y contraseña requeridos' });
  email = email.trim().toLowerCase();
  var h = getAuthSheet(AUTH_SHEET_USERS);
  var d = h.getDataRange().getValues();
  var hash = hashPassword(password);
  var usuario = null;
  for (var i = 1; i < d.length; i++) {
    if (String(d[i][0]).trim().toLowerCase() === email && String(d[i][2]).trim() === hash) {
      if (String(d[i][4]).trim().toUpperCase() !== 'SI') return JSON.stringify({ error: 'Tu cuenta está desactivada. Contacta al administrador.' });
      usuario = { email: String(d[i][0]).trim(), nombre: String(d[i][1]).trim() };
      break;
    }
  }
  if (!usuario) return JSON.stringify({ error: 'Email o contraseña incorrectos' });
  // Crear sesión
  var token = generarToken();
  var fecha = Utilities.formatDate(new Date(), 'America/Guayaquil', 'yyyy-MM-dd HH:mm:ss');
  var hs = getAuthSheet(AUTH_SHEET_SESSIONS);
  hs.appendRow([token, usuario.email, fingerprint || '', fecha, fecha]);
  return JSON.stringify({ ok: true, token: token, nombre: usuario.nombre, email: usuario.email });
}

function validarSesion(token, fingerprint) {
  if (!token) return JSON.stringify({ ok: false });
  var hs = getAuthSheet(AUTH_SHEET_SESSIONS);
  var d = hs.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) {
    if (String(d[i][0]).trim() === token) {
      var fpGuardado = String(d[i][2]).trim();
      if (fpGuardado && fingerprint && fpGuardado !== fingerprint) {
        return JSON.stringify({ ok: false, reason: 'Dispositivo diferente' });
      }
      // Verificar que el usuario siga ACTIVO
      var emailSesion = String(d[i][1]).trim().toLowerCase();
      var hu = getAuthSheet(AUTH_SHEET_USERS);
      var du = hu.getDataRange().getValues();
      var nombre = '', activo = false;
      for (var u = 1; u < du.length; u++) {
        if (String(du[u][0]).trim().toLowerCase() === emailSesion) {
          nombre = String(du[u][1]).trim();
          activo = String(du[u][4]).trim().toUpperCase() === 'SI';
          break;
        }
      }
      if (!activo) {
        // Eliminar sesión del usuario desactivado
        hs.deleteRow(i + 1);
        return JSON.stringify({ ok: false, reason: 'Cuenta desactivada' });
      }
      hs.getRange(i + 1, 5).setValue(Utilities.formatDate(new Date(), 'America/Guayaquil', 'yyyy-MM-dd HH:mm:ss'));
      return JSON.stringify({ ok: true, nombre: nombre, email: emailSesion });
    }
  }
  return JSON.stringify({ ok: false });
}

function cerrarSesion(token) {
  if (!token) return;
  var hs = getAuthSheet(AUTH_SHEET_SESSIONS);
  var d = hs.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) {
    if (String(d[i][0]).trim() === token) {
      hs.deleteRow(i + 1);
      break;
    }
  }
  return JSON.stringify({ ok: true });
}

// ============================================================
// WEB APP
// ============================================================
function doGet() {
  return HtmlService.createHtmlOutput(getHTML())
    .setTitle('Compras TN UIO')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ============================================================
// CANCELADO
// ============================================================
function esCancelado(item) {
  var t = '';
  for (var k in item) { if (k.toUpperCase().indexOf('OBSERV') !== -1) t += ' ' + item[k]; }
  t = t.toLowerCase();
  var p = [
    'compra cancelada','se cancela','cancelada','cancelado',
    'anulada','anulado','se anula','se anuló','se anulo','anula oc','anular',
    'compra anulada','orden cancelada','oc cancelada','oc anulada',
    'suspende la compra','se suspende','compra suspendida','suspendida','suspendido',
    'stock en bodega','hay en bodega','existe en bodega',
    'no se requiere','ya no se necesita','no se necesita','no aplica',
    'devuelto','devuelta','rechazado','rechazada'
  ];
  for (var i = 0; i < p.length; i++) { if (t.indexOf(p[i]) !== -1) return true; }
  return false;
}

// ============================================================
// COL HELPER — normaliza nombres de columna con saltos de línea
// ============================================================
function colVal(item, nombres) {
  for (var i = 0; i < nombres.length; i++) {
    var v = item[nombres[i]];
    if (v !== undefined && v !== null) return String(v).trim();
  }
  return '';
}

// ============================================================
// CALC PENDIENTE — lee columna o calcula SOLICITADA - ENTREGADA
// ============================================================
function calcPend(it) {
  var pe = colVal(it, ['PENDIENTE ENTREGA']);
  if (pe && pe !== '' && pe !== '0') return parseFloat(pe) || 0;
  var sol = parseFloat(colVal(it, ['CANTIDAD SOLICITADA']) || '0') || 0;
  var ent = parseFloat(colVal(it, ['CANTIDAD ENTREGADA']) || '0') || 0;
  if (sol > 0) return Math.max(0, sol - ent);
  return parseFloat(pe || '0') || 0;
}

// ============================================================
// AUTO-DETECT HOJAS
// ============================================================
function getHojasDisponibles() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var hojas = ss.getSheets();
  var r = [];
  for (var s = 0; s < hojas.length; s++) {
    var n = hojas[s].getName();
    if (n === LOG_SHEET_NAME || n === 'TAREA_TRACKING') continue;
    var lr = hojas[s].getLastRow();
    if (lr < 10) continue;
    var sample = hojas[s].getRange(1, 1, Math.min(50, lr), Math.min(8, hojas[s].getLastColumn())).getValues();
    var hasTarea = false, hasDelim = false, hasProv = false;
    for (var i = 0; i < sample.length; i++) {
      var p = String(sample[i][0]).trim().toUpperCase();
      if (p === 'TAREA:' || p === 'TAREA') hasTarea = true;
      if (p === 'PROVEEDOR') hasProv = true;
      for (var j = 0; j < sample[i].length; j++) {
        if (String(sample[i][j]).trim().toUpperCase() === 'DELIMITADOR') hasDelim = true;
      }
    }
    // Formato JT/RZ: TAREA + DELIMITADOR — Formato ABASTECIMIENTO: PROVEEDOR + DELIMITADOR
    if ((hasTarea || hasProv) && hasDelim) r.push({ nombre: n, filas: lr });
  }
  return JSON.stringify(r);
}

// ============================================================
// PARSER OPTIMIZADO — Lee datos UNA vez por hoja
// ============================================================
function parsearBloques(nombreHoja) {
  var ajustes = getAjustes();
  var filMin = ajustes.filaMinima || FILA_MINIMA;
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var hojasAParsear = [];
  if (!nombreHoja || nombreHoja === 'TODAS') {
    var disp = JSON.parse(getHojasDisponibles());
    for (var d = 0; d < disp.length; d++) hojasAParsear.push(disp[d].nombre);
  } else {
    hojasAParsear.push(nombreHoja);
  }

  var bloques = [];
  for (var s = 0; s < hojasAParsear.length; s++) {
    var hoja = ss.getSheetByName(hojasAParsear[s]);
    if (!hoja) continue;
    var datos = hoja.getDataRange().getValues();
    var ba = null;
    var pendProv = '', pendOC = ''; // Para formato ABASTECIMIENTO

    for (var i = 0; i < datos.length; i++) {
      var p = String(datos[i][0]).trim().toUpperCase();

      // === FORMATO JT/RZ: fila TAREA ===
      if (p === 'TAREA:' || p === 'TAREA') {
        if (ba && ba.items.length > 0 && ba.fi >= filMin) bloques.push(ba);
        var nt = '';
        for (var t = 1; t < datos[i].length; t++) {
          var v = String(datos[i][t]).trim();
          if (v && v !== '' && v !== 'GENERAL') { nt = v; break; }
        }
        ba = { tarea: nt, hoja: hojasAParsear[s], fi: i + 1, enc: [], ci: {}, items: [], _tipo: 'tarea' };
        pendProv = ''; pendOC = '';
        continue;
      }

      // === FORMATO ABASTECIMIENTO: fila PROVEEDOR ===
      if (p === 'PROVEEDOR') {
        if (ba && ba.items.length > 0 && ba.fi >= filMin) bloques.push(ba);
        pendProv = String(datos[i][1] || '').trim();
        pendOC = '';
        ba = null;
        continue;
      }

      // === FORMATO ABASTECIMIENTO: fila OC ===
      if (p === 'OC' && pendProv) {
        pendOC = String(datos[i][1] || '').trim();
        ba = { tarea: 'OC-' + pendOC, hoja: hojasAParsear[s], fi: i + 1, enc: [], ci: {}, items: [], _tipo: 'abast', _prov: pendProv, _oc: pendOC };
        continue;
      }

      if (!ba) continue;

      // === DELIMITADOR ===
      var isDel = false;
      for (var dd = 0; dd < datos[i].length; dd++) {
        if (String(datos[i][dd]).trim().toUpperCase() === 'DELIMITADOR') { isDel = true; break; }
      }
      if (isDel) {
        if (ba.items.length > 0 && ba.fi >= filMin) bloques.push(ba);
        ba = null; pendProv = ''; pendOC = '';
        continue;
      }

      // === ENCABEZADOS — DETALLE (JT/RZ) o DESCRIPCIÓN (ABASTECIMIENTO) ===
      var isH = false;
      for (var h = 0; h < datos[i].length; h++) {
        var hVal = String(datos[i][h]).trim().toUpperCase().replace(/\n/g, ' ');
        if (hVal === 'DETALLE' || hVal === 'DESCRIPCIÓN' || hVal === 'DESCRIPCION') { isH = true; break; }
      }
      if (isH) {
        ba.enc = []; ba.ci = {};
        for (var e = 0; e < datos[i].length; e++) {
          var en = String(datos[i][e]).trim().replace(/\n/g, ' ');
          if (en.toUpperCase() === 'DESCRIPCIÓN' || en.toUpperCase() === 'DESCRIPCION') en = 'DETALLE';
          ba.enc.push(en);
          if (en) ba.ci[en] = e;
        }
        continue;
      }

      // === DATA ROW ===
      var empty = true;
      for (var v = 0; v < datos[i].length; v++) { if (String(datos[i][v]).trim() !== '') { empty = false; break; } }
      if (!empty && ba.enc.length > 0) {
        var it = {};
        for (var c = 0; c < ba.enc.length; c++) {
          if (ba.enc[c]) it[ba.enc[c]] = String(datos[i][c]).trim();
        }
        // Para ABASTECIMIENTO: inyectar PROVEEDOR y ORDEN DE COMPRA del encabezado del bloque
        if (ba._tipo === 'abast') {
          if (!it['PROVEEDOR'] && ba._prov) it['PROVEEDOR'] = ba._prov;
          if (!it['ORDEN DE COMPRA'] && ba._oc) it['ORDEN DE COMPRA'] = ba._oc;
        }
        if (it['DETALLE'] && it['DETALLE'] !== '') {
          it._c = esCancelado(it); it._f = i + 1; it._h = hojasAParsear[s];
          ba.items.push(it);
        }
      }
    }
    if (ba && ba.items.length > 0 && ba.fi >= filMin) bloques.push(ba);
  }

  // Flags
  for (var b = 0; b < bloques.length; b++) {
    var bl = bloques[b], allC = true, anyC = false, allE = true, hasA = false;
    for (var i = 0; i < bl.items.length; i++) {
      var it = bl.items[i];
      if (it._c) { anyC = true; continue; } else allC = false;
      hasA = true;
      var pend = calcPend(it);
      if (pend > 0) allE = false;
    }
    bl._ca = allC && anyC;
    bl._en = hasA && allE && !bl._ca;
    bl._sem = bl._ca ? 'gris' : bl._en ? (function(){
      for(var i=0;i<bl.items.length;i++){if(bl.items[i]._c)continue;var ig=colVal(bl.items[i],['NRO. INGRESO','NRO INGRESO']);if(!ig||ig==='0')return 'amarillo';}return 'verde';
    })() : (function(){
      for(var i=0;i<bl.items.length;i++){if(bl.items[i]._c)continue;if(calcPend(bl.items[i])>0)return 'rojo';}return 'amarillo';
    })();
  }
  return bloques;
}

// ============================================================
// LOG
// ============================================================
function getOrCreateLog() {
  var ss = SpreadsheetApp.openById(SHEET_GESTION_ID);
  var h = ss.getSheetByName(LOG_SHEET_NAME);
  if (!h) {
    h = ss.insertSheet(LOG_SHEET_NAME);
    h.appendRow(['TIMESTAMP','USUARIO','HOJA','TAREA','DETALLE','TIPO','VALOR','CAMPO','FILA']);
    h.getRange(1,1,1,9).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#fff');
    h.setFrozenRows(1);
  }
  return h;
}

// ============================================================
// TRACKING DE FECHAS — primera vez que se ve cada tarea
// ============================================================
var TRACK_SHEET = 'TAREA_TRACKING';
function getTrackingDates() {
  var ss = SpreadsheetApp.openById(SHEET_GESTION_ID);
  var h = ss.getSheetByName(TRACK_SHEET);
  if (!h) {
    h = ss.insertSheet(TRACK_SHEET);
    h.appendRow(['TAREA','PRIMERA_VEZ']);
    h.getRange(1,1,1,2).setFontWeight('bold');
    h.setFrozenRows(1);
  }
  var d = h.getDataRange().getValues();
  var map = {};
  for (var i = 1; i < d.length; i++) {
    map[String(d[i][0]).trim()] = new Date(d[i][1]);
  }
  return { sheet: h, map: map };
}

function registrarTareasNuevas(bloques) {
  var track = getTrackingDates();
  var nuevas = [];
  var hoy = new Date();
  for (var b = 0; b < bloques.length; b++) {
    var t = bloques[b].tarea;
    if (!track.map[t]) {
      track.map[t] = hoy;
      nuevas.push([t, hoy]);
    }
    // Calcular días y criticidad
    var dias = Math.floor((hoy - track.map[t]) / 86400000);
    bloques[b]._dias = dias;
    if (dias <= 10) bloques[b]._crit = 'normal';
    else if (dias <= 20) bloques[b]._crit = 'atencion';
    else if (dias <= 30) bloques[b]._crit = 'urgente';
    else bloques[b]._crit = 'critico';
  }
  if (nuevas.length > 0) {
    track.sheet.getRange(track.sheet.getLastRow() + 1, 1, nuevas.length, 2).setValues(nuevas);
  }
  registrarTareasNuevas(bloques);
  return bloques;
}

// ============================================================
// BÚSQUEDA
// ============================================================
function buscarPalabraClave(kw, nh) {
  var bl = parsearBloques(nh), s = kw.toLowerCase().trim(), r = [];
  for (var b = 0; b < bl.length; b++) {
    var bk = bl[b], ok = false;
    if (bk.tarea.toLowerCase().indexOf(s) !== -1) ok = true;
    if (!ok) { for (var i = 0; i < bk.items.length; i++) { for (var k in bk.items[i]) { if (k.charAt(0)!=='_'&&String(bk.items[i][k]).toLowerCase().indexOf(s)!==-1){ok=true;break;}} if(ok)break; }}
    if (ok) { bk.enc=bk.enc.filter(function(e){return e!=='';}); r.push(bk); }
    if (r.length >= 30) break;
  }
  return JSON.stringify(r);
}

// ============================================================
// DASHBOARD
// ============================================================
function getDashboardData(nh) {
  var bl = parsearBloques(nh);
  var tt=bl.length,ti=0,pe=0,si=0,sf=0,co=0,ep=0,cr=0,ca=0,ic=0,en=0,ph={};
  var crit={normal:0,atencion:0,urgente:0,critico:0};
  for (var b=0;b<bl.length;b++) {
    var bk=bl[b], h=bk.hoja||'-', esAbast=bk._tipo==='abast';
    if(!ph[h])ph[h]={t:0,i:0,pe:0,si:0,co:0,cr:0,ca:0,en:0};
    ph[h].t++;
    if(bk._ca){ca++;ic+=bk.items.length;ph[h].ca++;continue;}
    if(bk._en){en++;ph[h].en++;}
    if(!bk._en&&bk._crit)crit[bk._crit]=(crit[bk._crit]||0)+1;
    var bc=true,bp=false;
    for(var i=0;i<bk.items.length;i++){
      var it=bk.items[i]; if(it._c){ic++;continue;} ti++; ph[h].i++;
      var pd=calcPend(it);
      if(pd>0){pe++;bc=false;bp=true;ph[h].pe++;}
      // Factura/Ingreso solo aplica para hojas que tienen esas columnas (no ABASTECIMIENTO)
      if(!esAbast){
        var ig=colVal(it,['NRO. INGRESO','NRO INGRESO']);
        var fa=colVal(it,['Factura No.','FACTURA NO.','Factura No']);
        if(!ig||ig===''||ig==='0'){si++;bc=false;ph[h].si++;}
        if(!fa||fa===''||fa==='0')sf++;
      }
    }
    if(bc){co++;ph[h].co++;}else if(bp){cr++;ph[h].cr++;}else ep++;
  }
  return JSON.stringify({tt:tt-ca,ti:ti,pe:pe,si:si,sf:sf,co:co,ep:ep,cr:cr,ca:ca,ic:ic,en:en,ph:ph,crit:crit});
}

// ============================================================
// POR RECIBIR — solo bloques con pendiente > 0, no cancelados/suspendidos
// ============================================================
function getPorRecibir(nh) {
  var bl=parsearBloques(nh),r=[];
  for(var b=0;b<bl.length;b++){
    var bk=bl[b]; if(bk._ca)continue;
    var itemsPend=[];
    for(var i=0;i<bk.items.length;i++){
      var it=bk.items[i]; if(it._c)continue;
      var pd=calcPend(it);
      if(pd>0)itemsPend.push(it);
    }
    if(itemsPend.length>0)r.push({tarea:bk.tarea,hoja:bk.hoja,enc:bk.enc.filter(function(e){return e!=='';}),items:itemsPend,_sem:bk._sem,_dias:bk._dias,_crit:bk._crit});
  }
  return JSON.stringify(r);
}

// ============================================================
// PROVEEDORES — excluye cancelados/suspendidos
// ============================================================
function getResumenProveedores(nh) {
  var bl=parsearBloques(nh),pv={};
  for(var b=0;b<bl.length;b++){
    var bk=bl[b]; if(bk._ca)continue;
    var esAbast=bk._tipo==='abast';
    for(var i=0;i<bk.items.length;i++){
      var it=bk.items[i]; if(it._c)continue;
      var n=(colVal(it,['PROVEEDOR'])||'SIN PROVEEDOR').toUpperCase();
      if(!n||n==='0')n='SIN PROVEEDOR';
      if(!pv[n])pv[n]={n:n,ti:0,pe:0,si:0,sf:0,oc:{},ta:{}};
      var p=pv[n]; p.ti++; p.ta[bk.tarea]=1;
      var oc=colVal(it,['ORDEN DE COMPRA']); if(oc&&oc!=='0')p.oc[oc]=1;
      if(calcPend(it)>0)p.pe++;
      if(!esAbast){
        var ig=colVal(it,['NRO. INGRESO','NRO INGRESO']); if(!ig||ig===''||ig==='0')p.si++;
        var fa=colVal(it,['Factura No.','FACTURA NO.','Factura No']); if(!fa||fa===''||fa==='0')p.sf++;
      }
    }
  }
  var r=[];for(var k in pv){var p=pv[k];r.push({n:p.n,ti:p.ti,pe:p.pe,si:p.si,sf:p.sf,oc:Object.keys(p.oc).length,ta:Object.keys(p.ta).length});}
  r.sort(function(a,b){return(b.pe+b.si)-(a.pe+a.si);});
  return JSON.stringify(r);
}

// ============================================================
// ALERTAS — con niveles de criticidad por antigüedad
// ============================================================
function getAlertas(nh) {
  var bl=parsearBloques(nh),r=[];
  for(var b=0;b<bl.length;b++){
    var bk=bl[b]; if(bk._ca||bk._en)continue;
    var esAbast=bk._tipo==='abast';
    var hp=false,hs=false,provs={};
    for(var i=0;i<bk.items.length;i++){
      var it=bk.items[i]; if(it._c)continue;
      if(calcPend(it)>0)hp=true;
      // Sin documentar solo aplica a hojas con factura/ingreso (no ABASTECIMIENTO)
      if(!esAbast){var ig=colVal(it,['NRO. INGRESO','NRO INGRESO']); if(!ig||ig===''||ig==='0')hs=true;}
      var pv=colVal(it,['PROVEEDOR']); if(pv&&pv!=='0')provs[pv]=1;
    }
    if(hp||hs){
      var motivos=[];
      if(hp)motivos.push('Pend. entrega');
      if(hs)motivos.push('Sin documentar');
      r.push({t:bk.tarea,h:bk.hoja,n:bk.items.length,m:motivos,s:bk._sem,p:Object.keys(provs).join(', '),dias:bk._dias||0,crit:bk._crit||'normal'});
    }
  }
  // Ordenar por criticidad: critico > urgente > atencion > normal
  var orden={critico:0,urgente:1,atencion:2,normal:3};
  r.sort(function(a,b){return (orden[a.crit]||3)-(orden[b.crit]||3);});
  return JSON.stringify(r);
}

// ============================================================
// SIN DOCUMENTAR — entregados (pend=0) pero sin factura Y/O sin ingreso, no cancelados
// ============================================================
function getSinDocumentar(nh) {
  var bl=parsearBloques(nh),r=[];
  for(var b=0;b<bl.length;b++){
    var bk=bl[b]; if(bk._ca||bk._tipo==='abast')continue; // ABASTECIMIENTO no tiene factura/ingreso
    for(var i=0;i<bk.items.length;i++){
      var it=bk.items[i]; if(it._c)continue;
      var pd=calcPend(it);
      if(pd>0)continue;
      var ig=colVal(it,['NRO. INGRESO','NRO INGRESO']),fa=colVal(it,['Factura No.','FACTURA NO.','Factura No']);
      var hi=ig&&ig!==''&&ig!=='0',hf=fa&&fa!==''&&fa!=='0';
      var falta=[];
      if(!hf)falta.push('FACTURA');
      if(!hi)falta.push('NRO. INGRESO');
      if(falta.length>0)r.push({t:bk.tarea,h:bk.hoja,d:it['DETALLE'],falta:falta.join(' + '),tiene:(hf?'Fact: '+fa:'')+(hi?' Ing: '+ig:''),pv:colVal(it,['PROVEEDOR'])});
    }
  }
  return JSON.stringify(r);
}

// ============================================================
// REGISTRO RÁPIDO — busca por tarea o OC
// ============================================================
function getItemsParaRegistro(busq, nh) {
  var bl=parsearBloques(nh||'TODAS'),r=[],term=busq.trim().toLowerCase();
  for(var b=0;b<bl.length;b++){
    var bk=bl[b],ok=false;
    if(bk.tarea.toLowerCase().indexOf(term)!==-1)ok=true;
    if(!ok){for(var i=0;i<bk.items.length;i++){var oc=colVal(bk.items[i],['ORDEN DE COMPRA']).toLowerCase();if(oc&&oc.indexOf(term)!==-1){ok=true;break;}}}
    if(ok){bk.enc=bk.enc.filter(function(e){return e!=='';});r.push(bk);}
    if(r.length>=15)break;
  }
  return JSON.stringify(r);
}

// ============================================================
// ESCRITURA DIRECTA — append con "/", cantidad entregada
// ============================================================
function guardarRegistroBatch(jsonStr) {
  var regs=JSON.parse(jsonStr),log=getOrCreateLog();
  var ahora=Utilities.formatDate(new Date(),'America/Guayaquil','yyyy-MM-dd HH:mm:ss');
  var usr=Session.getActiveUser().getEmail()||'App';
  var ss=SpreadsheetApp.openById(SPREADSHEET_ID),guardados=0;

  // Agrupar por hoja
  var porH={};
  for(var i=0;i<regs.length;i++){var r=regs[i];if(!porH[r.hoja])porH[r.hoja]=[];porH[r.hoja].push(r);}

  for(var nh in porH){
    var hoja=ss.getSheetByName(nh); if(!hoja)continue;
    var datos=hoja.getDataRange().getValues();
    var items=porH[nh];
    for(var i=0;i<items.length;i++){
      var reg=items[i],fr=reg.filaReal;
      // Buscar encabezados hacia arriba
      var cF=-1,cI=-1,cO=-1,cCE=-1,cP=-1,cCS=-1;
      for(var r=fr-2;r>=0;r--){
        var found=false;
        for(var c=0;c<datos[r].length;c++){
          var h=String(datos[r][c]).trim().toUpperCase().replace(/\n/g,' ');
          if(h==='FACTURA NO.'||h==='FACTURA NO')cF=c;
          if(h==='NRO. INGRESO'||h==='NRO INGRESO')cI=c;
          if(h==='OBSERVACIONES'||h==='OBSERVACION')cO=c;
          if(h==='CANTIDAD ENTREGADA')cCE=c;
          if(h==='PENDIENTE ENTREGA')cP=c;
          if(h==='CANTIDAD SOLICITADA')cCS=c;
          if(h==='DETALLE'||h==='DESCRIPCIÓN'||h==='DESCRIPCION')found=true;
        }
        if(found)break;
      }
      // FACTURA — append /
      if(reg.factura&&reg.factura.trim()!==''&&cF>=0){
        var act=String(datos[fr-1][cF]).trim(),nv=reg.factura.trim();
        if(act&&act!==''&&act!=='0')nv=act+' / '+nv;
        hoja.getRange(fr,cF+1).setValue(nv);
        log.appendRow([ahora,usr,nh,reg.tarea,reg.detalle,'FACTURA',reg.factura.trim(),'Factura No.',fr]);
        guardados++;
      }
      // INGRESO — append /
      if(reg.ingreso&&reg.ingreso.trim()!==''&&cI>=0){
        var act=String(datos[fr-1][cI]).trim(),nv=reg.ingreso.trim();
        if(act&&act!==''&&act!=='0')nv=act+' / '+nv;
        hoja.getRange(fr,cI+1).setValue(nv);
        log.appendRow([ahora,usr,nh,reg.tarea,reg.detalle,'INGRESO',reg.ingreso.trim(),'NRO. INGRESO',fr]);
        guardados++;
      }
      // CANTIDAD ENTREGADA
      if(reg.cantEnt&&parseFloat(reg.cantEnt)>0&&cCE>=0){
        var cn=parseFloat(reg.cantEnt),ea=parseFloat(datos[fr-1][cCE])||0,ne=ea+cn;
        hoja.getRange(fr,cCE+1).setValue(ne);
        if(cP>=0&&cCS>=0){var sol=parseFloat(datos[fr-1][cCS])||0;hoja.getRange(fr,cP+1).setValue(Math.max(0,sol-ne));}
        log.appendRow([ahora,usr,nh,reg.tarea,reg.detalle,'CANT_ENT','+'+cn+' (='+ne+')','CANTIDAD ENTREGADA',fr]);
        guardados++;
      }
      // OBSERVACIÓN — append /
      if(reg.obs&&reg.obs.trim()!==''&&cO>=0){
        var act=String(datos[fr-1][cO]).trim(),nv=reg.obs.trim();
        if(act&&act!==''&&act!=='0')nv=act+' / '+nv;
        hoja.getRange(fr,cO+1).setValue(nv);
        log.appendRow([ahora,usr,nh,reg.tarea,reg.detalle,'OBS',reg.obs.trim(),'OBSERVACIONES',fr]);
        guardados++;
      }
    }
  }
  return JSON.stringify({ok:true,g:guardados,ts:ahora});
}

// ============================================================
// LOG RECIENTE
// ============================================================
function getLogReciente(lim) {
  lim=lim||50; var log=getOrCreateLog(),d=log.getDataRange().getValues(),r=[];
  for(var i=d.length-1;i>=1;i--){
    r.push({ts:String(d[i][0]),u:String(d[i][1]),h:String(d[i][2]),t:String(d[i][3]),d:String(d[i][4]),tp:String(d[i][5]),v:String(d[i][6])});
    if(r.length>=lim)break;
  }
  return JSON.stringify(r);
}

// ============================================================
// CRUCE
// ============================================================
function getCruceTareas(nh) {
  var bl=parsearBloques(nh);
  var ssG;try{ssG=SpreadsheetApp.openById(SHEET_GESTION_ID);}catch(e){return JSON.stringify({error:'Sin acceso a Gestión'});}
  var hG=ssG.getSheetByName(SHEET_GESTION_NAME)||ssG.getSheets()[0];
  var dG=hG.getDataRange().getValues(),tG={};
  for(var i=1;i<dG.length;i++){for(var j=0;j<dG[i].length;j++){var v=String(dG[i][j]).trim();for(var b=0;b<bl.length;b++){if(v&&v===bl[b].tarea)tG[v]=true;}}}
  var r=[];
  for(var b=0;b<bl.length;b++){
    var bk=bl[b], esAbast=bk._tipo==='abast';
    var siCount = 0;
    if(!esAbast){
      siCount = bk.items.filter(function(it){if(it._c)return false;var ig=colVal(it,['NRO. INGRESO','NRO INGRESO']);return !ig||ig===''||ig==='0';}).length;
    }
    r.push({t:bk.tarea,h:bk.hoja,s:bk._sem,ca:bk._ca||false,ni:bk.items.length,
      pe:bk.items.filter(function(it){return !it._c&&calcPend(it)>0;}).length,
      si:siCount,
      eg: esAbast ? true : (tG[bk.tarea]||false) // ABASTECIMIENTO no tiene tarea en Gestión, marcar como OK
    });
  }
  return JSON.stringify(r);
}

// ============================================================
// REPORTE ACTA DE ENTREGA — genera datos para el formato
// ============================================================
function generarReporteActa(fechaDesde, fechaHasta) {
  var log = getOrCreateLog();
  var datos = log.getDataRange().getValues();
  var desde = new Date(fechaDesde); desde.setHours(0,0,0,0);
  var hasta = new Date(fechaHasta); hasta.setHours(23,59,59,999);

  // Recolectar facturas e ingresos del rango
  var registros = {}; // key: hoja+tarea+detalle+fila
  for (var i = 1; i < datos.length; i++) {
    var ts = new Date(datos[i][0]);
    if (ts < desde || ts > hasta) continue;
    var tipo = String(datos[i][5]).trim();
    if (tipo !== 'FACTURA' && tipo !== 'INGRESO') continue;
    var hoja = String(datos[i][2]).trim();
    var tarea = String(datos[i][3]).trim();
    var detalle = String(datos[i][4]).trim();
    var valor = String(datos[i][6]).trim();
    var fila = String(datos[i][8]).trim();
    var key = hoja + '|' + tarea + '|' + fila;
    if (!registros[key]) registros[key] = { hoja: hoja, tarea: tarea, detalle: detalle, proveedor: '', factura: '', ingreso: '', oc: '', fecha: Utilities.formatDate(ts, 'America/Guayaquil', 'dd-MM-yy') };
    if (tipo === 'FACTURA') registros[key].factura = valor;
    if (tipo === 'INGRESO') registros[key].ingreso = valor;
  }

  // Enriquecer con datos actuales de la hoja (proveedor, OC)
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var hojaCache = {};
  for (var key in registros) {
    var reg = registros[key];
    if (!hojaCache[reg.hoja]) {
      var h = ss.getSheetByName(reg.hoja);
      hojaCache[reg.hoja] = h ? h.getDataRange().getValues() : null;
    }
    var d = hojaCache[reg.hoja];
    if (d) {
      var parts = key.split('|');
      var fila = parseInt(parts[2]) - 1;
      if (fila >= 0 && fila < d.length) {
        // Buscar encabezados
        for (var r = fila; r >= 0; r--) {
          var isH = false;
          for (var c = 0; c < d[r].length; c++) {
            var h = String(d[r][c]).trim().toUpperCase().replace(/\n/g,' ');
            if (h === 'PROVEEDOR') reg.proveedor = String(d[fila][c]).trim();
            if (h === 'ORDEN DE COMPRA' || h === 'ORDEN DE COMPRA') reg.oc = String(d[fila][c]).trim();
            if (h === 'DETALLE' || h === 'DESCRIPCIÓN' || h === 'DESCRIPCION') isH = true;
          }
          if (isH) break;
        }
      }
    }
  }

  var items = [];
  for (var key in registros) items.push(registros[key]);

  // Deduplicar por número de factura — si varias filas comparten la misma factura, solo 1 entrada
  var facturasVistas = {};
  var itemsUnicos = [];
  for (var i = 0; i < items.length; i++) {
    var fac = items[i].factura;
    if (!fac || fac === '' || fac === '0') {
      // Sin factura pero con ingreso: incluir
      if (items[i].ingreso && items[i].ingreso !== '' && items[i].ingreso !== '0') itemsUnicos.push(items[i]);
      continue;
    }
    if (facturasVistas[fac]) continue; // Ya incluida
    facturasVistas[fac] = true;
    itemsUnicos.push(items[i]);
  }

  itemsUnicos.sort(function(a, b) { return a.hoja.localeCompare(b.hoja) || a.tarea.localeCompare(b.tarea); });
  return JSON.stringify(itemsUnicos);
}

// ============================================================
// GENERAR EXCEL ACTA
// ============================================================
function generarExcelActa(fechaDesde, fechaHasta) {
  var items = JSON.parse(generarReporteActa(fechaDesde, fechaHasta));
  if (!items.length) return JSON.stringify({ error: 'Sin registros en el rango' });

  var ss = SpreadsheetApp.create('ACTA_ENTREGA_' + fechaDesde + '_' + fechaHasta);
  var hoja = ss.getActiveSheet();
  hoja.setName('ACTA');

  // Header
  hoja.getRange('A1:H1').merge().setValue('ACTA DE ENTREGA Y RECEPCION DE FACTURAS').setHorizontalAlignment('center').setFontWeight('bold').setFontSize(12);
  var ajustes = getAjustes();
  hoja.getRange('A3').setValue('FECHA DE ENTREGA:'); hoja.getRange('D3').setValue(fechaHasta);
  hoja.getRange('A4').setValue('DEPARTAMENTO EMISOR:'); hoja.getRange('D4').setValue('COMPRAS');
  hoja.getRange('A5').setValue('RESPONSABLE:'); hoja.getRange('D5').setValue(ajustes.responsable);
  hoja.getRange('A3:A5').setFontWeight('bold');

  // Table headers
  var headers = ['Nro.','PROVEEDOR','N°CREDITO','FECHA DE FACTURA','ORDEN DE COMPRA','NUMERO DE INGRESO','N° DE TAREA','HOJA'];
  hoja.getRange(7, 1, 1, 8).setValues([headers]).setFontWeight('bold').setBackground('#B7DEE8').setHorizontalAlignment('center');

  // Data
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    hoja.getRange(8 + i, 1, 1, 8).setValues([[i + 1, it.proveedor, it.factura, it.fecha, it.oc, it.ingreso, it.tarea, it.hoja]]);
  }

  // Format
  hoja.autoResizeColumns(1, 8);
  hoja.getRange(7, 1, items.length + 1, 8).setBorder(true, true, true, true, true, true);

  // Convert to blob
  var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
  var blob = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob();
  blob.setName('Acta_Entrega_' + fechaDesde + '_a_' + fechaHasta + '.xlsx');

  // Cleanup temp file
  DriveApp.getFileById(ss.getId()).setTrashed(true);

  return JSON.stringify({ ok: true, count: items.length });
}

// ============================================================
// ENVIAR REPORTE POR EMAIL
// ============================================================
function enviarReporteActa(fechaDesde, fechaHasta) {
  var items = JSON.parse(generarReporteActa(fechaDesde, fechaHasta));
  if (!items.length) return 'Sin registros en el rango';
  var ajustes = getAjustes();
  if (!ajustes.emailDestino) return 'Configura el email en Ajustes';

  // Generar Excel con Nro. en primera columna
  var ss = SpreadsheetApp.create('ACTA_TEMP');
  var hoja = ss.getActiveSheet(); hoja.setName('ACTA');
  hoja.getRange('A1:H1').merge().setValue('ACTA DE ENTREGA Y RECEPCION DE FACTURAS').setHorizontalAlignment('center').setFontWeight('bold').setFontSize(12);
  hoja.getRange('A3').setValue('FECHA DE ENTREGA:'); hoja.getRange('D3').setValue(fechaHasta);
  hoja.getRange('A4').setValue('DEPARTAMENTO EMISOR:'); hoja.getRange('D4').setValue('COMPRAS');
  hoja.getRange('A5').setValue('RESPONSABLE:'); hoja.getRange('D5').setValue(ajustes.responsable);
  hoja.getRange('A3:A5').setFontWeight('bold');
  var headers = ['Nro.','PROVEEDOR','N°CREDITO','FECHA DE FACTURA','ORDEN DE COMPRA','NUMERO DE INGRESO','N° DE TAREA','HOJA'];
  hoja.getRange(7,1,1,8).setValues([headers]).setFontWeight('bold').setBackground('#B7DEE8').setHorizontalAlignment('center');
  for(var i=0;i<items.length;i++){
    var it=items[i];
    hoja.getRange(8+i,1,1,8).setValues([[i+1,it.proveedor,it.factura,it.fecha,it.oc,it.ingreso,it.tarea,it.hoja]]);
  }
  hoja.autoResizeColumns(1,8);
  hoja.getRange(7,1,items.length+1,8).setBorder(true,true,true,true,true,true);
  SpreadsheetApp.flush();

  var url='https://docs.google.com/spreadsheets/d/'+ss.getId()+'/export?format=xlsx';
  var blob=UrlFetchApp.fetch(url,{headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()}}).getBlob();
  blob.setName('Acta_Entrega_'+fechaDesde+'_a_'+fechaHasta+'.xlsx');

  // HTML body con tabla embebida
  var html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333">';
  html += '<p>Su gentil ayuda digitalizando el siguiente detalle de facturas. (Las facturas físicas fueron entregadas a digitalización).</p><br>';
  html += '<table style="border-collapse:collapse;width:100%;font-size:12px">';
  html += '<tr style="background:#B7DEE8;font-weight:bold;text-align:center">';
  html += '<td style="border:1px solid #999;padding:6px">Nro.</td>';
  html += '<td style="border:1px solid #999;padding:6px">PROVEEDOR</td>';
  html += '<td style="border:1px solid #999;padding:6px">N°CREDITO</td>';
  html += '<td style="border:1px solid #999;padding:6px">FECHA DE FACTURA</td>';
  html += '<td style="border:1px solid #999;padding:6px">ORDEN DE COMPRA</td>';
  html += '<td style="border:1px solid #999;padding:6px">NUMERO DE INGRESO</td>';
  html += '<td style="border:1px solid #999;padding:6px">N° DE TAREA</td>';
  html += '<td style="border:1px solid #999;padding:6px">HOJA</td></tr>';
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var bg = i % 2 === 0 ? '#fff' : '#f5f5f5';
    html += '<tr style="background:' + bg + '">';
    html += '<td style="border:1px solid #ccc;padding:5px;text-align:center">' + (i+1) + '</td>';
    html += '<td style="border:1px solid #ccc;padding:5px">' + (it.proveedor||'') + '</td>';
    html += '<td style="border:1px solid #ccc;padding:5px;text-align:center">' + (it.factura||'') + '</td>';
    html += '<td style="border:1px solid #ccc;padding:5px;text-align:center">' + (it.fecha||'') + '</td>';
    html += '<td style="border:1px solid #ccc;padding:5px;text-align:center">' + (it.oc||'') + '</td>';
    html += '<td style="border:1px solid #ccc;padding:5px;text-align:center">' + (it.ingreso||'') + '</td>';
    html += '<td style="border:1px solid #ccc;padding:5px;text-align:center">' + (it.tarea||'') + '</td>';
    html += '<td style="border:1px solid #ccc;padding:5px;text-align:center">' + (it.hoja||'') + '</td></tr>';
  }
  html += '</table><br>';
  html += '<p>Saludos,<br><b>' + ajustes.responsable + '</b></p></div>';

  var plainBody = 'Estimados Compras,\n\nSe acaba de generar un reporte de facturas ingresadas las cuales se deben compartir cuando sean digitalizadas.\n\nTotal: ' + items.length + ' registros\nPeriodo: ' + fechaDesde + ' al ' + fechaHasta + '\n\nSaludos,\n' + ajustes.responsable;

  var mailOpts = { to: ajustes.emailDestino, subject: 'DETALLE DE ENTREGA DE FACTURAS ' + fechaHasta, body: plainBody, htmlBody: html, attachments: [blob] };
  if (ajustes.emailCC) mailOpts.cc = ajustes.emailCC;
  MailApp.sendEmail(mailOpts);

  DriveApp.getFileById(ss.getId()).setTrashed(true);
  return 'Email enviado a ' + ajustes.emailDestino + ' con ' + items.length + ' registros';
}

function configurarTriggerDiario() {
  var triggers=ScriptApp.getProjectTriggers();
  for(var i=0;i<triggers.length;i++){if(triggers[i].getHandlerFunction()==='enviarResumenAuto')ScriptApp.deleteTrigger(triggers[i]);}
  ScriptApp.newTrigger('enviarResumenAuto').timeBased().everyDays(1).atHour(7).inTimezone('America/Guayaquil').create();
  return 'Trigger activo: 7am diario';
}
function enviarResumenAuto() {
  var hoy = Utilities.formatDate(new Date(), 'America/Guayaquil', 'yyyy-MM-dd');
  enviarReporteActa(hoy, hoy);
}

// ============================================================
// ASISTENTE IA — Context-aware: envía SOLO lo necesario
// Chat=0 datos, búsqueda=solo matches, resumen=solo stats
// ============================================================
// ASISTENTE IA — Motor inteligente multi-hoja
// FUENTES: 1) Detalle Pedidos (bloques TAREA→DELIMITADOR)
//          2) Gestión Tareas > Precios Enero (productos+precios)
//          3) Gestión Tareas > General (historial compras+departamentos)
// ============================================================

// Lee hoja "Precios Enero" de Gestión → productos, códigos (col H=idx7), precios
function leerPrecios() {
  try {
    var ss = SpreadsheetApp.openById(SHEET_GESTION_ID);
    var h = ss.getSheetByName('Precios Enero') || ss.getSheetByName('precios enero') || ss.getSheetByName('PRECIOS ENERO');
    if (!h) return [];
    var d = h.getDataRange().getValues();
    var enc = [];
    for (var j = 0; j < d[0].length; j++) { var c = String(d[0][j]).trim().replace(/\n/g,' '); if (c) enc.push({n:c,j:j}); }
    var rows = [];
    for (var i = 1; i < d.length; i++) {
      var obj = {};
      for (var e = 0; e < enc.length; e++) {
        var v = String(d[i][enc[e].j]).trim();
        if (v && v !== '' && v !== 'undefined') obj[enc[e].n] = v;
      }
      // Asegurar que columna H (idx 7) se guarde como _COD
      var colH = String(d[i][7] || '').trim();
      if (colH) obj._COD = colH;
      if (Object.keys(obj).length > 1) rows.push(obj);
    }
    return rows;
  } catch(e) { return []; }
}

// Lee hoja "General" o "Hoja 1" de Gestión → historial compras, códigos (col B=idx1), departamentos
function leerGeneral() {
  try {
    var ss = SpreadsheetApp.openById(SHEET_GESTION_ID);
    var h = ss.getSheetByName('General') || ss.getSheetByName('general') || ss.getSheetByName(SHEET_GESTION_NAME) || ss.getSheets()[0];
    if (!h) return [];
    var d = h.getDataRange().getValues();
    var enc = [];
    for (var j = 0; j < d[0].length; j++) { var c = String(d[0][j]).trim().replace(/\n/g,' '); if (c) enc.push({n:c,j:j}); }
    var rows = [];
    for (var i = 1; i < d.length; i++) {
      var obj = {};
      for (var e = 0; e < enc.length; e++) {
        var v = String(d[i][enc[e].j]).trim();
        if (v && v !== '' && v !== 'undefined') obj[enc[e].n] = v;
      }
      // Asegurar que columna B (idx 1) se guarde como _COD
      var colB = String(d[i][1] || '').trim();
      if (colB) obj._COD = colB;
      if (Object.keys(obj).length > 1) rows.push(obj);
    }
    return rows;
  } catch(e) { return []; }
}

// Stemmer español simple — no toca palabras cortas ni códigos
function stemES(palabra) {
  // No tocar códigos (contienen guiones o son números puros)
  if (/\d/.test(palabra) || palabra.indexOf('-') !== -1) return palabra.toLowerCase();
  // No tocar palabras cortas (marcas: SIKA, KYWI, PADI)
  if (palabra.length <= 5) return palabra.toLowerCase();
  var s = palabra.toLowerCase().replace(/(oras?|ores?|iones?|ados?|idas?|bles?|mente|ción|sión|dora?s?|ador|tura|ería|ero|era|ista|ivo|iva|nte|es|as|os|s)$/i, '');
  return s.length >= 3 ? s : palabra.toLowerCase();
}

// Busca en un array de objetos — prioriza búsqueda por _COD para códigos
function buscarEnHoja(rows, stems, palabras, maxR, prefijo) {
  var res = [];
  // Separar códigos de palabras normales
  var codigos = [], normales = [], stemsN = [];
  for (var w = 0; w < palabras.length; w++) {
    if (/\d{1,2}-\d{1,2}-\d{1,2}/.test(palabras[w])) codigos.push(palabras[w]);
    else { normales.push(palabras[w]); if (w < stems.length) stemsN.push(stems[w]); }
  }

  for (var i = 0; i < rows.length && res.length < maxR; i++) {
    var hit = false;
    // Búsqueda directa por código en _COD
    if (codigos.length > 0 && rows[i]._COD) {
      var cod = String(rows[i]._COD).toLowerCase();
      for (var c = 0; c < codigos.length; c++) {
        if (cod.indexOf(codigos[c]) !== -1 || codigos[c].indexOf(cod) !== -1) { hit = true; break; }
      }
    }
    // Búsqueda en todo el texto de la fila
    if (!hit) {
      var rowText = '';
      for (var k in rows[i]) rowText += ' ' + String(rows[i][k]).toLowerCase();
      // Buscar códigos en texto completo también
      for (var c = 0; c < codigos.length; c++) {
        if (rowText.indexOf(codigos[c]) !== -1) { hit = true; break; }
      }
      if (!hit) {
        for (var w = 0; w < normales.length; w++) {
          if (rowText.indexOf(normales[w]) !== -1) { hit = true; break; }
          if (w < stemsN.length && stemsN[w] !== normales[w] && rowText.indexOf(stemsN[w]) !== -1) { hit = true; break; }
        }
      }
    }
    if (hit) {
      var parts = [];
      for (var k in rows[i]) {
        if (k === '_COD') parts.push('Código:' + rows[i][k]);
        else parts.push(k + ':' + String(rows[i][k]).substring(0, 60));
      }
      res.push(prefijo + parts.join('|'));
    }
  }
  return res;
}

function preguntarIA(pregunta, nombreHoja, historialJSON) {
  var ajustes = getAjustes();
  var provider = ajustes.iaProvider || 'groq';
  var key = provider === 'openrouter' ? ajustes.apiKeyOpenRouter : ajustes.apiKeyGroq;
  if (!key) return JSON.stringify({ error: 'Configura tu API Key en Ajustes' });

  var q = pregunta.toLowerCase().replace(/[?¿!¡.,]/g, '');

  // TIER 1: CHAT
  var chatWords = ['hola','buenos','buenas','gracias','ok','bien','perfecto','chao','adios','ayuda','que puedes'];
  var isChat = false;
  for (var c = 0; c < chatWords.length; c++) { if (q.indexOf(chatWords[c]) !== -1 && q.length < 25) { isChat = true; break; } }
  if (isChat) {
    return callIA(key, provider, 'Asistente Compras TN UIO. Español, emojis. Breve (3 líneas). Tienes acceso a: seguimiento de pedidos, precios referenciales, historial de compras por departamento, proveedores, OC, facturas, ingresos.', pregunta, historialJSON);
  }

  // --- CONTEXTO DEL HISTORIAL ---
  var allText = q;
  if (historialJSON) {
    try {
      var hst = JSON.parse(historialJSON);
      for (var h = Math.max(0, hst.length - 4); h < hst.length; h++) allText += ' ' + hst[h].t.toLowerCase();
    } catch(e) {}
  }

  // --- PREPARAR BÚSQUEDA ---
  var bloques = parsearBloques(nombreHoja || 'TODAS');

  // Stop-words: palabras genéricas que matchean TODO
  var stopWords = 'que como cual cuando donde quien por para con sin del las los una uno este ese esos esta estos estas puede pueden hay tiene tienen ser son fue haber esa esas item items producto productos proveedor proveedores precio precios compra compras vender venta comprar comprado ultimo primera primero pendiente pendientes tarea tareas hoja dato datos numero orden factura ingreso favor dame dime lista muestra busca encuentra cuanto cuantos cuantas codigo codigos pertenece corresponde asociado asociada relacionado tener necesito necesita cuantas cuantos alguno alguna'.split(' ');
  var stopSet = {};
  for (var s = 0; s < stopWords.length; s++) stopSet[stopWords[s]] = 1;

  // Extraer códigos formato XX-XX-XX-XXX
  var codigos = q.match(/\d{1,2}-\d{1,2}-\d{1,2}-\d{1,3}/g) || [];
  // Extraer números de tarea/OC (5+ dígitos)
  var numeros = q.match(/\b\d{5,12}\b/g) || [];

  // Filtrar stop-words
  var rawWords = q.split(/[\s,;]+/).filter(function(w) { return w.length > 2; });
  var palabras = [];
  for (var w = 0; w < rawWords.length; w++) {
    if (!stopSet[rawWords[w]]) palabras.push(rawWords[w]);
  }
  for (var c = 0; c < codigos.length; c++) palabras.push(codigos[c]);
  for (var n = 0; n < numeros.length; n++) palabras.push(numeros[n]);

  // --- DETECCIÓN DE FOLLOW-UP ---
  // Si después de filtrar quedan 0-1 keywords útiles Y hay historial → es follow-up
  // Extraer nombres de productos, proveedores, tareas y códigos del historial
  var esFollowUp = (palabras.length <= 1 && historialJSON);
  if (esFollowUp || /\b(este|ese|esos|estas|estos|anterior|mencion|mismo|el que|la que)\b/.test(q)) {
    try {
      var hst = JSON.parse(historialJSON || '[]');
      for (var h = Math.max(0, hst.length - 4); h < hst.length; h++) {
        var txt = hst[h].t;
        // Extraer proveedores conocidos
        var proveedoresDB2 = {};
        for (var b = 0; b < bloques.length; b++) {
          for (var i = 0; i < bloques[b].items.length; i++) {
            var pv = colVal(bloques[b].items[i], ['PROVEEDOR']);
            if (pv) proveedoresDB2[pv.toUpperCase()] = 1;
          }
        }
        for (var pv in proveedoresDB2) {
          if (txt.toLowerCase().indexOf(pv.toLowerCase()) !== -1) palabras.push(pv.toLowerCase());
        }
        // Extraer números de tarea/OC
        var nums = txt.match(/\b\d{5,12}\b/g);
        if (nums) { for (var n = 0; n < nums.length; n++) palabras.push(nums[n]); }
        // Extraer códigos de producto
        var cods = txt.match(/\d{1,2}-\d{1,2}-\d{1,2}-\d{1,3}/g);
        if (cods) { for (var c = 0; c < cods.length; c++) palabras.push(cods[c]); }
        // Extraer palabras sustantivas largas del historial (nombres de productos)
        var histWords = txt.toLowerCase().split(/[\s,;|:]+/).filter(function(w) { return w.length > 3 && !stopSet[w]; });
        for (var hw = 0; hw < histWords.length; hw++) {
          // Solo agregar si parecen nombres de producto (mayúsculas en original, o alfanuméricos)
          if (/[A-Z]{2,}/.test(txt.substring(txt.toLowerCase().indexOf(histWords[hw]), txt.toLowerCase().indexOf(histWords[hw]) + histWords[hw].length + 2)) || /\d/.test(histWords[hw])) {
            palabras.push(histWords[hw]);
          }
        }
      }
    } catch(e) {}
    // Deduplicar
    var unique = {};
    var deduped = [];
    for (var p = 0; p < palabras.length; p++) {
      if (!unique[palabras[p]]) { unique[palabras[p]] = 1; deduped.push(palabras[p]); }
    }
    palabras = deduped;
  }

  var stems = [];
  for (var w = 0; w < palabras.length; w++) stems.push(stemES(palabras[w]));

  // --- CARGAR FUENTES COMPLEMENTARIAS ---
  var precios = leerPrecios();
  var general = leerGeneral();

  // Índice: tarea → filas de Gestión
  var gestionPorTarea = {};
  // Índice: código (col B General) → filas de Gestión
  var gestionPorCodigo = {};
  for (var g = 0; g < general.length; g++) {
    var row = general[g];
    var nTarea = '';
    for (var k in row) {
      if (k.toUpperCase().indexOf('TAREA') !== -1) { nTarea = String(row[k]).trim(); break; }
    }
    if (nTarea) {
      if (!gestionPorTarea[nTarea]) gestionPorTarea[nTarea] = [];
      gestionPorTarea[nTarea].push(row);
    }
    if (row._COD) {
      var codKey = String(row._COD).trim().toLowerCase();
      if (!gestionPorCodigo[codKey]) gestionPorCodigo[codKey] = [];
      gestionPorCodigo[codKey].push(row);
    }
  }

  // Índice: código (col H Precios) → fila de Precios
  var preciosPorCodigo = {};
  var preciosPorProducto = {};
  for (var p = 0; p < precios.length; p++) {
    var rowP = precios[p];
    if (rowP._COD) preciosPorCodigo[String(rowP._COD).trim().toLowerCase()] = rowP;
    for (var k in rowP) {
      var val = String(rowP[k]).toLowerCase();
      if (val.length > 5 && k !== '_COD') preciosPorProducto[val] = rowP;
    }
  }

  // --- BÚSQUEDA DIRECTA POR CÓDIGO XX-XX-XX-XXX ---
  // Prioridad: 1° Precios Enero col H, 2° General col B
  if (codigos.length > 0) {
    var directMatches = [];
    for (var c = 0; c < codigos.length; c++) {
      var cod = codigos[c].toLowerCase();
      // 1° Precios Enero (col H) — precios referenciales
      if (preciosPorCodigo[cod]) {
        var row = preciosPorCodigo[cod];
        var parts = [];
        for (var k in row) {
          if (k === '_COD') parts.push('Código:' + row[k]);
          else parts.push(k + ':' + String(row[k]).substring(0, 60));
        }
        directMatches.push('[PRECIO]' + parts.join('|'));
      }
      // 2° General (col B) — historial con departamento
      if (gestionPorCodigo[cod]) {
        var rows = gestionPorCodigo[cod];
        for (var r = 0; r < Math.min(rows.length, 5); r++) {
          var parts = [];
          for (var k in rows[r]) {
            if (k === '_COD') parts.push('Código:' + rows[r][k]);
            else parts.push(k + ':' + String(rows[r][k]).substring(0, 60));
          }
          directMatches.push('[GESTION]' + parts.join('|'));
        }
      }
    }
    if (directMatches.length > 0) {
      var ctx = 'Asistente Compras TN UIO. Español, emojis.\n'
        + 'BÚSQUEDA POR CÓDIGO. Fuentes: [PRECIO]=catálogo Precios Enero, [GESTION]=historial General.\n'
        + 'Encontré '+directMatches.length+' registros. SOLO usa estos datos.\n'
        + 'DATOS:\n' + directMatches.join('\n');
      return callIA(key, provider, ctx, pregunta, historialJSON);
    }
  }

  // --- BÚSQUEDA DIRECTA POR OC o TAREA (número) ---
  // Prioridad: 1° Detalle Pedidos (RZ, JT, ABASTECIMIENTO, etc.), 2° General
  if (numeros.length > 0) {
    var ocMatches = [];
    // 1° Buscar en Detalle Pedidos (bloques de todas las hojas)
    for (var b = 0; b < bloques.length; b++) {
      var bk = bloques[b]; if (bk._ca) continue;
      for (var i = 0; i < bk.items.length; i++) {
        var it = bk.items[i]; if (it._c) continue;
        var oc = colVal(it, ['ORDEN DE COMPRA']);
        var tarea = bk.tarea;
        for (var n = 0; n < numeros.length; n++) {
          if ((oc && oc.indexOf(numeros[n]) !== -1) || tarea.indexOf(numeros[n]) !== -1) {
            var pe = calcPend(it), fa = colVal(it,['Factura No.','FACTURA NO.','Factura No']), ig = colVal(it,['NRO. INGRESO','NRO INGRESO']);
            var ocVal = oc || '-';
            var provVal = colVal(it,['PROVEEDOR']) || 'SIN ASIGNAR';
            var comprado = (ocVal && ocVal !== '-' && ocVal !== '0') ? 'COMPRADO' : 'SIN_OC';
            var linea = '[PEDIDO]T:'+tarea+'|H:'+bk.hoja+'|'+comprado+'|'+(it['DETALLE']||'')+'|Prov:'+provVal+'|OC:'+ocVal+'|Sol:'+colVal(it,['CANTIDAD SOLICITADA'])+'|Ent:'+colVal(it,['CANTIDAD ENTREGADA'])+'|Pend:'+pe;
            if (fa&&fa!=='0') linea += '|Fact:'+fa;
            if (ig&&ig!=='0') linea += '|Ing:'+ig;
            ocMatches.push(linea);
            break;
          }
        }
        if (ocMatches.length >= 20) break;
      }
      if (ocMatches.length >= 20) break;
    }
    // 2° Si no hubo resultados en Pedidos, buscar en General
    if (ocMatches.length === 0) {
      for (var n = 0; n < numeros.length; n++) {
        for (var g = 0; g < general.length; g++) {
          var rowText = '';
          for (var k in general[g]) rowText += ' ' + String(general[g][k]);
          if (rowText.indexOf(numeros[n]) !== -1) {
            var parts = [];
            for (var k in general[g]) {
              if (k === '_COD') parts.push('Código:' + general[g][k]);
              else parts.push(k + ':' + String(general[g][k]).substring(0, 60));
            }
            ocMatches.push('[GESTION]' + parts.join('|'));
            if (ocMatches.length >= 10) break;
          }
        }
      }
    }
    if (ocMatches.length > 0) {
      var ctx = 'Asistente Compras TN UIO. Español, emojis.\n'
        + 'BÚSQUEDA POR OC/TAREA. Fuente principal: Detalle Pedidos.\n'
        + '- COMPRADO + OC = sí se compró a ese proveedor\n'
        + '- SIN_OC = aún no tiene orden de compra\n'
        + '- Prov: SIN ASIGNAR = no tiene proveedor definido\n'
        + 'Encontré '+ocMatches.length+' ítems. SOLO usa estos datos.\n'
        + 'DATOS:\n' + ocMatches.join('\n');
      return callIA(key, provider, ctx, pregunta, historialJSON);
    }
  }

  // --- BUSCAR EN DETALLE PEDIDOS + CRUZAR ---
  // SCORING: cada ítem recibe puntos por cada keyword que matchea
  // Más keywords = mejor match. SIKA+TOPP > solo SIKA
  var candidatos = [];

  for (var b = 0; b < bloques.length; b++) {
    var bk = bloques[b]; if (bk._ca) continue;
    var tareaScore = 0;
    for (var w = 0; w < palabras.length; w++) { if (bk.tarea.indexOf(palabras[w]) !== -1) tareaScore += 10; }

    for (var i = 0; i < bk.items.length; i++) {
      var it = bk.items[i]; if (it._c) continue;
      var det = (it['DETALLE'] || '').toLowerCase(), prov = colVal(it, ['PROVEEDOR']).toLowerCase(), oc = colVal(it, ['ORDEN DE COMPRA']).toLowerCase();
      var score = tareaScore;
      for (var w = 0; w < stems.length; w++) {
        if (det.indexOf(palabras[w]) !== -1) score += 5;     // palabra exacta en detalle
        else if (det.indexOf(stems[w]) !== -1) score += 3;   // stem en detalle
        if (prov.indexOf(palabras[w]) !== -1) score += 4;    // proveedor exacto
        else if (prov.indexOf(stems[w]) !== -1) score += 2;
        if (oc && oc.indexOf(palabras[w]) !== -1) score += 10;    // OC contiene número
        if (bk.tarea.indexOf(palabras[w]) !== -1) score += 10;   // Tarea contiene número
      }
      if (score > 0) candidatos.push({ b: b, i: i, score: score });
    }
  }

  // Ordenar por score DESC y tomar top 15
  candidatos.sort(function(a, b) { return b.score - a.score; });
  var matchesPedidos = [];
  for (var c = 0; c < Math.min(candidatos.length, 15); c++) {
    var bk = bloques[candidatos[c].b], it = bk.items[candidatos[c].i];
    var pe = calcPend(it), fa = colVal(it,['Factura No.','FACTURA NO.','Factura No']), ig = colVal(it,['NRO. INGRESO','NRO INGRESO']);
    var ocVal = colVal(it,['ORDEN DE COMPRA']);
    var comprado = (ocVal && ocVal !== '' && ocVal !== '0') ? 'COMPRADO' : 'SIN_OC';

        // Cruzar con Gestión: buscar depto y código por tarea
        var depto = '', codigo = '';
        if (gestionPorTarea[bk.tarea]) {
          var gRows = gestionPorTarea[bk.tarea];
          for (var g = 0; g < gRows.length; g++) {
            // Código directo de columna B
            if (gRows[g]._COD && /\d{1,2}-\d{1,2}-\d{1,2}/.test(gRows[g]._COD)) codigo = gRows[g]._COD;
            for (var k in gRows[g]) {
              var kU = k.toUpperCase();
              if (kU.indexOf('DEPART') !== -1 || kU.indexOf('SOLICIT') !== -1 || kU.indexOf('AREA') !== -1 || kU.indexOf('DEPT') !== -1) depto = gRows[g][k];
              if (!codigo && (kU.indexOf('CODIGO') !== -1 || kU.indexOf('CÓDIGO') !== -1)) {
                var codVal = String(gRows[g][k]).trim();
                if (/\d{1,2}-\d{1,2}-\d{1,2}-\d{1,3}/.test(codVal)) codigo = codVal;
              }
            }
          }
        }

        // Buscar precio referencial — primero por código, luego por nombre
        var precioRef = '';
        if (codigo && preciosPorCodigo[codigo.toLowerCase()]) {
          var pRow = preciosPorCodigo[codigo.toLowerCase()];
          for (var k in pRow) {
            if (k.toUpperCase().indexOf('PRECIO') !== -1 || k.toUpperCase().indexOf('VALOR') !== -1 || k.toUpperCase().indexOf('COSTO') !== -1) {
              precioRef = pRow[k]; break;
            }
          }
        }
        if (!precioRef) {
          var detLC = (it['DETALLE'] || '').toLowerCase();
          for (var pk in preciosPorProducto) {
            if (detLC.length > 7 && pk.length > 7 && (detLC.indexOf(pk.substring(0, 8)) !== -1 || pk.indexOf(detLC.substring(0, 8)) !== -1)) {
              var pRow = preciosPorProducto[pk];
              for (var k in pRow) {
                if (k.toUpperCase().indexOf('PRECIO') !== -1 || k.toUpperCase().indexOf('VALOR') !== -1 || k.toUpperCase().indexOf('COSTO') !== -1) {
                  precioRef = pRow[k]; break;
                }
              }
              break;
            }
          }
        }

        var linea = '[PEDIDO]T:'+bk.tarea+'|H:'+bk.hoja+'|'+comprado+'|'+(bk._dias||0)+'d|'+bk._sem+'|'+(it['DETALLE']||'')+'|Prov:'+colVal(it,['PROVEEDOR'])+'|OC:'+(ocVal||'-')+'|Sol:'+colVal(it,['CANTIDAD SOLICITADA'])+'|Ent:'+colVal(it,['CANTIDAD ENTREGADA'])+'|Pend:'+pe;
        if (fa&&fa!=='0') linea += '|Fact:'+fa;
        if (ig&&ig!=='0') linea += '|Ing:'+ig;
        if (depto) linea += '|Depto:'+depto;
        if (codigo) linea += '|Cod:'+codigo;
        if (precioRef) linea += '|PrecioRef:'+precioRef;

        matchesPedidos.push(linea);
  }

  // Buscar en Precios directamente
  var matchesPrecios = buscarEnHoja(precios, stems, palabras, 6, '[PRECIO]');

  // Buscar en General directamente (puede matchear por depto u otro campo)
  var matchesGeneral = buscarEnHoja(general, stems, palabras, 6, '[GESTION]');

  var todosMatches = matchesPedidos.concat(matchesPrecios).concat(matchesGeneral);

  // --- CONSTRUIR CONTEXTO ---
  if (todosMatches.length > 0) {
    var ctx = 'Asistente Compras TN UIO. Español, emojis.\n'
      + 'MODELO DE DATOS:\n'
      + '- [PEDIDO]: Seguimiento actual. Si dice COMPRADO y tiene OC, significa que SÍ se compró a ese proveedor.\n'
      + '- Depto: departamento que solicitó la compra (cruzado por nro de tarea con Gestión).\n'
      + '- Cod: código del producto (formato XX-XX-XX-XXX).\n'
      + '- PrecioRef: precio referencial de lista.\n'
      + '- [PRECIO]: Catálogo de precios referenciales.\n'
      + '- [GESTION]: Historial de compras con departamento solicitante.\n'
      + 'REGLAS: SOLO usa estos '+todosMatches.length+' registros. NUNCA inventes.\n'
      + 'DATOS:\n' + todosMatches.join('\n');
    return callIA(key, provider, ctx, pregunta, historialJSON);
  }

  // TIER 3: Sin matches — stats generales
  var st = {tareas:0,items:0,pend:0,entreg:0,canc:0};
  var pvMap = {}, hojaMap = {};
  for (var b = 0; b < bloques.length; b++) {
    var bk = bloques[b], h = bk.hoja||'-';
    if (!hojaMap[h]) hojaMap[h]={t:0,pe:0,en:0};
    hojaMap[h].t++;
    if (bk._ca) { st.canc++; continue; }
    st.tareas++;
    for (var i = 0; i < bk.items.length; i++) {
      var it = bk.items[i]; if(it._c){st.canc++;continue;}
      st.items++;
      var pe=calcPend(it),pv=colVal(it,['PROVEEDOR'])||'-';
      if(pe>0){st.pend++;hojaMap[h].pe++;}else{st.entreg++;hojaMap[h].en++;}
      if(!pvMap[pv])pvMap[pv]={i:0,pe:0};
      pvMap[pv].i++;if(pe>0)pvMap[pv].pe++;
    }
  }
  var pvL=[],hL=[];
  for(var k in pvMap)pvL.push(k+':'+pvMap[k].i+'items,'+pvMap[k].pe+'pend');
  for(var k in hojaMap)hL.push(k+':'+hojaMap[k].t+'t,'+hojaMap[k].pe+'pe,'+hojaMap[k].en+'en');

  var ctx = 'Asistente Compras TN UIO. Español, emojis.\n'
    + 'REGLAS: Solo tengo estadísticas generales. Si preguntan por un producto específico, sugiere que escriban parte del nombre para buscarlo.\n'
    + 'TOTALES:T:'+st.tareas+' I:'+st.items+' Pend:'+st.pend+' Entreg:'+st.entreg+' Canc:'+st.canc+'\n'
    + 'HOJAS:'+hL.join(';')+'\n'
    + 'PROVEEDORES:'+pvL.join(';');
  return callIA(key, provider, ctx, pregunta, historialJSON);
}

// Llamada unificada
function callIA(key, provider, sysMsg, pregunta, historialJSON) {
  var url = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.groq.com/openai/v1/chat/completions';
  var model = provider === 'openrouter' ? 'meta-llama/llama-3.3-70b-instruct:free' : 'llama-3.3-70b-versatile';
  var label = provider === 'openrouter' ? 'OpenRouter 70B' : 'Groq 70B';
  try {
    // Construir mensajes con historial (últimos 4 turnos para no gastar tokens)
    var msgs = [{ role: 'system', content: sysMsg }];
    if (historialJSON) {
      try {
        var hist = JSON.parse(historialJSON);
        var start = Math.max(0, hist.length - 4);
        for (var i = start; i < hist.length; i++) {
          msgs.push({ role: hist[i].r, content: hist[i].t.substring(0, 300) });
        }
      } catch(e) {}
    }
    msgs.push({ role: 'user', content: pregunta });

    var resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + key },
      payload: JSON.stringify({ model: model, messages: msgs, max_tokens: 400, temperature: 0.3 }),
      muteHttpExceptions: true
    });
    var data = JSON.parse(resp.getContentText());
    if (data.error) return JSON.stringify({ error: label + ': ' + (data.error.message || JSON.stringify(data.error)) });
    if (data.choices && data.choices.length > 0 && data.choices[0].message) {
      return JSON.stringify({ respuesta: data.choices[0].message.content, modelo: label });
    }
    return JSON.stringify({ error: label + ': sin respuesta' });
  } catch (e) {
    return JSON.stringify({ error: label + ': ' + e.message });
  }
}

// ============================================================
// HTML
// ============================================================
function getHTML() {
  return [
    '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">',
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>',
    '<style>',
    ':root{--bg:#0b1120;--s:#151d2e;--s2:#1c2740;--bd:#263354;--t:#e0e7f1;--t2:#8896b0;--a:#3b82f6;--a2:#60a5fa;--g:#22c55e;--y:#eab308;--r:#ef4444;--p:#a78bfa;--o:#fb923c;}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    'body{font-family:"DM Sans",sans-serif;background:var(--bg);color:var(--t);min-height:100vh}',
    '.app{display:flex;flex-direction:column;min-height:100vh}',
    '.sb{display:none}',
    '@media(min-width:900px){.sb{display:flex;flex-direction:column;width:210px;background:var(--s);border-right:1px solid var(--bd);position:fixed;top:0;left:0;bottom:0;z-index:100;padding-top:16px}.sb-logo{padding:0 16px 16px;border-bottom:1px solid var(--bd);margin-bottom:6px}.sb-logo h1{font-size:14px;font-weight:800;color:#fff}.sb-logo p{font-size:10px;color:var(--t2)}.sb-b{display:flex;align-items:center;gap:8px;padding:9px 16px;cursor:pointer;color:var(--t2);font-size:12px;font-weight:500;border:none;background:none;width:100%;text-align:left;border-left:3px solid transparent}.sb-b:hover{background:rgba(59,130,246,.08);color:var(--t)}.sb-b.on{color:var(--a2);background:rgba(59,130,246,.1);border-left-color:var(--a)}.sb-b .si{font-size:15px;width:20px;text-align:center}.ma{margin-left:210px}.hd{display:none}.bn{display:none!important}}',
    '.hd{background:linear-gradient(135deg,#0c2d5a,#152844);padding:12px 16px;text-align:center;position:sticky;top:0;z-index:100}.hd h1{font-size:15px;color:#fff;font-weight:800}.hd p{font-size:10px;color:var(--a2)}',
    '.bn{position:fixed;bottom:0;left:0;right:0;background:var(--s);border-top:1px solid var(--bd);display:flex;z-index:100;padding-bottom:env(safe-area-inset-bottom);overflow-x:auto;-webkit-overflow-scrolling:touch}.nb{flex:0 0 auto;min-width:52px;padding:6px 3px;text-align:center;cursor:pointer;border:none;background:none;color:var(--t2);font-size:8px;font-weight:500}.nb .ni{font-size:16px;display:block;margin-bottom:1px}.nb.on{color:var(--a2)}',
    '.sc{display:flex;gap:6px;margin-bottom:12px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch}.sh{padding:6px 12px;font-size:11px;font-weight:600;background:var(--s);color:var(--t2);border:1px solid var(--bd);border-radius:20px;cursor:pointer;white-space:nowrap}.sh.on{background:var(--a);color:#fff;border-color:var(--a)}',
    '.vw{display:none;padding:12px;padding-bottom:85px}.vw.on{display:block}@media(min-width:900px){.vw{padding:24px 28px;max-width:1100px}}',
    '.sg{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}@media(min-width:900px){.sg{grid-template-columns:repeat(5,1fr);gap:12px}}.sk{background:var(--s);border:1px solid var(--bd);border-radius:10px;padding:12px;text-align:center;cursor:pointer}.sk:hover{border-color:var(--a)}.sn{font-size:22px;font-weight:800;line-height:1}.sl{font-size:10px;color:var(--t2);margin-top:3px;font-weight:500}.cb{color:var(--a2)}.cg{color:var(--g)}.cy{color:var(--y)}.cr{color:var(--r)}.cp{color:var(--p)}',
    '.sb2{display:flex;gap:6px;margin-bottom:10px}.sb2 input,.inp{flex:1;padding:11px 12px;font-size:15px;border:1px solid var(--bd);border-radius:10px;background:var(--s);color:var(--t);outline:none;font-family:inherit;-webkit-appearance:none}.sb2 input:focus,.inp:focus{border-color:var(--a)}.sb2 input::placeholder,.inp::placeholder{color:var(--t2)}',
    '.bt{padding:10px 16px;font-size:12px;border:none;border-radius:10px;cursor:pointer;font-weight:700;font-family:inherit;display:inline-block}.bt:active{transform:scale(.97)}.bp{background:var(--a);color:#fff}.bg{background:var(--g);color:#fff}.bw{background:var(--y);color:#1e293b}.bd{background:var(--r);color:#fff}.bo{background:transparent;color:var(--t2);border:1px solid var(--bd)}.bs{padding:6px 10px;font-size:10px}',
    '.st{text-align:center;padding:10px;font-size:12px;color:var(--t2)}.st.er{color:var(--r)}.sp{display:inline-block;width:14px;height:14px;border:2px solid var(--bd);border-top-color:var(--a);border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}@keyframes spin{to{transform:rotate(360deg)}}',
    '.bq{background:var(--s);border:1px solid var(--bd);border-radius:12px;margin-bottom:12px;overflow:hidden}.bh{padding:10px 12px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--bd);flex-wrap:wrap;gap:4px}.bt2{font-size:11px;font-weight:700;color:var(--y)}.bhl{font-size:9px;color:var(--a2);background:rgba(59,130,246,.15);padding:1px 6px;border-radius:8px;margin-left:4px}.br{display:flex;align-items:center;gap:5px}.bb{font-size:9px;color:var(--t2);background:var(--bg);padding:2px 7px;border-radius:20px}',
    '.sm{width:9px;height:9px;border-radius:50%;display:inline-block}.sr{background:var(--r);box-shadow:0 0 4px var(--r)}.sa{background:var(--y);box-shadow:0 0 4px var(--y)}.sv{background:var(--g);box-shadow:0 0 4px var(--g)}.sg2{background:#64748b}',
    '.cb2{font-size:8px;font-weight:700;color:#fca5a5;background:#7f1d1d;padding:1px 6px;border-radius:8px;margin-left:4px}.bc{opacity:.5}.rc td{text-decoration:line-through;opacity:.5}',
    '.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}.tb{width:100%;border-collapse:collapse;font-size:11px;min-width:450px}.tb th{background:var(--bg);color:var(--t2);padding:6px 8px;text-align:left;font-weight:600;white-space:nowrap;font-size:9px;text-transform:uppercase;letter-spacing:.5px}.tb td{padding:8px;border-bottom:1px solid rgba(255,255,255,.03);color:var(--t)}.tb td mark{background:#78350f;color:#fde68a;border-radius:2px;padding:0 2px}.cd{min-width:160px;font-weight:500}.ps{color:var(--r);font-weight:700}.po{color:var(--g)}',
    '.ri{background:var(--s);border:1px solid var(--bd);border-radius:10px;padding:12px;margin-bottom:8px;transition:border-color .2s}.ri.hd2{border-color:var(--g)}.ri.lk{opacity:.4;pointer-events:none;position:relative}.ri.ic{opacity:.35;pointer-events:none}.rn{font-size:12px;font-weight:600;margin-bottom:2px}.rm{font-size:10px;color:var(--t2);margin-bottom:5px}.rm b{color:var(--t)}.rf{display:grid;grid-template-columns:1fr 1fr;gap:6px}@media(min-width:900px){.rf{grid-template-columns:1fr 1fr 1fr 1fr}}.rfl{display:flex;flex-direction:column}.rfl label{font-size:9px;color:var(--t2);margin-bottom:2px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}.rfl input,.rfl textarea{padding:8px;font-size:13px;border:1px solid var(--bd);border-radius:7px;background:var(--bg);color:var(--t);outline:none;font-family:inherit;-webkit-appearance:none}.rfl input:focus,.rfl textarea:focus{border-color:var(--a)}.rfl.fu{grid-column:1/-1}.rfl textarea{resize:vertical;min-height:38px}',
    '.lk-badge{position:absolute;top:8px;right:8px;font-size:9px;font-weight:700;color:var(--g);background:rgba(34,197,94,.15);padding:2px 8px;border-radius:8px}',
    '.pc{background:var(--s);border:1px solid var(--bd);border-radius:10px;padding:12px;margin-bottom:8px}.pn{font-size:13px;font-weight:700;margin-bottom:4px}.ps2{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--t2)}.ps2 span{font-weight:700}.wn span{color:var(--r)}.ok span{color:var(--g)}',
    '.ac{background:var(--s);border-left:3px solid var(--r);border-radius:0 10px 10px 0;padding:10px 12px;margin-bottom:8px}.ac.aw{border-left-color:var(--y)}',
    '.le{background:var(--s);border-left:3px solid var(--a);border-radius:0 7px 7px 0;padding:8px 10px;margin-bottom:5px}.le.tF{border-left-color:var(--p)}.le.tI{border-left-color:var(--g)}.le.tO{border-left-color:var(--o)}',
    '.cw{background:var(--s);border:1px solid var(--bd);border-radius:10px;padding:9px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px}.cbi{font-size:9px;padding:3px 8px;border-radius:20px;font-weight:600;white-space:nowrap}.cy2{background:#166534;color:#4ade80}.cn{background:#7f1d1d;color:#fca5a5}',
    '.tt{font-size:14px;font-weight:800;margin:12px 0 10px;display:flex;align-items:center;gap:6px}.rc2{font-size:11px;color:var(--t2);margin-bottom:8px}.rc2 span{color:var(--a2);font-weight:700}.es{text-align:center;padding:30px 16px;color:var(--t2)}.es .ei{font-size:36px;margin-bottom:8px}.ab{display:flex;gap:5px;margin-bottom:12px;flex-wrap:wrap}',
    '.ra{background:var(--s);border:1px solid var(--bd);border-radius:10px;padding:12px;margin-top:8px;font-family:monospace;font-size:10px;color:var(--t2);white-space:pre-wrap;word-break:break-word;max-height:350px;overflow-y:auto}',
    '.to{position:fixed;top:60px;left:50%;transform:translateX(-50%);background:var(--g);color:#fff;padding:8px 20px;border-radius:10px;font-size:12px;font-weight:700;z-index:200;box-shadow:0 4px 20px rgba(0,0,0,.5);animation:fio 3s forwards;font-family:inherit}.to.te{background:var(--r)}@keyframes fio{0%{opacity:0;transform:translateX(-50%) translateY(-10px)}10%{opacity:1;transform:translateX(-50%) translateY(0)}80%{opacity:1}100%{opacity:0}}',
    '.afh{background:rgba(59,130,246,.1);border:1px solid var(--a);border-radius:7px;padding:6px 10px;margin-bottom:8px;font-size:10px;color:var(--a2);display:none}',
    '.hs{display:grid;grid-template-columns:1fr;gap:6px;margin-top:10px}@media(min-width:900px){.hs{grid-template-columns:1fr 1fr}}.hc{background:var(--s2);border:1px solid var(--bd);border-radius:8px;padding:10px 12px}.hcn{font-size:11px;font-weight:700;color:var(--a2);margin-bottom:4px}.hcs{display:flex;gap:8px;flex-wrap:wrap;font-size:10px;color:var(--t2)}.hcs b{font-weight:700}',
    '.cfg{background:var(--s);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:10px}.cfg-t{font-size:12px;font-weight:700;margin-bottom:8px}.cfg-l{font-size:11px;color:var(--t2);margin-bottom:4px}.cfg-i{width:100%;padding:9px 10px;font-size:13px;border:1px solid var(--bd);border-radius:7px;background:var(--bg);color:var(--t);outline:none;font-family:inherit;margin-bottom:8px;-webkit-appearance:none}.cfg-i:focus{border-color:var(--a)}',
    '.chg{display:grid;grid-template-columns:1fr;gap:12px;margin:14px 0}@media(min-width:700px){.chg{grid-template-columns:1fr 1fr}}.chc{background:var(--s);border:1px solid var(--bd);border-radius:12px;padding:14px}.cht{font-size:11px;font-weight:700;margin-bottom:8px;color:var(--t2)}',
    '.auth-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:var(--bg);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px}',
    '.auth-box{background:var(--s);border:1px solid var(--bd);border-radius:16px;padding:32px 28px;max-width:380px;width:100%}',
    '.auth-box h2{font-size:20px;font-weight:800;text-align:center;margin-bottom:4px}',
    '.auth-box p{font-size:11px;color:var(--t2);text-align:center;margin-bottom:18px}',
    '.auth-box .af{margin-bottom:12px}.af label{display:block;font-size:10px;color:var(--t2);margin-bottom:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}.af input{width:100%;padding:11px 12px;font-size:14px;border:1px solid var(--bd);border-radius:10px;background:var(--bg);color:var(--t);outline:none;font-family:inherit;-webkit-appearance:none}.af input:focus{border-color:var(--a)}',
    '.auth-box .bt{width:100%;padding:12px;font-size:14px;margin-top:4px}',
    '.auth-msg{font-size:11px;text-align:center;margin-top:10px}.auth-msg.er{color:var(--r)}.auth-msg.ok{color:var(--g)}',
    '.auth-switch{font-size:11px;color:var(--t2);text-align:center;margin-top:14px}.auth-switch a{color:var(--a2);cursor:pointer;text-decoration:underline}',
    '.auth-user{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--bd);margin-top:auto}.auth-user .au-name{font-size:11px;font-weight:600;color:var(--t)}.auth-user .au-email{font-size:9px;color:var(--t2)}.auth-user .au-logout{font-size:9px;color:var(--r);cursor:pointer;margin-left:auto}',
    '</style></head><body>',
    '',
    '<!-- LOGIN OVERLAY -->',
    '<div class="auth-overlay" id="authOverlay">',
    '  <div class="auth-box" id="authBox">',
    '    <h2>📦 Compras TN UIO</h2>',
    '    <p>Inicia sesión para continuar</p>',
    '    <div id="authLogin">',
    '      <div class="af"><label>Email</label><input type="email" id="lgEmail" placeholder="tu@email.com" autocomplete="email"></div>',
    '      <div class="af"><label>Contraseña</label><input type="password" id="lgPass" placeholder="••••••" autocomplete="current-password"></div>',
    '      <button class="bt bp" onclick="doLogin()">Iniciar Sesión</button>',
    '      <div class="auth-msg" id="lgMsg"></div>',
    '      <div class="auth-switch">¿No tienes cuenta? <a onclick="showReg()">Registrarse</a></div>',
    '    </div>',
    '    <div id="authReg" style="display:none">',
    '      <div class="af"><label>Nombre completo</label><input type="text" id="rgName" placeholder="Tu nombre" autocomplete="name"></div>',
    '      <div class="af"><label>Email</label><input type="email" id="rgEmail" placeholder="tu@email.com" autocomplete="email"></div>',
    '      <div class="af"><label>Contraseña</label><input type="password" id="rgPass" placeholder="Mínimo 4 caracteres" autocomplete="new-password"></div>',
    '      <button class="bt bp" onclick="doRegister()">Crear Cuenta</button>',
    '      <div class="auth-msg" id="rgMsg"></div>',
    '      <div class="auth-switch"><a onclick="showLogin()">Ya tengo cuenta</a></div>',
    '    </div>',
    '    <div id="authLoading" style="display:none;text-align:center;padding:20px"><span class="sp"></span> Verificando...</div>',
    '  </div>',
    '</div>',
    '',
    '<div class="app" id="mainApp" style="display:none">',

    // SIDEBAR
    '<aside class="sb" id="sb"><div class="sb-logo"><h1>📦 Compras TN UIO</h1><p>Sistema de Gestión</p></div>',
    '<div class="sb-b on" data-v="ia" onclick="go(\'ia\',this)"><span class="si">🤖</span>Asistente IA</div>',
    '<div class="sb-b" data-v="buscar" onclick="go(\'buscar\',this)"><span class="si">🔍</span>Buscar</div>',
    '<div class="sb-b" data-v="registro" onclick="go(\'registro\',this)"><span class="si">✏️</span>Registro</div>',
    '<div class="sb-b" data-v="reporte" onclick="go(\'reporte\',this)"><span class="si">📤</span>Reporte</div>',
    '<div class="sb-b" data-v="dashboard" onclick="go(\'dashboard\',this)"><span class="si">📊</span>Dashboard</div>',
    '<div class="sb-b" data-v="sinIngreso" onclick="go(\'sinIngreso\',this)"><span class="si">📋</span>Por Recibir</div>',
    '<div class="sb-b" data-v="incompletos" onclick="go(\'incompletos\',this)"><span class="si">⚠️</span>Sin Documentar</div>',
    '<div class="sb-b" data-v="proveedores" onclick="go(\'proveedores\',this)"><span class="si">📈</span>Proveedores</div>',
    '<div class="sb-b" data-v="alertas" onclick="go(\'alertas\',this)"><span class="si">🔔</span>Alertas</div>',
    '<div class="sb-b" data-v="cruce" onclick="go(\'cruce\',this)"><span class="si">🔗</span>Cruce</div>',
    '<div class="sb-b" data-v="log" onclick="go(\'log\',this)"><span class="si">📝</span>Log</div>',
    '<div class="sb-b" data-v="ajustes" onclick="go(\'ajustes\',this)"><span class="si">⚙️</span>Ajustes</div>',
    '<div class="auth-user" id="sideUser"><div><div class="au-name" id="suName">—</div><div class="au-email" id="suEmail">—</div></div><span class="au-logout" onclick="doLogout()">Cerrar sesión</span></div>',
    '</aside>',

    '<header class="hd"><h1>📦 Compras TN UIO</h1><p>Sistema de Gestión</p></header>',
    '<div class="ma">',
    '<div style="padding:10px 12px 0"><div class="sc" id="ss"><div class="st"><span class="sp"></span></div></div></div>',

    // VIEWS
    '<div class="vw" id="v-dashboard"><div class="tt">📊 Dashboard</div><div id="dc"><div class="st"><span class="sp"></span>Cargando...</div></div></div>',
    '<div class="vw" id="v-buscar"><div class="tt">🔍 Buscar</div><div class="sb2"><input type="text" id="kw" placeholder="Tarea, OC, producto, proveedor..." autocomplete="off"><button class="bt bp" onclick="buscar()">Buscar</button></div><div id="ss2"></div><div id="sr"></div></div>',
    '<div class="vw" id="v-registro"><div class="tt">✏️ Registro Rápido</div><p style="font-size:11px;color:var(--t2);margin-bottom:8px">Busca por <b style="color:var(--y)">Tarea</b> o <b style="color:var(--a2)">OC</b>. Escribe directo en la hoja. Ítems con pendiente=0 están bloqueados.</p><div class="sb2"><input type="text" id="rq" placeholder="Tarea u Orden de Compra..." autocomplete="off"><button class="bt bp" onclick="loadReg()">Cargar</button></div><div class="afh" id="afh">💡 Misma OC/Proveedor detectada. <button class="bt bp bs" onclick="doAF()">Auto-llenar factura</button></div><div id="rs"></div><div id="ri2"></div><div id="ra" style="display:none;text-align:center;margin-top:10px"><button class="bt bg" onclick="saveAll()" style="width:100%;padding:12px;font-size:14px">💾 Guardar todo en la hoja</button></div></div>',
    '<div class="vw" id="v-sinIngreso"><div class="tt">📋 Por Recibir</div><div id="sic"><div class="st"><span class="sp"></span>Cargando...</div></div></div>',
    '<div class="vw" id="v-incompletos"><div class="tt">⚠️ Sin Documentar</div><p style="font-size:11px;color:var(--t2);margin-bottom:8px">Ítems entregados sin factura y/o ingreso registrado.</p><div id="inc"><div class="st"><span class="sp"></span></div></div></div>',
    '<div class="vw" id="v-proveedores"><div class="tt">📈 Proveedores</div><div id="prc"><div class="st"><span class="sp"></span></div></div></div>',
    '<div class="vw" id="v-alertas"><div class="tt">🔔 Alertas</div><div id="alc"><div class="st"><span class="sp"></span></div></div></div>',
    '<div class="vw" id="v-log"><div class="tt">📝 Log</div><div id="lgc"><div class="st"><span class="sp"></span></div></div></div>',
    '<div class="vw" id="v-cruce"><div class="tt">🔗 Cruce</div><div id="crc"><div class="st"><span class="sp"></span></div></div></div>',

    // REPORTE
    '<div class="vw" id="v-reporte">',
    '  <div class="tt">📤 Reporte Acta de Entrega</div>',
    '  <p style="font-size:11px;color:var(--t2);margin-bottom:8px">Genera el Acta con las facturas/ingresos registrados en el rango de fechas.</p>',
    '  <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;align-items:center">',
    '    <input type="date" id="rd1" class="cfg-i" style="width:auto;margin:0">',
    '    <span style="color:var(--t2);font-size:12px">al</span>',
    '    <input type="date" id="rd2" class="cfg-i" style="width:auto;margin:0">',
    '  </div>',
    '  <div class="ab">',
    '    <button class="bt bp" onclick="prevActa()">👁 Ver Reporte</button>',
    '    <button class="bt bg" onclick="sendActa()">📧 Enviar por Email</button>',
    '  </div>',
    '  <div id="rpc"></div>',
    '</div>',

    // AJUSTES
    // IA ASSISTANT
    '<div class="vw on" id="v-ia">',
    '  <div class="tt">🤖 Asistente de Compras IA</div>',
    '  <p style="font-size:11px;color:var(--t2);margin-bottom:10px">Pregunta lo que quieras sobre tus datos: proveedores, tareas, pendientes, estadísticas, recomendaciones...</p>',
    '  <div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">',
    '    <button class="bt bo bs" onclick="askIA(\'Resumen general de todas las compras\')">📊 Resumen</button>',
    '    <button class="bt bo bs" onclick="askIA(\'Qué proveedores tienen más ítems pendientes\')">🚨 Pendientes</button>',
    '    <button class="bt bo bs" onclick="askIA(\'Qué tareas están en estado crítico o urgente\')">🔴 Críticos</button>',
    '    <button class="bt bo bs" onclick="askIA(\'Qué ítems ya entregados les falta factura o ingreso\')">📋 Sin doc.</button>',
    '  </div>',
    '  <div id="ia-chat" style="margin-bottom:10px;max-height:400px;overflow-y:auto"></div>',
    '  <div class="sb2" style="position:sticky;bottom:80px;background:var(--bg);padding:8px 0">',
    '    <input type="text" id="ia-q" placeholder="Pregunta sobre tus compras..." autocomplete="off">',
    '    <button class="bt bp" onclick="askIA()">Enviar</button>',
    '  </div>',
    '</div>',
    '',

    '<div class="vw" id="v-ajustes">',
    '  <div class="tt">⚙️ Ajustes</div>',
    '  <div class="cfg"><div class="cfg-t">📧 Email principal (reporte)</div><input type="email" id="aj-em" class="cfg-i" placeholder="email@empresa.com"></div>',
    '  <div class="cfg"><div class="cfg-t">📧 CC (opcional)</div><input type="email" id="aj-cc" class="cfg-i" placeholder="copia@empresa.com"></div>',
    '  <div class="cfg"><div class="cfg-t">👤 Responsable</div><input type="text" id="aj-re" class="cfg-i" placeholder="Sistemas Compras"></div>',
    '  <div class="cfg"><div class="cfg-t">📍 Fila mínima (formato nuevo)</div><input type="number" id="aj-fm" class="cfg-i" placeholder="500"></div>',
    '  <div class="cfg"><div class="cfg-t">⏰ Alerta días</div><input type="number" id="aj-da" class="cfg-i" placeholder="15"></div>',
    '  <div class="cfg"><div class="cfg-t">🤖 Proveedor IA</div><select id="aj-prov" class="cfg-i" style="padding:10px"><option value="groq">Groq — Llama 3.3 70B (Gratis, inteligente)</option><option value="openrouter">OpenRouter — Llama 3.3 70B (Gratis)</option></select></div>',
    '  <div class="cfg"><div class="cfg-t">🔑 API Key Groq (recomendado)</div><p style="font-size:10px;color:var(--t2);margin-bottom:6px">100% gratis · 30 req/min · 14,400 req/día → <a href="https://console.groq.com/keys" target="_blank" style="color:var(--a2)">console.groq.com/keys</a></p><input type="password" id="aj-akg" class="cfg-i" placeholder="gsk_..."></div>',
    '  <div class="cfg"><div class="cfg-t">🔑 API Key OpenRouter (alternativa)</div><p style="font-size:10px;color:var(--t2);margin-bottom:6px">100% gratis con modelos :free → <a href="https://openrouter.ai/keys" target="_blank" style="color:var(--a2)">openrouter.ai/keys</a></p><input type="password" id="aj-akr" class="cfg-i" placeholder="sk-or-..."></div>',
    '  <button class="bt bg" onclick="saveAj()" style="width:100%;padding:12px;margin-bottom:10px">💾 Guardar Ajustes</button>',
    '  <button class="bt bp bs" onclick="activarTrig()">🔔 Activar email diario (7am)</button>',
    '  <div id="ajs" style="margin-top:8px"></div>',
    '  <div class="cfg" style="margin-top:12px"><div class="cfg-t">Leyenda de Estados</div><p style="font-size:10px;color:var(--t2);line-height:1.8"><span class="sm sv" style="vertical-align:middle"></span> <b>Verde</b> = Entregado + Documentado<br><span class="sm sa" style="vertical-align:middle"></span> <b>Amarillo</b> = Entregado sin documentar / en proceso<br><span class="sm sr" style="vertical-align:middle"></span> <b>Rojo</b> = Pendiente entrega > 0<br><span class="sm sg2" style="vertical-align:middle"></span> <b>Gris</b> = Cancelada / Suspendida</p></div>',
    '  <div class="cfg"><div class="cfg-t">Niveles de Criticidad</div><p style="font-size:10px;color:var(--t2);line-height:1.8"><span style="color:var(--a)">●</span> <b>1-10 días</b> — Normal (creación del bloque)<br><span style="color:var(--y)">●</span> <b>10-20 días</b> — Atención (debe aprobarse OC)<br><span style="color:var(--o)">●</span> <b>20-30 días</b> — Urgente (debe llegar mercadería)<br><span style="color:var(--r)">●</span> <b>30+ días</b> — ¡CRÍTICO! (requiere acción inmediata)<br>📌 Factura/Ingreso se acumulan con / · Pend=0 bloquea el ítem · Cancelada/Suspendida se excluye de todo</p></div>',
    '</div>',

    '</div>',

    // BOTTOM NAV
    '<nav class="bn">',
    '<div class="nb on" data-v="ia" onclick="go(\'ia\',this)"><span class="ni">🤖</span>IA</div>',
    '<div class="nb" data-v="buscar" onclick="go(\'buscar\',this)"><span class="ni">🔍</span>Buscar</div>',
    '<div class="nb" data-v="registro" onclick="go(\'registro\',this)"><span class="ni">✏️</span>Reg.</div>',
    '<div class="nb" data-v="reporte" onclick="go(\'reporte\',this)"><span class="ni">📤</span>Rep.</div>',
    '<div class="nb" data-v="dashboard" onclick="go(\'dashboard\',this)"><span class="ni">📊</span>Inicio</div>',
    '<div class="nb" data-v="sinIngreso" onclick="go(\'sinIngreso\',this)"><span class="ni">📋</span>Recibir</div>',
    '<div class="nb" data-v="incompletos" onclick="go(\'incompletos\',this)"><span class="ni">⚠️</span>Doc.</div>',
    '<div class="nb" data-v="proveedores" onclick="go(\'proveedores\',this)"><span class="ni">📈</span>Prov.</div>',
    '<div class="nb" data-v="alertas" onclick="go(\'alertas\',this)"><span class="ni">🔔</span>Alert.</div>',
    '<div class="nb" data-v="cruce" onclick="go(\'cruce\',this)"><span class="ni">🔗</span>Cruce</div>',
    '<div class="nb" data-v="log" onclick="go(\'log\',this)"><span class="ni">📝</span>Log</div>',
    '<div class="nb" data-v="ajustes" onclick="go(\'ajustes\',this)"><span class="ni">⚙️</span>Ajust.</div>',
    '</nav></div>',

    '<script>',
    'var vc={},ha="TODAS",ub="",rb=[];',
    'function go(id,b){var v=document.querySelectorAll(".vw");for(var i=0;i<v.length;i++)v[i].classList.remove("on");document.getElementById("v-"+id).classList.add("on");var n=document.querySelectorAll(".nb,.sb-b");for(var i=0;i<n.length;i++){n[i].classList.remove("on");if(n[i].getAttribute("data-v")===id)n[i].classList.add("on");}if(id==="dashboard"&&!vc.d)lD();if(id==="sinIngreso"&&!vc.si)lSI();if(id==="proveedores"&&!vc.pr)lPR();if(id==="alertas"&&!vc.al)lAL();if(id==="cruce"&&!vc.cr)lCR();if(id==="log"&&!vc.lg)lLG();if(id==="incompletos"&&!vc.ic)lIC();if(id==="ajustes"&&!vc.aj)lAJ();if(id==="buscar")document.getElementById("kw").focus();if(id==="registro")document.getElementById("rq").focus();if(id==="ia")document.getElementById("ia-q").focus();}',
    'function toast(m,e){var t=document.createElement("div");t.className="to"+(e?" te":"");t.textContent=m;document.body.appendChild(t);setTimeout(function(){t.remove()},3200);}',
    'function oE(id){return function(e){document.getElementById(id).innerHTML=\'<div class="st er">❌ \'+esc(e.message)+\'</div>\'};}',
    'function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML;}',
    'function eR(s){return s.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&");}',
    '',

    // INIT SHEETS
    'function iS(){google.script.run.withSuccessHandler(function(j){var h=JSON.parse(j);var x=\'<div class="sh on" data-h="TODAS" onclick="sH(this.dataset.h,this)">📁 Todas</div>\';for(var i=0;i<h.length;i++)x+=\'<div class="sh" data-h="\'+esc(h[i].nombre)+\'" onclick="sH(this.dataset.h,this)">\'+esc(h[i].nombre.substring(0,20))+\'</div>\';document.getElementById("ss").innerHTML=x;}).getHojasDisponibles();}',
    'function sH(n,e){ha=n;var c=document.querySelectorAll(".sh");for(var i=0;i<c.length;i++)c[i].classList.remove("on");if(e)e.classList.add("on");vc={};var av=document.querySelector(".vw.on");if(av){var id=av.id.replace("v-","");if(id==="dashboard")lD();else if(id==="sinIngreso")lSI();else if(id==="proveedores")lPR();else if(id==="alertas")lAL();else if(id==="cruce")lCR();else if(id==="log")lLG();else if(id==="incompletos")lIC();}}',
    '',

    // DASHBOARD
    'function lD(){document.getElementById("dc").innerHTML=\'<div class="st"><span class="sp"></span>Cargando...</div>\';google.script.run.withSuccessHandler(rD).withFailureHandler(oE("dc")).getDashboardData(ha);}',
    'function rD(j){var d=JSON.parse(j);vc.d=1;var h=\'<div class="sg">\';h+=sk(d.tt,"Tareas","cb");h+=sk(d.ti,"Ítems","cb");h+=sk(d.co,"Completas","cg");h+=sk(d.en,"Entregadas","cg");h+=sk(d.ep,"En Proceso","cy");h+=sk(d.pe,"Pend. Entrega","cr");h+=sk(d.si,"Sin Documentar","cp");h+=sk(d.sf,"Sin Factura","cy");h+=sk(d.ca,"Canceladas","cb");h+=\'</div>\';',
    '  // Charts row',
    '  h+=\'<div class="chg">\'',
    '  +\'<div class="chc"><div class="cht">📊 Estado General</div><canvas id="chPie" height="200"></canvas></div>\'',
    '  +\'<div class="chc"><div class="cht">⏱ Criticidad</div><canvas id="chCrit" height="200"></canvas></div>\'',
    '  +\'</div>\';',
    '  if(d.ph){var k=Object.keys(d.ph);if(k.length>1){',
    '    h+=\'<div class="chc" style="margin-bottom:14px"><div class="cht">📁 Por Hoja</div><canvas id="chBar" height="180"></canvas></div>\';',
    '    h+=\'<div class="hs">\';for(var i=0;i<k.length;i++){var p=d.ph[k[i]];h+=\'<div class="hc"><div class="hcn">\'+esc(k[i])+\'</div><div class="hcs"><div>T: <b>\'+p.t+\'</b></div><div style="color:var(--r)">Pe: <b>\'+p.pe+\'</b></div><div style="color:var(--p)">SD: <b>\'+p.si+\'</b></div><div style="color:var(--g)">✓ <b>\'+p.co+\'</b> Ent: <b>\'+p.en+\'</b></div></div></div>\';}h+=\'</div>\';',
    '  }}',
    '  h+=\'<div style="text-align:center;margin-top:8px"><button class="bt bo bs" onclick="vc.d=0;lD()">↻</button></div>\';',
    '  document.getElementById("dc").innerHTML=h;',
    '  // Render charts after DOM update',
    '  setTimeout(function(){',
    '    if(window._ch1){window._ch1.destroy();}if(window._ch2){window._ch2.destroy();}if(window._ch3){window._ch3.destroy();}',
    '    var co={responsive:true,plugins:{legend:{labels:{color:"#8896b0",font:{family:"DM Sans",size:11}}}}};',
    '    // Pie - Estado',
    '    var ctx1=document.getElementById("chPie");',
    '    if(ctx1){window._ch1=new Chart(ctx1,{type:"doughnut",data:{labels:["Completas","Entregadas","En Proceso","Pend. Entrega","Canceladas"],datasets:[{data:[d.co,d.en,d.ep,d.pe,d.ca],backgroundColor:["#22c55e","#60a5fa","#eab308","#ef4444","#475569"],borderWidth:0}]},options:{responsive:true,cutout:"65%",plugins:{legend:{position:"bottom",labels:{color:"#8896b0",font:{family:"DM Sans",size:10},padding:8}}}}});}',
    '    // Bar - Criticidad',
    '    if(d.crit){var ctx2=document.getElementById("chCrit");',
    '    if(ctx2){window._ch2=new Chart(ctx2,{type:"bar",data:{labels:["1-10d Normal","10-20d Atención","20-30d Urgente","30+d Crítico"],datasets:[{data:[d.crit.normal,d.crit.atencion,d.crit.urgente,d.crit.critico],backgroundColor:["#3b82f6","#eab308","#fb923c","#ef4444"],borderRadius:6,borderSkipped:false}]},options:{responsive:true,scales:{y:{ticks:{color:"#8896b0",font:{family:"DM Sans"}},grid:{color:"#263354"}},x:{ticks:{color:"#8896b0",font:{family:"DM Sans",size:9}},grid:{display:false}}},plugins:{legend:{display:false}}}});}',
    '    }',
    '    // Bar - Por Hoja',
    '    if(d.ph){var k=Object.keys(d.ph);if(k.length>1){var ctx3=document.getElementById("chBar");',
    '    if(ctx3){var lbls=[],dPe=[],dSi=[],dCo=[],dEn=[];for(var i=0;i<k.length;i++){lbls.push(k[i]);var p=d.ph[k[i]];dPe.push(p.pe);dSi.push(p.si);dCo.push(p.co);dEn.push(p.en);}',
    '    window._ch3=new Chart(ctx3,{type:"bar",data:{labels:lbls,datasets:[{label:"Pendientes",data:dPe,backgroundColor:"#ef4444",borderRadius:4},{label:"Sin Doc.",data:dSi,backgroundColor:"#a78bfa",borderRadius:4},{label:"Completas",data:dCo,backgroundColor:"#22c55e",borderRadius:4},{label:"Entregadas",data:dEn,backgroundColor:"#60a5fa",borderRadius:4}]},options:{responsive:true,scales:{y:{stacked:true,ticks:{color:"#8896b0"},grid:{color:"#263354"}},x:{stacked:true,ticks:{color:"#8896b0",font:{size:10}},grid:{display:false}}},plugins:{legend:{position:"bottom",labels:{color:"#8896b0",font:{family:"DM Sans",size:10},padding:6}}}}});',
    '    }}}',
    '  },100);',
    '}',
    'function sk(n,l,c){return \'<div class="sk"><div class="sn \'+c+\'">\'+n+\'</div><div class="sl">\'+l+\'</div></div>\';}',
    '',

    // SEARCH
    'document.getElementById("kw").addEventListener("keydown",function(e){if(e.key==="Enter")buscar();});',
    'function buscar(){var k=document.getElementById("kw").value.trim();if(!k)return;ub=k;document.getElementById("ss2").innerHTML=\'<div class="st"><span class="sp"></span></div>\';document.getElementById("sr").innerHTML="";google.script.run.withSuccessHandler(function(j){var b=JSON.parse(j);document.getElementById("ss2").innerHTML="";if(!b.length){document.getElementById("sr").innerHTML=\'<div class="es"><div class="ei">🔍</div>Sin resultados</div>\';return;}document.getElementById("sr").innerHTML=\'<div class="rc2"><span>\'+b.length+\'</span> tarea(s)</div>\'+rBL(b,ub);}).withFailureHandler(oE("ss2")).buscarPalabraClave(k,ha);}',
    '',

    // REGISTRO
    'document.getElementById("rq").addEventListener("keydown",function(e){if(e.key==="Enter")loadReg();});',
    'function loadReg(){var q=document.getElementById("rq").value.trim();if(!q)return;document.getElementById("rs").innerHTML=\'<div class="st"><span class="sp"></span></div>\';document.getElementById("ri2").innerHTML="";document.getElementById("ra").style.display="none";document.getElementById("afh").style.display="none";google.script.run.withSuccessHandler(rReg).withFailureHandler(oE("rs")).getItemsParaRegistro(q,ha);}',
    'function rReg(j){rb=JSON.parse(j);document.getElementById("rs").innerHTML="";if(!rb||!rb.length){document.getElementById("ri2").innerHTML=\'<div class="es"><div class="ei">❌</div>No encontrado</div>\';return;}',
    '  var h=\'<div class="rc2"><span>\'+rb.length+\'</span> tarea(s)</div>\',gi=0,poc={};',
    '  for(var b=0;b<rb.length;b++){var bl=rb[b];',
    '    h+=\'<div class="bq" style="margin-bottom:12px"><div class="bh"><span class="bt2">TAREA: \'+esc(bl.tarea)+\'<span class="bhl">\'+esc(bl.hoja||"")+\'</span></span><div class="br"><span class="sm s\'+({rojo:"r",amarillo:"a",verde:"v",gris:"g2"}[bl._sem]||"a")+\'"></span><span class="bb">\'+bl.items.length+\'</span></div></div>\';',
    '    for(var i=0;i<bl.items.length;i++){var it=bl.items[i],ca=it._c||false;',
    '      var fa=it["Factura No."]||it["FACTURA NO."]||it["Factura No"]||"";',
    '      var ig=it["NRO. INGRESO"]||it["NRO INGRESO"]||"";',
    '      var pv=it["PROVEEDOR"]||"",oc=it["ORDEN DE COMPRA"]||"";',
    '      var cs=it["CANTIDAD SOLICITADA"]||"0";',
    '      var ce=it["CANTIDAD ENTREGADA"]||"0";',
    '      var csN=parseFloat(cs)||0,ceN=parseFloat(ce)||0;',
    '      var pn=Math.max(0,csN-ceN);',
    '      var locked=pn<=0&&ceN>0&&!ca;',
    '      var k=pv+"||"+oc;if(pv&&oc)poc[k]=(poc[k]||0)+1;',
    '      h+=\'<div class="ri\'+(ca?" ic":"")+(locked?" lk":"")+\'" id="ri-\'+gi+\'" data-b="\'+b+\'" data-i="\'+i+\'" data-pv="\'+esc(pv)+\'" data-oc="\'+esc(oc)+\'">\';',
    '      if(locked)h+=\'<span class="lk-badge">✅ COMPLETO</span>\';',
    '      if(ca)h+=\'<span class="cb2">CANCELADA</span> \';',
    '      h+=\'<div class="rn">\'+esc(it["DETALLE"]||"")+\'</div>\';',
    '      h+=\'<div class="rm">Prov: <b>\'+esc(pv)+\'</b> · OC: <b style="color:var(--a2)">\'+esc(oc)+\'</b></div>\';',
    '      h+=\'<div class="rm">Sol: <b>\'+csN+\'</b> · Ent: <b style="color:var(--g)">\'+ceN+\'</b> · <span style="color:\'+(pn>0?"var(--r)":"var(--g)")+\';font-weight:700">Pend: \'+pn+\'</span></div>\';',
    '      if(fa&&fa!=="0")h+=\'<div class="rm" style="color:var(--g)">✓ Fact: \'+esc(fa)+\'</div>\';',
    '      if(ig&&ig!=="0")h+=\'<div class="rm" style="color:var(--g)">✓ Ing: \'+esc(ig)+\'</div>\';',
    '      h+=\'<div class="rf">\';',
    '      h+=\'<div class="rfl"><label>Cant. Entregar</label><input type="number" id="ce-\'+gi+\'" placeholder="\'+(pn>0?pn+" pend":"—")+\'" min="0" max="\'+pn+\'" oninput="mc(\'+gi+\')"></div>\';',
    '      h+=\'<div class="rfl"><label>Factura</label><input type="text" id="f-\'+gi+\'" placeholder="\'+(fa&&fa!=="0"?"Agregar":"Nro")+\'" oninput="mc(\'+gi+\');cAF(\'+gi+\')"></div>\';',
    '      h+=\'<div class="rfl"><label>Nro. Ingreso</label><input type="text" id="g-\'+gi+\'" placeholder="\'+(ig&&ig!=="0"?"Agregar":"Nro")+\'" oninput="mc(\'+gi+\')"></div>\';',
    '      h+=\'<div class="rfl fu"><label>Obs.</label><textarea id="o-\'+gi+\'" placeholder="Nota..." oninput="mc(\'+gi+\')"></textarea></div>\';',
    '      h+=\'</div></div>\';gi++;}h+=\'</div>\';}',
    '  document.getElementById("ri2").innerHTML=h;document.getElementById("ra").style.display="block";window._rt=gi;',
    '  for(var k in poc){if(poc[k]>1){document.getElementById("afh").style.display="block";break;}}}',
    '',
    'function mc(i){var e=document.getElementById("ri-"+i);if(!e)return;var a=document.getElementById("ce-"+i).value||document.getElementById("f-"+i).value||document.getElementById("g-"+i).value||document.getElementById("o-"+i).value;if(a)e.classList.add("hd2");else e.classList.remove("hd2");}',
    'var laf=-1;function cAF(i){var e=document.getElementById("ri-"+i);var pv=e.getAttribute("data-pv"),oc=e.getAttribute("data-oc"),fv=document.getElementById("f-"+i).value.trim();if(!fv||!pv||!oc)return;laf=i;var els=document.querySelectorAll(".ri[data-pv=\\""+pv+"\\"][data-oc=\\""+oc+"\\"]");if(els.length>1)document.getElementById("afh").style.display="block";}',
    'function doAF(){if(laf<0)return;var s=document.getElementById("ri-"+laf),pv=s.getAttribute("data-pv"),oc=s.getAttribute("data-oc"),fv=document.getElementById("f-"+laf).value.trim();if(!fv)return;var els=document.querySelectorAll(".ri"),ct=0;for(var i=0;i<els.length;i++){if(els[i].getAttribute("data-pv")===pv&&els[i].getAttribute("data-oc")===oc&&!els[i].classList.contains("lk")){var id=els[i].id.replace("ri-",""),inp=document.getElementById("f-"+id);if(!inp.value){inp.value=fv;mc(parseInt(id));ct++;}}}toast("✅ "+ct+" auto-llenados");document.getElementById("afh").style.display="none";}',
    '',
    'var _saving=false;',
    'function saveAll(){if(_saving||!rb||!rb.length)return;_saving=true;var btn=document.querySelector("#ra .bt");btn.textContent="⏳ Guardando...";btn.style.opacity="0.5";btn.style.pointerEvents="none";var regs=[],gi=0;for(var b=0;b<rb.length;b++){for(var i=0;i<rb[b].items.length;i++){var el=document.getElementById("ri-"+gi);if(el&&!el.classList.contains("lk")){var cv=document.getElementById("ce-"+gi).value.trim(),fv=document.getElementById("f-"+gi).value.trim(),gv=document.getElementById("g-"+gi).value.trim(),ov=document.getElementById("o-"+gi).value.trim();if(cv||fv||gv||ov)regs.push({hoja:rb[b].hoja,tarea:rb[b].tarea,detalle:rb[b].items[i]["DETALLE"]||"",filaReal:rb[b].items[i]._f,cantEnt:cv,factura:fv,ingreso:gv,obs:ov});}gi++;}}if(!regs.length){toast("Sin datos",true);_saving=false;btn.textContent="💾 Guardar todo en la hoja";btn.style.opacity="1";btn.style.pointerEvents="auto";return;}document.getElementById("ri2").innerHTML=\'<div class="st"><span class="sp"></span>Escribiendo en la hoja...</div>\';document.getElementById("ra").style.display="none";google.script.run.withSuccessHandler(function(j){var r=JSON.parse(j);toast("✅ "+r.g+" cambio(s) guardados");vc={};_saving=false;loadReg();}).withFailureHandler(function(e){toast("Error: "+e.message,true);_saving=false;btn.textContent="💾 Guardar todo en la hoja";btn.style.opacity="1";btn.style.pointerEvents="auto";document.getElementById("ra").style.display="block";document.getElementById("ri2").innerHTML="<p style=\\"color:var(--r);text-align:center\\">Error al guardar. Intenta de nuevo.</p>";}).guardarRegistroBatch(JSON.stringify(regs));}',
    'function goReg(t){document.getElementById("rq").value=t;go("registro",null);loadReg();}',
    '',

    // SIN INGRESO
    'function lSI(){document.getElementById("sic").innerHTML=\'<div class="st"><span class="sp"></span></div>\';google.script.run.withSuccessHandler(function(j){var b=JSON.parse(j);vc.si=1;if(!b.length){document.getElementById("sic").innerHTML=\'<div class="es"><div class="ei">✅</div>Todo recibido</div>\';return;}var h=\'<div class="rc2"><span>\'+b.length+\'</span> por recibir</div>\';h+=rBL(b,"",true);h+=\'<div style="text-align:center;margin-top:6px"><button class="bt bo bs" onclick="vc.si=0;lSI()">↻</button></div>\';document.getElementById("sic").innerHTML=h;}).withFailureHandler(oE("sic")).getPorRecibir(ha);}',
    '',

    // INCOMPLETOS
    'function lIC(){document.getElementById("inc").innerHTML=\'<div class="st"><span class="sp"></span></div>\';google.script.run.withSuccessHandler(function(j){var its=JSON.parse(j);vc.ic=1;if(!its.length){document.getElementById("inc").innerHTML=\'<div class="es"><div class="ei">✅</div>Todo documentado</div>\';return;}var h=\'<div class="rc2">⚠️ <span>\'+its.length+\'</span> incompleto(s)</div>\';for(var i=0;i<its.length;i++){var it=its[i];h+=\'<div class="ac aw"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px"><div><span style="font-weight:700;color:var(--y);font-size:11px">TAREA: \'+esc(it.t)+\'</span><span class="bhl">\'+esc(it.h||"")+\'</span><br><span style="font-size:12px">\'+esc(it.d)+\'</span></div><span style="font-size:9px;font-weight:700;color:#fde68a;background:#78350f;padding:1px 6px;border-radius:8px">Falta: \'+esc(it.falta)+\'</span></div><div style="font-size:10px;color:var(--t2);margin-top:3px">\'+esc(it.tiene)+(it.pv?" · "+esc(it.pv):"")+\'</div><div style="margin-top:4px"><button class="bt bp bs" data-t="\'+esc(it.t)+\'" onclick="goReg(this.dataset.t)">✏️ Completar</button></div></div>\';}h+=\'<div style="text-align:center;margin-top:6px"><button class="bt bo bs" onclick="vc.ic=0;lIC()">↻</button></div>\';document.getElementById("inc").innerHTML=h;}).withFailureHandler(oE("inc")).getSinDocumentar(ha);}',
    '',

    // PROVEEDORES
    'function lPR(){document.getElementById("prc").innerHTML=\'<div class="st"><span class="sp"></span></div>\';google.script.run.withSuccessHandler(function(j){var ps=JSON.parse(j);vc.pr=1;var h=\'<div class="rc2"><span>\'+ps.length+\'</span> proveedor(es)</div>\';for(var i=0;i<ps.length;i++){var p=ps[i];h+=\'<div class="pc"><div class="pn">\'+esc(p.n)+\'</div><div class="ps2"><div>Ít: <span>\'+p.ti+\'</span></div><div>OC: <span>\'+p.oc+\'</span></div><div class="\'+(p.pe>0?"wn":"ok")+\'">Pe: <span>\'+p.pe+\'</span></div><div class="\'+(p.si>0?"wn":"ok")+\'">SI: <span>\'+p.si+\'</span></div></div></div>\';}h+=\'<div style="text-align:center;margin-top:6px"><button class="bt bo bs" onclick="vc.pr=0;lPR()">↻</button></div>\';document.getElementById("prc").innerHTML=h;}).withFailureHandler(oE("prc")).getResumenProveedores(ha);}',
    '',

    // ALERTAS
    'function lAL(){document.getElementById("alc").innerHTML=\'<div class="st"><span class="sp"></span></div>\';google.script.run.withSuccessHandler(function(j){var als=JSON.parse(j);vc.al=1;if(!als.length){document.getElementById("alc").innerHTML=\'<div class="es"><div class="ei">✅</div>Sin alertas</div>\';return;}var critCol={normal:"var(--a)",atencion:"var(--y)",urgente:"var(--o)",critico:"var(--r)"};var critLbl={normal:"Normal",atencion:"Atención",urgente:"Urgente",critico:"¡CRÍTICO!"};var h=\'<div class="rc2">🚨 <span>\'+als.length+\'</span> alerta(s)</div>\';for(var i=0;i<als.length;i++){var a=als[i];var cc=critCol[a.crit]||"var(--a)";var cl=critLbl[a.crit]||"";h+=\'<div class="ac" style="border-left-color:\'+cc+\'"><div style="display:flex;justify-content:space-between;align-items:center"><span style="font-weight:700;color:var(--y);font-size:12px">\'+esc(a.t)+\' <span class="bhl">\'+esc(a.h||"")+\'</span></span><span style="font-size:9px;font-weight:700;padding:2px 8px;border-radius:8px;background:rgba(255,255,255,.08);color:\'+cc+\'">\'+a.dias+\'d · \'+cl+\'</span></div><div style="font-size:11px;color:\'+cc+\';margin-top:3px">⚠ \'+a.m.join(" | ")+\'</div><div style="font-size:10px;color:var(--t2);margin-top:3px">\'+a.n+\' ítems · \'+esc(a.p||"—")+\'</div><div style="margin-top:4px"><button class="bt bp bs" data-t="\'+esc(a.t)+\'" onclick="goReg(this.dataset.t)">✏️</button></div></div>\';}h+=\'<div style="text-align:center;margin-top:6px"><button class="bt bo bs" onclick="vc.al=0;lAL()">↻</button></div>\';document.getElementById("alc").innerHTML=h;}).withFailureHandler(oE("alc")).getAlertas(ha);}',
    '',

    // LOG
    'function lLG(){document.getElementById("lgc").innerHTML=\'<div class="st"><span class="sp"></span></div>\';google.script.run.withSuccessHandler(function(j){var es=JSON.parse(j);vc.lg=1;if(!es.length){document.getElementById("lgc").innerHTML=\'<div class="es"><div class="ei">📝</div>Sin registros</div>\';return;}var h=\'<div class="rc2"><span>\'+es.length+\'</span> registro(s)</div>\';for(var i=0;i<es.length;i++){var e=es[i];h+=\'<div class="le t\'+e.tp.charAt(0)+\'"><div style="display:flex;justify-content:space-between;align-items:center;gap:6px"><span style="font-size:11px;font-weight:700;color:var(--y)">\'+esc(e.t)+\' <span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.05)">\'+esc(e.tp)+\'</span></span><span style="font-size:9px;color:var(--t2)">\'+esc(e.ts)+\'</span></div><div style="font-size:10px;color:var(--t2)">\'+esc(e.d)+\'</div><div style="font-size:12px;margin-top:1px">\'+esc(e.v)+\'</div></div>\';}h+=\'<div style="text-align:center;margin-top:6px"><button class="bt bo bs" onclick="vc.lg=0;lLG()">↻</button></div>\';document.getElementById("lgc").innerHTML=h;}).withFailureHandler(oE("lgc")).getLogReciente(50);}',
    '',

    // CRUCE
    'function lCR(){document.getElementById("crc").innerHTML=\'<div class="st"><span class="sp"></span></div>\';google.script.run.withSuccessHandler(function(j){var d=JSON.parse(j);vc.cr=1;if(d.error){document.getElementById("crc").innerHTML=\'<div class="st er">\'+esc(d.error)+\'</div>\';return;}var eg=0,fg=0;for(var i=0;i<d.length;i++){if(d[i].eg)eg++;else fg++;}var h=\'<div class="sg">\'+sk(d.length,"Total","cb")+sk(eg,"En Gestión","cg")+sk(fg,"Fuera","cr")+\'</div>\';for(var i=0;i<d.length;i++){var r=d[i];h+=\'<div class="cw\'+(r.ca?" bc":"")+\'"><div style="flex:1"><div style="font-size:11px;font-weight:700;color:var(--y)">\'+esc(r.t)+\' <span class="sm s\'+({rojo:"r",amarillo:"a",verde:"v",gris:"g2"}[r.s]||"a")+\'"></span>\'+(r.ca?\'<span class="cb2">CANC</span>\':"")+\' <span class="bhl">\'+esc(r.h||"")+\'</span></div><div style="font-size:10px;color:var(--t2)">\'+r.ni+\' ít · \'+r.pe+\' pe · \'+r.si+\' si</div></div><span class="cbi \'+(r.eg?"cy2":"cn")+\'">\' +(r.eg?"✓":"✗")+\'</span></div>\';}h+=\'<div style="text-align:center;margin-top:6px"><button class="bt bo bs" onclick="vc.cr=0;lCR()">↻</button></div>\';document.getElementById("crc").innerHTML=h;}).withFailureHandler(oE("crc")).getCruceTareas(ha);}',
    '',

    // REPORTE ACTA
    'function prevActa(){var d1=document.getElementById("rd1").value,d2=document.getElementById("rd2").value;if(!d1||!d2){toast("Selecciona fechas",true);return;}document.getElementById("rpc").innerHTML=\'<div class="st"><span class="sp"></span></div>\';google.script.run.withSuccessHandler(function(j){var its=JSON.parse(j);if(!its.length){document.getElementById("rpc").innerHTML=\'<div class="es">Sin registros en el rango</div>\';return;}var h=\'<div class="rc2"><span>\'+its.length+\'</span> registro(s)</div><div class="tw"><table class="tb"><thead><tr><th>Nro.</th><th>PROVEEDOR</th><th>N°CREDITO</th><th>FECHA</th><th>ORDEN COMPRA</th><th>NRO INGRESO</th><th>N° TAREA</th><th>HOJA</th></tr></thead><tbody>\';for(var i=0;i<its.length;i++){var it=its[i];h+=\'<tr><td>\'+(i+1)+\'</td><td>\'+esc(it.proveedor)+\'</td><td>\'+esc(it.factura)+\'</td><td>\'+esc(it.fecha)+\'</td><td>\'+esc(it.oc)+\'</td><td>\'+esc(it.ingreso)+\'</td><td>\'+esc(it.tarea)+\'</td><td>\'+esc(it.hoja)+\'</td></tr>\';}h+=\'</tbody></table></div>\';document.getElementById("rpc").innerHTML=h;}).withFailureHandler(oE("rpc")).generarReporteActa(d1,d2);}',
    'function sendActa(){var d1=document.getElementById("rd1").value,d2=document.getElementById("rd2").value;if(!d1||!d2){toast("Selecciona fechas",true);return;}document.getElementById("rpc").innerHTML=\'<div class="st"><span class="sp"></span>Generando Excel y enviando...</div>\';google.script.run.withSuccessHandler(function(r){toast("✅ "+r);document.getElementById("rpc").innerHTML="";}).withFailureHandler(oE("rpc")).enviarReporteActa(d1,d2);}',
    '',

    // AJUSTES
    'function lAJ(){google.script.run.withSuccessHandler(function(j){var a=JSON.parse(j);vc.aj=1;document.getElementById("aj-em").value=a.emailDestino||"";document.getElementById("aj-cc").value=a.emailCC||"";document.getElementById("aj-re").value=a.responsable||"";document.getElementById("aj-fm").value=a.filaMinima||500;document.getElementById("aj-da").value=a.diasAlerta||15;document.getElementById("aj-prov").value=a.iaProvider||"groq";document.getElementById("aj-akg").value=a.apiKeyGroq||"";document.getElementById("aj-akr").value=a.apiKeyOpenRouter||"";}).getAjustes();}',
    'function saveAj(){var a={emailDestino:document.getElementById("aj-em").value.trim(),emailCC:document.getElementById("aj-cc").value.trim(),responsable:document.getElementById("aj-re").value.trim(),filaMinima:document.getElementById("aj-fm").value,diasAlerta:document.getElementById("aj-da").value,iaProvider:document.getElementById("aj-prov").value,apiKeyGroq:document.getElementById("aj-akg").value.trim(),apiKeyOpenRouter:document.getElementById("aj-akr").value.trim()};google.script.run.withSuccessHandler(function(){toast("✅ Ajustes guardados");vc={};}).withFailureHandler(function(e){toast("Error: "+e.message,true);}).guardarAjustes(JSON.stringify(a));}',
    'function activarTrig(){document.getElementById("ajs").innerHTML=\'<div class="st"><span class="sp"></span></div>\';google.script.run.withSuccessHandler(function(r){document.getElementById("ajs").innerHTML=\'<div class="st" style="color:var(--g)">✅ \'+r+\'</div>\';}).withFailureHandler(oE("ajs")).configurarTriggerDiario();}',
    '',
    '// IA CHAT',
    'var iaHist=[];',
    'document.getElementById("ia-q").addEventListener("keydown",function(e){if(e.key==="Enter")askIA();});',
    'function askIA(preset){',
    '  var q=preset||document.getElementById("ia-q").value.trim();',
    '  if(!q)return;',
    '  if(!preset)document.getElementById("ia-q").value="";',
    '  var chat=document.getElementById("ia-chat");',
    '  chat.innerHTML+=\'<div style="text-align:right;margin-bottom:8px"><span style="display:inline-block;background:var(--a);color:#fff;padding:8px 12px;border-radius:12px 12px 2px 12px;font-size:12px;max-width:80%">\'+esc(q)+\'</span></div>\';',
    '  chat.innerHTML+=\'<div id="ia-loading" style="margin-bottom:8px"><span style="display:inline-block;background:var(--s2);color:var(--t2);padding:8px 12px;border-radius:12px 12px 12px 2px;font-size:12px"><span class="sp"></span>Analizando datos...</span></div>\';',
    '  chat.scrollTop=chat.scrollHeight;',
    '  var histJSON=JSON.stringify(iaHist);',
    '  iaHist.push({r:"user",t:q});',
    '  google.script.run.withSuccessHandler(function(j){',
    '    var r=JSON.parse(j);',
    '    var el=document.getElementById("ia-loading");if(el)el.remove();',
    '    var chat=document.getElementById("ia-chat");',
    '    if(r.error){chat.innerHTML+=\'<div style="margin-bottom:8px"><span style="display:inline-block;background:#7f1d1d;color:#fca5a5;padding:8px 12px;border-radius:12px 12px 12px 2px;font-size:12px">❌ \'+esc(r.error)+\'</span></div>\';chat.scrollTop=chat.scrollHeight;return;}',
    '    iaHist.push({r:"assistant",t:r.respuesta});',
    '    if(iaHist.length>8)iaHist=iaHist.slice(-8);',
    '    var txt=r.respuesta.replace(/\\n/g,"<br>");',
    '    var badge=r.modelo?\'<div style="font-size:9px;color:var(--t2);margin-top:4px">vía \'+esc(r.modelo)+\'</div>\':"";',
    '    chat.innerHTML+=\'<div style="margin-bottom:8px"><span style="display:inline-block;background:var(--s2);border:1px solid var(--bd);color:var(--t);padding:10px 14px;border-radius:12px 12px 12px 2px;font-size:12px;max-width:85%;line-height:1.5">\'+txt+badge+\'</span></div>\';',
    '    chat.scrollTop=chat.scrollHeight;',
    '  }).withFailureHandler(function(e){',
    '    var el=document.getElementById("ia-loading");if(el)el.remove();',
    '    var chat=document.getElementById("ia-chat");',
    '    chat.innerHTML+=\'<div style="margin-bottom:8px"><span style="display:inline-block;background:#7f1d1d;color:#fca5a5;padding:8px 12px;border-radius:12px 12px 12px 2px;font-size:12px">❌ \'+esc(e.message)+\'</span></div>\';',
    '    chat.scrollTop=chat.scrollHeight;',
    '  }).preguntarIA(q,ha,histJSON);',
    '}',
    '',

    // RENDER BLOQUES
    'function rBL(bs,hl,showCrit){var re=hl?new RegExp("("+eR(hl)+")","gi"):null,html="";var critCol={normal:"var(--a)",atencion:"var(--y)",urgente:"var(--o)",critico:"var(--r)"};var critLbl={normal:"Normal",atencion:"Atención",urgente:"Urgente",critico:"¡CRÍTICO!"};for(var b=0;b<bs.length;b++){var bl=bs[b],ca=bl._ca||false;html+=\'<div class="bq\'+(ca?" bc":"")+\'"><div class="bh"><span class="bt2">TAREA: \'+esc(bl.tarea);if(ca)html+=\'<span class="cb2">CANC</span>\';if(bl.hoja)html+=\'<span class="bhl">\'+esc(bl.hoja)+\'</span>\';if(showCrit&&bl._crit&&bl._crit!=="normal"){var cc=critCol[bl._crit]||"var(--a)";html+=\' <span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.08);color:\'+cc+\'">\'+((bl._dias||0))+"d · "+(critLbl[bl._crit]||"")+\'</span>\';}html+=\'</span><div class="br"><span class="sm s\'+({rojo:"r",amarillo:"a",verde:"v",gris:"g2"}[bl._sem]||"a")+\'"></span><span class="bb">\'+bl.items.length+\'</span>\';if(!ca)html+=\'<button class="bt bp bs" style="padding:2px 6px;font-size:9px;margin:0" data-t="\'+esc(bl.tarea)+\'" onclick="goReg(this.dataset.t)">✏️</button>\';html+=\'</div></div>\';var cs=bl.enc||[];if(!cs.length&&bl.items.length>0){for(var k in bl.items[0]){if(k.charAt(0)!=="_")cs.push(k);}}html+=\'<div class="tw"><table class="tb"><thead><tr>\';for(var h=0;h<cs.length;h++){if(cs[h].charAt(0)!=="_")html+=\'<th>\'+esc(cs[h])+\'</th>\';}html+=\'</tr></thead><tbody>\';for(var r=0;r<bl.items.length;r++){var ic=bl.items[r]._c||false;html+=\'<tr\'+(ic?\' class="rc"\':"")+\'>\';for(var c=0;c<cs.length;c++){if(cs[c].charAt(0)==="_")continue;var v=bl.items[r][cs[c]]||"",d=esc(v);if(re)d=d.replace(re,"<mark>$1</mark>");var cl="";if(cs[c]==="DETALLE")cl=" cd";if(cs[c].toUpperCase().indexOf("PENDIENTE")!==-1){var n=parseFloat(v);if(n>0)d=\'<span class="ps">\'+d+\'</span>\';else if(v!=="")d=\'<span class="po">\'+d+\'</span>\';}html+=\'<td class="\'+cl+\'">\'+d+\'</td>\';}html+=\'</tr>\';}html+=\'</tbody></table></div></div>\';}return html;}',
    '',
    'var hoy=new Date();var hoyStr=hoy.getFullYear()+"-"+String(hoy.getMonth()+1).padStart(2,"0")+"-"+String(hoy.getDate()).padStart(2,"0");',
    'document.getElementById("rd1").value=hoyStr;document.getElementById("rd2").value=hoyStr;',
    '// === AUTH ===',
    'function getFP(){return navigator.userAgent+"|"+screen.width+"x"+screen.height+"|"+navigator.language;}',
    'function showLogin(){document.getElementById("authLogin").style.display="block";document.getElementById("authReg").style.display="none";}',
    'function showReg(){document.getElementById("authLogin").style.display="none";document.getElementById("authReg").style.display="block";}',
    '',
    'function doLogin(){',
    '  var em=document.getElementById("lgEmail").value.trim(),pw=document.getElementById("lgPass").value;',
    '  if(!em||!pw){document.getElementById("lgMsg").className="auth-msg er";document.getElementById("lgMsg").textContent="Completa todos los campos";return;}',
    '  document.getElementById("lgMsg").className="auth-msg";document.getElementById("lgMsg").innerHTML=\'<span class="sp"></span> Verificando...\';',
    '  google.script.run.withSuccessHandler(function(j){',
    '    var r=JSON.parse(j);',
    '    if(r.error){document.getElementById("lgMsg").className="auth-msg er";document.getElementById("lgMsg").textContent=r.error;return;}',
    '    localStorage.setItem("tnuio_token",r.token);localStorage.setItem("tnuio_fp",getFP());',
    '    enterApp(r.nombre,r.email);',
    '  }).withFailureHandler(function(e){document.getElementById("lgMsg").className="auth-msg er";document.getElementById("lgMsg").textContent=e.message;}).loginUsuario(em,pw,getFP());',
    '}',
    '',
    'function doRegister(){',
    '  var nm=document.getElementById("rgName").value.trim(),em=document.getElementById("rgEmail").value.trim(),pw=document.getElementById("rgPass").value;',
    '  if(!nm||!em||!pw){document.getElementById("rgMsg").className="auth-msg er";document.getElementById("rgMsg").textContent="Completa todos los campos";return;}',
    '  document.getElementById("rgMsg").className="auth-msg";document.getElementById("rgMsg").innerHTML=\'<span class="sp"></span> Registrando...\';',
    '  google.script.run.withSuccessHandler(function(j){',
    '    var r=JSON.parse(j);',
    '    if(r.error){document.getElementById("rgMsg").className="auth-msg er";document.getElementById("rgMsg").textContent=r.error;return;}',
    '    document.getElementById("rgMsg").className="auth-msg ok";document.getElementById("rgMsg").textContent=r.msg;',
    '    setTimeout(showLogin,1500);',
    '  }).withFailureHandler(function(e){document.getElementById("rgMsg").className="auth-msg er";document.getElementById("rgMsg").textContent=e.message;}).registrarUsuario(nm,em,pw);',
    '}',
    '',
    'function doLogout(){',
    '  var tk=localStorage.getItem("tnuio_token");',
    '  if(tk)google.script.run.cerrarSesion(tk);',
    '  localStorage.removeItem("tnuio_token");localStorage.removeItem("tnuio_fp");',
    '  document.getElementById("mainApp").style.display="none";',
    '  document.getElementById("authOverlay").style.display="flex";',
    '  document.getElementById("lgEmail").value="";document.getElementById("lgPass").value="";',
    '  document.getElementById("lgMsg").textContent="";',
    '}',
    '',
    'function enterApp(nombre,email){',
    '  document.getElementById("authOverlay").style.display="none";',
    '  document.getElementById("mainApp").style.display="flex";',
    '  document.getElementById("suName").textContent=nombre||"Usuario";',
    '  document.getElementById("suEmail").textContent=email||"";',
    '  iS();',
    '}',
    '',
    '// Enter key on login/register',
    'document.getElementById("lgPass").addEventListener("keydown",function(e){if(e.key==="Enter")doLogin();});',
    'document.getElementById("rgPass").addEventListener("keydown",function(e){if(e.key==="Enter")doRegister();});',
    '',
    '// Check existing session on load',
    '(function(){',
    '  var tk=localStorage.getItem("tnuio_token"),fp=localStorage.getItem("tnuio_fp");',
    '  if(!tk){document.getElementById("authLoading").style.display="none";return;}',
    '  document.getElementById("authLogin").style.display="none";',
    '  document.getElementById("authLoading").style.display="block";',
    '  google.script.run.withSuccessHandler(function(j){',
    '    var r=JSON.parse(j);',
    '    document.getElementById("authLoading").style.display="none";',
    '    if(r.ok){enterApp(r.nombre,r.email);}',
    '    else{localStorage.removeItem("tnuio_token");document.getElementById("authLogin").style.display="block";}',
    '  }).withFailureHandler(function(){',
    '    document.getElementById("authLoading").style.display="none";',
    '    document.getElementById("authLogin").style.display="block";',
    '  }).validarSesion(tk,fp||getFP());',
    '})();',
    '</script></body></html>'
  ].join('\n');
}
