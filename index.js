const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2');
const path = require('path');
const he = require('he'); // Decodificador de entidades HTML (resuelve &iacute;, &aacute;, etc.)

const {
    token,
    retStaticToken,
    retTestBaseUrl,
    retProdBaseUrl,
    usuario,
    password,
    database,
    host,
    port
} = require('./config');

app.use(bodyParser.json());
app.use('/docs', express.static(path.join(__dirname, 'docs')));

const staticToken = token;
const retApiToken = retStaticToken || 'RET-TEST-2026-STATIC-TOKEN';
const retTestUrl = retTestBaseUrl || 'http://localhost:3001';
const retProdUrl = retProdBaseUrl || 'https://api-ret-produccion.example.com';

// Configuración de la conexión MySQL
const dbConfig = {
    host: host,
    user: usuario,
    password: password,
    database: database,
    port: port,
    connectTimeout: 10000,
    charset: 'utf8mb4'
};

// ==================== FUNCIONES DE BASE DE DATOS ====================

// Función para crear conexión por cada operación (PARA EL CHECADOR)
async function withDatabaseConnection(callback) {
    let connection;

    try {
        connection = mysql.createConnection(dbConfig);

        await new Promise((resolve, reject) => {
            connection.connect((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });

        const result = await callback(connection);
        return result;

    } catch (error) {
        console.error('❌ Error con conexión a BD:', error.message);
        throw error;
    } finally {
        if (connection) {
            try {
                connection.end();
            } catch (closeError) {
                // Ignorar errores al cerrar
            }
        }
    }
}



// Conexión permanente para la API (mantener abierta)
// -------------------------------------------------
// Pool de conexiones MySQL (reemplaza la conexión única)
// -------------------------------------------------
const pool = mysql.createPool({
  ...dbConfig,
  connectionLimit: 10, // Máximo de conexiones simultáneas
  waitForConnections: true,
  queueLimit: 0,
});
const promisePool = pool.promise();

// Opcional: Verificar conexión al iniciar la aplicación
promisePool.getConnection()
  .then(conn => {
    console.log('Conexión a la base de datos MariaDB establecida (pool).');
    conn.release();
  })
  .catch(err => {
    console.error('Error al conectar al pool de MySQL:', err);
    process.exit(1);
  });

// Función query para la API (usa conexión permanente)
async function query(sql, params) {
  console.log(sql, params);
  const [rows] = await promisePool.execute(sql, params);
  return rows;
}

// -------------------------------------------------
// Decodificación de entidades HTML en respuestas
// -------------------------------------------------
// Algunos valores se almacenaron en la BD codificados como entidades HTML
// (p.ej. "Gu&iacute;a de Tur&iacute;stas"). Esta función los devuelve ya
// legibles ("Guía de Turistas") SIN modificar la base de datos: la limpieza
// ocurre únicamente en la capa de respuesta de la API.
//
// Recorre recursivamente strings, arrays y objetos. Acepta filas de MySQL,
// listas de filas o valores sueltos. Es segura ante null/undefined/números.
function decodeHtmlEntities(value) {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
        // he.decode resuelve entidades nombradas (&iacute;), numéricas (&#237;)
        // y hexadecimales (&#xED;). Si no hay entidades, devuelve el mismo texto.
        return he.decode(value);
    }

    if (Array.isArray(value)) {
        return value.map(decodeHtmlEntities);
    }

    if (typeof value === 'object') {
        // Conserva el tipo Date y otros objetos no planos sin tocarlos.
        if (value instanceof Date) return value;
        const out = {};
        for (const k of Object.keys(value)) {
            out[k] = decodeHtmlEntities(value[k]);
        }
        return out;
    }

    // number, boolean, bigint, etc. → sin cambios
    return value;
}

// ==================== FUNCIONES DEL CHECADOR ====================

// Parámetros de negocio
const MIN_GAP_SECONDS = 60;
const MIN_STAY_SECONDS = 60;

// Utilidades de fecha/hora
function toYMD(date) {
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function toHMS(date) {
    const d = new Date(date);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map(v => String(v).padStart(2, '0')).join(':');
}

function diffSeconds(a, b) {
    return Math.floor((new Date(b) - new Date(a)) / 1000);
}

function getPunchType(registro) {
    if (typeof registro.state === 'number') {
        const s = registro.state;
        if ([0, 3, 4].includes(s)) return 'IN';
        if ([1, 2, 5].includes(s)) return 'OUT';
    }
    return null;
}




// ==================== MIDDLEWARE Y API ====================

// Middleware para verificar el token JWT
function verifyStaticToken(req, res, next) {
    const bearerHeader = req.headers['authorization'];

    if (typeof bearerHeader !== 'undefined') {
        const token = bearerHeader.split(' ')[1];

        if (token != 'ZRnsLEykJAMTEvacurIPAMAeRvelINclOg') {
            return res.status(403).json({ error: true, respuesta: 'Token inválido o expirado' });
        } else {
            const data = req.body;
            req.userData = data;
            next();
        }

    } else {
        res.status(403).json({ error: true, respuesta: 'Token no proporcionado' });
    }
}

function verifyRetStaticToken(req, res, next) {
    const authorizationHeader = req.headers.authorization || '';
    const [scheme, token] = authorizationHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({
            error: true,
            codigo: 'RET-401',
            mensaje: 'Token no proporcionado',
            observacion: 'Envia el encabezado Authorization: Bearer <token_estatico>'
        });
    }

    if (token !== retApiToken) {
        return res.status(401).json({
            error: true,
            codigo: 'RET-401',
            mensaje: 'Token invalido',
            observacion: 'Verifica el token estatico configurado para el ambiente de pruebas'
        });
    }

    next();
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidDate(value) {
    return !Number.isNaN(Date.parse(value));
}

function buildRetTrackingCode() {
    return `RET-${Date.now()}`;
}

function buildRetApiDocumentation() {
    return {
        api: 'Registro Estatal de Turismo',
        version: '1.0.0',
        formato: 'JSON',
        importablePostman: `${retTestUrl}/docs/ret-registro-estatal-turismo.postman_collection.json`,
        importablePostmanEnvironment: `${retTestUrl}/docs/ret-registro-estatal-turismo.postman_environment.json`,
        evidenciaGrafica: `${retTestUrl}/docs/ret-registro-estatal-turismo-evidencia.html`,
        descripcion: 'API de inyeccion al Sistema RET para registrar solicitudes del tramite Registro Estatal de Turismo en ambiente de pruebas.',
        autenticacion: {
            tipo: 'Bearer Token estatico',
            consumo: {
                header: 'Authorization',
                formato: `Bearer ${retApiToken}`,
                nota: 'Token estatico de pruebas. No requiere firma JWT ni API de pago.'
            }
        },
        ambientes: {
            pruebas: {
                nombre: 'Ambiente de pruebas',
                baseUrl: retTestUrl,
                endpoint: `${retTestUrl}/api/ret/registro-estatal-turismo`,
                disponible: true
            },
            produccion: {
                nombre: 'Ambiente de produccion',
                baseUrl: retProdUrl,
                endpoint: `${retProdUrl}/api/ret/registro-estatal-turismo`
            }
        },
        endpoint: {
            metodo: 'POST',
            url: '/api/ret/registro-estatal-turismo',
            contentType: 'application/json'
        },
        glosarioVariables: [
            { variable: 'folioSolicitud', tipo: 'string', clasificacion: 'obligatoria', funcion: 'Identificador unico del tramite enviado por el sistema consumidor.' },
            { variable: 'fechaSolicitud', tipo: 'string', clasificacion: 'obligatoria', funcion: 'Fecha y hora de captura o envio del tramite en formato ISO 8601.' },
            { variable: 'tipoSolicitante', tipo: 'string', clasificacion: 'obligatoria', funcion: 'Indica si el solicitante es Persona Fisica o Persona Moral.' },
            { variable: 'nombreSolicitante', tipo: 'string', clasificacion: 'obligatoria', funcion: 'Nombre completo o razon social del solicitante.' },
            { variable: 'rfc', tipo: 'string', clasificacion: 'obligatoria', funcion: 'RFC del solicitante o contribuyente relacionado al tramite.' },
            { variable: 'correoElectronico', tipo: 'string', clasificacion: 'obligatoria', funcion: 'Correo para contacto y seguimiento del tramite.' },
            { variable: 'telefono', tipo: 'string', clasificacion: 'obligatoria', funcion: 'Telefono de contacto del solicitante.' },
            { variable: 'municipio', tipo: 'string', clasificacion: 'obligatoria', funcion: 'Municipio donde se realiza o registra la actividad turistica.' },
            { variable: 'nombreComercial', tipo: 'string', clasificacion: 'opcional', funcion: 'Nombre comercial del establecimiento turistico si aplica.' },
            { variable: 'observaciones', tipo: 'string', clasificacion: 'opcional', funcion: 'Comentarios adicionales enviados por el sistema origen.' },
            { variable: 'datosTramite', tipo: 'object', clasificacion: 'obligatoria', funcion: 'Objeto que concentra los datos particulares requeridos por el sistema RET para el tramite.' },
            { variable: 'datosTramite.tipoEstablecimiento', tipo: 'string', clasificacion: 'obligatoria', funcion: 'Clasificacion del establecimiento turistico a registrar.' },
            { variable: 'datosTramite.direccion', tipo: 'string', clasificacion: 'obligatoria', funcion: 'Domicilio completo del establecimiento o actividad.' },
            { variable: 'datosTramite.localidad', tipo: 'string', clasificacion: 'obligatoria', funcion: 'Localidad asociada al tramite.' },
            { variable: 'datosTramite.codigoPostal', tipo: 'string', clasificacion: 'obligatoria', funcion: 'Codigo postal del establecimiento.' },
            { variable: 'datosTramite.representanteLegal', tipo: 'string', clasificacion: 'opcional', funcion: 'Nombre del representante legal cuando aplique.' },
            { variable: 'token', tipo: 'string', clasificacion: 'fija', funcion: 'Se consume via encabezado Authorization con un token estatico de pruebas.' }
        ],
        glosarioRespuesta: [
            { variable: 'error', tipo: 'boolean', clasificacion: 'fija', funcion: 'Indica si la operacion fallo o fue exitosa.' },
            { variable: 'codigo', tipo: 'string', clasificacion: 'fija', funcion: 'Codigo funcional de resultado o error de la API RET.' },
            { variable: 'mensaje', tipo: 'string', clasificacion: 'fija', funcion: 'Descripcion general del resultado del consumo.' },
            { variable: 'observacion', tipo: 'string', clasificacion: 'fija', funcion: 'Detalle adicional sobre la aceptacion o error del tramite.' },
            { variable: 'ambiente', tipo: 'string', clasificacion: 'fija', funcion: 'Ambiente que proceso la solicitud.' },
            { variable: 'tramite', tipo: 'string', clasificacion: 'fija', funcion: 'Nombre del tramite procesado.' },
            { variable: 'folioSolicitud', tipo: 'string', clasificacion: 'fija', funcion: 'Folio original enviado por el consumidor.' },
            { variable: 'folioSeguimiento', tipo: 'string', clasificacion: 'fija', funcion: 'Folio generado por la API para seguimiento interno.' },
            { variable: 'fechaRecepcion', tipo: 'string', clasificacion: 'fija', funcion: 'Fecha de recepcion del payload en formato ISO 8601.' },
            { variable: 'data', tipo: 'object', clasificacion: 'opcional', funcion: 'Eco estructurado de los datos aceptados por la API de pruebas.' }
        ],
        peticionEjemplo: {
            folioSolicitud: 'RET-TEST-0001',
            fechaSolicitud: '2026-03-25T10:00:00-06:00',
            tipoSolicitante: 'Persona Moral',
            nombreSolicitante: 'Hotel Demo del Centro SA de CV',
            rfc: 'XAXX010101000',
            correoElectronico: 'demo.ret@sectur.gob.mx',
            telefono: '5555555555',
            municipio: 'Oaxaca de Juarez',
            nombreComercial: 'Hotel Demo del Centro',
            observaciones: 'Registro de prueba para integracion con RET.',
            datosTramite: {
                tipoEstablecimiento: 'Hospedaje',
                direccion: 'Av. Principal 100, Centro',
                localidad: 'Oaxaca de Juarez',
                codigoPostal: '68000',
                representanteLegal: 'Maria Perez'
            }
        },
        respuestaExitosaEjemplo: {
            error: false,
            codigo: 'RET-000',
            mensaje: 'Solicitud procesada correctamente en ambiente de pruebas',
            observacion: 'La informacion fue aceptada por la API de prueba del RET',
            folioSeguimiento: 'RET-1742896800000',
            ambiente: 'pruebas',
            fechaRecepcion: '2026-03-25T10:00:00.000Z'
        },
        respuestaErrorEjemplo: {
            error: true,
            codigo: 'RET-400',
            mensaje: 'Datos obligatorios incompletos',
            observacion: 'Faltan uno o mas campos requeridos para el tramite'
        },
        codigosError: [
            { httpStatus: 200, codigo: 'RET-000', descripcion: 'Solicitud aceptada y procesada correctamente.' },
            { httpStatus: 400, codigo: 'RET-400', descripcion: 'Peticion invalida o datos obligatorios incompletos.' },
            { httpStatus: 401, codigo: 'RET-401', descripcion: 'Token ausente o invalido.' },
            { httpStatus: 409, codigo: 'RET-409', descripcion: 'La solicitud ya fue enviada con el mismo folio.' },
            { httpStatus: 500, codigo: 'RET-500', descripcion: 'Error interno al procesar la solicitud.' }
        ],
        datosPrueba: {
            tokenEstatico: retApiToken,
            body: {
                folioSolicitud: 'RET-TEST-0001',
                fechaSolicitud: '2026-03-25T10:00:00-06:00',
                tipoSolicitante: 'Persona Moral',
                nombreSolicitante: 'Hotel Demo del Centro SA de CV',
                rfc: 'XAXX010101000',
                correoElectronico: 'demo.ret@sectur.gob.mx',
                telefono: '5555555555',
                municipio: 'Oaxaca de Juarez',
                nombreComercial: 'Hotel Demo del Centro',
                observaciones: 'Consumo de prueba para RET.',
                datosTramite: {
                    tipoEstablecimiento: 'Hospedaje',
                    direccion: 'Av. Principal 100, Centro',
                    localidad: 'Oaxaca de Juarez',
                    codigoPostal: '68000',
                    representanteLegal: 'Maria Perez'
                }
            }
        }
    };
}

// Funciones de transacción (para la API)
async function beginTransaction() {
  const conn = await promisePool.getConnection();
  await conn.beginTransaction();
  return conn;
}

async function commitTransaction(conn) {
  await conn.commit();
  conn.release();
}

async function rollbackTransaction(conn) {
  await conn.rollback();
  conn.release();
}

// ==================== ENDPOINTS DE LA API ====================

app.get('/api/docs/ret/registro-estatal-turismo', (req, res) => {
    return res.json(buildRetApiDocumentation());
});

app.post('/api/ret/registro-estatal-turismo', verifyRetStaticToken, async (req, res) => {
    const {
        folioSolicitud,
        fechaSolicitud,
        tipoSolicitante,
        nombreSolicitante,
        rfc,
        correoElectronico,
        telefono,
        municipio,
        nombreComercial,
        observaciones,
        datosTramite
    } = req.body || {};

    const missingFields = [
        ['folioSolicitud', folioSolicitud],
        ['fechaSolicitud', fechaSolicitud],
        ['tipoSolicitante', tipoSolicitante],
        ['nombreSolicitante', nombreSolicitante],
        ['rfc', rfc],
        ['correoElectronico', correoElectronico],
        ['telefono', telefono],
        ['municipio', municipio],
        ['datosTramite', datosTramite],
        ['datosTramite.tipoEstablecimiento', datosTramite && datosTramite.tipoEstablecimiento],
        ['datosTramite.direccion', datosTramite && datosTramite.direccion],
        ['datosTramite.localidad', datosTramite && datosTramite.localidad],
        ['datosTramite.codigoPostal', datosTramite && datosTramite.codigoPostal]
    ].filter(([, value]) => !value).map(([field]) => field);

    if (missingFields.length > 0) {
        return res.status(400).json({
            error: true,
            codigo: 'RET-400',
            mensaje: 'Datos obligatorios incompletos',
            observacion: `Campos faltantes: ${missingFields.join(', ')}`
        });
    }

    if (!isValidEmail(correoElectronico)) {
        return res.status(400).json({
            error: true,
            codigo: 'RET-400',
            mensaje: 'Correo electronico invalido',
            observacion: 'El campo correoElectronico debe tener un formato valido'
        });
    }

    if (!isValidDate(fechaSolicitud)) {
        return res.status(400).json({
            error: true,
            codigo: 'RET-400',
            mensaje: 'Fecha de solicitud invalida',
            observacion: 'El campo fechaSolicitud debe enviarse en formato ISO 8601'
        });
    }

    if (String(folioSolicitud).toUpperCase().includes('DUPLICADO')) {
        return res.status(409).json({
            error: true,
            codigo: 'RET-409',
            mensaje: 'Folio de solicitud duplicado',
            observacion: 'El folio enviado ya fue utilizado previamente en ambiente de pruebas'
        });
    }

    try {
        return res.status(200).json({
            error: false,
            codigo: 'RET-000',
            mensaje: 'Solicitud procesada correctamente en ambiente de pruebas',
            observacion: 'La informacion fue aceptada por la API de prueba del RET',
            ambiente: 'pruebas',
            tramite: 'Registro Estatal de Turismo',
            folioSolicitud,
            folioSeguimiento: buildRetTrackingCode(),
            fechaRecepcion: new Date().toISOString(),
            data: {
                tipoSolicitante,
                nombreSolicitante,
                rfc,
                correoElectronico,
                telefono,
                municipio,
                nombreComercial: nombreComercial || null,
                observaciones: observaciones || null,
                datosTramite
            }
        });
    } catch (error) {
        return res.status(500).json({
            error: true,
            codigo: 'RET-500',
            mensaje: 'Error interno al procesar la solicitud',
            observacion: error.message
        });
    }
});

// ==================== LÓGICA DE NEGOCIO RET (equivalente a Guardar_form.php) ====================

/**
 * Catálogo de giros del RET.
 * Cada entrada define:
 *   - tabla:      tabla específica del giro en la BD
 *   - autoclasif: campo cuyo valor se copia a ret_datos_generales.autoclasificacion al concluir
 *   - verifyDb:   si debe ejecutarse la verificación de filas pregrabadas (giros 1 y 17)
 *   - obsoleto:   si el formulario fue descontinuado (giro 8 — Educativas)
 *   - camposReq:  campos de negocio obligatorios según el formulario PHP
 *
 * Ejemplo de uso:
 *   GIRO_META['hospedaje'].tabla          // 'ret_frm_hospedaje'
 *   GIRO_META['restaurante'].autoclasif   // 'tipo_establecimiento'
 */
const GIRO_META = {
    'datos-generales':  { tabla: 'ret_datos_generales',          autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: [] },
    'datos-tecnicos':   { tabla: 'ret_frm_tecnicos',             autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: [] },
    'datos-legales':    { tabla: 'ret_archivo_legal',             autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: [] },
    'imagenes':         { tabla: 'ret_archivo_legal',             autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: [] },
    'hospedaje':        { tabla: 'ret_frm_hospedaje',             autoclasif: 'establecimiento',       verifyDb: true,  obsoleto: false, camposReq: ['establecimiento', 'tipo', 'tipo2', 'cuartos', 'pisos', 'nocajon', 'seguro'] },
    'agencia':          { tabla: 'ret_frm_agencia',               autoclasif: 'modalidad',             verifyDb: false, obsoleto: false, camposReq: ['asociacion'] },
    'guias':            { tabla: 'ret_frm_guia',                  autoclasif: 'guia',                  verifyDb: false, obsoleto: false, camposReq: ['num_credencial'] },
    'promotor':         { tabla: 'ret_frm_promotores',            autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: ['licencia', 'zona'] },
    'restaurante':      { tabla: 'ret_frm_restaurantes',          autoclasif: 'tipo_establecimiento',  verifyDb: false, obsoleto: false, camposReq: ['num_potenciales', 'num_mesas'] },
    'golf':             { tabla: 'ret_frm_golf',                  autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: ['turistico', 'hoyos', 'par', 'longitud'] },
    'arte':             { tabla: 'ret_frm_arte',                  autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: ['descripcion', 'operacion'] },
    'educativa':        { tabla: 'ret_frm_educativas',            autoclasif: null,                    verifyDb: false, obsoleto: true,  camposReq: [] },
    'arrendadora':      { tabla: 'ret_frm_arrendadora',           autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: ['novehiculos', 'tipovehiculos'] },
    'parque':           { tabla: 'ret_frm_parques',               autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: ['capacidad'] },
    'auxilio':          { tabla: 'ret_frm_auxturistico',          autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: ['horario'] },
    'balneario':        { tabla: 'ret_frm_balnearios',            autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: ['capacidad', 'alberca', 'chapoteadero', 'tobogan', 'estacionamiento', 'apertura'] },
    'capacitacion':     { tabla: 'ret_frm_capacitacion',          autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: ['nopersonas'] },
    'deporte':          { tabla: 'ret_frm_deporte',               autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: ['detalle'] },
    'spa':              { tabla: 'ret_frm_spa',                   autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: ['horario'] },
    'recinto':          { tabla: 'ret_frm_recinto',               autoclasif: null,                    verifyDb: false, obsoleto: false, camposReq: ['horario', 'modalidad'] },
    'hospedaje-digital':{ tabla: 'ret_frm_hospedaje-digitales',   autoclasif: null,                    verifyDb: true,  obsoleto: false, camposReq: ['categoria', 'establecimiento', 'cuartos', 'pisos', 'seguro'] },
};

/**
 * Construye un UPDATE parametrizado seguro.
 * Equivalente a update_data() del modelo PHP.
 * @param {object} conn   - Conexión de transacción activa
 * @param {string} tabla  - Nombre de la tabla destino
 * @param {object} data   - Campos y valores a actualizar
 * @param {string} campoClave - Columna WHERE (generalmente 'clave')
 * @param {string} valorClave - Valor del WHERE
 */
async function txUpdate(conn, tabla, data, campoClave, valorClave) {
    const keys = Object.keys(data);
    if (keys.length === 0) return { affectedRows: 0 };
    const setClause = keys.map(k => `\`${k}\` = ?`).join(', ');
    const values    = [...keys.map(k => data[k]), valorClave];
    const sql       = `UPDATE \`${tabla}\` SET ${setClause} WHERE \`${campoClave}\` = ?`;
    console.log('[TX UPDATE]', sql, values);
    const [result] = await conn.execute(sql, values);
    return result;
}

/**
 * Construye un INSERT parametrizado seguro.
 * Equivalente a insert() en el modelo PHP.
 * @param {object} conn  - Conexión de transacción activa
 * @param {string} tabla - Nombre de la tabla destino
 * @param {object} data  - Campos y valores a insertar
 */
async function txInsert(conn, tabla, data) {
    const keys   = Object.keys(data);
    const cols   = keys.map(k => `\`${k}\``).join(', ');
    const marks  = keys.map(() => '?').join(', ');
    const values = keys.map(k => data[k]);
    const sql    = `INSERT INTO \`${tabla}\` (${cols}) VALUES (${marks})`;
    console.log('[TX INSERT]', sql, values);
    const [result] = await conn.execute(sql, values);
    return result;
}

/**
 * Inserta N filas pregrabadas en tablas de detalle de hospedaje.
 * Equivalente al insertBatch del PHP para hospedaje_detalle (10 filas) y hospedaje_estable (6 filas).
 * @param {object} conn    - Conexión de transacción
 * @param {string} tabla   - Tabla de detalle
 * @param {string} clave   - Clave RET
 * @param {number} cantidad - Número de filas a pregrabar
 * @param {string} campo   - Nombre del campo secuencial ('hab' o 'estab')
 */
async function txInsertDetalle(conn, tabla, clave, cantidad, campo) {
    const placeholders = Array.from({ length: cantidad }, () => `(?, ?)`).join(', ');
    const values = [];
    for (let i = 1; i <= cantidad; i++) { values.push(clave, i); }
    const sql = `INSERT INTO \`${tabla}\` (\`clave\`, \`${campo}\`) VALUES ${placeholders}`;
    console.log('[TX INSERT DETALLE]', sql);
    const [result] = await conn.execute(sql, values);
    return result;
}

/**
 * Verifica que existan las filas pregrabadas de detalle para los giros 1 y 17.
 * Equivalente a verify_db() del modelo PHP.
 * Si faltan filas, las elimina y las regenera dentro de una transacción propia.
 * @param {number} giro  - Número de giro (1 o 17)
 * @param {string} clave - Clave RET del prestador
 */
async function verifyDb(giro, clave) {
    const g = parseInt(giro);
    let tablaDet, tablaEst, countDet, countEst, campoDet;

    if (g === 1) {
        tablaDet = 'ret_frm_hospedaje_detalle';
        tablaEst = 'ret_frm_hospedaje_estable';
        countDet = 10; countEst = 6; campoDet = 'hab';
    } else if (g === 17) {
        tablaDet = 'ret_frm_hospedaje-digitales_detalle';
        tablaEst = 'ret_frm_hospedaje-digitales_estable';
        countDet = 10; countEst = 6; campoDet = 'hab';
    } else {
        return;
    }

    const [[rowsDet]] = await promisePool.execute(`SELECT COUNT(*) AS c FROM \`${tablaDet}\` WHERE clave = ?`, [clave]);
    const [[rowsEst]] = await promisePool.execute(`SELECT COUNT(*) AS c FROM \`${tablaEst}\` WHERE clave = ?`, [clave]);

    if (rowsDet.c === countDet && rowsEst.c === countEst) return; // Todo OK

    // Regenerar filas pregrabadas
    const conn = await beginTransaction();
    try {
        await conn.execute(`DELETE FROM \`${tablaDet}\` WHERE clave = ?`, [clave]);
        await conn.execute(`DELETE FROM \`${tablaEst}\` WHERE clave = ?`, [clave]);
        await txInsertDetalle(conn, tablaDet, clave, countDet, campoDet);
        await txInsertDetalle(conn, tablaEst, clave, countEst, 'estab');
        await commitTransaction(conn);
        console.log(`✅ verifyDb: filas regeneradas para clave=${clave} giro=${g}`);
    } catch (err) {
        await rollbackTransaction(conn);
        console.error('❌ verifyDb error:', err.message);
        throw err;
    }
}

/**
 * Ejecuta la lógica del switch de Guardar_form.php.
 * Dado un controlador, determina qué tabla(s) actualizar y si debe marcar concluido=1.
 *
 * Controladores de giro (Paso 5):
 *   hospedaje | agencia | guias | promotor | restaurante | golf | arte |
 *   educativa | arrendadora | parque | auxilio | balneario | capacitacion |
 *   deporte | spa | recinto | hospedaje-digital
 *
 * Controladores de pasos comunes (Pasos 1-4):
 *   datos-generales | datos-tecnicos | datos-legales | imagenes
 *
 * @param {object} conn        - Conexión de transacción activa
 * @param {string} controlador - Nombre del controlador PHP
 * @param {object} dbfield     - Campos del formulario validados
 * @param {string} clave       - Clave RET del prestador
 * @returns {{ tablaGiro: string|null, concluido: boolean }}
 */
async function ejecutarLogicaGuardarForm(conn, controlador, dbfield, clave) {
    const meta = GIRO_META[controlador];
    if (!meta) throw new Error(`Controlador no reconocido: ${controlador}`);

    // Pasos 1-4: solo actualizar la tabla correspondiente, sin concluir
    if (['datos-generales', 'datos-tecnicos', 'datos-legales', 'imagenes'].includes(controlador)) {
        await txUpdate(conn, meta.tabla, dbfield, 'clave', clave);
        return { tablaGiro: null, concluido: false };
    }

    // Giro 8 — Educativas (OBSOLETO): solo marcar concluido, no guardar campos
    if (meta.obsoleto) {
        await txUpdate(conn, 'ret_datos_generales', { concluido: 1, renovar: 0 }, 'clave', clave);
        return { tablaGiro: meta.tabla, concluido: true };
    }

    // Paso 5 — cualquier giro activo: verifyDb si aplica, guardar formulario, concluir
    if (meta.verifyDb) {
        const giroNum = controlador === 'hospedaje' ? 1 : 17;
        await verifyDb(giroNum, clave);
    }

    // Guardar datos en la tabla del giro
    await txUpdate(conn, meta.tabla, dbfield, 'clave', clave);

    // Construir dgrales equivalente al PHP
    const dgrales = { concluido: 1, renovar: 0 };
    if (meta.autoclasif && dbfield[meta.autoclasif] !== undefined) {
        dgrales['autoclasificacion'] = dbfield[meta.autoclasif];
    }
    await txUpdate(conn, 'ret_datos_generales', dgrales, 'clave', clave);

    return { tablaGiro: meta.tabla, concluido: true };
}

// ==================== REGISTRO INICIAL RET (equivalente a Usuario_model->nuevo()) ====================

/**
 * Ancho (dígitos con relleno de ceros) de la parte numérica id_pts en la clave.
 *   4 → "RET01110042"   (coincide con sprintf("%04d") del PHP Usuario_model) ← ACTUAL
 *   5 → "RET011100042"  (formato alterno visto en la documentación)
 * Fuente de verdad: Usuario_model->nuevo():
 *   $clave = 'RET'.sprintf("%02d",$giro).sprintf("%02d",$municipio).sprintf("%04d",$id_pts);
 * NOTA: es solo relleno mínimo; ids mayores al ancho crecen de forma natural.
 */
const RET_ID_PAD = 4;

/**
 * Genera la clave RET con el mismo patrón que el modelo PHP:
 *   'RET' + giro(2 díg) + municipio(2 díg) + id_pts(RET_ID_PAD díg)
 * Ej (RET_ID_PAD=4): giro=1, municipio=11, id_pts=42  →  "RET01110042"
 *
 * @param {number|string} giro      - ID del giro
 * @param {number|string} municipio - ID del municipio
 * @param {number}        idPts     - insertID() de ret_datos_generales
 * @returns {string} Clave RET
 */
function generarClaveRET(giro, municipio, idPts) {
    const pad = (val, len) => String(parseInt(val, 10)).padStart(len, '0');
    return 'RET' + pad(giro, 2) + pad(municipio, 2) + pad(idPts, RET_ID_PAD);
}

/**
 * Mapa giro → tabla(s) del giro donde se debe pre-insertar la clave al crear
 * el registro inicial. Replica el switch de Usuario_model->nuevo().
 * Solo se siembra la fila base con la clave; los datos del giro se cargan
 * después vía /saveTabla (Paso 5).
 */
const GIRO_TABLA_INICIAL = {
    1:  'ret_frm_hospedaje',
    2:  'ret_frm_agencia',
    3:  'ret_frm_guia',
    4:  'ret_frm_promotores',
    5:  'ret_frm_restaurantes',
    6:  'ret_frm_golf',
    7:  'ret_frm_arte',
    8:  'ret_frm_educativas',
    9:  'ret_frm_arrendadora',
    10: 'ret_frm_parques',
    11: 'ret_frm_auxturistico',
    12: 'ret_frm_balnearios',
    13: 'ret_frm_capacitacion',
    14: 'ret_frm_deporte',
    15: 'ret_frm_spa',
    16: 'ret_frm_recinto',
    17: 'ret_frm_hospedaje-digitales',
};

/**
 * POST /crearRegistroRET
 * Crea un registro RET inicial y devuelve la clave RET generada.
 * Es el equivalente HTTP de Usuario_model->nuevo(): inserta en
 * ret_datos_generales, genera la clave, la propaga a las tablas de pasos
 * comunes (técnicos, legales) y a la tabla del giro elegido, y para los
 * giros 1 y 17 pregraba las filas de detalle/establecimientos.
 *
 * Toda la operación corre dentro de una transacción con rollback automático.
 *
 * ─── Estructura del body ──────────────────────────────────────────────────
 *  data (object) — Campos iniciales del registro. Mínimos obligatorios:
 *    .info_rfc          (string)  — RFC del prestador.
 *    .giro              (number)  — ID del giro (1..17).
 *    .municipio         (number)  — ID del municipio.
 *    .nombre_comercial  (string)  — Nombre comercial.
 *    .correo            (string)  — Correo del prestador.
 *  Campos opcionales se insertan tal cual lleguen en data (privacidad,
 *  ip_visitante, etc.). NO envíes 'clave': la API la genera.
 *
 *  bitacora (object, opcional) — { id_user, script } para log de auditoría.
 *
 * ─── Respuesta exitosa ────────────────────────────────────────────────────
 *  { "error": false,
 *    "respuesta": "Registro creado correctamente",
 *    "clave": "RET01110042",        ← úsala como pivote en /saveTabla
 *    "id_pts": 42,
 *    "giro": 1,
 *    "municipio": 11,
 *    "tablaGiro": "ret_frm_hospedaje" }
 *
 * ─── Ejemplo de petición ──────────────────────────────────────────────────
 *  { "data": {
 *      "info_rfc": "HCE960315AB3",
 *      "giro": 1,
 *      "municipio": 11,
 *      "nombre_comercial": "HOTEL CENTRO",
 *      "correo": "contacto@hotelcentro.com",
 *      "privacidad": 1,
 *      "ip_visitante": "189.203.0.1",
 *      "fecha": "2026-05-21",
 *      "fecha_registro": "2026-05-21 10:30:00"
 *    },
 *    "bitacora": { "id_user": "45", "script": "Portal/RegistroInicial" } }
 */
app.post('/crearRegistroRET', verifyStaticToken, async (req, res) => {
    const { data, bitacora } = req.body || {};
    const response = { error: true, respuesta: 'Error en la operación' };
    let conn = null;

    try {
        // ── Validaciones básicas ───────────────────────────────────────────
        if (!data || typeof data !== 'object') {
            response.respuesta = 'Error|El campo data es obligatorio';
            return res.json(response);
        }

        const requeridos = ['info_rfc', 'giro', 'municipio', 'nombre_comercial', 'correo'];
        const faltantes = requeridos.filter(c => data[c] === undefined || data[c] === null || data[c] === '');
        if (faltantes.length > 0) {
            response.respuesta = `Error|Campos obligatorios faltantes: ${faltantes.join(', ')}`;
            return res.json(response);
        }

        const giro      = parseInt(data.giro, 10);
        const municipio = parseInt(data.municipio, 10);

        if (Number.isNaN(giro) || !GIRO_TABLA_INICIAL[giro]) {
            response.respuesta = `Error|Giro no reconocido: '${data.giro}'. Valores válidos: ${Object.keys(GIRO_TABLA_INICIAL).join(', ')}`;
            return res.json(response);
        }
        if (Number.isNaN(municipio)) {
            response.respuesta = `Error|municipio debe ser numérico`;
            return res.json(response);
        }

        // La clave la genera la API: nunca se acepta del cliente.
        const datosInsert = { ...data };
        delete datosInsert.clave;
        datosInsert.giro      = giro;
        datosInsert.municipio = municipio;

        // ── Transacción ────────────────────────────────────────────────────
        conn = await beginTransaction();

        // 1) INSERT inicial en ret_datos_generales → obtener id_pts
        const insertResult = await txInsert(conn, 'ret_datos_generales', datosInsert);
        const idPts = insertResult.insertId;

        // 2) Generar clave RET
        const clave = generarClaveRET(giro, municipio, idPts);

        // 3) Actualizar ret_datos_generales con la clave (WHERE id_pts)
        await txUpdate(conn, 'ret_datos_generales', { clave }, 'id_pts', idPts);

        // 4) Sembrar la clave en tablas de pasos comunes
        await txInsert(conn, 'ret_frm_tecnicos',   { clave });
        await txInsert(conn, 'ret_archivo_legal',  { clave });

        // 5) Sembrar la clave en la tabla del giro elegido
        const tablaGiro = GIRO_TABLA_INICIAL[giro];
        await txInsert(conn, tablaGiro, { clave });

        // 6) Giros 1 (hospedaje) y 17 (hospedaje digital): pregrabar detalle/estable
        if (giro === 1) {
            await txInsertDetalle(conn, 'ret_frm_hospedaje_detalle', clave, 10, 'hab');
            await txInsertDetalle(conn, 'ret_frm_hospedaje_estable', clave, 6,  'estab');
        } else if (giro === 17) {
            await txInsertDetalle(conn, 'ret_frm_hospedaje-digitales_detalle', clave, 10, 'hab');
            await txInsertDetalle(conn, 'ret_frm_hospedaje-digitales_estable', clave, 6,  'estab');
        }

        await commitTransaction(conn);

        // ── Respuesta ──────────────────────────────────────────────────────
        response.error     = false;
        response.respuesta = 'Registro creado correctamente';
        response.clave     = clave;
        response.id_pts    = idPts;
        response.giro      = giro;
        response.municipio = municipio;
        response.tablaGiro = tablaGiro;

        if (bitacora) {
            console.log(`[BITÁCORA] crearRegistroRET clave=${clave} id_pts=${idPts} user=${bitacora.id_user || '-'} script=${bitacora.script || '-'}`);
        }

    } catch (err) {
        console.error('❌ Error en crearRegistroRET:', err.message);
        if (conn) await rollbackTransaction(conn);
        response.respuesta = `Error|${err.message}`;
    }

    return res.json(response);
});

// ==================== ENDPOINT: getTabla ====================

/**
 * POST /getTabla
 * Consulta flexible de cualquier tabla o vista de la BD del RET.
 *
 * Soporta los siguientes filtros dentro del objeto "data":
 *   tabla         (string)  — obligatorio. Tabla o vista a consultar.
 *   select        (array)   — columnas a retornar. Omitir = SELECT *.
 *   where         (object)  — condiciones de igualdad exacta.
 *   whereIn       (array)   — filtro IN: [[columna, [val1, val2, ...]], ...]
 *   whereNotIn    (array)   — filtro NOT IN.
 *   whereBetween  (array)   — filtro BETWEEN: [[columna, inicio, fin], ...]
 *   whereMonth    (array)   — filtro por mes: [[columna, num_mes], ...]
 *   like          (object)  — filtro LIKE con AND.
 *   orlike        (object)  — filtro LIKE con OR.
 *   join          (array)   — JOINs adicionales: [[tabla, ON, tipo?], ...]
 *   groupBy       (array)   — columnas para GROUP BY.
 *   orderBy       (string)  — cláusula ORDER BY.
 *   limit         (number|object) — límite. Objeto {start, length} para paginación.
 *   query         (string)  — SQL crudo. Si se envía, ignora el resto.
 *
 * NOTA: Siempre incluir activo:"0" en where para ver todos los registros
 *       (el sistema RET usa borrado lógico con el campo activo).
 *
 * Ejemplos de uso:
 *
 * // Búsqueda por RFC (recomendado como primer intento):
 * { "data": { "tabla": "vw_usr_datos", "where": { "info_rfc": "HCE960315AB3", "activo": "0" } } }
 *
 * // Búsqueda por CLAVE RET (si no hay RFC):
 * { "data": { "tabla": "vw_usr_datos", "where": { "clave": "RET011100042", "activo": "0" } } }
 *
 * // Consultar formulario de un giro específico:
 * { "data": { "tabla": "ret_frm_hospedaje", "where": { "clave": "RET011100042" } } }
 *
 * // Listar prestadores por giro y municipio:
 * { "data": { "tabla": "vw_usr_datos", "where": { "activo": "0", "municipio": 11 }, "whereIn": [["giro", [1, 5]]], "orderBy": "nombre_comercial ASC", "limit": 50 } }
 *
 * // Buscar por nombre parcial:
 * { "data": { "tabla": "vw_usr_datos", "where": { "activo": "0" }, "like": { "nombre_comercial": "hotel" } } }
 *
 * // Consultar datos técnicos:
 * { "data": { "tabla": "ret_frm_tecnicos", "where": { "clave": "RET011100042" } } }
 *
 * // Consultar archivos legales e imágenes:
 * { "data": { "tabla": "ret_archivo_legal", "where": { "clave": "RET011100042" } } }
 */
app.get('/getTabla', verifyStaticToken, async (req, res) => {
    const { data } = req.body;

    const response = {
        error: true,
        respuesta: 'Error|Parámetros de entrada',
        query: null,
        data: []
    };

    try {
        // ── Modo SQL crudo (bypass completo del builder) ──────────────────
        if (data.query) {
            try {
                const result = await query(data.query);
                response.query    = data.query;
                response.data     = decodeHtmlEntities(result);
                response.error    = false;
                response.respuesta = result.length === 0
                    ? 'No se encontraron resultados que coincidan con la búsqueda'
                    : 'Consulta exitosa';
                return res.json(response);
            } catch (err) {
                response.respuesta = 'Fallo en la consulta a la base de datos';
                response.errorDB   = err.message;
                return res.json(response);
            }
        }

        if (!data.tabla) return res.json(response);

        // ── Builder de SQL dinámico ────────────────────────────────────────
        let sql    = 'SELECT ';
        const params = [];
        let hasWhere  = false;

        // SELECT
        sql += data.select ? data.select.join(', ') : '*';
        sql += ` FROM \`${data.tabla}\``;

        // JOIN
        if (data.join) {
            data.join.forEach(j => {
                const tipo = j[2] || 'RIGHT';
                sql += ` ${tipo} JOIN ${j[0]} ON ${j[1]}`;
            });
        }

        // Helper para añadir WHERE / AND
        const addWhere = () => {
            if (!hasWhere) { sql += ' WHERE '; hasWhere = true; }
            else           { sql += ' AND '; }
        };

        // WHERE (igualdad)
        if (data.where && Object.keys(data.where).length > 0) {
            addWhere();
            sql += Object.keys(data.where).map(k => `\`${k}\` = ?`).join(' AND ');
            params.push(...Object.values(data.where));
        }

        // WHERE MONTH
        if (data.whereMonth) {
            data.whereMonth.forEach((wm, i) => {
                addWhere();
                if (i > 0) sql += ' AND ';
                sql += `MONTH(\`${wm[0]}\`) = ?`;
                params.push(wm[1]);
            });
        }

        // WHERE IN
        if (data.whereIn) {
            data.whereIn.forEach((wi, i) => {
                addWhere();
                if (i > 0) sql += ' AND ';
                sql += `\`${wi[0]}\` IN (${wi[1].map(() => '?').join(', ')})`;
                params.push(...wi[1]);
            });
        }

        // WHERE NOT IN
        if (data.whereNotIn) {
            data.whereNotIn.forEach((wni, i) => {
                addWhere();
                if (i > 0) sql += ' AND ';
                sql += `\`${wni[0]}\` NOT IN (${wni[1].map(() => '?').join(', ')})`;
                params.push(...wni[1]);
            });
        }

        // WHERE BETWEEN
        if (data.whereBetween) {
            data.whereBetween.forEach((wb, i) => {
                addWhere();
                if (i > 0) sql += ' AND ';
                sql += `\`${wb[0]}\` BETWEEN ? AND ?`;
                params.push(wb[1], wb[2]);
            });
        }

        // LIKE (AND entre columnas)
        if (data.like && Object.keys(data.like).length > 0) {
            addWhere();
            sql += Object.keys(data.like).map(k => `\`${k}\` LIKE ?`).join(' AND ');
            params.push(...Object.values(data.like).map(v => `%${v}%`));
        }

        // OR LIKE
        if (data.orlike && Object.keys(data.orlike).length > 0) {
            addWhere();
            sql += `(${Object.keys(data.orlike).map(k => `\`${k}\` LIKE ?`).join(' OR ')})`;
            params.push(...Object.values(data.orlike).map(v => `%${v}%`));
        }

        // GROUP BY
        if (data.groupBy) sql += ` GROUP BY ${data.groupBy.join(', ')}`;

        // ORDER BY
        if (data.orderBy) sql += ` ORDER BY ${data.orderBy}`;

        // LIMIT
        if (data.limit) {
            sql += (data.limit.start !== undefined)
                ? ` LIMIT ${data.limit.start}, ${data.limit.length}`
                : ` LIMIT ${data.limit}`;
        }

        const result      = await query(sql, params);
        response.query    = sql;
        response.data     = decodeHtmlEntities(result);
        response.error    = false;
        response.respuesta = result.length === 0
            ? 'No se encontraron resultados que coincidan con la búsqueda'
            : 'Consulta exitosa';
        return res.json(response);

    } catch (err) {
        console.error('❌ Error en getTabla:', err);
        response.respuesta = `Error|${err.message}`;
        return res.json(response);
    }
});

// ==================== ENDPOINT: saveTabla ====================

/**
 * POST /saveTabla
 * Guarda datos en la BD del RET siguiendo la lógica exacta de Guardar_form.php.
 *
 * El campo config.controlador determina qué tabla se afecta y qué lógica de negocio
 * se ejecuta. Toda la operación corre en una transacción con rollback automático.
 *
 * ─── Estructura del body ──────────────────────────────────────────────────────
 *
 *  data       (object)  — Campos del formulario. Checkboxes como 1/0.
 *  config     (object)  — Configuración de la operación:
 *    .controlador (string)  — Nombre del controlador PHP (ver tabla abajo).
 *    .clave       (string)  — Clave RET del prestador (ej: "RET011100042").
 *    .editar      (boolean) — false=INSERT nuevo | true=UPDATE existente.
 *    .idEditar    (object)  — Solo si editar=true. WHERE del UPDATE. Ej: {"id_pts": 909}
 *  bitacora   (object)  — Auditoría: { id_user, script }
 *
 * ─── Controladores disponibles y sus tablas ──────────────────────────────────
 *
 *  PASOS COMUNES (aplican igual para todos los giros):
 *    datos-generales  → ret_datos_generales
 *    datos-tecnicos   → ret_frm_tecnicos
 *    datos-legales    → ret_archivo_legal  (documentos legales como URLs)
 *    imagenes         → ret_archivo_legal  (imágenes como URLs)
 *
 *  PASO 5 — FORMULARIO DEL GIRO:
 *    hospedaje        → ret_frm_hospedaje             + concluido=1  (verifyDb giro 1)
 *    agencia          → ret_frm_agencia                + concluido=1
 *    guias            → ret_frm_guia                   + concluido=1
 *    promotor         → ret_frm_promotores              + concluido=1
 *    restaurante      → ret_frm_restaurantes            + concluido=1
 *    golf             → ret_frm_golf                   + concluido=1
 *    arte             → ret_frm_arte                   + concluido=1
 *    educativa        → ret_frm_educativas              + concluido=1  (OBSOLETO — sin campos)
 *    arrendadora      → ret_frm_arrendadora             + concluido=1
 *    parque           → ret_frm_parques                 + concluido=1
 *    auxilio          → ret_frm_auxturistico            + concluido=1
 *    balneario        → ret_frm_balnearios              + concluido=1
 *    capacitacion     → ret_frm_capacitacion            + concluido=1
 *    deporte          → ret_frm_deporte                 + concluido=1
 *    spa              → ret_frm_spa                     + concluido=1
 *    recinto          → ret_frm_recinto                 + concluido=1
 *    hospedaje-digital→ ret_frm_hospedaje-digitales    + concluido=1  (verifyDb giro 17)
 *
 * ─── Ejemplos JSON por giro ──────────────────────────────────────────────────
 *
 * // PASO 1 — Datos Generales:
 * { "data": { "nombre_comercial":"Hotel Centro", "contacto":"Carlos Mendoza", "tipo_persona":2,
 *     "info_rfc":"HCE960315AB3", "razon_social":"Hotelera del Centro SA de CV",
 *     "representante_moral":"Carlos Mendoza Ruiz", "giro":1, "idgiro_subrubro":3,
 *     "calle":"Hidalgo", "numero":"45", "colonia":"Centro", "municipio":11, "cp":"36000",
 *     "telefono":"4721234567", "telefono_comercial":"4721234568",
 *     "correo_atncli":"atencion@hotel.com",
 *     "descripcion":"Hotel boutique en el centro histórico de Guanajuato.",
 *     "latitud":"21.0190", "longitud":"-101.2574",
 *     "aviso_protesta":1, "privacidad":1, "protesto_juridico":1 },
 *   "config": { "controlador":"datos-generales", "clave":"RET011100042", "editar":true, "idEditar":{"clave":"RET011100042"} },
 *   "bitacora": { "id_user":"45", "script":"Portal/Registro" } }
 *
 * // PASO 2 — Datos Técnicos:
 * { "data": { "fijos_h":10, "fijos_m":8, "tempo_h":2, "tempo_m":3,
 *     "disca_h":0, "disca_m":1, "capacita":1, "cert_med":1,
 *     "inst_disca":"1", "pet_friendly":"1", "lgbttit":"1",
 *     "inversion":"Nacional", "inicio_opera":"2010-03-15",
 *     "organizacion":"Independiente", "local":1, "regional":1 },
 *   "config": { "controlador":"datos-tecnicos", "clave":"RET011100042", "editar":true, "idEditar":{"clave":"RET011100042"} } }
 *
 * // PASO 3 — Datos Legales (archivos como URLs):
 * { "data": { "a_rfc":"https://storage.com/rfc.pdf", "a_ife":"https://storage.com/ine.pdf",
 *     "a_licencia_suelo":"https://storage.com/licencia.pdf",
 *     "a_escritura_publica":"https://storage.com/escritura.pdf",
 *     "a_domicilio":"https://storage.com/domicilio.pdf" },
 *   "config": { "controlador":"datos-legales", "clave":"RET011100042", "editar":true, "idEditar":{"clave":"RET011100042"} } }
 *
 * // PASO 4 — Imágenes:
 * { "data": { "a_imagen_promocional":"https://storage.com/promo.jpg",
 *     "promocion_gtomx":1, "a_logo":"https://storage.com/logo.png",
 *     "a_imagen1":"https://storage.com/ext.jpg", "a_imagen2":"https://storage.com/int.jpg" },
 *   "config": { "controlador":"imagenes", "clave":"RET011100042", "editar":true, "idEditar":{"clave":"RET011100042"} } }
 *
 * // PASO 5 — Giro 1 Hospedaje:
 * { "data": { "establecimiento":"Hotel", "tipo":"Boutique", "tipo2":"Independiente",
 *     "cuartos":40, "pisos":4, "tv":1, "aireacondicionado":1, "telefono":1, "aguacaliente":1,
 *     "cafeteria":1, "bar":1, "restaurante":1, "internet":1, "gimnasio":1,
 *     "elevador":1, "estacionamiento":1, "nocajon":20, "tipocajon":"Interno",
 *     "seguro":1, "aseguradora":"GNP Seguros", "unidad":0 },
 *   "config": { "controlador":"hospedaje", "clave":"RET011100042", "editar":true, "idEditar":{"clave":"RET011100042"} } }
 *
 * // PASO 5 — Giro 2 Agencias:
 * { "data": { "segmento":"Turismo Cultural", "asociacion":1, "nombre_asociacion":"ANATO" },
 *   "config": { "controlador":"agencia", "clave":"RET021100010", "editar":true, "idEditar":{"clave":"RET021100010"} } }
 *
 * // PASO 5 — Giro 3 Guías:
 * { "data": { "tip_historia":1, "tip_arte":1, "tip_cultura":1, "tip_museos":0,
 *     "tip_religiosos":0, "tip_compras":1, "tip_aventura":0,
 *     "num_credencial":"SECTUR-GTO-2024-0042", "nombre_asociacion":"AGUGT",
 *     "esp":1, "eng":1, "fra":1, "ita":0, "ale":0, "cor":0, "por":0, "otro_idioma":"Japonés" },
 *   "config": { "controlador":"guias", "clave":"RET031100005", "editar":true, "idEditar":{"clave":"RET031100005"} } }
 *
 * // PASO 5 — Giro 4 Promotores:
 * { "data": { "licencia":1, "zona":"Establecimiento", "convenio":1, "txt_convenio":"Convenio hoteles boutique" },
 *   "config": { "controlador":"promotor", "clave":"RET041100003", "editar":true, "idEditar":{"clave":"RET041100003"} } }
 *
 * // PASO 5 — Giro 5 Restaurante:
 * { "data": { "licencia":"Si", "num_licencia":"SS-2024-001", "permiso":"Si",
 *     "tipo_servicio":0, "num_bebidas":"MPIO-2024-456",
 *     "hro_matutino":1, "hro_vespertino":1, "hro_diurno":1, "hro_nocturno":0,
 *     "num_potenciales":80, "num_mesas":20, "op_mesa":1, "op_alacarta":1, "tipo_cocina":"Mexicana" },
 *   "config": { "controlador":"restaurante", "clave":"RET051100033", "editar":true, "idEditar":{"clave":"RET051100033"} } }
 *
 * // PASO 5 — Giro 6 Golf:
 * { "data": { "turistico":"publico", "hoyos":18, "par":"72", "longitud":6800,
 *     "carrito":"Si", "privado":"No", "plano":0, "semiplano":1, "ondulado":1,
 *     "disenado":"Jack Nicklaus", "fairways":"Bermuda", "greens":"Bent Grass",
 *     "serv01":1, "serv02":1, "serv05":1, "tc02":1, "tc03":1, "tc04":1 },
 *   "config": { "controlador":"golf", "clave":"RET061100002", "editar":true, "idEditar":{"clave":"RET061100002"} } }
 *
 * // PASO 5 — Giro 7 Arte Popular:
 * { "data": { "tipo3":1, "tipo4":1,
 *     "descripcion":"Artesanías en barro y talavera guanajuatense.", "operacion":"Permanentes" },
 *   "config": { "controlador":"arte", "clave":"RET071100011", "editar":true, "idEditar":{"clave":"RET071100011"} } }
 *
 * // PASO 5 — Giro 9 Arrendadora:
 * { "data": { "perm2":1, "perm3":1, "novehiculos":25, "tipovehiculos":"Automóviles compactos y SUV",
 *     "caract1":1, "caract4":1, "caract8":1, "caract10":1, "mod03":1, "mod05":1,
 *     "serv01":1, "serv03":1, "serv05":1, "tc02":1, "tc03":1, "tc04":1 },
 *   "config": { "controlador":"arrendadora", "clave":"RET091100007", "editar":true, "idEditar":{"clave":"RET091100007"} } }
 *
 * // PASO 5 — Giro 10 Parques Temáticos:
 * { "data": { "capacidad":3500, "serv02":1, "serv05":1, "serv06":1, "serv14":1,
 *     "serv17":1, "serv24":1, "serv25":1, "serv35":1, "tc02":1, "tc03":1, "tc04":1 },
 *   "config": { "controlador":"parque", "clave":"RET101100014", "editar":true, "idEditar":{"clave":"RET101100014"} } }
 *
 * // PASO 5 — Giro 11 Auxilio Turístico:
 * { "data": { "hora01":1, "hora02":1, "hora03":1, "hora04":0,
 *     "horario":"Lun-Vie 08:00-18:00 / Sáb 09:00-14:00" },
 *   "config": { "controlador":"auxilio", "clave":"RET111100005", "editar":true, "idEditar":{"clave":"RET111100005"} } }
 *
 * // PASO 5 — Giro 12 Balneario:
 * { "data": { "hor_mat":1, "hor_vesp":1, "hor_diur":1, "capacidad":500,
 *     "alberca":4, "chapoteadero":2, "tobogan":6, "estacionamiento":120,
 *     "apertura":"Todo el año", "serv03":1, "serv05":1, "serv11":1, "serv14":1, "serv36":1,
 *     "tc02":1, "tc04":1 },
 *   "config": { "controlador":"balneario", "clave":"RET121100008", "editar":true, "idEditar":{"clave":"RET121100008"} } }
 *
 * // PASO 5 — Giro 13 Capacitación:
 * { "data": { "horario":"Lun-Vie 08:00-18:00", "nopersonas":18,
 *     "serv02":1, "serv06":1, "serv07":1, "serv11":1, "tc02":1, "tc04":1 },
 *   "config": { "controlador":"capacitacion", "clave":"RET131100006", "editar":true, "idEditar":{"clave":"RET131100006"} } }
 *
 * // PASO 5 — Giro 14 Deporte / Cinegético:
 * { "data": { "pesca":1, "rancho":1, "detalle":"Rancho cinegético 350 ha, pesca en presa.",
 *     "superficie":350, "serv01":1, "serv02":1, "serv07":1,
 *     "caza02":1, "caza09":1, "caza69":1, "tc04":1 },
 *   "config": { "controlador":"deporte", "clave":"RET141100004", "editar":true, "idEditar":{"clave":"RET141100004"} } }
 *
 * // PASO 5 — Giro 15 Spa:
 * { "data": { "horario":"Lun-Dom 09:00-21:00", "complejo":1,
 *     "serv11":1, "serv14":1, "serv16":1, "serv21":1, "serv39":1,
 *     "tc02":1, "tc03":1, "tc04":1 },
 *   "config": { "controlador":"spa", "clave":"RET151100009", "editar":true, "idEditar":{"clave":"RET151100009"} } }
 *
 * // PASO 5 — Giro 16 Recinto:
 * { "data": { "horario":"Lun-Sáb 07:00-23:00", "modalidad":"Centros de Congresos y Exposiciones",
 *     "serv05":1, "serv06":1, "serv12":1, "serv14":1, "serv24":1, "serv30":1,
 *     "tc02":1, "tc03":1, "tc04":1 },
 *   "config": { "controlador":"recinto", "clave":"RET161100006", "editar":true, "idEditar":{"clave":"RET161100006"} } }
 *
 * // PASO 5 — Giro 17 Hospedaje Digital:
 * { "data": { "categoria":1, "establecimiento":"Alojamiento Completo", "cuartos":3, "pisos":2,
 *     "airbnb":1, "booking":1, "tv":1, "internet":1, "aireacondicionado":1,
 *     "estacionamiento":1, "nocajon":2, "tipocajon":"Externo",
 *     "carta_protesta":1, "seguro":1, "aseguradora":"Qualitas" },
 *   "config": { "controlador":"hospedaje-digital", "clave":"RET171100015", "editar":true, "idEditar":{"clave":"RET171100015"} } }
 */
app.post('/saveTabla', verifyStaticToken, async (req, res) => {
    const { data, config, bitacora } = req.body;

    const response = { error: true, respuesta: 'Error en la operación' };
    let conn = null;

    try {
        // ── Validaciones básicas ──────────────────────────────────────────
        if (!data || typeof data !== 'object') {
            response.respuesta = 'Error|El campo data es obligatorio';
            return res.json(response);
        }
        if (!config || !config.controlador) {
            response.respuesta = 'Error|config.controlador es obligatorio';
            return res.json(response);
        }
        if (!config.clave && !config.idEditar) {
            response.respuesta = 'Error|Se requiere config.clave o config.idEditar para identificar el registro';
            return res.json(response);
        }

        const controlador = config.controlador;
        const meta        = GIRO_META[controlador];

        if (!meta) {
            response.respuesta = `Error|Controlador no reconocido: '${controlador}'. Valores válidos: ${Object.keys(GIRO_META).join(', ')}`;
            return res.json(response);
        }

        // ── Validar campos obligatorios del giro ─────────────────────────
        if (meta.camposReq.length > 0) {
            const faltantes = meta.camposReq.filter(c => data[c] === undefined || data[c] === null || data[c] === '');
            if (faltantes.length > 0) {
                response.respuesta = `Error|Campos obligatorios faltantes para el giro '${controlador}': ${faltantes.join(', ')}`;
                return res.json(response);
            }
        }

        const clave = config.clave || (config.idEditar && Object.values(config.idEditar)[0]);

        // ── Modo edición genérica (UPDATE libre, sin lógica de giro) ─────
        // Se activa cuando config.editar=true Y NO se envía config.controlador de giro.
        // Útil para correcciones administrativas puntuales.
        if (config.editar && config.tabla && !['datos-generales','datos-tecnicos','datos-legales','imagenes'].includes(controlador) && !meta) {
            conn = await beginTransaction();
            const whereClause = Object.keys(config.idEditar).map(k => `\`${k}\` = ?`).join(' AND ');
            const existing    = await conn.execute(`SELECT 1 FROM \`${config.tabla}\` WHERE ${whereClause}`, Object.values(config.idEditar));
            if (!existing[0] || existing[0].length === 0) {
                response.respuesta = 'Error|No se encontró el registro para editar';
                await rollbackTransaction(conn);
                return res.json(response);
            }
            const updateResult = await txUpdate(conn, config.tabla, data, Object.keys(config.idEditar)[0], Object.values(config.idEditar)[0]);
            if (updateResult.affectedRows === 0) {
                response.respuesta = 'Error|No se pudo actualizar el registro';
                await rollbackTransaction(conn);
                return res.json(response);
            }
            await commitTransaction(conn);
            response.error     = false;
            response.respuesta = 'Operación realizada correctamente';
            response.idRegistro = Object.values(config.idEditar)[0];
            return res.json(response);
        }

        // ── Lógica principal: equivalente al switch de Guardar_form.php ──
        conn = await beginTransaction();

        const { tablaGiro, concluido } = await ejecutarLogicaGuardarForm(conn, controlador, data, clave);

        await commitTransaction(conn);

        response.error      = false;
        response.respuesta  = 'Operación realizada correctamente';
        response.controlador = controlador;
        response.tabla      = meta.tabla;
        response.clave      = clave;
        response.concluido  = concluido;
        if (tablaGiro) response.tablaGiro = tablaGiro;

        // Log de bitácora (si se envió)
        if (bitacora) {
            console.log(`[BITÁCORA] controlador=${controlador} clave=${clave} user=${bitacora.id_user || '-'} script=${bitacora.script || '-'}`);
        }

    } catch (err) {
        console.error('❌ Error en saveTabla:', err.message);
        if (conn) await rollbackTransaction(conn);
        response.respuesta = `Error|${err.message}`;
    }

    return res.json(response);
});

app.listen(3001, () => {
    console.log('Servidor Node.js corriendo en el puerto 3001');
});
