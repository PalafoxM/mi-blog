const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2');
const path = require('path');

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

app.post('/getTabla', verifyStaticToken, async (req, res) => {
    const { data } = req.body;

    const response = {
        error: true,
        respuesta: 'Error|Parámetros de entrada',
        query: null,
        data: []
    };

    try {
        if (data.query) {
            try {
                const result = await query(data.query);
                response.query = data.query;
                response.data = result;
                response.error = false;
                response.respuesta = result.length === 0 ? 'No se encontraron resultados que coincidan con la búsqueda' : 'Consulta exitosa';
                return res.json(response);
            } catch (err) {
                response.respuesta = 'Fallo en la consulta a la base de datos';
                response.errorDB = err.message;
                return res.json(response);
            }
        }

        if (!data.tabla) return res.json(response);

        let sql = `SELECT `;
        sql += data.select ? data.select.join(', ') : '*';
        sql += ` FROM ${data.tabla}`;

        if (data.join) {
            data.join.forEach(join => {
                const joinType = join[2] || 'RIGHT';
                sql += ` ${joinType} JOIN ${join[0]} ON ${join[1]}`;
            });
        }

        let hasWhere = false;
        if (data.where) {
            const whereConditions = Object.keys(data.where)
                .map(key => `${key} = ?`)
                .join(' AND ');
            sql += ` WHERE ${whereConditions}`;
            hasWhere = true;
        }

        if (data.whereMonth) {
            if (!hasWhere) {
                sql += ` WHERE `;
                hasWhere = true;
            } else {
                sql += ` AND `;
            }
            data.whereMonth.forEach((whereMonth, index) => {
                const [column, month] = whereMonth;
                if (index > 0) sql += ` AND `;
                sql += `MONTH(${column}) = ?`;
            });
        }

        if (data.whereIn) {
            if (!hasWhere) {
                sql += ` WHERE `;
                hasWhere = true;
            } else {
                sql += ` AND `;
            }
            data.whereIn.forEach((whereIn, index) => {
                const values = whereIn[1].map(() => '?').join(', ');
                if (index > 0) sql += ` AND `;
                sql += `${whereIn[0]} IN (${values})`;
            });
        }

        if (data.whereNotIn) {
            if (!hasWhere) {
                sql += ` WHERE `;
                hasWhere = true;
            } else {
                sql += ` AND `;
            }
            data.whereNotIn.forEach((whereNotIn, index) => {
                const values = whereNotIn[1].map(() => '?').join(', ');
                if (index > 0) sql += ` AND `;
                sql += `${whereNotIn[0]} NOT IN (${values})`;
            });
        }

        if (data.whereBetween) {
            if (!hasWhere) {
                sql += ` WHERE `;
                hasWhere = true;
            } else {
                sql += ` AND `;
            }
            data.whereBetween.forEach((between, index) => {
                const [column, start, end] = between;
                if (index > 0) sql += ` AND `;
                sql += `${column} BETWEEN ? AND ?`;
            });
        }

        if (data.like) {
            if (!hasWhere) {
                sql += ` WHERE `;
                hasWhere = true;
            } else {
                sql += ` AND `;
            }
            const likeConditions = Object.keys(data.like)
                .map(key => `${key} LIKE ?`)
                .join(' AND ');
            sql += likeConditions;
        }

        if (data.orlike) {
            if (!hasWhere) {
                sql += ` WHERE `;
                hasWhere = true;
            } else {
                sql += ` AND `;
            }
            const orLikeConditions = Object.keys(data.orlike)
                .map(key => `${key} LIKE ?`)
                .join(' OR ');
            sql += `(${orLikeConditions})`;
        }

        if (data.groupBy) {
            sql += ` GROUP BY ${data.groupBy.join(', ')}`;
        }

        if (data.orderBy) {
            sql += ` ORDER BY ${data.orderBy}`;
        }

        if (data.limit) {
            if (data.limit.length && data.limit.start !== undefined) {
                sql += ` LIMIT ${data.limit.start}, ${data.limit.length}`;
            } else {
                sql += ` LIMIT ${data.limit}`;
            }
        }

        const params = [
            ...(data.where ? Object.values(data.where) : []),
            ...(data.whereIn ? data.whereIn.flatMap(wi => wi[1]) : []),
            ...(data.whereNotIn ? data.whereNotIn.flatMap(wni => wni[1]) : []),
            ...(data.whereBetween ? data.whereBetween.flatMap(wb => [wb[1], wb[2]]) : []),
            ...(data.like ? Object.values(data.like).map(val => `%${val}%`) : []),
            ...(data.whereMonth ? data.whereMonth.flatMap(wm => [wm[1]]) : []),
            ...(data.orlike ? Object.values(data.orlike).map(val => `%${val}%`) : [])
        ];

        const result = await query(sql, params);
        response.query = sql;
        response.data = result;
        response.error = false;
        response.respuesta = result.length === 0 ? 'No se encontraron resultados que coincidan con la búsqueda' : 'Consulta exitosa';
        return res.json(response);
    } catch (err) {
        console.error('❌ Error procesando registro:', err);
        response.respuesta = `Error|${err.message}`;
        return res.json(response);
    }
});

app.post('/saveTabla', verifyStaticToken, async (req, res) => {
    const { data, config, bitacora } = req.body;

    let response = {
        error: true,
        respuesta: 'Error en la operación',
    };
    let idRegistro = 0;

    try {
        const conn = await beginTransaction();

        if (config.editar) {
            const selectSQL = `SELECT * FROM ${config.tabla} WHERE ${Object.keys(config.idEditar).map(key => `${key} = ?`).join(' AND ')}`;
            const existingRecord = await query(selectSQL, Object.values(config.idEditar));

            if (!existingRecord || existingRecord.length === 0) {
                response.respuesta = 'Error|No se encontró el registro para editar';
                await rollbackTransaction(conn);
                return res.json(response);
            }

            const updateSQL = `UPDATE ${config.tabla} SET ? WHERE ${Object.keys(config.idEditar).map(key => `${key} = ?`).join(' AND ')}`;
            const updateResult = await query(updateSQL, [data, ...Object.values(config.idEditar)]);

            if (updateResult.affectedRows === 0) {
                response.respuesta = 'Error|No se pudo actualizar el registro';
                await rollbackTransaction(conn);
                return res.json(response);
            }

            idRegistro = Object.values(config.idEditar)[0];
        } else {
            const insertSQL = `INSERT INTO ${config.tabla} SET ?`;
            const insertResult = await query(insertSQL, data);

            if (insertResult.affectedRows === 0) {
                response.respuesta = 'Error|No se pudo insertar el registro';
                await rollbackTransaction(conn);
                return res.json(response);
            }
            idRegistro = insertResult.insertId;
        }

        await commitTransaction(conn);

        response.error = false;
        response.respuesta = 'Operación realizada correctamente';
        response.idRegistro = idRegistro;
    } catch (err) {
        console.error('❌ Error procesando registro:', err);
        if (conn) await rollbackTransaction(conn);
        response.respuesta = `Error|${err.message}`;
    }

    return res.json(response);
});

app.listen(3001, () => {
    console.log('Servidor Node.js corriendo en el puerto 3001');
});
