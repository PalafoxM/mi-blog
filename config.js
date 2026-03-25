// config.js
require('dotenv').config();

module.exports = {
    moodleUrl: process.env.MOODLE_URL,
    moodleToken: process.env.MOODLE_TOKEN,
    token_sti: process.env.TOKEN,
    retStaticToken: process.env.RET_STATIC_TOKEN,
    retTestBaseUrl: process.env.RET_TEST_BASE_URL,
    retProdBaseUrl: process.env.RET_PROD_BASE_URL,
    usuario: process.env.USUARIO,
    password: process.env.PASSWORD,
    database: process.env.DATABASE,
    host: process.env.HOST,
    port: process.env.PORT_DB 
};
