"use strict";

require("dotenv").config();

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
    throw new Error(
        "A variável DATABASE_URL não foi configurada."
    );
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
    console.error(
        "Erro inesperado na conexão PostgreSQL:",
        error.message
    );
});

async function testarConexao() {
    const resultado = await pool.query(
        "SELECT NOW() AS horario, current_database() AS banco"
    );

    console.log("PostgreSQL conectado com sucesso!");
    console.log("Banco:", resultado.rows[0].banco);
    console.log("Horário:", resultado.rows[0].horario);

    return resultado.rows[0];
}

module.exports = {
    pool,
    testarConexao
};
